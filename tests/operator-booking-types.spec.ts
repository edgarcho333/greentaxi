import { existsSync } from 'node:fs';
import { operatorSessionPath } from './helpers/operator-session';
import { test as base, expect, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import { addDays, today, type Booking, type DriverDay, type DriverSchedule, type TripCapacity } from '../src/api';

const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'Whole-car booking forms must not throw browser runtime errors').toEqual([]);
  }, { auto: true }],
});
let api: APIRequestContext;
const createdIds: number[] = [];
const inquiryIds: number[] = [];
const changedDrivers = new Set<number>();
const attendanceToRestore = new Set<number>();
const employee = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const tripDate = () => addDays(today(), 1);

test.beforeAll(async ({ playwright, baseURL }, info) => {
  const sessionPath = operatorSessionPath(info.config.metadata.fixtureDatabasePath);
  api = await playwright.request.newContext({ baseURL, ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}) });
  const session = await (await api.get('/api/auth/session')).json();
  if (!session.user) expect((await api.post(session.needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: employee })).ok()).toBeTruthy();
});
test.afterEach(async () => {
  for (const id of inquiryIds.splice(0)) expect((await api.post(`/api/admin/calls/${id}/delete`)).ok()).toBeTruthy();
  for (const id of createdIds.splice(0)) expect((await api.post(`/api/admin/bookings/${id}/delete`)).ok()).toBeTruthy();
  for (const id of attendanceToRestore) expect((await api.patch(`/api/admin/drivers/${id}/day`, { data: { direction: 'gori-tbilisi', date: tripDate(), declined: false } })).ok()).toBeTruthy();
  attendanceToRestore.clear();
  // Release only assignments created here, after deleting the corresponding orders.
  for (const id of changedDrivers) {
    const driver = (await driverDay()).drivers.find(driver => driver.id === id)!;
    if (!driver.assignedTime) continue;
    const trip = await capacity(driver.assignedTime);
    expect((await api.post('/api/admin/trips/drivers', { data: {
      direction: 'gori-tbilisi', date: tripDate(), time: driver.assignedTime, expectedRevision: trip.revision,
      action: 'remove', removeKey: `roster:${id}`,
    } })).ok()).toBeTruthy();
  }
  changedDrivers.clear();
});
test.afterAll(async () => { await api.dispose(); });

async function driverDay(date = tripDate()): Promise<DriverSchedule> {
  const response = await api.get(`/api/admin/drivers/schedule?direction=gori-tbilisi&date=${date}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as DriverSchedule;
}
async function capacity(time: string): Promise<TripCapacity> {
  const response = await api.get(`/api/admin/trips/capacity?direction=gori-tbilisi&date=${tripDate()}&time=${time}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as TripCapacity;
}
async function unassignedDriver(capacity?: number): Promise<DriverDay> {
  const driver = (await driverDay()).drivers.find(driver => !driver.declined && !driver.assignedTime && (!capacity || driver.capacity === capacity));
  expect(driver, 'The fixture must select an active driver without a departure').toBeTruthy();
  changedDrivers.add(driver!.id);
  return driver!;
}
async function assign(driver: DriverDay, time: string) {
  const trip = await capacity(time);
  expect((await api.post('/api/admin/trips/drivers', { data: {
    direction: 'gori-tbilisi', date: tripDate(), time, expectedRevision: trip.revision, action: 'add', driver: { kind: 'roster', id: driver.id },
  } })).ok()).toBeTruthy();
}
async function openAdmin(page: Page) {
  await page.context().addCookies((await api.storageState()).cookies);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'ჯავშნები', exact: true })).toBeVisible();
}
function bookingForm(page: Page, name = 'ახალი ჯავშანი'): Locator { return page.getByRole('dialog', { name, exact: true }); }
function picker(page: Page): Locator { return page.locator('[data-whole-car-dialog]'); }
function choice(page: Page, driver: Pick<DriverDay, 'id'>): Locator { return picker(page).locator(`[data-whole-car-driver="roster:${driver.id}"]`); }
function isMutation(response: Response, path: string, method = 'POST'): boolean {
  return new URL(response.url()).pathname === path && response.request().method() === method;
}
function mutationPaths(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && (path.startsWith('/api/admin/bookings') || path.startsWith('/api/admin/drivers/') || path === '/api/admin/trips/drivers' || /\/api\/admin\/calls\/\d+\/convert/.test(path))) writes.push(path);
  });
  return writes;
}
async function newBooking(page: Page, phone: string, time: string, type: 'parcel' | 'whole_car' = 'whole_car') {
  await openAdmin(page);
  await page.getByRole('button', { name: 'ახალი ჯავშანი', exact: true }).click();
  const form = bookingForm(page);
  await form.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill(`გორი, ტიპის სატესტო მისამართი ${phone}`);
  await form.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
  await form.getByRole('group', { name: 'თარიღი', exact: true }).getByRole('button', { name: /^ხვალ,/ }).click();
  await form.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: time, exact: true }).click();
  await form.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }).getByRole('button', { name: type === 'parcel' ? 'გზავნილი' : 'მთლიანი მანქანა', exact: true }).click();
  await expect(form.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true })).toHaveCount(0);
  await expect(form.getByRole('group', { name: 'სასურველი ადგილი', exact: true })).toHaveCount(0);
  return form;
}
async function openPicker(page: Page, form: Locator) {
  const trigger = form.getByRole('button', { name: 'დანიშნული მანქანა', exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(picker(page)).toBeVisible();
  return trigger;
}
async function selectUnassigned(page: Page, form: Locator, driver: DriverDay) {
  await openPicker(page, form);
  await choice(page, driver).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(form.locator('[data-whole-car-selected-name]')).toContainText(driver.name);
}
async function submitNew(page: Page, form: Locator): Promise<Booking> {
  const saved = page.waitForResponse(response => isMutation(response, '/api/admin/bookings'));
  await form.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const booking = await response.json() as Booking;
  createdIds.push(booking.id);
  if (booking.bookingType === 'whole_car') expect(response.request().postDataJSON().expectedVehicleRevision).toMatch(/^[a-f0-9]{64}$/);
  await expect(form).toHaveCount(0);
  return booking;
}
async function findBookingRow(page: Page, booking: Booking) {
  await page.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true }).fill(tripDate());
  await page.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true }).fill(booking.phone);
  const row = page.locator(`.admin-booking-table tr[data-booking-id="${booking.id}"]`);
  await expect(row).toBeVisible();
  return row;
}

