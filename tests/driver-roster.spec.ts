import { test as base, expect, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import type { DriverDay, DriverSchedule, TripCapacity } from '../src/api';

// Reuse the isolated browser employee: each spec file may be the first to set up
// the disposable database, and Playwright can restart a worker after a failure.
const EMPLOYEE = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const ANCHOR = '2026-10-09';
const TIMES = ['06:00', '07:00', '08:00', '08:30', '09:00', '09:30', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00'];
const EXPECTED_ROSTER: readonly [string, number][] = [
  ['რეზო', 7], ['კუდუხა', 7], ['გოჩა', 8], ['ვიქტორი', 7], ['ბიძინა', 6], ['დიმა', 7],
  ['გუგა', 7], ['ამიკო', 6], ['ნიკა', 6], ['გიგა', 6], ['ვანო', 7], ['გიორგი', 7],
  ['შოშია', 7], ['ლევანი', 6], ['დოლიმე', 7], ['კობა', 6], ['ბოლოთა', 7], ['ბუზა', 7],
  ['ზურა', 7], ['ედიკა', 7], ['კახა ახალი', 7], ['ბორა', 7], ['თემო ახალი', 7],
  ['ფურცელა', 7], ['ბადრი', 6], ['რამაზი', 7], ['ვალერი', 7], ['დათო ტინის ხიდი', 7],
  ['დათო ტინის ხიდი ახალი', 7], ['ერასტი', 7], ['გურამი', 7], ['სუხიტა', 7],
  ['გელა', 6], ['სოსო', 8], ['აჩიკო', 7], ['ირაკლი', 7], ['კევა', 6], ['ზვიადი', 7],
  ['სვანი', 6], ['დევი', 6], ['ილარიონო', 7], ['გია', 8], ['ლაშა / ვიქტორი', 7],
];

const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'Driver management should not throw browser runtime errors').toEqual([]);
  }, { auto: true }],
});

let adminApi: APIRequestContext;

test.beforeAll(async ({ playwright, baseURL }) => {
  adminApi = await playwright.request.newContext({ baseURL });
  const session = await adminApi.get('/api/auth/session');
  expect(session.ok()).toBeTruthy();
  const { needsSetup } = await session.json() as { needsSetup: boolean };
  const auth = await adminApi.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: EMPLOYEE });
  expect(auth.ok(), 'The disposable test employee must be authenticated').toBeTruthy();
});

test.afterAll(async () => { await adminApi?.dispose(); });

function roster(page: Page): Locator { return page.getByRole('region', { name: 'მძღოლების რიგი', exact: true }); }
function driverRow(page: Page, id: number): Locator { return page.locator(`.admin-driver-table [data-driver-id="${id}"]`); }
function driverAttendance(page: Page, driver: Pick<DriverDay, 'id' | 'name'>): Locator {
  return driverRow(page, driver.id).getByRole('switch', { name: `${driver.name} — მონაწილეობა ამ დღეს`, exact: true });
}
function scheduleCard(page: Page): Locator { return page.locator('.admin-config-schedule'); }
function dateInput(page: Page): Locator { return scheduleCard(page).getByLabel('თარიღი', { exact: true }); }

