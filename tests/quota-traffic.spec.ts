import { test as base, expect, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import { existsSync } from 'node:fs';
import type { Booking, CallInquiry } from '../src/api';
import { operatorSessionPath } from './helpers/operator-session';

// Only the disposable database from playwright.config.ts receives these calls.
// The shared operator session avoids spending another login attempt when this
// suite follows the caller/contact and multiple-passenger regression suites.
const EMPLOYEE = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const DEVICE_NAME = 'quota-pagination-disposable-fixture';
type CallsPage = { calls: CallInquiry[]; total: number; page: number; pageSize: number };
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'Bounded incoming polling and pagination must not throw browser errors').toEqual([]);
  }, { auto: true }],
});
let adminApi: APIRequestContext;
const calls: { id: number; phone: string }[] = [];
const bookingIds: number[] = [];

test.beforeAll(async ({ playwright, baseURL }, testInfo) => {
  const sessionPath = operatorSessionPath(testInfo.config.metadata.fixtureDatabasePath);
  adminApi = await playwright.request.newContext({ baseURL, ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}) });
  const session = await adminApi.get('/api/auth/session');
  expect(session.ok()).toBeTruthy();
  const { user, needsSetup } = await session.json() as { user: { login: string } | null; needsSetup: boolean };
  if (user?.login !== EMPLOYEE.login) {
    expect((await adminApi.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: EMPLOYEE })).ok()).toBeTruthy();
  }
  const device = await adminApi.post('/api/admin/devices', { data: { name: DEVICE_NAME } });
  expect(device.status()).toBe(201);
  const { token } = await device.json() as { token: string };
  const stamp = Date.now();
  // Forty-six calls make four pages, with only one inquiry on the last page.
  // Seed once for this file, keeping the Android intake limit meaningful.
  for (let index = 0; index < 46; index++) {
    const phone = `555890${String(index).padStart(3, '0')}`;
    const response = await adminApi.post('/api/integrations/android/calls', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        eventId: `quota-browser-${stamp}-${index}`, kind: 'incoming', phase: 'answered',
        phone: `+995${phone}`, occurredAt: new Date(stamp - (46 - index) * 1000).toISOString(), durationSeconds: 0,
      },
    });
    expect(response.status()).toBe(201);
    const { id } = await response.json() as { id: number };
    calls.push({ id, phone });
  }
});
test.afterEach(async () => {
  for (const id of bookingIds.splice(0)) expect((await adminApi.post(`/api/admin/bookings/${id}/delete`)).ok()).toBeTruthy();
});
test.afterAll(async () => {
  for (const { id } of calls.splice(0)) expect((await adminApi.post(`/api/admin/calls/${id}/delete`)).ok()).toBeTruthy();
  await adminApi?.dispose();
});