test('operator creates a parcel without seats and reserves an unassigned driver with his real capacity', async ({ page }) => {
  const parcel = await submitNew(page, await newBooking(page, '599800101', '08:30', 'parcel'));
  expect(parcel).toMatchObject({ bookingType: 'parcel', seats: 0 });
  const driver = await unassignedDriver(8);
  const form = await newBooking(page, '599800102', '08:30');
  await selectUnassigned(page, form, driver);
  expect((await driverDay()).drivers.find(item => item.id === driver.id)?.assignedTime).toBeNull();
  const booking = await submitNew(page, form);
  expect(booking).toMatchObject({ bookingType: 'whole_car', assignedVehicleKey: `roster:${driver.id}`, seats: 8 });
  expect((await driverDay()).drivers.find(item => item.id === driver.id)?.assignedTime).toBe('08:30');
  expect((await capacity('08:30')).drivers.find(car => car.driverId === driver.id)).toMatchObject({ capacity: 8, reservedBookingId: booking.id, freeSeats: 0 });
  await page.reload();
  const stored = await (await api.get('/api/admin/bookings')).json() as { bookings: Booking[] };
  expect(stored.bookings.find(item => item.id === parcel.id)?.seats).toBe(0);
  expect(stored.bookings.find(item => item.id === booking.id)?.assignedVehicleKey).toBe(`roster:${driver.id}`);
});

