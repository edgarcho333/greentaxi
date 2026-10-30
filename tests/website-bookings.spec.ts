import { test as base, expect, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { addDays, directions, today, type Booking, type Direction, type DriverSchedule, type PublicConfig, type Schedule, type TripCapacity } from '../src/api';
import { operatorSessionPath } from './helpers/operator-session';
import { formatPhone } from '../shared/phone';

// Playwright supplies a disposable local database. Never use production orders.
const EMPLOYEE = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'Website inbox must not throw browser runtime errors').toEqual([]);
  }, { auto: true }],
});
let api: APIRequestContext;
let config: PublicConfig;
let sequence = 0;
const bookingIds: number[] = [];
const inquiryIds: number[] = [];
const changedDrivers = new Set<number>();
let restoreSchedule: Schedule | null = null;
const travelDate = () => addDays(today(), 1);

test.beforeAll(async ({ playwright, baseURL }, info) => {
  const sessionPath = operatorSessionPath(info.config.metadata.fixtureDatabasePath);
  api = await playwright.request.newContext({ baseURL, ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}) });
  const session = await (await api.get('/api/auth/session')).json();
  if (session.user?.login !== EMPLOYEE.login) expect((await api.post(session.needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: EMPLOYEE })).ok()).toBeTruthy();
  writeFileSync(sessionPath, JSON.stringify(await api.storageState()), { mode: 0o600 });
  chmodSync(sessionPath, 0o600);
  config = await (await api.get('/api/public/config')).json() as PublicConfig;
});
test.afterEach(async () => {
  for (const id of inquiryIds.splice(0)) expect((await api.post(`/api/admin/calls/${id}/delete`)).ok()).toBeTruthy();
  for (const id of new Set(bookingIds.splice(0))) expect((await api.post(`/api/admin/bookings/${id}/delete`)).ok()).toBeTruthy();
  for (const id of changedDrivers) {
    expect((await api.patch(`/api/admin/drivers/${id}/day`, { data: { direction: 'gori-tbilisi', date: travelDate(), declined: false } })).ok()).toBeTruthy();
    const driver = (await driverDay()).drivers.find(item => item.id === id)!;
    for (const time of driver.assignedTimes ?? (driver.assignedTime ? [driver.assignedTime] : [])) {
      const trip = await capacity(time);
      expect((await api.post('/api/admin/trips/drivers', { data: {
        direction: 'gori-tbilisi', date: travelDate(), time, expectedRevision: trip.revision, action: 'remove', removeKey: `roster:${id}`,
      } })).ok()).toBeTruthy();
    }
  }
  changedDrivers.clear();
  if (restoreSchedule) {
    const params = new URLSearchParams({ direction: restoreSchedule.direction, date: restoreSchedule.date });
    const response = restoreSchedule.overrideTimes === null
      ? await api.delete(`/api/admin/schedule/date?${params}`)
      : await api.put('/api/admin/schedule/date', { data: { direction: restoreSchedule.direction, date: restoreSchedule.date, times: restoreSchedule.overrideTimes } });
    expect(response.ok()).toBeTruthy();
    restoreSchedule = null;
  }
});
test.afterAll(async () => { await api?.dispose(); });