async function getDriverDay(date: string): Promise<DriverSchedule> {
  const response = await adminApi.get(`/api/admin/drivers/schedule?direction=gori-tbilisi&date=${date}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as DriverSchedule;
}

async function resetDay(date: string, times = TIMES) {
  const response = await adminApi.put('/api/admin/schedule/date', { data: { direction: 'gori-tbilisi', date, times } });
  expect(response.ok()).toBeTruthy();
  const schedule = await getDriverDay(date);
  for (const driver of schedule.drivers) {
    if (!driver.declined) continue;
    const result = await adminApi.patch(`/api/admin/drivers/${driver.id}/day`, { data: {
      direction: 'gori-tbilisi', date, declined: false,
    } });
    expect(result.ok()).toBeTruthy();
  }
}

async function openSettings(page: Page, date: string) {
  await page.context().addCookies((await adminApi.storageState()).cookies);
  await page.goto('/admin');
  const navigation = page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true });
  await expect(navigation).toBeAttached();
  const mobileMenu = page.getByRole('button', { name: 'მენიუს გახსნა', exact: true });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await navigation.getByRole('button', { name: 'პარამეტრები', exact: true }).click();
  await expect(scheduleCard(page).getByRole('heading', { name: 'მგზავრობის განრიგი', exact: true })).toBeVisible();
  await chooseDate(page, date);
}

async function chooseDate(page: Page, date: string) {
  await dateInput(page).fill(date);
  await expect(roster(page).getByRole('table', { name: 'მძღოლები არჩეულ დღეს', exact: true })).toBeVisible();
  await expect(roster(page).locator('[data-driver-id]')).toHaveCount(43);
  const actual = await getDriverDay(date);
  await expect(roster(page).locator('[data-driver-id]').first()).toHaveAttribute('data-driver-id', String(actual.firstDriverId));
}

function isDriverPatch(response: Response, id: number): boolean {
  return new URL(response.url()).pathname === `/api/admin/drivers/${id}/day` && response.request().method() === 'PATCH';
}

async function assignDriver(date: string, id: number, time: string): Promise<TripCapacity> {
  const current = await adminApi.get(`/api/admin/trips/capacity?direction=gori-tbilisi&date=${date}&time=${time}`);
  expect(current.ok()).toBeTruthy();
  const trip = await current.json() as TripCapacity;
  const saved = await adminApi.post('/api/admin/trips/drivers', { data: {
    direction: 'gori-tbilisi', date, time, expectedRevision: trip.revision,
    action: 'add', driver: { kind: 'roster', id },
  } });
  expect(saved.ok()).toBeTruthy();
  return await saved.json() as TripCapacity;
}

async function setAttendance(page: Page, driver: Pick<DriverDay, 'id' | 'name'>, participates: boolean): Promise<DriverSchedule> {
  const toggle = driverAttendance(page, driver);
  if (await toggle.getAttribute('aria-checked') === String(participates)) return await getDriverDay(await dateInput(page).inputValue());
  const response = page.waitForResponse(response => isDriverPatch(response, driver.id));
  await toggle.click();
  const saved = await response;
  expect(saved.ok()).toBeTruthy();
  await expect(toggle).toHaveAttribute('aria-checked', String(participates));
  await expect(toggle).toBeEnabled();
  return await saved.json() as DriverSchedule;
}

test('the saved schedule shows all 43 provided drivers, capacities and daily circular order', async ({ page }) => {
  await resetDay(ANCHOR);
  await resetDay('2026-10-10');
  await resetDay('2026-11-21');
  await openSettings(page, ANCHOR);
  const rows = roster(page).locator('[data-driver-id]');
  expect(await rows.evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-driver-id')))))
    .toEqual(Array.from({ length: 43 }, (_, index) => index + 1));
  for (const [index, [name, capacity]] of EXPECTED_ROSTER.entries()) {
    const row = driverRow(page, index + 1);
    await expect(row.getByText(name, { exact: true })).toBeVisible();
    await expect(row.locator('.admin-driver-capacity')).toHaveText(`${capacity} ადგილი`);
    await expect(driverAttendance(page, { id: index + 1, name })).toHaveAttribute('aria-checked', 'true');
  }
  await expect(roster(page).getByRole('combobox')).toHaveCount(0);
  expect((await getDriverDay(ANCHOR)).drivers.every(driver => driver.assignedTime === null && driver.automaticTime === null)).toBeTruthy();

  await chooseDate(page, '2026-10-10');
  await expect(rows.first()).toHaveAttribute('data-driver-id', '2');
  await expect(rows.last()).toHaveAttribute('data-driver-id', '1');
  expect((await getDriverDay('2026-10-10')).drivers.every(driver => driver.assignedTime === null)).toBeTruthy();
  await chooseDate(page, '2026-11-21');
  await expect(rows.first()).toHaveAttribute('data-driver-id', '1');
  expect((await getDriverDay('2026-11-21')).drivers.every(driver => driver.assignedTime === null)).toBeTruthy();
});

test('daily participation persists without assigning times or changing tomorrow’s queue', async ({ page }) => {
  await resetDay(ANCHOR);
  await resetDay('2026-10-10');
  await openSettings(page, ANCHOR);
  const rezo = { id: 1, name: 'რეზო' };
  const kudukha = { id: 2, name: 'კუდუხა' };
  await setAttendance(page, rezo, false);
  await setAttendance(page, kudukha, false);
  expect((await getDriverDay(ANCHOR)).drivers.every(driver => driver.assignedTime === null)).toBeTruthy();
  await expect(roster(page).locator('[data-driver-id]').first()).toHaveAttribute('data-driver-id', '1');
  await page.reload();
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true })
    .getByRole('button', { name: 'პარამეტრები', exact: true }).click();
  await chooseDate(page, ANCHOR);
  await expect(driverAttendance(page, rezo)).toHaveAttribute('aria-checked', 'false');
  await expect(driverAttendance(page, kudukha)).toHaveAttribute('aria-checked', 'false');
  await chooseDate(page, '2026-10-10');
  await expect(driverAttendance(page, kudukha)).toHaveAttribute('aria-checked', 'true');
  await expect(roster(page).locator('[data-driver-id]').first()).toHaveAttribute('data-driver-id', '2');
  expect((await getDriverDay('2026-10-10')).drivers.every(driver => driver.assignedTime === null)).toBeTruthy();
  await chooseDate(page, ANCHOR);
  await setAttendance(page, rezo, true);
  await setAttendance(page, kudukha, true);
  expect((await getDriverDay(ANCHOR)).drivers.every(driver => driver.assignedTime === null)).toBeTruthy();
});

test('participation changes preserve explicit trip choices without reflowing the queue', async ({ page }) => {
  const date = '2030-05-06';
  await resetDay(date);
  const initial = await getDriverDay(date);
  const [first, second, third] = initial.drivers;
  await assignDriver(date, first.id, '08:30');
  await assignDriver(date, second.id, '08:30');
  await openSettings(page, date);
  const saved = await getDriverDay(date);
  expect(saved.drivers.filter(driver => [first.id, second.id].includes(driver.id))).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.id, assignmentMode: 'manual', assignedTime: '08:30', assignmentActive: true }),
    expect.objectContaining({ id: second.id, assignmentMode: 'manual', assignedTime: '08:30', assignmentActive: true }),
  ]));
  expect(saved.drivers.find(driver => driver.id === third.id)).toMatchObject({ assignmentMode: 'manual', assignedTime: null });
  await expect(roster(page).getByRole('combobox')).toHaveCount(0);
  await expect(roster(page).locator('[data-driver-slot]')).toHaveCount(0);

  await setAttendance(page, first, false);
  expect((await getDriverDay(date)).drivers.filter(driver => driver.assignmentActive).map(driver => driver.id)).toEqual([second.id]);
  await setAttendance(page, first, true);
  await chooseDate(page, '2030-05-07');
  await chooseDate(page, date);
  const restored = await getDriverDay(date);
  expect(restored.drivers.filter(driver => driver.assignmentActive).map(driver => driver.id)).toEqual([first.id, second.id]);
  expect(restored.drivers.find(driver => driver.id === third.id)?.assignedTime).toBeNull();
  expect((await getDriverDay('2030-05-07')).drivers.every(driver => driver.assignedTime === null)).toBeTruthy();
});

test('editing departure times creates no driver assignments and preserves an explicit removed time', async ({ page }) => {
  const date = '2030-05-08';
  await resetDay(date, ['06:00', '08:30', '09:30']);
  const initial = await getDriverDay(date);
  const [first] = initial.drivers;
  await openSettings(page, date);
  const editor = scheduleCard(page).locator('.admin-config-subsection').filter({ has: page.locator('#date-new-time') });
  await editor.locator('#date-new-time').fill('09:15');
  await editor.getByRole('button', { name: 'დროის დამატება', exact: true }).click();
  const save = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/schedule/date' && response.request().method() === 'PUT');
  await editor.getByRole('button', { name: 'ამ დღის შენახვა', exact: true }).click();
  expect((await save).ok()).toBeTruthy();
  const expanded = await getDriverDay(date);
  expect(expanded.times).toEqual(['06:00', '08:30', '09:15', '09:30']);
  expect(expanded.drivers.every(driver => driver.assignedTime === null)).toBeTruthy();

  await assignDriver(date, first.id, '08:30');
  await editor.getByRole('button', { name: '08:30 საათის ამოღება', exact: true }).click();
  const remove = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/schedule/date' && response.request().method() === 'PUT');
  await editor.getByRole('button', { name: 'ამ დღის შენახვა', exact: true }).click();
  expect((await remove).ok()).toBeTruthy();
  const removed = await getDriverDay(date);
  expect(removed.drivers.find(driver => driver.id === first.id)).toMatchObject({
    assignmentMode: 'manual', assignedTime: '08:30', assignmentActive: false,
  });
  expect(removed.drivers.filter(driver => driver.assignmentActive)).toHaveLength(0);
  await expect(roster(page).getByRole('combobox')).toHaveCount(0);
});

test('the queue belongs only to Gori departures and anonymous users cannot read or change it', async ({ page, playwright, baseURL }) => {
  await openSettings(page, ANCHOR);
  const driverRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/admin/drivers')) driverRequests.push(request.url());
  });
  await scheduleCard(page).getByLabel('მიმართულება', { exact: true }).selectOption('tbilisi-gori');
  await expect(roster(page).getByRole('table', { name: 'მძღოლები არჩეულ დღეს', exact: true })).toHaveCount(0);
  await expect(roster(page)).toContainText('თბილისი');
  expect(driverRequests).toEqual([]);
  await scheduleCard(page).getByLabel('მიმართულება', { exact: true }).selectOption('gori-tbilisi');
  await expect(roster(page).locator('[data-driver-id]')).toHaveCount(43);
  expect(driverRequests.length).toBeGreaterThan(0);
  expect(driverRequests.every(url => new URL(url).searchParams.get('direction') === 'gori-tbilisi')).toBeTruthy();

  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    expect((await anonymous.get(`/api/admin/drivers/schedule?direction=gori-tbilisi&date=${ANCHOR}`)).status()).toBe(401);
    expect((await anonymous.patch('/api/admin/drivers/1/day', { data: { direction: 'gori-tbilisi', date: ANCHOR, declined: true } })).status()).toBe(401);
  } finally { await anonymous.dispose(); }
});

test('a late response from another date cannot replace the displayed driver queue', async ({ page }) => {
  const oldDate = '2030-05-12';
  const newDate = '2030-05-13';
  await resetDay(oldDate);
  await resetDay(newDate);
  await openSettings(page, ANCHOR);
  let release!: () => void;
  let sawDelayed!: () => void;
  let finishedRoute!: () => void;
  const delayed = new Promise<void>(resolve => { sawDelayed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { finishedRoute = resolve; });
  await page.route('**/api/admin/drivers/schedule?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('date') !== oldDate) return route.continue();
    const result = await route.fetch();
    sawDelayed();
    await gate;
    try { await route.fulfill({ response: result }); }
    finally { finishedRoute(); }
  });
  try {
    await dateInput(page).fill(oldDate);
    await delayed;
    await chooseDate(page, newDate);
    const firstId = (await getDriverDay(newDate)).firstDriverId;
    release();
    // Changing dates may abort the original browser fetch. Waiting for its
    // response event would then hang even though cancellation is correct.
    await completed;
    await expect(dateInput(page)).toHaveValue(newDate);
    await expect(roster(page)).toHaveAttribute('data-date', newDate);
    await expect(roster(page).locator('[data-driver-id]').first()).toHaveAttribute('data-driver-id', String(firstId));
  } finally { release(); }
});

test('a delayed daily change is saved to its original date while the operator views another day', async ({ page }) => {
  const oldDate = '2030-05-14';
  const newDate = '2030-05-15';
  await resetDay(oldDate);
  await resetDay(newDate);
  const first = (await getDriverDay(oldDate)).drivers[0];
  await openSettings(page, oldDate);
  let release!: () => void;
  let sawDelayed!: () => void;
  const delayed = new Promise<void>(resolve => { sawDelayed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/admin/drivers/${first.id}/day`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const result = await route.fetch();
    sawDelayed();
    await gate;
    await route.fulfill({ response: result });
  });
  try {
    await driverAttendance(page, first).click();
    await delayed;
    await chooseDate(page, newDate);
    await expect(driverAttendance(page, first)).toHaveAttribute('aria-checked', 'true');
    const oldResponse = page.waitForResponse(response => isDriverPatch(response, first.id));
    release();
    await oldResponse;
    await expect(dateInput(page)).toHaveValue(newDate);
    await expect(driverAttendance(page, first)).toHaveAttribute('aria-checked', 'true');
    expect((await getDriverDay(oldDate)).drivers.find(driver => driver.id === first.id)?.declined).toBe(true);
    expect((await getDriverDay(newDate)).drivers.find(driver => driver.id === first.id)?.declined).toBe(false);
    await chooseDate(page, oldDate);
    await expect(driverAttendance(page, first)).toHaveAttribute('aria-checked', 'false');
  } finally { release(); }
});

for (const width of [320, 390]) {
  test(`driver queue and participation controls remain usable at ${width}px`, async ({ page }) => {
    const date = width === 320 ? '2030-05-16' : '2030-05-17';
    await page.setViewportSize({ width, height: 844 });
    await resetDay(date);
    await openSettings(page, date);
    const first = (await getDriverDay(date)).drivers[0];
    const attendance = driverAttendance(page, first);
    for (const control of [attendance]) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    await setAttendance(page, first, false);
    await setAttendance(page, first, true);
    await expect(roster(page).getByRole('combobox')).toHaveCount(0);
    expect((await getDriverDay(date)).drivers.every(driver => driver.assignedTime === null)).toBeTruthy();
  });
}