test('the picker shows every driver in daily order, and closing it or its form makes no assignment', async ({ page }) => {
  const driver = await unassignedDriver();
  const absent = (await driverDay()).drivers.find(item => item.id !== driver.id && !item.declined && !item.assignedTime)!;
  expect(absent).toBeTruthy(); attendanceToRestore.add(absent.id);
  expect((await api.patch(`/api/admin/drivers/${absent.id}/day`, { data: { direction: 'gori-tbilisi', date: tripDate(), declined: true } })).ok()).toBeTruthy();
  const expected = (await driverDay()).drivers;
  const form = await newBooking(page, '599800103', '09:00');
  const writes = mutationPaths(page);
  const trigger = await openPicker(page, form);
  const rosterChoices = picker(page).locator('[data-whole-car-driver^="roster:"]');
  await expect(rosterChoices).toHaveCount(expected.length);
  expect(await rosterChoices.evaluateAll(buttons => buttons.map(button => button.getAttribute('data-whole-car-driver')))).toEqual(expected.map(item => `roster:${item.id}`));
  expect(await rosterChoices.evaluateAll(buttons => buttons.map(button => Number(button.getAttribute('data-whole-car-queue'))))).toEqual(expected.map(item => item.queuePosition));
  await expect(choice(page, absent)).toBeEnabled();
  await expect(choice(page, absent)).toHaveAttribute('data-whole-car-declined', 'true');
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await expect(form).toBeVisible(); await expect(trigger).toBeFocused();
  await selectUnassigned(page, form, driver);
  expect((await driverDay()).drivers.find(item => item.id === driver.id)?.assignedTime).toBeNull();
  await form.getByRole('button', { name: 'გაუქმება', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(writes).toEqual([]);
  expect((await driverDay()).drivers.find(item => item.id === driver.id)?.assignedTime).toBeNull();
  expect((await capacity('09:00')).drivers.some(car => car.driverId === driver.id)).toBe(false);
});

test('an inactive driver requires confirmation and becomes active only on the booked day after final save', async ({ page }) => {
  const driver = await unassignedDriver(6);
  const todayBefore = (await driverDay(today())).drivers.find(item => item.id === driver.id);
  const followingDate = addDays(tripDate(), 1);
  const followingBefore = (await driverDay(followingDate)).drivers.find(item => item.id === driver.id);
  attendanceToRestore.add(driver.id);
  expect((await api.patch(`/api/admin/drivers/${driver.id}/day`, { data: {
    direction: 'gori-tbilisi', date: tripDate(), declined: true,
  } })).ok()).toBeTruthy();
  let form = await newBooking(page, '599800110', '09:30');
  const writes = mutationPaths(page);
  await openPicker(page, form);
  await expect(choice(page, driver)).toBeEnabled();
  await expect(choice(page, driver)).toHaveAttribute('data-whole-car-declined', 'true');
  await choice(page, driver).click();
  const confirm = picker(page).locator('[data-whole-car-activation-confirm]');
  await expect(picker(page).locator('[data-whole-car-activation]')).toBeVisible();
  await expect(confirm).toBeVisible();
  await picker(page).getByRole('button', { name: 'უკან', exact: true }).click();
  await expect(choice(page, driver)).toBeVisible();
  expect((await driverDay()).drivers.find(item => item.id === driver.id)).toMatchObject({ declined: true, assignedTime: null });
  await choice(page, driver).click();
  await confirm.click();
  await expect(picker(page)).toHaveCount(0);
  await expect(form.locator('[data-whole-car-selected-name]')).toContainText(driver.name);
  expect((await driverDay()).drivers.find(item => item.id === driver.id)).toMatchObject({ declined: true, assignedTime: null });
  await form.getByRole('button', { name: 'გაუქმება', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(writes).toEqual([]);
  expect((await driverDay()).drivers.find(item => item.id === driver.id)).toMatchObject({ declined: true, assignedTime: null });

  form = await newBooking(page, '599800110', '09:30');
  await openPicker(page, form);
  await choice(page, driver).click();
  await confirm.click();
  await expect(picker(page)).toHaveCount(0);
  expect(writes).toEqual([]);
  expect((await driverDay()).drivers.find(item => item.id === driver.id)?.declined).toBe(true);
  const booking = await submitNew(page, form);
  expect(writes).toEqual(['/api/admin/bookings']);
  expect(booking).toMatchObject({ bookingType: 'whole_car', assignedDate: tripDate(), assignedTime: '09:30', assignedVehicleKey: `roster:${driver.id}`, seats: 6 });
  expect((await driverDay()).drivers.find(item => item.id === driver.id)).toMatchObject({ declined: false, assignedTime: '09:30', assignmentActive: true });
  expect((await capacity('09:30')).drivers.find(car => car.driverId === driver.id)).toMatchObject({ capacity: 6, reservedBookingId: booking.id, freeSeats: 0 });
  expect((await driverDay(today())).drivers.find(item => item.id === driver.id)).toEqual(todayBefore);
  expect((await driverDay(followingDate)).drivers.find(item => item.id === driver.id)).toEqual(followingBefore);
});

test('choosing a driver from another hour asks for confirmation and transfers only when the booking is saved', async ({ page }) => {
  const driver = await unassignedDriver(); await assign(driver, '10:00');
  const form = await newBooking(page, '599800104', '11:00');
  const writes = mutationPaths(page); await openPicker(page, form); await choice(page, driver).click();
  const confirm = picker(page).locator('[data-whole-car-transfer-confirm]');
  await expect(confirm).toBeVisible();
  await expect(picker(page)).toContainText('10:00'); await expect(picker(page)).toContainText('11:00');
  await picker(page).getByRole('button', { name: 'უკან', exact: true }).click();
  await expect(choice(page, driver)).toBeVisible(); expect(writes).toEqual([]);
  await choice(page, driver).click(); await confirm.click();
  await expect(picker(page)).toHaveCount(0); expect(writes).toEqual([]);
  expect((await driverDay()).drivers.find(item => item.id === driver.id)?.assignedTime).toBe('10:00');
  const booking = await submitNew(page, form);
  expect(writes).toEqual(['/api/admin/bookings']);
  expect(booking).toMatchObject({ assignedTime: '11:00', assignedVehicleKey: `roster:${driver.id}`, seats: driver.capacity });
  expect((await capacity('10:00')).drivers.some(car => car.driverId === driver.id)).toBe(false);
  expect((await capacity('11:00')).drivers.find(car => car.driverId === driver.id)?.reservedBookingId).toBe(booking.id);
});

test('a whole-car booking retains its own driver in edit and can move that reservation to another hour', async ({ page }) => {
  const driver = await unassignedDriver();
  let form = await newBooking(page, '599800105', '12:00'); await selectUnassigned(page, form, driver);
  const booking = await submitNew(page, form); const row = await findBookingRow(page, booking);
  await row.getByRole('button', { name: /რედაქტირება$/ }).click();
  form = bookingForm(page, 'ჯავშნის რედაქტირება'); await openPicker(page, form);
  await expect(choice(page, driver)).toBeEnabled(); await choice(page, driver).click();
  await form.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, განახლებული მთლიანი მანქანის მისამართი');
  const edited = page.waitForResponse(response => isMutation(response, `/api/admin/bookings/${booking.id}`, 'PATCH'));
  await form.getByRole('button', { name: 'ცვლილებების შენახვა', exact: true }).click();
  expect((await edited).ok()).toBeTruthy(); await expect(form).toHaveCount(0);
  expect((await capacity('12:00')).drivers.find(car => car.driverId === driver.id)?.reservedBookingId).toBe(booking.id);
  await row.getByRole('button', { name: /დროის შეცვლა$/ }).click();
  form = bookingForm(page, 'ჯავშნის გადატანა');
  await form.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '13:00', exact: true }).click();
  await openPicker(page, form); await expect(choice(page, driver)).toBeEnabled(); await choice(page, driver).click();
  await picker(page).locator('[data-whole-car-transfer-confirm]').click();
  const moved = page.waitForResponse(response => isMutation(response, `/api/admin/bookings/${booking.id}/move`));
  await form.getByRole('button', { name: 'გადატანა', exact: true }).click();
  const response = await moved; expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ id: booking.id, assignedTime: '13:00', assignedVehicleKey: `roster:${driver.id}`, seats: driver.capacity });
  await expect(form).toHaveCount(0);
  expect((await capacity('12:00')).drivers.some(car => car.driverId === driver.id)).toBe(false);
  expect((await capacity('13:00')).drivers.find(car => car.driverId === driver.id)?.reservedBookingId).toBe(booking.id);
});

