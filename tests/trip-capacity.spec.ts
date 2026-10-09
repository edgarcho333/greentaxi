import { test as base, expect, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Booking, DriverSchedule, TripCapacity } from '../src/api';
import { createDatabase } from '../server/database';

// All specs share one disposable server. Reuse its employee if a worker restarts.
const EMPLOYEE = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'Trip capacity controls should not throw browser runtime errors').toEqual([]);
  }, { auto: true }],
});
let adminApi: APIRequestContext;
let phoneSequence = 0;

test.beforeAll(async ({ playwright, baseURL }) => {
  adminApi = await playwright.request.newContext({ baseURL });
  const session = await adminApi.get('/api/auth/session');
  expect(session.ok()).toBeTruthy();
  const { needsSetup } = await session.json() as { needsSetup: boolean };
  const auth = await adminApi.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: EMPLOYEE });
  expect(auth.ok()).toBeTruthy();
});
test.afterAll(async () => { await adminApi?.dispose(); });

function tomorrow(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  const day = new Date(`${part('year')}-${part('month')}-${part('day')}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function capacityPanel(page: Page): Locator { return page.locator('.admin-trip-capacity'); }
function car(page: Page, key: string): Locator { return capacityPanel(page).locator(`[data-trip-driver="${key}"]`); }
function stat(page: Page, label: string): Locator {
  return capacityPanel(page).locator('.admin-trip-capacity-stat').filter({ hasText: label }).locator('strong');
}
async function capacity(date: string, time = '09:00'): Promise<TripCapacity> {
  const response = await adminApi.get(`/api/admin/trips/capacity?${new URLSearchParams({ direction: 'gori-tbilisi', date, time })}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as TripCapacity;
}
async function driverDay(date: string): Promise<DriverSchedule> {
  const response = await adminApi.get(`/api/admin/drivers/schedule?direction=gori-tbilisi&date=${date}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as DriverSchedule;
}
async function fixtureDay(date: string, times = ['09:00', '10:00']): Promise<TripCapacity> {
  const saved = await adminApi.put('/api/admin/schedule/date', { data: { direction: 'gori-tbilisi', date, times } });
  expect(saved.ok()).toBeTruthy();
  const initial = await driverDay(date);
  // Limit just this synthetic date to two provided seven-seat cars. Global queue,
  // attendance and other dates retain their normal rotating schedule.
  for (const driver of initial.drivers.filter(value => value.assignmentActive || [1, 2].includes(value.id))) {
    const result = await adminApi.patch(`/api/admin/drivers/${driver.id}/day`, { data: {
      direction: 'gori-tbilisi', date, declined: false,
      assignment: { mode: 'manual', time: [1, 2].includes(driver.id) ? '09:00' : null },
    } });
    expect(result.ok()).toBeTruthy();
  }
  const result = await capacity(date);
  expect(result.totalSeats).toBe(14);
  expect(result.drivers.map(driver => driver.driverId).sort((left, right) => left! - right!)).toEqual([1, 2]);
  return result;
}

async function seedTripSeats(date: string, seats: number[], options: { time?: string; differentRequestedDate?: boolean } = {}): Promise<Booking[]> {
  const bookings: Booking[] = [];
  for (const count of seats) {
    const phone = `55586${String(++phoneSequence).padStart(4, '0')}`;
    const response = await adminApi.post('/api/admin/bookings', { data: {
      phone, seats: count, direction: 'gori-tbilisi', goriAddress: `ტესტის მისამართი ${phoneSequence}`,
      requestedDate: tomorrow(), requestedTime: '21:00',
    } });
    expect(response.ok()).toBeTruthy();
    bookings.push(await response.json() as Booking);
  }
  // Represent existing assigned trips on isolated synthetic days without changing
  // the two-day rule for ordinary employee booking forms. Guard the disposable DB.
  const dbPath = test.info().config.metadata.fixtureDatabasePath;
  expect(typeof dbPath).toBe('string');
  expect(basename(dbPath)).toBe('greentaxi.sqlite');
  const directory = dirname(resolve(dbPath));
  expect(dirname(directory)).toBe(resolve(tmpdir()));
  expect(basename(directory)).toMatch(/^greentaxi-e2e-[^/]+$/);
  expect(dbPath).toBe(join(directory, 'greentaxi.sqlite'));
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) expect(existsSync(dbPath)).toBeTruthy();
  const database = await createDatabase({ dbPath, databaseUrl, production: false });
  try {
    for (const [index, booking] of bookings.entries()) {
      const requested = index === 0 && options.differentRequestedDate ? tomorrow() : date;
      const changed = await database.prepare("UPDATE bookings SET requested_date=?,requested_time=?,assigned_date=?,assigned_time=? WHERE id=? AND status='confirmed' AND source='employee'")
        .run(requested, options.time ?? '09:00', date, options.time ?? '09:00', booking.id);
      expect(changed.changes).toBe(1);
    }
  } finally { await database.close(); }
  return bookings;
}

async function openTrip(page: Page, date: string, time = '09:00') {
  await page.context().addCookies((await adminApi.storageState()).cookies);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'ჯავშნები', exact: true })).toBeVisible();
  await page.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true }).fill(date);
  await chooseTime(page, time);
  await expect(capacityPanel(page)).toHaveAttribute('data-trip-date', date);
  await expect(capacityPanel(page)).toHaveAttribute('data-trip-time', time);
}
async function chooseTime(page: Page, time: string) {
  await page.locator('.admin-time-strip').getByRole('button', { name: new RegExp(`^${time}\\s`) }).click();
}
function isDriverMutation(response: Response): boolean {
  return new URL(response.url()).pathname === '/api/admin/trips/drivers' && response.request().method() === 'POST';
}
async function expectCounts(page: Page, total: number, booked: number, free: number) {
  await expect(stat(page, 'სულ')).toHaveText(String(total));
  await expect(stat(page, 'დაკავებული')).toHaveText(String(booked));
  await expect(stat(page, 'თავისუფალი')).toHaveText(String(free));
}

async function manage(page: Page) {
  const toggle = capacityPanel(page).getByRole('button', { name: 'მძღოლების მართვა', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
async function temporaryEditor(page: Page, name: string, seats: number, replaces?: string) {
  await manage(page);
  if (replaces) await capacityPanel(page).getByRole('button', { name: `${replaces} — რეისის მძღოლის შეცვლა`, exact: true }).click();
  else await capacityPanel(page).getByRole('button', { name: 'მძღოლის დამატება', exact: true }).click();
  await capacityPanel(page).getByRole('button', { name: 'სხვა მძღოლი', exact: true }).click();
  await capacityPanel(page).getByRole('textbox', { name: 'სხვა მძღოლის სახელი', exact: true }).fill(name);
  await capacityPanel(page).getByRole('combobox', { name: 'სხვა მძღოლის ადგილები', exact: true }).selectOption(String(seats));
}
async function submitEditor(page: Page, action: 'add' | 'replace' = 'add'): Promise<TripCapacity> {
  const saved = page.waitForResponse(isDriverMutation);
  await capacityPanel(page).getByRole('button', { name: action === 'replace' ? 'შეცვლა' : 'დამატება', exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  return await response.json() as TripCapacity;
}
async function removeCar(page: Page, name: string): Promise<TripCapacity> {
  await manage(page);
  const saved = page.waitForResponse(isDriverMutation);
  await capacityPanel(page).getByRole('button', { name: `${name} — ამ რეისიდან მოხსნა`, exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  return await response.json() as TripCapacity;
}

test('two seven-seat cars show ten occupied seats as seven plus three and exclude waiting/deleted orders', async ({ page }) => {
  const date = '2040-06-01';
  await fixtureDay(date);
  await seedTripSeats(date, [8, 2], { differentRequestedDate: true });
  const [deleted] = await seedTripSeats(date, [8]);
  expect((await adminApi.post(`/api/admin/bookings/${deleted.id}/delete`)).ok()).toBeTruthy();
  const waiting = await adminApi.post('/api/bookings', { data: {
    name: 'დასადასტურებელი სატესტო მგზავრი', phone: '555860099', seats: 4,
    direction: 'gori-tbilisi', goriAddress: 'ტესტის მისამართი 99', requestedDate: date, requestedTime: '09:00',
  } });
  expect(waiting.ok()).toBeTruthy();
  await openTrip(page, date);
  await expectCounts(page, 14, 10, 4);
  const actual = await capacity(date);
  expect(actual).toMatchObject({ bookingCount: 2, bookedSeats: 10, totalSeats: 14, freeSeats: 4, uncoveredSeats: 0 });
  for (const [index, driver] of actual.drivers.entries()) {
    const card = car(page, driver.key);
    await expect(card.getByRole('img', { name: `${driver.name}: ${index === 0 ? 7 : 3} დაკავებული, ${index === 0 ? 0 : 4} თავისუფალი ადგილი`, exact: true })).toBeVisible();
    await expect(card.locator('.admin-trip-capacity-seat')).toHaveCount(7);
    await expect(card.locator('.admin-trip-capacity-seat.filled')).toHaveCount(index === 0 ? 7 : 3);
    await expect(card).toHaveClass(index === 0 ? /\bfull\b/ : /admin-trip-capacity-car/);
  }
  await expect(capacityPanel(page).locator('[data-driver-uncovered]')).toHaveCount(0);
});

test('capacity counts every assigned seat while the operator pages and searches the orders', async ({ page }) => {
  const date = '2040-06-02';
  await fixtureDay(date);
  const bookings = await seedTripSeats(date, Array.from({ length: 16 }, (_, index) => index % 4 + 1));
  await openTrip(page, date);
  await expectCounts(page, 14, 40, 0);
  await expect(capacityPanel(page).locator('[data-trip-uncovered]')).toHaveText('26');
  await expect(page.locator('.admin-booking-table tbody tr[data-booking-id]')).toHaveCount(15);
  await page.getByRole('button', { name: 'შემდეგი გვერდი', exact: true }).click();
  await expect(page.locator('.admin-booking-table tbody tr[data-booking-id]')).toHaveCount(1);
  await expectCounts(page, 14, 40, 0);
  const searched = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/bookings' && url.searchParams.get('search') === bookings[0].phone;
  });
  await page.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true }).fill(bookings[0].phone);
  expect((await searched).ok()).toBeTruthy();
  await expect(page.locator('.admin-booking-table tbody tr[data-booking-id]')).toHaveCount(1);
  await expect(page.locator(`tr[data-booking-id="${bookings[0].id}"]`)).toBeVisible();
  await expectCounts(page, 14, 40, 0);
  await expect(capacityPanel(page).locator('[data-trip-uncovered]')).toHaveText('26');
  await expect(car(page, 'roster:1').locator('.admin-trip-capacity-seat.filled')).toHaveCount(7);
  await expect(car(page, 'roster:2').locator('.admin-trip-capacity-seat.filled')).toHaveCount(7);
});

test('removing a car exposes uncovered seats, and a temporary replacement stays on this trip only', async ({ page }) => {
  const date = '2040-06-03';
  const nextDate = '2040-06-04';
  await fixtureDay(date);
  const tomorrowQueue = await driverDay(nextDate);
  await seedTripSeats(date, [8, 2]);
  await openTrip(page, date);
  const removed = await removeCar(page, 'რეზო');
  expect(removed).toMatchObject({ totalSeats: 7, bookedSeats: 10, freeSeats: 0, uncoveredSeats: 3 });
  await expectCounts(page, 7, 10, 0);
  await expect(capacityPanel(page).locator('[data-trip-uncovered]')).toHaveText('3');
  const uncovered = capacityPanel(page).locator('[data-driver-uncovered]');
  await expect(uncovered.locator('.admin-trip-capacity-seat')).toHaveCount(3);
  await expect(uncovered.locator('.admin-trip-capacity-seat.filled')).toHaveCount(0);
  const rezo = (await driverDay(date)).drivers.find(driver => driver.id === 1)!;
  expect(rezo).toMatchObject({ declined: false, assignmentMode: 'manual', assignedTime: null });

  await temporaryEditor(page, 'სატესტო შემცვლელი', 8);
  const added = await submitEditor(page);
  const temporary = added.drivers.find(driver => driver.kind === 'temporary')!;
  expect(temporary).toMatchObject({ name: 'სატესტო შემცვლელი', capacity: 8, filledSeats: 3, freeSeats: 5 });
  await expectCounts(page, 15, 10, 5);
  await expect(car(page, temporary.key)).toContainText('სატესტო შემცვლელი');
  await expect(capacityPanel(page).locator('[data-trip-uncovered]')).toHaveCount(0);
  await page.reload();
  await page.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true }).fill(date);
  await chooseTime(page, '09:00');
  await expectCounts(page, 15, 10, 5);
  await expect(car(page, temporary.key)).toBeVisible();

  await temporaryEditor(page, 'მეორე სატესტო შემცვლელი', 6, 'სატესტო შემცვლელი');
  const replaced = await submitEditor(page, 'replace');
  expect(replaced.drivers.filter(driver => driver.kind === 'temporary')).toHaveLength(1);
  expect(replaced.drivers.find(driver => driver.kind === 'temporary')).toMatchObject({ name: 'მეორე სატესტო შემცვლელი', capacity: 6 });
  await expectCounts(page, 13, 10, 3);
  await expect(car(page, temporary.key)).toHaveCount(0);
  expect((await capacity(date, '10:00')).drivers.some(driver => driver.kind === 'temporary')).toBe(false);
  expect(await driverDay(nextDate)).toEqual(tomorrowQueue);
  expect((await driverDay(date)).drivers).toHaveLength(43);
});

test('replacing a roster driver preserves other automatic departures and reserves the removed car', async ({ page }) => {
  const date = '2040-06-05';
  const saved = await adminApi.put('/api/admin/schedule/date', { data: { direction: 'gori-tbilisi', date, times: ['09:00', '10:00', '11:00'] } });
  expect(saved.ok()).toBeTruthy();
  const initial = await driverDay(date);
  const first = initial.drivers.find(driver => driver.assignedTime === '09:00')!;
  const second = initial.drivers.find(driver => driver.assignedTime === '10:00')!;
  const third = initial.drivers.find(driver => driver.assignedTime === '11:00')!;
  const reserve = initial.drivers.find(driver => driver.assignedTime === null && driver.capacity === 7)!;
  await openTrip(page, date);
  await manage(page);
  await capacityPanel(page).getByRole('button', { name: `${first.name} — რეისის მძღოლის შეცვლა`, exact: true }).click();
  await capacityPanel(page).getByRole('combobox', { name: 'რეისზე დასამატებელი მძღოლი', exact: true }).selectOption(String(reserve.id));
  const changed = await submitEditor(page, 'replace');
  expect(changed.drivers.map(driver => driver.driverId)).toEqual([reserve.id]);
  await expect(car(page, `roster:${reserve.id}`)).toContainText(reserve.name);
  const after = await driverDay(date);
  expect(after.drivers.find(driver => driver.id === first.id)).toMatchObject({ declined: false, assignmentMode: 'manual', assignedTime: null });
  for (const retained of [second, third]) expect(after.drivers.find(driver => driver.id === retained.id)).toEqual(retained);
});

test('a concurrent driver change rejects a stale edit, refreshes the trip and keeps the operator’s draft', async ({ page }) => {
  const date = '2040-06-06';
  await fixtureDay(date);
  await openTrip(page, date);
  await expectCounts(page, 14, 0, 14);
  await temporaryEditor(page, 'შენარჩუნებული სატესტო არჩევანი', 6);
  let writes = 0;
  await page.route('**/api/admin/trips/drivers', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    writes++;
    if (writes === 1) {
      // Another authenticated operator changes the plan only after this browser
      // has submitted its original revision. This exercises a real backend 409.
      const latest = await capacity(date);
      const other = await adminApi.post('/api/admin/trips/drivers', { data: {
        direction: 'gori-tbilisi', date, time: '09:00', expectedRevision: latest.revision,
        action: 'add', driver: { kind: 'temporary', name: 'სხვა ოპერატორის მანქანა', capacity: 7 },
      } });
      expect(other.ok()).toBeTruthy();
    }
    await route.continue();
  });
  const rejected = page.waitForResponse(isDriverMutation);
  await capacityPanel(page).getByRole('button', { name: 'დამატება', exact: true }).click();
  const failed = await rejected;
  expect(failed.status()).toBe(409);
  expect(await failed.json()).toMatchObject({ code: 'TRIP_CHANGED' });
  await expect(capacityPanel(page).getByRole('alert')).toContainText('სხვა ოპერატორმა');
  await expectCounts(page, 21, 0, 21);
  await expect(capacityPanel(page).getByRole('textbox', { name: 'სხვა მძღოლის სახელი', exact: true })).toHaveValue('შენარჩუნებული სატესტო არჩევანი');
  await expect(capacityPanel(page).getByRole('combobox', { name: 'სხვა მძღოლის ადგილები', exact: true })).toHaveValue('6');
  expect(writes).toBe(1);
  expect((await capacity(date)).drivers.filter(driver => driver.kind === 'temporary').map(driver => driver.name)).toEqual(['სხვა ოპერატორის მანქანა']);
  await submitEditor(page);
  await expectCounts(page, 27, 0, 27);
  expect(writes).toBe(2);
});

test('a late capacity response for the previous hour cannot repaint the selected trip', async ({ page }) => {
  const date = '2040-06-07';
  await fixtureDay(date);
  await seedTripSeats(date, [8, 2]);
  await seedTripSeats(date, [2], { time: '10:00' });
  const otherHour = await capacity(date, '10:00');
  const added = await adminApi.post('/api/admin/trips/drivers', { data: {
    direction: 'gori-tbilisi', date, time: '10:00', expectedRevision: otherHour.revision,
    action: 'add', driver: { kind: 'temporary', name: 'ათის საათის მანქანა', capacity: 7 },
  } });
  expect(added.ok()).toBeTruthy();
  let release!: () => void;
  let sawDelayed!: () => void;
  let finishedRoute!: () => void;
  const delayed = new Promise<void>(resolve => { sawDelayed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { finishedRoute = resolve; });
  await page.route('**/api/admin/trips/capacity?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('date') !== date || url.searchParams.get('time') !== '09:00') return route.continue();
    const response = await route.fetch();
    sawDelayed();
    await gate;
    try { await route.fulfill({ response }); }
    finally { finishedRoute(); }
  });
  try {
    await openTrip(page, date);
    await delayed;
    await chooseTime(page, '10:00');
    await expect(capacityPanel(page)).toHaveAttribute('data-trip-time', '10:00');
    await expectCounts(page, 7, 2, 5);
    release();
    await completed;
    await expect(capacityPanel(page)).toHaveAttribute('data-trip-time', '10:00');
    await expectCounts(page, 7, 2, 5);
    await expect(capacityPanel(page)).toContainText('ათის საათის მანქანა');
    await expect(car(page, 'roster:1')).toHaveCount(0);
    await expect(car(page, 'roster:2')).toHaveCount(0);
  } finally { release(); }
});

for (const width of [320, 390]) {
  test(`operator car add/replace controls fit the screen and are usable at ${width}px`, async ({ page }) => {
    const date = width === 320 ? '2040-06-10' : '2040-06-11';
    await page.setViewportSize({ width, height: 844 });
    await fixtureDay(date);
    await openTrip(page, date);
    await expectCounts(page, 14, 0, 14);
    await temporaryEditor(page, 'მობილური სატესტო მანქანა', 8);
    for (const control of [
      capacityPanel(page).getByRole('button', { name: 'მძღოლების მართვა', exact: true }),
      capacityPanel(page).getByRole('button', { name: 'სხვა მძღოლი', exact: true }),
      capacityPanel(page).getByRole('textbox', { name: 'სხვა მძღოლის სახელი', exact: true }),
      capacityPanel(page).getByRole('combobox', { name: 'სხვა მძღოლის ადგილები', exact: true }),
      capacityPanel(page).getByRole('button', { name: 'დამატება', exact: true }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    const result = await submitEditor(page);
    const temporary = result.drivers.find(driver => driver.kind === 'temporary')!;
    await expectCounts(page, 22, 0, 22);
    const replace = capacityPanel(page).getByRole('button', { name: 'მობილური სატესტო მანქანა — რეისის მძღოლის შეცვლა', exact: true });
    await replace.scrollIntoViewIfNeeded();
    const box = await replace.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    await temporaryEditor(page, 'მობილური შეცვლილი მანქანა', 6, 'მობილური სატესტო მანქანა');
    await submitEditor(page, 'replace');
    await expectCounts(page, 20, 0, 20);
    await expect(car(page, temporary.key)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    // Verify access through the real narrow-screen navigation as well.
    await page.getByRole('button', { name: 'მენიუს გახსნა', exact: true }).click();
    await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true }).getByRole('button', { name: 'პარამეტრები', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'პარამეტრები', exact: true })).toBeVisible();
  });
}

test('capacity management belongs to Gori departures and the API requires an employee session', async ({ page, playwright, baseURL }) => {
  const date = '2040-06-12';
  await fixtureDay(date);
  await openTrip(page, date);
  await expectCounts(page, 14, 0, 14);
  const requests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/admin/trips/capacity') requests.push(request.url());
  });
  await page.locator('.admin-filters').getByRole('combobox').first().selectOption('tbilisi-gori');
  await expect(capacityPanel(page)).toHaveCount(0);
  await chooseTime(page, '09:00');
  await expect(page.locator('.admin-time-chip.selected')).toContainText('09:00');
  expect(requests).toEqual([]);
  await page.locator('.admin-filters').getByRole('combobox').first().selectOption('gori-tbilisi');
  await expect(capacityPanel(page)).toContainText('აირჩიეთ დრო');
  expect(requests).toEqual([]);
  await chooseTime(page, '09:00');
  await expectCounts(page, 14, 0, 14);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(url => new URL(url).searchParams.get('direction') === 'gori-tbilisi')).toBeTruthy();
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    expect((await anonymous.get(`/api/admin/trips/capacity?direction=gori-tbilisi&date=${date}&time=09:00`)).status()).toBe(401);
    expect((await anonymous.post('/api/admin/trips/drivers', { data: {
      direction: 'gori-tbilisi', date, time: '09:00', expectedRevision: (await capacity(date)).revision,
      action: 'add', driver: { kind: 'temporary', name: 'Anonymous car', capacity: 7 },
    } })).status()).toBe(401);
  } finally { await anonymous.dispose(); }
});
