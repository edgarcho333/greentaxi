import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createDatabase } from '../server/database';
import { createDriverAccount } from '../server/driver-accounts';
import { addDays, today, type Booking, type DriverSchedule, type TripCapacity, type WholeCarOptions } from '../src/api';
import { operatorSessionPath } from './helpers/operator-session';

// These credentials belong only to the isolated database from playwright.config.ts.
const EMPLOYEE = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const DRIVER_A = { driverId: 41, login: 'driver_browser_a', password: 'test-only-driver-a-password-123' };
const DRIVER_B = { driverId: 42, login: 'driver_browser_b', password: 'test-only-driver-b-password-123' };
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
  // Guard the complete path before opening a database directly. Never fall back
  // to DATABASE_URL, .data/, or a developer/production database.
  const dbPath = info.config.metadata.fixtureDatabasePath;
  expect(typeof dbPath).toBe('string');
  const directory = dirname(resolve(dbPath));
  expect(basename(dbPath)).toBe('greentaxi.sqlite');
  expect(dirname(directory)).toBe(resolve(tmpdir()));
  expect(basename(directory)).toMatch(/^greentaxi-e2e-[^/]+$/);
  expect(dbPath).toBe(join(directory, 'greentaxi.sqlite'));
  if (!process.env.E2E_DATABASE_URL) expect(existsSync(dbPath)).toBeTruthy();
  const database = await createDatabase({ dbPath, databaseUrl: process.env.E2E_DATABASE_URL ?? '', production: false });
  try {
    for (const account of [DRIVER_A, DRIVER_B]) {
      try { await createDriverAccount(database, account); }
      catch (error) {
        // A restarted worker can reuse the two explicit disposable accounts.
        if (!(error instanceof Error) || !['ACCOUNT_EXISTS', 'LOGIN_TAKEN'].includes((error as Error & { code?: string }).code ?? '')) throw error;
      }
    }
  } finally { await database.close(); }
  const sessionPath = operatorSessionPath(dbPath);
  admin = await playwright.request.newContext({ baseURL, ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}) });
  const session = await (await admin.get('/api/auth/session')).json();
  if (!session.user) expect((await admin.post(session.needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: EMPLOYEE })).ok()).toBeTruthy();
  driverName = (await day(today())).drivers.find(driver => driver.id === DRIVER_A.driverId)!.name;
  driverApi = await playwright.request.newContext({ baseURL });
  otherDriverApi = await playwright.request.newContext({ baseURL });
  for (const [context, account] of [[driverApi, DRIVER_A], [otherDriverApi, DRIVER_B]] as const) {
    const response = await context.post('/api/driver/auth/login', { data: { login: account.login, password: account.password } });
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
    if (!driver.assignedTime) continue;
    const trip = await capacity(tomorrow(), driver.assignedTime);
    expect((await admin.post('/api/admin/trips/drivers', { data: {
      direction: 'gori-tbilisi', date: tomorrow(), time: driver.assignedTime, expectedRevision: trip.revision,
      action: 'remove', removeKey: `roster:${id}`,
    } })).ok()).toBeTruthy();
  }
  assignedDrivers.clear();
});
test.afterAll(async () => { await Promise.all([admin?.dispose(), driverApi?.dispose(), otherDriverApi?.dispose()]); });

