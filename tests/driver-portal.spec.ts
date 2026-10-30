import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { addDays, today, type Booking, type DriverDashboard, type DriverSchedule, type TripCapacity, type WholeCarOptions } from '../src/api';
import { operatorSessionPath } from './helpers/operator-session';
import { formatPhone } from '../shared/phone';

// These staff credentials and driver phones exist only in Playwright's isolated database.
const EMPLOYEE = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const DRIVER_A = { driverId: 41, phone: '599920041' };
const DRIVER_B = { driverId: 42, phone: '599920042' };
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'The driver page must not throw browser runtime errors').toEqual([]);
  }, { auto: true }],
});
let admin: APIRequestContext;
let driverApi: APIRequestContext;
let otherDriverApi: APIRequestContext;
let driverName: string;
const bookingIds: number[] = [];
const assignedDrivers = new Set<number>();
const tomorrow = () => addDays(today(), 1);

async function day(date: string): Promise<DriverSchedule> {
  const response = await admin.get(`/api/admin/drivers/schedule?direction=gori-tbilisi&date=${date}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as DriverSchedule;
}
async function capacity(date: string, time: string): Promise<TripCapacity> {
  const response = await admin.get(`/api/admin/trips/capacity?${new URLSearchParams({ direction: 'gori-tbilisi', date, time })}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as TripCapacity;
}
async function working(date: string, driverId: number, value: boolean) {
  const response = await admin.patch(`/api/admin/drivers/${driverId}/day`, { data: { direction: 'gori-tbilisi', date, declined: !value } });
  expect(response.ok()).toBeTruthy();
}

test.beforeAll(async ({ playwright, baseURL }, info) => {
  const sessionPath = operatorSessionPath(info.config.metadata.fixtureDatabasePath);
  admin = await playwright.request.newContext({ baseURL, ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}) });
  const session = await (await admin.get('/api/auth/session')).json();
  if (!session.user) expect((await admin.post(session.needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: EMPLOYEE })).ok()).toBeTruthy();
  for (const account of [DRIVER_A, DRIVER_B]) {
    const saved = await admin.patch(`/api/admin/drivers/${account.driverId}/phone`, { data: { phone: account.phone } });
    expect(saved.ok()).toBeTruthy();
    expect(await saved.json()).toMatchObject({ driverId: account.driverId, phone: account.phone });
  }
  driverName = (await day(today())).drivers.find(driver => driver.id === DRIVER_A.driverId)!.name;
  driverApi = await playwright.request.newContext({ baseURL });
  otherDriverApi = await playwright.request.newContext({ baseURL });
  for (const [context, account] of [[driverApi, DRIVER_A], [otherDriverApi, DRIVER_B]] as const) {
    const response = await context.post('/api/driver/auth/login', { data: { phone: account.phone } });
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).driver.id).toBe(account.driverId);
  }
});
test.beforeEach(async () => {
  for (const date of [today(), tomorrow()]) for (const account of [DRIVER_A, DRIVER_B]) await working(date, account.driverId, true);
});
test.afterEach(async () => {
  for (const id of bookingIds.splice(0)) expect((await admin.post(`/api/admin/bookings/${id}/delete`)).ok()).toBeTruthy();
  for (const date of [today(), tomorrow()]) for (const account of [DRIVER_A, DRIVER_B]) await working(date, account.driverId, true);
  for (const id of assignedDrivers) {
    const driver = (await day(tomorrow())).drivers.find(driver => driver.id === id)!;
    for (const time of driver.assignedTimes ?? (driver.assignedTime ? [driver.assignedTime] : [])) {
      const trip = await capacity(tomorrow(), time);
      expect((await admin.post('/api/admin/trips/drivers', { data: {
        direction: 'gori-tbilisi', date: tomorrow(), time, expectedRevision: trip.revision,
        action: 'remove', removeKey: `roster:${id}`,
      } })).ok()).toBeTruthy();
    }
  }
  assignedDrivers.clear();
});
test.afterAll(async () => {
  if (admin) for (const account of [DRIVER_A, DRIVER_B]) expect((await admin.patch(`/api/admin/drivers/${account.driverId}/phone`, { data: { phone: null } })).ok()).toBeTruthy();
  await Promise.all([admin?.dispose(), driverApi?.dispose(), otherDriverApi?.dispose()]);
});