test('a reserved driver is disabled for another order even at a different hour', async ({ page }) => {
  const driver = await unassignedDriver();
  let form = await newBooking(page, '599800106', '14:00'); await selectUnassigned(page, form, driver);
  const booking = await submitNew(page, form);
  form = await newBooking(page, '599800107', '15:00'); await openPicker(page, form);
  await expect(choice(page, driver)).toBeDisabled(); await expect(choice(page, driver)).toContainText('დაჯავშნილია');
  await page.keyboard.press('Escape'); await form.getByRole('button', { name: 'გაუქმება', exact: true }).click();
  expect((await capacity('14:00')).drivers.find(car => car.driverId === driver.id)?.reservedBookingId).toBe(booking.id);
  expect((await capacity('15:00')).drivers.some(car => car.driverId === driver.id)).toBe(false);
});

test('restoring a deleted whole-car order offers a fresh driver selection after that driver changed hours', async ({ page }) => {
  const driver = await unassignedDriver();
  let form = await newBooking(page, '599800109', '18:00'); await selectUnassigned(page, form, driver);
  const booking = await submitNew(page, form);
  expect((await api.post(`/api/admin/bookings/${booking.id}/delete`)).ok()).toBeTruthy();
  await assign(driver, '19:00');
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true }).getByRole('button', { name: 'ისტორია', exact: true }).click();
  await page.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true }).fill(booking.phone);
  const row = page.locator(`.admin-booking-table tr[data-booking-id="${booking.id}"]`);
  await row.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  form = bookingForm(page, 'ჯავშნის აღდგენა');
  await openPicker(page, form); await expect(choice(page, driver)).toBeEnabled(); await choice(page, driver).click();
  await picker(page).locator('[data-whole-car-transfer-confirm]').click();
  const restored = page.waitForResponse(response => isMutation(response, `/api/admin/bookings/${booking.id}/restore`));
  await form.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  const response = await restored; expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON().expectedVehicleRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(await response.json()).toMatchObject({ id: booking.id, deletedAt: null, assignedTime: '18:00', assignedVehicleKey: `roster:${driver.id}` });
  expect((await capacity('19:00')).drivers.some(car => car.driverId === driver.id)).toBe(false);
  expect((await capacity('18:00')).drivers.find(car => car.driverId === driver.id)?.reservedBookingId).toBe(booking.id);
});