function attendance(page: Page): Locator { return page.locator('[data-driver-attendance]'); }
function bookings(page: Page): Locator { return page.locator('[data-driver-bookings]'); }
function workDays(page: Page): Locator { return page.getByRole('group', { name: 'სამუშაო დღეები', exact: true }); }
function bookingDays(page: Page): Locator { return page.getByRole('group', { name: 'ჯავშნების დღეები', exact: true }); }
async function openDriver(page: Page) {
  await page.context().addCookies((await driverApi.storageState()).cookies);
  await page.goto('/driver');
  await expect(page.locator('[data-driver-portal]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'მძღოლის გვერდი', exact: true })).toBeVisible();
}
async function setWork(page: Page, date: 'დღეს' | 'ხვალ', value: boolean) {
  await workDays(page).getByRole('button', { name: date, exact: true }).click();
  const button = attendance(page).getByRole('button', { name: value ? 'ვმუშაობ' : 'არ ვმუშაობ', exact: true });
  await expect(button).toBeEnabled();
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/driver/attendance' && response.request().method() === 'PATCH');
  await button.click();
  return await saved;
}
async function seedWhole(driverId: number, phone: string): Promise<Booking> {
  const options = await admin.get(`/api/admin/trips/whole-car-options?direction=gori-tbilisi&date=${tomorrow()}&time=09:30`);
  expect(options.ok()).toBeTruthy();
  const candidate = (await options.json() as WholeCarOptions).drivers.find(driver => driver.key === `roster:${driverId}`)!;
  expect(candidate).toBeTruthy();
  const response = await admin.post('/api/admin/bookings', { data: {
    phone, seats: 1, bookingType: 'whole_car', assignedVehicleKey: candidate.key, expectedVehicleRevision: candidate.revision,
    direction: 'gori-tbilisi', goriAddress: `გორი, მძღოლის სატესტო მისამართი ${phone}`, requestedDate: tomorrow(), requestedTime: '09:30', luggage: true, dog: true,
  } });
  expect(response.status()).toBe(201);
  const result = await response.json() as Booking;
  bookingIds.push(result.id); assignedDrivers.add(driverId);
  return result;
}

test('the driver logs in with a password, keeps his session on reload and loses it after logout', async ({ page }) => {
  await page.goto('/driver');
  await expect(page.getByRole('heading', { name: 'მძღოლის შესვლა', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'მომხმარებლის სახელი', exact: true }).fill(DRIVER_A.login);
  await page.getByLabel('პაროლი', { exact: true }).fill('wrong-local-password');
  await page.getByRole('button', { name: 'შესვლა', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-driver-portal]')).toHaveCount(0);
  await page.getByLabel('პაროლი', { exact: true }).fill(DRIVER_A.password);
  await page.getByRole('button', { name: 'შესვლა', exact: true }).click();
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
  await expect(attendance(page).getByRole('button', { name: 'არ ვმუშაობ', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await day(tomorrow())).drivers.find(driver => driver.id === DRIVER_A.driverId)).toMatchObject({ declined: true, assignedTime: null });
  expect((await day(today())).drivers.find(driver => driver.id === DRIVER_A.driverId)?.declined).toBe(false);
  await page.reload();
  await workDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
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
  await bookingDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
  await expect(bookings(page).locator(`[data-driver-booking="${own.id}"]`)).toBeVisible();
  for (const id of [other.id, deleted.id, waiting.id]) await expect(bookings(page).locator(`[data-driver-booking="${id}"]`)).toHaveCount(0);
  const raw = await driverApi.get(`/api/driver/dashboard?date=${tomorrow()}`);
  expect(raw.ok()).toBeTruthy();
  const text = await raw.text();
  expect(text).toContain(own.phone);
  for (const phone of [other.phone, deleted.phone, '599910105']) expect(text).not.toContain(phone);
  const card = bookings(page).locator(`[data-driver-booking="${own.id}"]`);
  await expect(card).toContainText('09:30'); await expect(card).toContainText(own.goriAddress);
  await expect(card.locator('a[href^="tel:"]')).toBeVisible();
  await expect(bookings(page).locator('input, textarea, select, [contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('driver-portal-desktop.png'), fullPage: true });
});

test('a driver session cannot read or mutate administrative data or impersonate another driver', async ({ page }) => {
  await openDriver(page);
  const before = await day(tomorrow());
  for (const path of ['/api/admin/bookings', '/api/admin/settings', '/api/admin/staff', '/api/admin/calls']) expect((await page.request.get(path)).status()).toBe(401);
  expect((await page.request.patch(`/api/admin/drivers/${DRIVER_B.driverId}/day`, { data: { direction: 'gori-tbilisi', date: tomorrow(), declined: true } })).status()).toBe(401);
  expect((await page.request.post('/api/admin/bookings/999999/delete', { data: {} })).status()).toBe(401);
  expect((await page.request.patch('/api/driver/attendance', { data: { date: tomorrow(), working: false, driverId: DRIVER_B.driverId } })).status()).toBe(400);
  expect(await day(tomorrow())).toEqual(before);
  expect((await admin.get('/api/driver/dashboard')).status()).toBe(401);
  const other = await otherDriverApi.get(`/api/driver/dashboard?date=${tomorrow()}`);
  expect(other.ok()).toBeTruthy();
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
    await bookingDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
    await expect(bookings(page).locator(`[data-driver-booking="${own.id}"]`)).toBeVisible();
    release(); await completed;
    await expect(bookingDays(page).getByRole('button', { name: 'ხვალ', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(bookings(page).locator(`[data-driver-booking="${own.id}"]`)).toBeVisible();
  } finally { release(); }
});

for (const width of [320, 390]) {
  test(`the Georgian driver page has readable cards and large controls at ${width}px`, async ({ page }) => {
    const own = await seedWhole(DRIVER_A.driverId, width === 320 ? '599910107' : '599910108');
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/driver');
    await expect(page.getByRole('heading', { name: 'მძღოლის შესვლა', exact: true })).toBeVisible();
    for (const control of [
      page.getByRole('textbox', { name: 'მომხმარებლის სახელი', exact: true }),
      page.getByLabel('პაროლი', { exact: true }),
      page.getByRole('button', { name: 'შესვლა', exact: true }),
    ]) {
      const box = await control.boundingBox(); expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(56);
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(await control.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(18);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await openDriver(page);
    await bookingDays(page).getByRole('button', { name: 'ხვალ', exact: true }).click();
    const card = bookings(page).locator(`[data-driver-booking="${own.id}"]`);
    await expect(card).toBeVisible();
    for (const control of [
      workDays(page).getByRole('button', { name: 'დღეს', exact: true }),
      workDays(page).getByRole('button', { name: 'ხვალ', exact: true }),
      attendance(page).getByRole('button', { name: 'ვმუშაობ', exact: true }),
      attendance(page).getByRole('button', { name: 'არ ვმუშაობ', exact: true }),
    ]) {
      await control.scrollIntoViewIfNeeded(); const box = await control.boundingBox(); expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(56); expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(await control.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(18);
    }
    await expect(card.locator('a[href^="tel:"]')).toBeVisible();
    expect(await card.locator('a[href^="tel:"]').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(18);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: test.info().outputPath(`driver-portal-${width}.png`), fullPage: true });
  });
}