function day(offset = 1): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (name: string) => parts.find(part => part.type === name)!.value;
  const date = new Date(`${value('year')}-${value('month')}-${value('day')}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function display(phone: string) { return `${phone.slice(0, 3)} ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7)}`; }
function row(page: Page, id: number): Locator { return page.locator(`.admin-calls-table tbody tr[data-call-id="${id}"]`); }
function children(page: Page, id: number): Locator { return page.locator(`.admin-calls-table tbody tr[data-call-parent-id="${id}"][data-passenger-id]`); }
function pager(page: Page) { return page.getByRole('navigation', { name: 'სატელეფონო განაცხადების გვერდები', exact: true }); }
function times(container: Locator) { return container.getByRole('group', { name: 'დრო', exact: true }); }
function seats(container: Locator) { return container.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true }); }
function isQueue(response: Response, page?: number, search = DEVICE_NAME) {
  const url = new URL(response.url());
  return url.pathname === '/api/admin/calls' && url.searchParams.get('scope') === 'incoming'
    && url.searchParams.get('search') === search && (page === undefined || url.searchParams.get('page') === String(page));
}
async function navigate(page: Page, label: string) {
  const mobile = page.getByRole('button', { name: 'მენიუს გახსნა', exact: true });
  if (await mobile.isVisible()) await mobile.click();
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true }).getByRole('button', { name: label, exact: true }).click();
}
async function open(page: Page, incoming = true) {
  await page.context().addCookies((await adminApi.storageState()).cookies);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'ჯავშნები', exact: true })).toBeVisible();
  if (incoming) {
    await navigate(page, 'შემოსული');
    await search(page, DEVICE_NAME);
  }
}
async function search(page: Page, value: string): Promise<CallsPage> {
  const loaded = page.waitForResponse(response => isQueue(response, 1, value));
  await page.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true }).fill(value);
  const response = await loaded;
  expect(response.ok()).toBeTruthy();
  const result = await response.json() as CallsPage;
  await expect(pager(page)).toBeVisible();
  return result;
}
async function next(page: Page, expectedPage: number): Promise<CallsPage> {
  const loaded = page.waitForResponse(response => isQueue(response, expectedPage));
  await pager(page).getByRole('button', { name: 'შემდეგი გვერდი', exact: true }).click();
  const response = await loaded;
  expect(response.ok()).toBeTruthy();
  return await response.json() as CallsPage;
}
async function previous(page: Page, expectedPage: number) {
  const loaded = page.waitForResponse(response => isQueue(response, expectedPage));
  await pager(page).getByRole('button', { name: 'წინა გვერდი', exact: true }).click();
  expect((await loaded).ok()).toBeTruthy();
}
async function tomorrow(container: Locator, time = '09:30') {
  await container.getByRole('group', { name: 'დღე', exact: true }).getByRole('button', { name: /^ხვალ/ }).click();
  await times(container).getByRole('button', { name: time, exact: true }).click();
}
async function seed(phone: string, callerPhone: string) {
  const response = await adminApi.post('/api/admin/bookings', { data: {
    name: '', phone, callerPhone, seats: 1, direction: 'gori-tbilisi',
    goriAddress: 'გორი, ძებნით ნაპოვნი ბოლო გვერდის მისამართი', requestedDate: day(), requestedTime: '21:00',
  } });
  expect(response.status()).toBe(201);
  const booking = await response.json() as Booking;
  bookingIds.push(booking.id);
  return booking;
}

test('incoming polling transfers one actual page and keeps a total for all forty-six inquiries', async ({ page }) => {
  const responses: CallsPage[] = [];
  const queuedRequests: URL[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/admin/calls') queuedRequests.push(url);
  });
  await open(page);
  const firstPoll = page.waitForResponse(response => isQueue(response, 1));
  const first = await (await firstPoll).json() as CallsPage;
  responses.push(first);
  expect(first).toMatchObject({ total: 46, page: 1, pageSize: 15 });
  expect(first.calls).toHaveLength(15);
  await expect(page.locator('.admin-calls-table tbody tr[data-call-id]')).toHaveCount(15);
  await expect(page.locator('.admin-call-count')).toHaveText('46');
  const counts = await (await adminApi.get('/api/admin/incoming-counts')).json() as { calls: number; bookings: number; total: number };
  expect(counts.total).toBe(counts.calls + counts.bookings);
  await expect(page.locator('.admin-incoming-button b')).toHaveText(String(counts.total));
  for (const expectedPage of [2, 3, 4]) {
    const result = await next(page, expectedPage);
    responses.push(result);
    expect(result).toMatchObject({ total: 46, page: expectedPage, pageSize: 15 });
    expect(result.calls).toHaveLength(expectedPage === 4 ? 1 : 15);
    await expect(page.locator('.admin-calls-table tbody tr[data-call-id]')).toHaveCount(result.calls.length);
  }
  await expect(pager(page).getByRole('button', { name: 'შემდეგი გვერდი', exact: true })).toBeDisabled();
  expect(new Set(responses.flatMap(response => response.calls.map(call => call.id))).size).toBe(46);
  expect(queuedRequests.length).toBeGreaterThanOrEqual(4);
  expect(queuedRequests.every(url => url.searchParams.get('page') && url.searchParams.get('pageSize') === '15')).toBeTruthy();
});

test('manual addresses, seats, hours and added passenger identities survive leaving and returning to a page', async ({ page }) => {
  await open(page);
  const firstCall = calls[45];
  const first = row(page, firstCall.id);
  const firstAddress = 'გორი, გვერდებს შორის შესანარჩუნებელი პირველი მისამართი';
  const childAddress = 'გორი, გვერდებს შორის შესანარჩუნებელი მეორე მისამართი';
  await first.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill(firstAddress);
  await tomorrow(first);
  await seats(first).getByRole('button', { name: '6', exact: true }).click();
  await first.getByRole('button', { name: 'მგზავრის დამატება', exact: true }).click();
  await expect(children(page, firstCall.id)).toHaveCount(2);
  const child = children(page, firstCall.id).nth(1);
  await child.getByLabel('ტელეფონის ნომერი', { exact: true }).fill('555891901');
  await child.getByLabel('ტელეფონის ნომერი', { exact: true }).blur();
  await child.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill(childAddress);
  await seats(child).getByRole('button', { name: '2', exact: true }).click();
  await times(child).getByRole('button', { name: '10:00', exact: true }).click();
  await child.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  const passengerId = await child.getAttribute('data-passenger-id');
  expect(passengerId).toBeTruthy();
  const pageTwo = await next(page, 2);
  await expect(row(page, firstCall.id)).toHaveCount(0);
  const other = row(page, pageTwo.calls[0].id);
  await other.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, მეორე გვერდის ცალკე პროექტი');
  await previous(page, 1);
  await expect(children(page, firstCall.id)).toHaveCount(2);
  await expect(first.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(firstAddress);
  await expect(seats(first).getByRole('button', { name: '6', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(times(first).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(child).toHaveAttribute('data-passenger-id', passengerId!);
  await expect(child.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display('555891901'));
  await expect(child.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(childAddress);
  await expect(seats(child).getByRole('button', { name: '2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(times(child).getByRole('button', { name: '10:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(child.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }).getByRole('button', { name: 'ძაღლი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await next(page, 2);
  await expect(other.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, მეორე გვერდის ცალკე პროექტი');
});

test('search filters the entire queue by a late-page caller or its preferred order contact and resets the page', async ({ page }) => {
  const lateCall = calls[0];
  const contact = '555891902';
  await seed(contact, lateCall.phone);
  await open(page);
  await next(page, 2);
  await next(page, 3);
  await next(page, 4);
  const byContact = await search(page, display(contact));
  expect(byContact).toMatchObject({ total: 1, page: 1, pageSize: 15 });
  expect(byContact.calls.map(call => call.id)).toEqual([lateCall.id]);
  await expect(row(page, lateCall.id).getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(contact));
  await expect(pager(page)).toContainText('1 / 1');
  const byCaller = await search(page, display(lateCall.phone));
  expect(byCaller).toMatchObject({ total: 1, page: 1, pageSize: 15 });
  expect(byCaller.calls.map(call => call.id)).toEqual([lateCall.id]);
});

test('a held refresh response from page one cannot replace the current page-two rows', async ({ page }) => {
  await open(page);
  let holdNextPageOne = false;
  let release = () => {};
  let started = () => {};
  let finished = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const intercepted = new Promise<void>(resolve => { started = resolve; });
  const handled = new Promise<void>(resolve => { finished = resolve; });
  const pattern = '**/api/admin/calls?**';
  await page.route(pattern, async route => {
    const url = new URL(route.request().url());
    if (!holdNextPageOne || url.searchParams.get('page') !== '1' || url.searchParams.get('search') !== DEVICE_NAME) {
      await route.continue(); return;
    }
    holdNextPageOne = false;
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    started();
    await held;
    // Changing pages is allowed to abort this obsolete browser request.
    try {
      await route.fulfill({ response });
    } catch (cause) {
      // Chromium may already have handled the route when React aborts the old
      // page request. Accept that result only with the real aborted request.
      expect(String(cause)).toMatch(/closed|cancel|abort|disposed|invalid|already handled/i);
      await expect.poll(() => route.request().failure()?.errorText).toMatch(/abort|cancel/i);
    } finally { finished(); }
  });
  holdNextPageOne = true;
  await intercepted;
  const second = await next(page, 2);
  const expected = second.calls.map(call => String(call.id));
  try {
    await expect(page.locator('.admin-calls-table tbody tr[data-call-id]')).toHaveCount(15);
    release();
    await handled;
    await page.unroute(pattern);
    // A subsequent real page-two poll also has to retain the correct context.
    expect((await page.waitForResponse(response => isQueue(response, 2))).ok()).toBeTruthy();
    await expect.poll(() => page.locator('.admin-calls-table tbody tr[data-call-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-call-id')))).toEqual(expected);
    await expect(pager(page)).toContainText('2 / 4');
  } finally { release(); }
});

test('header polling uses count-only responses in different views without reloading full incoming lists or configuration', async ({ page }) => {
  test.setTimeout(60_000);
  const requests: URL[] = [];
  page.on('request', request => { requests.push(new URL(request.url())); });
  const waitCount = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/incoming-counts');
  const incomingLists = () => requests.filter(url => url.pathname === '/api/admin/bookings' && url.searchParams.get('scope') === 'incoming').length;
  const queueLists = () => requests.filter(url => url.pathname === '/api/admin/calls');
  const configs = () => requests.filter(url => url.pathname === '/api/public/config').length;
  await open(page, false);
  await waitCount();
  await waitCount();
  expect(queueLists()).toHaveLength(0);
  expect(incomingLists()).toBe(0);
  const initialConfigs = configs();
  expect(initialConfigs).toBeGreaterThanOrEqual(1);
  await navigate(page, 'შემოსული');
  await expect(page.locator('.admin-call-count')).toBeVisible();
  await expect.poll(incomingLists).toBe(1);
  await waitCount();
  await waitCount();
  expect(incomingLists()).toBe(1);
  expect(queueLists().length).toBeGreaterThan(1);
  expect(queueLists().every(url => url.searchParams.get('page') && url.searchParams.get('pageSize') === '15')).toBeTruthy();
  expect(configs()).toBe(initialConfigs);
  await navigate(page, 'მგზავრები');
  await expect(page.getByRole('heading', { name: 'მგზავრების სია', exact: true })).toBeVisible();
  const previousLists = queueLists().length;
  await waitCount();
  await waitCount();
  expect(queueLists()).toHaveLength(previousLists);
  expect(incomingLists()).toBe(1);
  expect(configs()).toBe(initialConfigs);
  const countRequests = requests.filter(url => url.pathname === '/api/admin/incoming-counts');
  expect(countRequests.length).toBeGreaterThanOrEqual(6);
  expect(countRequests.every(url => url.search === '')).toBeTruthy();
});

test('legacy calls-only responses retain client pagination during a rolling deployment', async ({ page }) => {
  const response = await adminApi.get(`/api/admin/calls?${new URLSearchParams({ scope: 'incoming', search: DEVICE_NAME })}`);
  expect(response.ok()).toBeTruthy();
  const legacy = await response.json() as { calls: CallInquiry[] };
  expect(legacy.calls).toHaveLength(46);
  expect(Object.keys(legacy)).toEqual(['calls']);
  await page.route('**/api/admin/calls?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('scope') === 'incoming' && url.searchParams.get('search') === DEVICE_NAME) await route.fulfill({ json: legacy });
    else await route.continue();
  });
  await open(page);
  await expect(page.locator('.admin-calls-table tbody tr[data-call-id]')).toHaveCount(15);
  await expect(row(page, legacy.calls[0].id)).toBeVisible();
  await next(page, 2);
  await expect(row(page, legacy.calls[0].id)).toHaveCount(0);
  await expect(row(page, legacy.calls[15].id)).toBeVisible();
  await expect(pager(page)).toContainText('2 / 4');
  await expect(page.locator('.admin-call-count')).toHaveText('46');
});

test('processing the final page clamps both cancellation and conversion to a remaining valid page', async ({ page }) => {
  // This case intentionally changes the shared queue and therefore runs last.
  await open(page);
  await next(page, 2);
  await next(page, 3);
  const last = await next(page, 4);
  expect(last.calls).toHaveLength(1);
  const removed = last.calls[0];
  const cancelled = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/calls/${removed.id}/delete`);
  await row(page, removed.id).getByRole('button', { name: 'უარი', exact: true }).click();
  expect((await cancelled).ok()).toBeTruthy();
  await expect(pager(page)).toContainText('3 / 3');
  await expect(page.locator('.admin-call-count')).toHaveText('45');
  await expect(page.locator('.admin-calls-table tbody tr[data-call-id]')).toHaveCount(15);
  // Keep only one fixture call on the third page, then convert it in the UI.
  // These are still the actual paged endpoints and real soft-deletes; no response
  // fixture can hide a bad server page clamp.
  const active = await adminApi.get(`/api/admin/calls?${new URLSearchParams({ scope: 'incoming', page: '3', pageSize: '15', search: DEVICE_NAME })}`);
  const tail = await active.json() as CallsPage;
  const remaining = tail.calls.at(-1)!;
  for (const call of tail.calls.slice(0, -1)) expect((await adminApi.post(`/api/admin/calls/${call.id}/delete`)).ok()).toBeTruthy();
  await expect(page.locator('.admin-call-count')).toHaveText('31');
  await expect(page.locator('.admin-calls-table tbody tr[data-call-id]')).toHaveCount(1);
  const remainingRow = row(page, remaining.id);
  await remainingRow.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, ბოლო გვერდიდან დადასტურებული მისამართი');
  await tomorrow(remainingRow);
  const converted = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/calls/${remaining.id}/convert` && response.request().method() === 'POST');
  await remainingRow.getByRole('button', { name: 'დადასტურება', exact: true }).click();
  const saved = await converted;
  bookingIds.push((await saved.json() as Booking).id);
  // Single-call conversion preserves its existing HTTP200 contract.
  expect(saved.status()).toBe(200);
  await expect(pager(page)).toContainText('2 / 2');
  await expect(page.locator('.admin-call-count')).toHaveText('30');
  await expect(page.locator('.admin-calls-table tbody tr[data-call-id]')).toHaveCount(15);
  await expect(pager(page).getByRole('button', { name: 'შემდეგი გვერდი', exact: true })).toBeDisabled();
});