function attendance(page: Page): Locator { return page.locator('[data-driver-attendance]'); }
function bookings(page: Page): Locator { return page.locator('[data-driver-bookings]'); }
function selectedDays(page: Page): Locator { return page.getByRole('group', { name: 'დღეები', exact: true }); }
function tripTimes(page: Page): Locator { return page.getByRole('group', { name: 'რეისის დრო', exact: true }); }
function bookedSeats(page: Page): Locator { return bookings(page).locator('[data-driver-seat-count]'); }
async function openDriver(page: Page) {
  await page.context().addCookies((await driverApi.storageState()).cookies);
  await page.goto('/driver');
  await expect(page.locator('[data-driver-portal]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'მძღოლის გვერდი', exact: true })).toBeVisible();
  await expect(selectedDays(page)).toHaveCount(1);
}
async function setWork(page: Page, date: 'დღეს' | 'ხვალ', value: boolean) {
  await selectedDays(page).getByRole('button', { name: date, exact: true }).click();
  const button = attendance(page).getByRole('button', { name: value ? 'ვმუშაობ' : 'არ ვმუშაობ', exact: true });
  await expect(button).toBeEnabled();
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/driver/attendance' && response.request().method() === 'PATCH');
  await button.click();
  return await saved;
}
async function seedWhole(driverId: number, phone: string, callerPhone?: string, time = '09:30'): Promise<Booking> {
  const options = await admin.get(`/api/admin/trips/whole-car-options?direction=gori-tbilisi&date=${tomorrow()}&time=${time}`);
  expect(options.ok()).toBeTruthy();
  const candidate = (await options.json() as WholeCarOptions).drivers.find(driver => driver.key === `roster:${driverId}`)!;
  expect(candidate).toBeTruthy();
  const response = await admin.post('/api/admin/bookings', { data: {
    phone, ...(callerPhone ? { callerPhone } : {}), seats: 1, bookingType: 'whole_car', assignedVehicleKey: candidate.key, expectedVehicleRevision: candidate.revision,
    direction: 'gori-tbilisi', goriAddress: `გორი, მძღოლის სატესტო მისამართი ${phone}`, requestedDate: tomorrow(), requestedTime: time, luggage: true, dog: true,
  } });
  expect(response.status()).toBe(201);
  const result = await response.json() as Booking;
  bookingIds.push(result.id); assignedDrivers.add(driverId);
  return result;
}

test('the driver logs in with only his assigned phone, keeps his session on reload and loses it after logout', async ({ page }) => {
  await page.goto('/driver');
  await expect(page.getByRole('heading', { name: 'მძღოლის შესვლა', exact: true })).toBeVisible();
  await expect(page.getByLabel('მომხმარებლის სახელი', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('პაროლი', { exact: true })).toHaveCount(0);
  const phone = page.getByRole('textbox', { name: 'ტელეფონის ნომერი', exact: true });
  await expect(phone).toHaveAttribute('type', 'tel');
  await expect(phone).toHaveAttribute('inputmode', 'tel');
  await phone.fill('599929999');
  const refused = page.waitForResponse(response => new URL(response.url()).pathname === '/api/driver/auth/login' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'შესვლა', exact: true }).click();
  expect((await refused).status()).toBe(401);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-driver-portal]')).toHaveCount(0);
  await phone.fill(`+995 ${DRIVER_A.phone}`);
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/driver/auth/login' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'შესვლა', exact: true }).click();
  const response = await accepted;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON()).toEqual({ phone: DRIVER_A.phone });
  await expect(page.locator('[data-driver-portal]')).toBeVisible();
  await expect(page.locator('[data-driver-portal]')).toContainText(driverName);
  await page.reload();
  await expect(page.locator('[data-driver-portal]')).toBeVisible();
  const cookies = await page.context().cookies();
  const oldSession = cookies.find(cookie => cookie.name === 'greentaxi_driver_session')!;
  expect(oldSession.httpOnly).toBe(true);
  expect(oldSession.path).toBe('/api/driver');
  await page.getByRole('button', { name: 'გამოსვლა', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'მძღოლის შესვლა', exact: true })).toBeVisible();
  expect((await page.request.get(`/api/driver/dashboard?date=${today()}`)).status()).toBe(401);
  expect((await page.request.get(`/api/driver/dashboard?date=${today()}`, { headers: { Cookie: `${oldSession.name}=${oldSession.value}` } })).status()).toBe(401);
});