function dialog(page: Page): Locator { return page.locator('[data-website-bookings-dialog]'); }
function editor(page: Page): Locator { return page.locator('[data-website-booking-editor]'); }
function card(page: Page, id: number): Locator { return dialog(page).locator(`[data-website-booking-id="${id}"]`); }
function services(page: Page): Locator { return editor(page).getByRole('group', { name: 'დამატებითი სერვისები', exact: true }); }
function mutation(response: Response, id: number, action = '', method = action ? 'POST' : 'PATCH'): boolean {
  return new URL(response.url()).pathname === `/api/admin/website-bookings/${id}${action ? `/${action}` : ''}` && response.request().method() === method;
}
async function stored(id: number, deleted = false): Promise<Booking> {
  const result = await (await api.get(`/api/admin/bookings?scope=${deleted ? 'deleted' : 'all'}`)).json() as { bookings: Booking[] };
  const booking = result.bookings.find(item => item.id === id);
  expect(booking).toBeTruthy();
  return booking!;
}
async function seed(direction: Direction = 'gori-tbilisi', time = '09:30'): Promise<Booking> {
  const phone = `59993${String(++sequence).padStart(4, '0')}`;
  const result = await api.post('/api/bookings', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: {
    name: 'საიტის სატესტო მგზავრი', phone, seats: 2, direction,
    goriAddress: `ვერხვების კოტეჯი, საიტის ტესტი ${sequence}`, requestedDate: travelDate(), requestedTime: time,
    ...(direction === 'tbilisi-gori' ? { pickupStopId: config.stops.find(stop => stop.active)!.id } : {}),
  } });
  expect(result.status()).toBe(201);
  const { id } = await result.json() as { id: number };
  bookingIds.push(id);
  return stored(id);
}
async function driverDay(): Promise<DriverSchedule> {
  const response = await api.get(`/api/admin/drivers/schedule?direction=gori-tbilisi&date=${travelDate()}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as DriverSchedule;
}
async function capacity(time: string): Promise<TripCapacity> {
  const response = await api.get(`/api/admin/trips/capacity?direction=gori-tbilisi&date=${travelDate()}&time=${time}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as TripCapacity;
}
async function openAdmin(page: Page): Promise<void> {
  await page.context().addCookies((await api.storageState()).cookies);
  await page.goto('/admin');
  await expect(page.locator('.auth-card')).toHaveCount(0);
  await expect(page.locator('[data-website-bookings-trigger]').first()).toBeVisible();
}
async function openInbox(page: Page): Promise<void> {
  await openAdmin(page);
  await page.locator('[data-website-bookings-trigger]').first().click();
  await expect(dialog(page)).toBeVisible();
}
async function edit(page: Page, booking: Booking): Promise<void> {
  await card(page, booking.id).getByRole('button', { name: 'რედაქტირება', exact: true }).click();
  await expect(editor(page)).toBeVisible();
}
async function save(page: Page, booking: Booking): Promise<Booking> {
  const saved = page.waitForResponse(response => mutation(response, booking.id));
  await editor(page).getByRole('button', { name: 'შენახვა', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const result = await response.json() as Booking;
  await expect(editor(page)).toHaveCount(0);
  return result;
}
async function confirm(page: Page, booking: Booking): Promise<Booking> {
  const confirmed = page.waitForResponse(response => mutation(response, booking.id, 'confirm'));
  await card(page, booking.id).getByRole('button', { name: 'დადასტურება', exact: true }).click();
  const response = await confirmed;
  expect(response.status()).toBe(200);
  await expect(card(page, booking.id)).toHaveCount(0);
  return await response.json() as Booking;
}

test('website requests stay out of the familiar calls queue and the editor opens only on Edit', async ({ page }) => {
  const gori = await seed();
  const tbilisi = await seed('tbilisi-gori', '14:00');
  const device = await api.post('/api/admin/devices', { data: { name: 'Website queue separation fixture' } });
  expect(device.status()).toBe(201);
  const { token } = await device.json() as { token: string };
  const incoming = await api.post('/api/integrations/android/calls', { headers: { Authorization: `Bearer ${token}` }, data: {
    eventId: `website-queue-${crypto.randomUUID()}`, kind: 'incoming', phase: 'answered', phone: '+995599939999', occurredAt: new Date().toISOString(), durationSeconds: 0,
  } });
  expect(incoming.status()).toBe(201);
  const { id: callId } = await incoming.json() as { id: number };
  inquiryIds.push(callId);
  const counts = await (await api.get('/api/admin/incoming-counts')).json() as { calls: number; website: number };
  expect(counts.website).toBeGreaterThanOrEqual(2);
  await openAdmin(page);
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true }).getByRole('button', { name: 'შემოსული', exact: true }).click();
  await expect(page.locator(`[data-call-id="${callId}"]`)).toBeVisible();
  await expect(page.locator(`.admin-booking-table [data-booking-id="${gori.id}"]`)).toHaveCount(0);
  await expect(page.locator(`.admin-booking-table [data-booking-id="${tbilisi.id}"]`)).toHaveCount(0);
  await expect(page.locator('[data-website-bookings-trigger]').first()).toContainText(String(counts.website));
  await page.locator('[data-website-bookings-trigger]').first().click();
  await expect(card(page, gori.id)).toBeVisible();
  await expect(card(page, tbilisi.id)).toBeVisible();
  await expect(editor(page)).toHaveCount(0);
  await page.screenshot({ path: '/tmp/greentaxi-website-inbox-list.png', fullPage: true });
  await edit(page, gori);
  await page.screenshot({ path: '/tmp/greentaxi-website-inbox-editor.png', fullPage: true });
  await expect(editor(page).getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(formatPhone(gori.phone));
});

test('full editing preserves the waiting request until separate confirmation', async ({ page }) => {
  const booking = await seed();
  await openInbox(page);
  await edit(page, booking);
  await editor(page).getByRole('button', { name: directions['tbilisi-gori'], exact: true }).click();
  await editor(page).getByRole('combobox', { name: 'თბილისის გაჩერება', exact: true }).selectOption(String(config.stops.find(stop => stop.active)!.id));
  await editor(page).getByRole('combobox', { name: 'დრო', exact: true }).selectOption('14:00');
  await editor(page).getByLabel('ტელეფონის ნომერი', { exact: true }).fill('598930001');
  await editor(page).getByLabel('ზარის ნომერი', { exact: true }).fill('598930099');
  await editor(page).getByRole('textbox', { name: 'ჩამოსვლის მისამართი გორში', exact: true }).fill('გორი, დამოუკიდებლობის ქუჩა 25');
  await services(page).getByRole('button', { name: 'ბარგი', exact: true }).click();
  await services(page).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await editor(page).getByRole('button', { name: '3 ადგილი', exact: true }).click();
  await expect(editor(page).getByRole('combobox', { name: 'დრო', exact: true })).toHaveValue('14:00');
  await expect(editor(page).getByLabel('თარიღი', { exact: true })).toHaveValue(travelDate());
  const saved = await save(page, booking);
  expect(saved).toMatchObject({ status: 'waiting', assignedDate: null, assignedTime: null, direction: 'tbilisi-gori', phone: '598930001', callerPhone: '598930099', seats: 3, luggage: true, dog: true, requestedTime: '14:00', goriAddress: 'გორი, დამოუკიდებლობის ქუჩა 25' });
  expect((await stored(booking.id)).status).toBe('waiting');
  const confirmed = await confirm(page, saved);
  expect(confirmed).toMatchObject({ status: 'confirmed', assignedDate: travelDate(), assignedTime: '14:00', direction: 'tbilisi-gori', seats: 3 });
  expect((await stored(booking.id)).status).toBe('confirmed');
});

test('a parcel has zero seats and confirmation adds no occupied passenger seats', async ({ page }) => {
  const booking = await seed();
  const before = await capacity('09:30');
  await openInbox(page);
  await edit(page, booking);
  await services(page).getByRole('button', { name: 'გზავნილი', exact: true }).click();
  await expect(editor(page).getByRole('group', { name: 'ადგილების რაოდენობა', exact: true })).toHaveCount(0);
  await expect(editor(page).getByRole('group', { name: 'სასურველი ადგილი', exact: true })).toHaveCount(0);
  const saved = await save(page, booking);
  expect(saved).toMatchObject({ bookingType: 'parcel', seats: 0, status: 'waiting' });
  expect((await capacity('09:30')).bookedSeats).toBe(before.bookedSeats);
  expect(await confirm(page, saved)).toMatchObject({ bookingType: 'parcel', seats: 0, status: 'confirmed' });
  expect((await capacity('09:30')).bookedSeats).toBe(before.bookedSeats);
});

test('editing a whole-car request does not activate or reserve its driver before confirmation', async ({ page }) => {
  const booking = await seed('gori-tbilisi', '14:00');
  const driver = (await driverDay()).drivers.find(item => !item.declined && !(item.assignedTimes?.length || item.assignedTime));
  expect(driver).toBeTruthy();
  changedDrivers.add(driver!.id);
  expect((await api.patch(`/api/admin/drivers/${driver!.id}/day`, { data: { direction: 'gori-tbilisi', date: travelDate(), declined: true } })).ok()).toBeTruthy();
  await openInbox(page);
  await edit(page, booking);
  await services(page).getByRole('button', { name: 'მთლიანი მანქანა', exact: true }).click();
  await expect(editor(page).getByRole('group', { name: 'ადგილების რაოდენობა', exact: true })).toHaveCount(0);
  await editor(page).getByRole('button', { name: 'დანიშნული მანქანა', exact: true }).click();
  const picker = page.locator('[data-whole-car-dialog]');
  await expect(picker).toBeVisible();
  await picker.locator(`[data-whole-car-driver="roster:${driver!.id}"]`).click();
  await picker.locator('[data-whole-car-activation-confirm]').click();
  await expect(picker).toHaveCount(0);
  const saved = await save(page, booking);
  expect(saved).toMatchObject({ bookingType: 'whole_car', status: 'waiting', seats: driver!.capacity, assignedVehicleKey: `roster:${driver!.id}` });
  expect((await driverDay()).drivers.find(item => item.id === driver!.id)).toMatchObject({ declined: true, assignedTime: null });
  expect((await capacity('14:00')).drivers.some(car => car.driverId === driver!.id)).toBe(false);
  const confirmed = await confirm(page, saved);
  expect(confirmed).toMatchObject({ status: 'confirmed', assignedVehicleKey: `roster:${driver!.id}`, seats: driver!.capacity });
  expect((await driverDay()).drivers.find(item => item.id === driver!.id)).toMatchObject({ declined: false, assignedTimes: ['14:00'] });
  expect((await capacity('14:00')).drivers.find(car => car.driverId === driver!.id)).toMatchObject({ reservedBookingId: booking.id, freeSeats: 0 });
});

test('another administrator editing the request cannot silently overwrite this draft', async ({ page }) => {
  const booking = await seed();
  await openInbox(page);
  await edit(page, booking);
  const address = editor(page).getByRole('textbox', { name: 'აყვანის მისამართი გორში', exact: true });
  await address.fill('ჩემი ჯერ შეუნახავი მისამართი');
  const changed = await api.patch(`/api/admin/website-bookings/${booking.id}`, { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: {
    expectedUpdatedAt: booking.updatedAt, goriAddress: 'სხვა ადმინისტრატორის შენახული მისამართი',
  } });
  expect(changed.status()).toBe(200);
  const conflict = page.waitForResponse(response => mutation(response, booking.id));
  await editor(page).getByRole('button', { name: 'შენახვა', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(address).toHaveValue('ჩემი ჯერ შეუნახავი მისამართი');
  await expect(editor(page).locator('[data-website-booking-reload]')).toBeVisible();
  await editor(page).locator('[data-website-booking-reload]').click();
  await expect(address).toHaveValue('სხვა ადმინისტრატორის შენახული მისამართი');
  expect((await stored(booking.id)).goriAddress).toBe('სხვა ადმინისტრატორის შენახული მისამართი');
});

test('rejection asks for confirmation and removes only the chosen waiting request', async ({ page }) => {
  const first = await seed();
  const second = await seed();
  await openInbox(page);
  await card(page, first.id).getByRole('button', { name: 'უარი', exact: true }).click();
  await expect(card(page, first.id).locator('[data-website-booking-reject-confirm]')).toBeVisible();
  expect((await stored(first.id)).deletedAt).toBeNull();
  const rejected = page.waitForResponse(response => mutation(response, first.id, 'reject'));
  await card(page, first.id).locator('[data-website-booking-reject-confirm]').click();
  expect((await rejected).status()).toBe(200);
  await expect(card(page, first.id)).toHaveCount(0);
  await expect(card(page, second.id)).toBeVisible();
  expect((await stored(first.id, true)).deletedAt).not.toBeNull();
  expect((await stored(second.id)).status).toBe('waiting');
});

test('the inbox and edit form fit a narrow screen without showing the editor automatically', async ({ page }) => {
  const booking = await seed();
  await page.setViewportSize({ width: 360, height: 800 });
  await openInbox(page);
  await expect(editor(page)).toHaveCount(0);
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await edit(page, booking);
  await expect(editor(page).getByLabel('ტელეფონის ნომერი', { exact: true })).toBeVisible();
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '/tmp/greentaxi-website-inbox-mobile.png', fullPage: true });
});

test('an unavailable departure remains waiting until the administrator explicitly edits it', async ({ page }) => {
  const booking = await seed();
  restoreSchedule = await (await api.get(`/api/admin/schedule?direction=gori-tbilisi&date=${travelDate()}`)).json() as Schedule;
  const times = restoreSchedule.slots.filter(slot => slot.active && slot.time !== '09:30').map(slot => slot.time);
  expect(times).toContain('14:00');
  expect((await api.put('/api/admin/schedule/date', { data: { direction: 'gori-tbilisi', date: travelDate(), times } })).ok()).toBeTruthy();
  await openInbox(page);
  const rejected = page.waitForResponse(response => mutation(response, booking.id, 'confirm'));
  await card(page, booking.id).getByRole('button', { name: 'დადასტურება', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(card(page, booking.id)).toBeVisible();
  await expect(editor(page)).toHaveCount(0);
  expect((await stored(booking.id)).status).toBe('waiting');
  await edit(page, booking);
  await editor(page).getByRole('combobox', { name: 'დრო', exact: true }).selectOption('14:00');
  const saved = await save(page, booking);
  expect(saved).toMatchObject({ requestedTime: '14:00', status: 'waiting' });
  expect(await confirm(page, saved)).toMatchObject({ assignedTime: '14:00', status: 'confirmed' });
});

test('a lost save reply retries the exact same mutation without losing or duplicating the edit', async ({ page }) => {
  const booking = await seed();
  await openInbox(page);
  await edit(page, booking);
  const address = editor(page).getByRole('textbox', { name: 'აყვანის მისამართი გორში', exact: true });
  await address.fill('ქუჩა 17, პასუხის დაკარგვის ტესტი');
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let lost = false;
  await page.route(`**/api/admin/website-bookings/${booking.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    if (!lost) {
      lost = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  await editor(page).getByRole('button', { name: 'შენახვა', exact: true }).click();
  const retry = dialog(page).locator('[data-website-booking-retry]');
  await expect(retry).toBeVisible();
  await expect(address).toBeDisabled();
  expect((await stored(booking.id)).goriAddress).toBe('ქუჩა 17, პასუხის დაკარგვის ტესტი');
  const saved = page.waitForResponse(response => mutation(response, booking.id));
  await retry.click();
  expect((await saved).status()).toBe(200);
  await expect(editor(page)).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await stored(booking.id)).status).toBe('waiting');
});