test('the incoming-call form selects an unassigned driver and sends its revision when confirming', async ({ page }) => {
  const driver = await unassignedDriver();
  const device = await api.post('/api/admin/devices', { data: { name: 'Whole-car disposable call fixture' } }); expect(device.status()).toBe(201);
  const { token } = await device.json() as { token: string };
  const incoming = await api.post('/api/integrations/android/calls', {
    headers: { Authorization: `Bearer ${token}` },
    data: { eventId: `whole-car-browser-${Date.now()}`, kind: 'incoming', phase: 'answered', phone: '+995599800108', occurredAt: new Date().toISOString(), durationSeconds: 0 },
  });
  expect(incoming.status()).toBe(201); const call = await incoming.json() as { id: number }; inquiryIds.push(call.id);
  await openAdmin(page);
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true }).getByRole('button', { name: /^შემოსული/ }).click();
  const row = page.locator(`.admin-calls-table tbody tr[data-call-id="${call.id}"]`);
  await row.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, სატესტო ზარით მთლიანი მანქანა');
  await row.getByRole('group', { name: 'დღე', exact: true }).getByRole('button', { name: /^ხვალ/ }).click();
  await row.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '16:00', exact: true }).click();
  await row.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }).getByRole('button', { name: 'მთლიანი მანქანა', exact: true }).click();
  await expect(row.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true })).toHaveCount(0);
  await selectUnassigned(page, row, driver);
  expect((await driverDay()).drivers.find(item => item.id === driver.id)?.assignedTime).toBeNull();
  const converted = page.waitForResponse(response => isMutation(response, `/api/admin/calls/${call.id}/convert`));
  await row.getByRole('button', { name: 'დადასტურება', exact: true }).click();
  const response = await converted;
  const booking = await response.json() as Booking; createdIds.push(booking.id);
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().expectedVehicleRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(booking).toMatchObject({ bookingType: 'whole_car', assignedTime: '16:00', assignedVehicleKey: `roster:${driver.id}`, seats: driver.capacity });
  expect((await capacity('16:00')).drivers.find(car => car.driverId === driver.id)?.reservedBookingId).toBe(booking.id);
});

for (const width of [320, 390]) {
  test(`parcel and whole-car picker buttons fit the ${width}px operator form`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const form = await newBooking(page, `599800${width}`, '17:00', 'parcel');
    const services = form.getByRole('group', { name: 'დამატებითი სერვისები', exact: true });
    for (const name of ['ბარგი', 'ძაღლი', 'გზავნილი', 'მთლიანი მანქანა']) await expect(services.getByRole('button', { name, exact: true })).toBeVisible();
    await services.getByRole('button', { name: 'მთლიანი მანქანა', exact: true }).click();
    const trigger = await openPicker(page, form); const buttons = picker(page).locator('[data-whole-car-driver]');
    await expect(buttons.first()).toBeVisible();
    for (const button of [buttons.first(), buttons.last()]) {
      await button.scrollIntoViewIfNeeded(); const box = await button.boundingBox(); expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(48); expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.keyboard.press('Escape'); await expect(picker(page)).toHaveCount(0); await expect(form).toBeVisible(); await expect(trigger).toBeFocused();
    await services.getByRole('button', { name: 'მთლიანი მანქანა', exact: true }).click();
    await expect(form.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true })).toBeVisible();
    await form.getByRole('button', { name: 'გაუქმება', exact: true }).click();
  });
}