test('today and tomorrow attendance changes stay independent and do not assign trips or change another driver', async ({ page }) => {
  const untouchedDate = addDays(tomorrow(), 1);
  const untouched = await day(untouchedDate);
  const otherBefore = (await day(tomorrow())).drivers.find(driver => driver.id === DRIVER_B.driverId);
  await openDriver(page);
  const response = await setWork(page, 'ხვალ', false);
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON()).toEqual({ date: tomorrow(), working: false });
  await expect(attendance(page)).toHaveAttribute('data-date', tomorrow());
  await expect(bookings(page)).toHaveAttribute('data-date', tomorrow());
  await expect(attendance(page).getByRole('button', { name: 'არ ვმუშაობ', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await day(tomorrow())).drivers.find(driver => driver.id === DRIVER_A.driverId)).toMatchObject({ declined: true, assignedTime: null });
  expect((await day(today())).drivers.find(driver => driver.id === DRIVER_A.driverId)?.declined).toBe(false);
  await page.reload();
  await selectedDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
  await expect(attendance(page).getByRole('button', { name: 'არ ვმუშაობ', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await setWork(page, 'ხვალ', true)).ok()).toBeTruthy();
  expect((await setWork(page, 'დღეს', false)).ok()).toBeTruthy();
  expect((await day(today())).drivers.find(driver => driver.id === DRIVER_A.driverId)?.declined).toBe(true);
  expect((await day(tomorrow())).drivers.find(driver => driver.id === DRIVER_A.driverId)?.declined).toBe(false);
  expect((await day(tomorrow())).drivers.find(driver => driver.id === DRIVER_B.driverId)).toEqual(otherBefore);
  expect(await day(untouchedDate)).toEqual(untouched);
});

test('a reserved whole car prevents declining the day and shows a clear error without losing the booking', async ({ page }) => {
  const booking = await seedWhole(DRIVER_A.driverId, '599910101');
  await openDriver(page);
  const response = await setWork(page, 'ხვალ', false);
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'VEHICLE_RESERVED' });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(attendance(page).getByRole('button', { name: 'ვმუშაობ', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await day(tomorrow())).drivers.find(driver => driver.id === DRIVER_A.driverId)).toMatchObject({ declined: false, assignedTime: '09:30' });
  expect((await capacity(tomorrow(), '09:30')).drivers.find(driver => driver.driverId === DRIVER_A.driverId)?.reservedBookingId).toBe(booking.id);
});

test('the driver reads his confirmed booking while another driver and deleted or waiting orders remain private', async ({ page }) => {
  const deleted = await seedWhole(DRIVER_A.driverId, '599910102');
  expect((await admin.post(`/api/admin/bookings/${deleted.id}/delete`)).ok()).toBeTruthy();
  const own = await seedWhole(DRIVER_A.driverId, '599910103');
  const other = await seedWhole(DRIVER_B.driverId, '599910104');
  const waitingResponse = await admin.post('/api/bookings', { data: {
    name: 'სატესტო დასადასტურებელი მგზავრი', phone: '599910105', seats: 1,
    direction: 'gori-tbilisi', goriAddress: 'გორი, დასადასტურებელი სატესტო მისამართი', requestedDate: tomorrow(), requestedTime: '09:30',
  } });
  expect(waitingResponse.status()).toBe(201); const waiting = await waitingResponse.json() as Pick<Booking, 'id'>; bookingIds.push(waiting.id);
  await openDriver(page);
  await selectedDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
  await expect(bookings(page).locator(`[data-driver-booking="${own.id}"]`)).toBeVisible();
  for (const id of [other.id, deleted.id, waiting.id]) await expect(bookings(page).locator(`[data-driver-booking="${id}"]`)).toHaveCount(0);
  const raw = await driverApi.get(`/api/driver/dashboard?date=${tomorrow()}`);
  expect(raw.ok()).toBeTruthy();
  const text = await raw.text();
  expect(text).toContain(own.phone);
  for (const phone of [other.phone, deleted.phone, '599910105']) expect(text).not.toContain(phone);
  const card = bookings(page).locator(`[data-driver-booking="${own.id}"]`);
  await expect(tripTimes(page).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(card).not.toContainText('09:30'); await expect(card).toContainText(own.goriAddress);
  await expect(bookedSeats(page)).toHaveText(String(own.seats));
  await expect(bookings(page).locator('[data-driver-booking-count]')).toHaveText('1');
  await expect(card.locator('a[href^="tel:"]')).toHaveCount(1);
  await expect(card.locator('a[href^="tel:"]')).toHaveText(formatPhone(own.phone));
  await expect(card.locator('a[href^="tel:"]')).toHaveAttribute('href', `tel:+995${own.phone}`);
  expect((await card.innerText()).split(formatPhone(own.phone))).toHaveLength(2);
  await expect(card).not.toContainText('დარეკვა');
  await expect(bookings(page).locator('input, textarea, select, [contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('driver-portal-desktop.png'), fullPage: true });
});

test('a multi-hour driver sees shared passengers, only his own whole car at its hour, and assigned hours without orders', async ({ page }) => {
  const exclusive = await seedWhole(DRIVER_B.driverId, '599910113');
  async function regular(phone: string, bookingType: 'passenger' | 'parcel', time = '09:30') {
    const response = await admin.post('/api/admin/bookings', { data: {
      phone, bookingType, seats: bookingType === 'parcel' ? 0 : 2,
      direction: 'gori-tbilisi', goriAddress: `გორი, საერთო რეისის მისამართი ${phone}`, requestedDate: tomorrow(), requestedTime: time,
    } });
    expect(response.status()).toBe(201);
    const booking = await response.json() as Booking;
    bookingIds.push(booking.id);
    return booking;
  }
  const passenger = await regular('599910114', 'passenger');
  const parcel = await regular('599910115', 'parcel');
  const anotherHour = await regular('599910116', 'passenger', '09:00');
  const ownCar = await seedWhole(DRIVER_A.driverId, '599910118', undefined, '14:00');
  const hiddenAtOwnHour = await regular('599910119', 'passenger', '14:00');
  for (const time of ['09:30', '18:00']) {
    const trip = await capacity(tomorrow(), time);
    const assigned = await admin.post('/api/admin/trips/drivers', { data: {
      direction: 'gori-tbilisi', date: tomorrow(), time, expectedRevision: trip.revision,
      action: 'add', driver: { kind: 'roster', id: DRIVER_A.driverId },
    } });
    expect(assigned.status()).toBe(201); assignedDrivers.add(DRIVER_A.driverId);
  }
  expect((await day(tomorrow())).drivers.find(driver => driver.id === DRIVER_A.driverId)?.assignedTimes).toEqual(['09:30', '14:00', '18:00']);
  await openDriver(page);
  await selectedDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
  for (const time of ['09:30', '14:00', '18:00']) await expect(tripTimes(page).getByRole('button', { name: time, exact: true })).toBeVisible();
  await expect(tripTimes(page).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(bookings(page).locator('[data-driver-booking]')).toHaveCount(2);
  await expect(bookedSeats(page)).toHaveText('2');
  await expect(bookings(page).locator('[data-driver-booking-count]')).toHaveText('2');
  for (const booking of [passenger, parcel]) {
    const card = bookings(page).locator(`[data-driver-booking="${booking.id}"]`);
    await expect(card).toContainText(booking.goriAddress);
    await expect(card.locator('a[href^="tel:"]')).toHaveText(formatPhone(booking.phone));
  }
  await expect(bookings(page).locator(`[data-driver-booking="${parcel.id}"]`)).toContainText('გზავნილი');
  for (const booking of [exclusive, anotherHour, ownCar, hiddenAtOwnHour]) await expect(bookings(page).locator(`[data-driver-booking="${booking.id}"]`)).toHaveCount(0);
  const dashboard = await driverApi.get(`/api/driver/dashboard?date=${tomorrow()}`);
  expect(dashboard.ok()).toBeTruthy();
  const data = await dashboard.json() as DriverDashboard;
  expect(data.bookingScope).toBe('mixed');
  expect(data.bookings.map(booking => booking.id)).toEqual([passenger.id, parcel.id, ownCar.id]);
  expect(data.trips?.map(trip => trip.time)).toEqual(['09:30', '14:00', '18:00']);

  await tripTimes(page).getByRole('button', { name: '14:00', exact: true }).click();
  await expect(bookings(page).locator('[data-driver-booking]')).toHaveCount(1);
  await expect(bookings(page).locator(`[data-driver-booking="${ownCar.id}"]`)).toBeVisible();
  await expect(bookedSeats(page)).toHaveText(String(ownCar.seats));
  await expect(bookings(page).locator(`[data-driver-booking="${hiddenAtOwnHour.id}"]`)).toHaveCount(0);
  await page.screenshot({ path: '/tmp/greentaxi-multi-hour-portal.png', fullPage: true });
  await tripTimes(page).getByRole('button', { name: '18:00', exact: true }).click();
  await expect(bookings(page).locator('[data-driver-booking]')).toHaveCount(0);
  await expect(bookedSeats(page)).toHaveText('0');
  await expect(tripTimes(page).getByRole('button', { name: '18:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a driver session cannot read or mutate administrative data or impersonate another driver', async ({ page }) => {
  await openDriver(page);
  const before = await day(tomorrow());
  for (const path of ['/api/admin/bookings', '/api/admin/settings', '/api/admin/staff', '/api/admin/calls']) expect((await page.request.get(path)).status()).toBe(401);
  expect((await page.request.patch(`/api/admin/drivers/${DRIVER_B.driverId}/day`, { data: { direction: 'gori-tbilisi', date: tomorrow(), declined: true } })).status()).toBe(401);
  expect((await page.request.patch(`/api/admin/drivers/${DRIVER_B.driverId}/phone`, { data: { phone: '599920099' } })).status()).toBe(401);
  expect((await page.request.post('/api/admin/bookings/999999/delete', { data: {} })).status()).toBe(401);
  expect((await page.request.patch('/api/driver/attendance', { data: { date: tomorrow(), working: false, driverId: DRIVER_B.driverId } })).status()).toBe(400);
  expect(await day(tomorrow())).toEqual(before);
  expect((await admin.get('/api/driver/dashboard')).status()).toBe(401);
  const other = await otherDriverApi.get(`/api/driver/dashboard?date=${tomorrow()}`);
  expect(other.ok()).toBeTruthy();
});

test('one day selector and trip hours filter cards, retain the chosen hour on refresh and recover when that hour disappears', async ({ page }) => {
  const own = await seedWhole(DRIVER_A.driverId, '599910109');
  const original = await driverApi.get(`/api/driver/dashboard?date=${tomorrow()}`);
  expect(original.ok()).toBeTruthy();
  const dashboard = await original.json() as DriverDashboard;
  const morning = dashboard.bookings.find(booking => booking.id === own.id)!;
  expect(morning).toBeTruthy();
  const noon = { ...morning, id: 900001, bookingType: 'passenger' as const, seats: 3, time: '12:30', phone: '599910110', callerPhone: '+995 599 91 01 99', goriAddress: 'გორი, შუადღის პირველი მისამართი' };
  const noonSecond = { ...noon, id: 900002, seats: 1, phone: '599910111', callerPhone: '+995 599 91 01 11', goriAddress: 'გორი, შუადღის მეორე მისამართი' };
  const noonParcel = { ...noon, id: 900004, bookingType: 'parcel' as const, seats: 0, phone: '599910117', callerPhone: null, goriAddress: 'გორი, შუადღის გზავნილი' };
  const evening = { ...morning, id: 900003, bookingType: 'passenger' as const, seats: 2, callerPhone: null, date: today(), time: '17:00', phone: '599910112', goriAddress: 'გორი, დღევანდელი მისამართი' };
  let withoutNoon = false;
  let empty = false;
  await page.route('**/api/driver/dashboard?**', async route => {
    const date = new URL(route.request().url()).searchParams.get('date');
    const rows = empty ? [] : date === today() ? [evening] : withoutNoon ? [morning] : [morning, noon, noonSecond, noonParcel];
    const times = [...new Set(rows.map(row => row.time))].sort();
    const trips = times.map(time => ({ direction: 'gori-tbilisi' as const, time, active: true }));
    await route.fulfill({ json: { ...dashboard, date, bookings: rows, trips, trip: trips[0] ?? null } });
  });
  await openDriver(page);
  await expect(tripTimes(page).getByRole('button', { name: '17:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(bookings(page).locator('[data-driver-booking]')).toHaveCount(1);
  await expect(bookedSeats(page)).toHaveText('2');
  await selectedDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
  await expect(attendance(page)).toHaveAttribute('data-date', tomorrow());
  await expect(bookings(page)).toHaveAttribute('data-date', tomorrow());
  await expect(tripTimes(page).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(bookedSeats(page)).toHaveText(String(morning.seats));
  await tripTimes(page).getByRole('button', { name: '12:30', exact: true }).click();
  await expect(bookings(page).locator('[data-driver-booking]')).toHaveCount(3);
  await expect(bookedSeats(page)).toHaveText('4');
  await expect(bookings(page).locator('[data-driver-booking-count]')).toHaveText('3');
  for (const booking of [noon, noonSecond, noonParcel]) {
    const card = bookings(page).locator(`[data-driver-booking="${booking.id}"]`);
    await expect(card).toContainText(booking.goriAddress);
    await expect(card).not.toContainText('12:30');
    await expect(card.locator('a[href^="tel:"]')).toHaveText(formatPhone(booking.phone));
    await expect(card.locator('a[href^="tel:"]')).toHaveAttribute('href', `tel:+995${booking.phone}`);
    await expect(card).not.toContainText('დარეკვა');
  }
  const distinctCaller = bookings(page).locator(`[data-driver-booking="${noon.id}"] [data-driver-caller]`);
  await expect(distinctCaller).toContainText(formatPhone(noon.callerPhone));
  await expect(distinctCaller).toContainText('ზარი:');
  for (const booking of [morning, noonSecond, noonParcel]) await expect(bookings(page).locator(`[data-driver-booking="${booking.id}"] [data-driver-caller]`)).toHaveCount(0);
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/driver/dashboard');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect(tripTimes(page).getByRole('button', { name: '12:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(bookings(page).locator('[data-driver-booking]')).toHaveCount(3);
  await expect(bookedSeats(page)).toHaveText('4');
  await selectedDays(page).getByRole('button', { name: 'დღეს', exact: true }).click();
  await expect(attendance(page)).toHaveAttribute('data-date', today());
  await expect(bookings(page)).toHaveAttribute('data-date', today());
  await expect(tripTimes(page).getByRole('button', { name: '17:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(tripTimes(page).getByRole('button', { name: '12:30', exact: true })).toHaveCount(0);
  await expect(bookings(page).locator(`[data-driver-booking="${evening.id}"]`)).toBeVisible();
  await expect(bookedSeats(page)).toHaveText('2');
  await selectedDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
  await expect(tripTimes(page).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await tripTimes(page).getByRole('button', { name: '12:30', exact: true }).click();
  withoutNoon = true;
  await page.getByRole('button', { name: 'ჯავშნების განახლება', exact: true }).click();
  await expect(tripTimes(page).getByRole('button', { name: '12:30', exact: true })).toHaveCount(0);
  await expect(tripTimes(page).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(bookings(page).locator(`[data-driver-booking="${morning.id}"]`)).toBeVisible();
  await expect(bookings(page).locator('[data-driver-booking]')).toHaveCount(1);
  await expect(bookedSeats(page)).toHaveText(String(morning.seats));
  empty = true;
  await page.getByRole('button', { name: 'ჯავშნების განახლება', exact: true }).click();
  await expect(tripTimes(page).getByRole('button')).toHaveCount(0);
  await expect(bookings(page).locator('[data-driver-booking]')).toHaveCount(0);
  await expect(bookedSeats(page)).toHaveText('0');
  await expect(bookings(page).locator('[data-driver-booking-count]')).toHaveText('0');
});

test('a late dashboard response for today cannot replace tomorrow’s bookings', async ({ page }) => {
  const own = await seedWhole(DRIVER_A.driverId, '599910106');
  let release!: () => void; let sawDelayed!: () => void; let finished!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delayed = new Promise<void>(resolve => { sawDelayed = resolve; });
  const completed = new Promise<void>(resolve => { finished = resolve; });
  await page.route('**/api/driver/dashboard?**', async route => {
    if (new URL(route.request().url()).searchParams.get('date') !== today()) return route.continue();
    const response = await route.fetch(); sawDelayed(); await gate;
    try { await route.fulfill({ response }); } finally { finished(); }
  });
  try {
    await openDriver(page); await delayed;
    await selectedDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
    await expect(bookings(page).locator(`[data-driver-booking="${own.id}"]`)).toBeVisible();
    release(); await completed;
    await expect(selectedDays(page).getByRole('button', { name: 'ხვალ', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(bookings(page).locator(`[data-driver-booking="${own.id}"]`)).toBeVisible();
  } finally { release(); }
});

for (const width of [320, 390]) {
  test(`the Georgian driver page has readable cards and large controls at ${width}px`, async ({ page }) => {
    const callerPhone = width === 320 ? '599910207' : '599910208';
    const own = await seedWhole(DRIVER_A.driverId, width === 320 ? '599910107' : '599910108', callerPhone);
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/driver');
    await expect(page.getByRole('heading', { name: 'მძღოლის შესვლა', exact: true })).toBeVisible();
    for (const control of [
      page.getByRole('textbox', { name: 'ტელეფონის ნომერი', exact: true }),
      page.getByRole('button', { name: 'შესვლა', exact: true }),
    ]) {
      const box = await control.boundingBox(); expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(56);
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(await control.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(18);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: `/tmp/driver-phone-login-${width}.png`, fullPage: true });
    await openDriver(page);
    await selectedDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
    const card = bookings(page).locator(`[data-driver-booking="${own.id}"]`);
    await expect(card).toBeVisible();
    for (const control of [
      selectedDays(page).getByRole('button', { name: 'დღეს', exact: true }),
      selectedDays(page).getByRole('button', { name: 'ხვალ', exact: true }),
      tripTimes(page).getByRole('button', { name: '09:30', exact: true }),
    ]) {
      await control.scrollIntoViewIfNeeded(); const box = await control.boundingBox(); expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(56); expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(await control.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(18);
    }
    const workButtons = attendance(page).getByRole('group', { name: 'მონაწილეობა', exact: true }).getByRole('button');
    await expect(workButtons).toHaveCount(2);
    const workLayout = await workButtons.evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      const label = button.querySelector('span')!;
      const style = getComputedStyle(label);
      return { left: rect.left, right: rect.right, top: rect.top, height: rect.height,
        font: parseFloat(style.fontSize), labelHeight: label.getBoundingClientRect().height,
        lineHeight: parseFloat(style.lineHeight), overflow: button.scrollWidth > button.clientWidth + 2 };
    }));
    expect(Math.abs(workLayout[0].top - workLayout[1].top), 'Working and not-working buttons must share one row').toBeLessThanOrEqual(1);
    expect(workLayout[0].right).toBeLessThanOrEqual(workLayout[1].left);
    for (const control of workLayout) {
      expect(control.height).toBeGreaterThanOrEqual(52);
      expect(control.font).toBeGreaterThanOrEqual(16);
      expect(control.left).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(width);
      expect(control.labelHeight, 'The compact work choices must retain complete one-line labels').toBeLessThanOrEqual(control.lineHeight + 1);
      expect(control.overflow).toBe(false);
    }
    const headingFonts = await page.locator('.driver-welcome h1,.driver-section-heading h2').evaluateAll(headings => headings.map(heading => parseFloat(getComputedStyle(heading).fontSize)));
    expect(Math.min(...headingFonts)).toBeGreaterThanOrEqual(18);
    expect(Math.max(...headingFonts), 'Home headings should remain smaller than the main phone action').toBeLessThanOrEqual(20);
    const hour = tripTimes(page).getByRole('button', { name: '09:30', exact: true });
    expect(await hour.evaluate(element => parseFloat(getComputedStyle(element).fontSize)), 'Time digits should stay readable without dominating the phone').toBeLessThanOrEqual(26);
    const phone = card.locator('a[href^="tel:"]');
    await expect(phone).toHaveCount(1);
    await expect(phone).toHaveText(formatPhone(own.phone));
    await expect(phone).toHaveAttribute('href', `tel:+995${own.phone}`);
    const callLayout = await phone.evaluate(element => {
      const card = element.closest<HTMLElement>('[data-driver-booking]')!;
      const style = getComputedStyle(card);
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, font: parseFloat(getComputedStyle(element).fontSize), cardContentWidth: card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), overflows: element.scrollWidth > element.clientWidth + 2 };
    });
    expect(callLayout.height).toBeGreaterThanOrEqual(56);
    expect(callLayout.font).toBeGreaterThanOrEqual(20);
    expect(Math.abs(callLayout.width - callLayout.cardContentWidth), 'The number itself should occupy the broad call button').toBeLessThanOrEqual(2);
    expect(callLayout.overflows).toBe(false);
    await expect(bookedSeats(page)).toHaveText(String(own.seats));
    await expect(bookings(page).locator('[data-driver-booking-count]')).toHaveText('1');
    const caller = card.locator('[data-driver-caller]');
    await expect(caller).toContainText(formatPhone(callerPhone));
    const callerLayout = await caller.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const seats = element.closest('[data-driver-booking]')!.querySelector('[data-driver-booking-seats]')!.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, seatsRight: seats.right,
        seatsTop: seats.top, seatsBottom: seats.bottom, font: parseFloat(getComputedStyle(element).fontSize),
        overflow: element.scrollWidth > element.clientWidth + 2 };
    });
    expect(callerLayout.left, 'The caller number belongs next to the seat badge').toBeGreaterThanOrEqual(callerLayout.seatsRight - 1);
    expect(callerLayout.top).toBeLessThan(callerLayout.seatsBottom);
    expect(callerLayout.bottom).toBeGreaterThan(callerLayout.seatsTop);
    expect(callerLayout.font).toBeGreaterThanOrEqual(14);
    expect(callerLayout.font).toBeLessThanOrEqual(16);
    expect(callerLayout.overflow).toBe(false);
    expect(callerLayout.right).toBeLessThanOrEqual(width);
    await expect(card).not.toContainText('09:30');
    expect((await card.innerText()).split(formatPhone(own.phone))).toHaveLength(2);
    const headingOverlaps = await bookings(page).locator('.driver-orders-heading').evaluate(element => {
      const heading = element.querySelector('h2')!;
      const range = document.createRange(); range.selectNodeContents(heading);
      const text = Array.from(range.getClientRects());
      return Array.from(element.querySelectorAll('[data-driver-booking-count],button')).filter(action => {
        const rect = action.getBoundingClientRect();
        return text.some(line => line.left < rect.right - 1 && line.right > rect.left + 1 && line.top < rect.bottom - 1 && line.bottom > rect.top + 1);
      }).map(action => action.getAttribute('aria-label') || action.textContent?.trim());
    });
    expect(headingOverlaps, 'The Georgian orders heading must not disappear behind the count or refresh button').toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: test.info().outputPath(`driver-portal-${width}.png`), fullPage: true });
    await page.screenshot({ path: `/tmp/greentaxi-driver-app-${width}.png`, fullPage: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/greentaxi-driver-app-${width}-viewport.png` });
  });
}
