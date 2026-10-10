import { test as base, expect, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import { existsSync } from 'node:fs';
import type { Booking, CallInquiry, PassengerDetail, TripCapacity } from '../src/api';
import { operatorSessionPath } from './helpers/operator-session';

// All records belong to the disposable database created by playwright.config.ts.
// Each case uses distinct synthetic phones and soft-deletes its orders/calls.
const EMPLOYEE = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'Independent passengers from one call must not throw runtime errors').toEqual([]);
  }, { auto: true }],
});
let adminApi: APIRequestContext;
let deviceHeaders: Record<string, string>;
let sequence = 0;
const inquiryIds: number[] = [];
const bookingIds: number[] = [];

test.beforeAll(async ({ playwright, baseURL }, testInfo) => {
  const sessionPath = operatorSessionPath(testInfo.config.metadata.fixtureDatabasePath);
  adminApi = await playwright.request.newContext({ baseURL, ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}) });
  const session = await adminApi.get('/api/auth/session');
  expect(session.ok()).toBeTruthy();
  const { user, needsSetup } = await session.json() as { user: { login: string } | null; needsSetup: boolean };
  // Reuse the existing synthetic operator rather than spending another real
  // login attempt. Running this suite alone still performs normal setup/login.
  if (user?.login !== EMPLOYEE.login) {
    expect((await adminApi.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: EMPLOYEE })).ok()).toBeTruthy();
  }
  const response = await adminApi.post('/api/admin/devices', { data: { name: 'Multiple-passenger disposable Samsung fixture' } });
  expect(response.status()).toBe(201);
  const { token } = await response.json() as { token: string };
  expect(Boolean(token)).toBeTruthy();
  deviceHeaders = { Authorization: `Bearer ${token}` };
});
test.afterEach(async () => {
  for (const id of inquiryIds.splice(0)) expect((await adminApi.post(`/api/admin/calls/${id}/delete`)).ok()).toBeTruthy();
  for (const id of new Set(bookingIds.splice(0))) expect((await adminApi.post(`/api/admin/bookings/${id}/delete`)).ok()).toBeTruthy();
});
test.afterAll(async () => { await adminApi?.dispose(); });

function day(offset = 1): string {
  const values = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (name: string) => values.find(part => part.type === name)!.value;
  const date = new Date(`${value('year')}-${value('month')}-${value('day')}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function display(phone: string): string { return `${phone.slice(0, 3)} ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7)}`; }
function callRow(page: Page, id: number): Locator { return page.locator(`.admin-calls-table tbody tr[data-call-id="${id}"]`); }
function passengers(page: Page, id: number): Locator { return page.locator(`.admin-calls-table tbody tr[data-call-parent-id="${id}"][data-passenger-id]`); }
function options(row: Locator) { return row.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }); }
function preference(row: Locator) { return row.getByRole('group', { name: 'სასურველი ადგილი', exact: true }); }
function times(row: Locator) { return row.getByRole('group', { name: 'დრო', exact: true }); }
function seats(row: Locator) { return row.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true }); }
function activeBooking(row: Locator, id: number) { return row.locator(`[data-active-booking-id="${id}"]`); }
function groupConfirm(page: Page, id: number) { return passengers(page, id).getByRole('button', { name: /^ყველა ჯავშნის დადასტურება/ }); }
function isProfile(response: Response, phone: string) {
  const url = new URL(response.url());
  return url.pathname === '/api/admin/passengers/profile' && url.searchParams.get('phone') === phone;
}
async function openIncoming(page: Page) {
  await page.context().addCookies((await adminApi.storageState()).cookies);
  await page.goto('/admin');
  await expect(page.locator('.auth-card')).toHaveCount(0);
  const menu = page.getByRole('button', { name: 'მენიუს გახსნა', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true })
    .getByRole('button', { name: /^შემოსული/ }).click();
}
async function incoming(phone: string) {
  const event = {
    eventId: `multiple-passengers-browser-${++sequence}`, kind: 'incoming', phase: 'answered',
    phone: `+995${phone}`, occurredAt: new Date().toISOString(), durationSeconds: 0,
  };
  const response = await adminApi.post('/api/integrations/android/calls', { headers: deviceHeaders, data: event });
  expect(response.status()).toBe(201);
  const result = await response.json() as { id: number };
  inquiryIds.push(result.id);
  return { id: result.id, event };
}
async function chooseTomorrow(row: Locator, time = '09:30') {
  await row.getByRole('group', { name: 'დღე', exact: true }).getByRole('button', { name: /^ხვალ/ }).click();
  await times(row).getByRole('button', { name: time, exact: true }).click();
}
async function fillPassenger(row: Locator, phone: string, address: string) {
  await row.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
  await row.getByLabel('ტელეფონის ნომერი', { exact: true }).blur();
  await row.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill(address);
}
async function addPassenger(page: Page, id: number, expectedCount: number) {
  await passengers(page, id).getByRole('button', { name: 'მგზავრის დამატება', exact: true }).click();
  await expect(passengers(page, id)).toHaveCount(expectedCount);
  return passengers(page, id).nth(expectedCount - 1);
}
async function confirmGroup(page: Page, id: number, retry = false): Promise<Booking[]> {
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/calls/${id}/convert-group` && response.request().method() === 'POST');
  await (retry ? passengers(page, id).getByRole('button', { name: 'განმეორებით გაგზავნა', exact: true }) : groupConfirm(page, id)).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const { bookings } = await response.json() as { bookings: Booking[] };
  bookingIds.push(...bookings.map(booking => booking.id));
  return bookings;
}
async function detail(phone: string): Promise<PassengerDetail> {
  const response = await adminApi.get(`/api/admin/passengers/${phone}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as PassengerDetail;
}
async function seed(phone: string, address: string, extra: Record<string, unknown> = {}) {
  const response = await adminApi.post('/api/admin/bookings', { data: {
    name: '', phone, seats: 1, direction: 'gori-tbilisi', goriAddress: address,
    requestedDate: day(), requestedTime: '21:00', ...extra,
  } });
  expect(response.status()).toBe(201);
  const booking = await response.json() as Booking;
  bookingIds.push(booking.id);
  return booking;
}
async function capacity(time = '09:30'): Promise<TripCapacity> {
  const response = await adminApi.get(`/api/admin/trips/capacity?${new URLSearchParams({ direction: 'gori-tbilisi', date: day(), time })}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as TripCapacity;
}

test('an added passenger copies only the journey and can independently change direction, day and time', async ({ page }) => {
  const inquiry = await incoming('555880101');
  await openIncoming(page);
  const first = callRow(page, inquiry.id);
  await fillPassenger(first, '555880102', 'გორი, პირველი მგზავრის დამოუკიდებელი მისამართი 102');
  await chooseTomorrow(first);
  await seats(first).getByRole('button', { name: '4', exact: true }).click();
  await options(first).getByRole('button', { name: 'ბარგი', exact: true }).click();
  await options(first).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await preference(first).getByRole('button', { name: 'წინ', exact: true }).click();
  const second = await addPassenger(page, inquiry.id, 2);
  await expect(second.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('');
  await expect(second.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('');
  await expect(second.getByLabel('გამგზავრების ქალაქი', { exact: true })).toHaveValue('gori-tbilisi');
  await expect(second.getByRole('group', { name: 'დღე', exact: true }).getByRole('button', { name: /^ხვალ/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(times(second).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(seats(second).getByRole('button', { name: '1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['ბარგი', 'ძაღლი']) await expect(options(second).getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');
  for (const name of ['წინ', 'უკან', 'შუაში']) await expect(preference(second).getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(groupConfirm(page, inquiry.id)).toBeDisabled();
  // A second passenger may travel on a different service; the first remains intact.
  await second.getByLabel('გამგზავრების ქალაქი', { exact: true }).selectOption('tbilisi-gori');
  await second.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true }).fill(day(2));
  await times(second).getByRole('button', { name: '10:00', exact: true }).click();
  await expect(first.getByLabel('გამგზავრების ქალაქი', { exact: true })).toHaveValue('gori-tbilisi');
  await expect(first.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true })).toHaveValue(day());
  await expect(times(first).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display('555880102'));
  await expect(options(first).getByRole('button', { name: 'ბარგი', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('each added contact loads its own saved address without changing another passenger or their manual choices', async ({ page }) => {
  const caller = '555880151', contactA = '555880152', contactB = '555880153';
  const addressA = 'გორი, დამოუკიდებელი შენახული პირველი მისამართი 152';
  const addressB = 'გორი, დამოუკიდებელი შენახული მეორე მისამართი 153';
  await seed(contactA, addressA, { callerPhone: caller });
  await seed(contactB, addressB);
  const inquiry = await incoming(caller);
  await openIncoming(page);
  const first = callRow(page, inquiry.id);
  await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(contactA));
  await expect(first.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(addressA);
  await chooseTomorrow(first);
  await options(first).getByRole('button', { name: 'ბარგი', exact: true }).click();
  const second = await addPassenger(page, inquiry.id, 2);
  await expect(second.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('');
  const secondProfile = page.waitForResponse(response => isProfile(response, contactB));
  await second.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(contactB);
  expect((await secondProfile).ok()).toBeTruthy();
  await expect(second.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(addressB);
  await first.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, პირველი მგზავრის ახალი ხელით შეყვანილი მისამართი 152');
  await times(second).getByRole('button', { name: '10:00', exact: true }).click();
  // Another operator adds a newer contact for this shared caller. The next
  // queue refresh may suggest that contact to new inquiries, but must not
  // replace this already initialized passenger or any added passenger.
  await seed('555880154', 'გორი, სხვა ოპერატორის ახალი ნომრის მისამართი 154', { callerPhone: caller });
  await page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/calls' && url.searchParams.get('scope') === 'incoming';
  });
  await expect(first.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, პირველი მგზავრის ახალი ხელით შეყვანილი მისამართი 152');
  await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(contactA));
  await expect(second.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(contactB));
  await expect(second.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(addressB);
  await expect(options(first).getByRole('button', { name: 'ბარგი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(options(second).getByRole('button', { name: 'ბარგი', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(times(first).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(times(second).getByRole('button', { name: '10:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('one call creates separate contact profiles and orders, and completion preserves every passenger', async ({ page }) => {
  test.setTimeout(45_000);
  const caller = '555880201', contactA = '555880202', contactB = '555880203';
  const addressA = 'გორი, საერთო ზარის პირველი მგზავრის მისამართი 202';
  const addressB = 'გორი, საერთო ზარის მეორე მგზავრის მისამართი 203';
  const inquiry = await incoming(caller);
  const before = await capacity();
  await openIncoming(page);
  const first = callRow(page, inquiry.id);
  await fillPassenger(first, contactA, addressA);
  await chooseTomorrow(first);
  await seats(first).getByRole('button', { name: '3', exact: true }).click();
  await options(first).getByRole('button', { name: 'ბარგი', exact: true }).click();
  await preference(first).getByRole('button', { name: 'წინ', exact: true }).click();
  const second = await addPassenger(page, inquiry.id, 2);
  await fillPassenger(second, contactB, addressB);
  await seats(second).getByRole('button', { name: '2', exact: true }).click();
  await options(second).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await preference(second).getByRole('button', { name: 'უკან', exact: true }).click();
  const bookings = await confirmGroup(page, inquiry.id);
  expect(bookings).toHaveLength(2);
  const bookingA = bookings.find(booking => booking.phone === contactA)!;
  const bookingB = bookings.find(booking => booking.phone === contactB)!;
  expect(bookingA).toMatchObject({ callerPhone: caller, phone: contactA, goriAddress: addressA, seats: 3, luggage: true, dog: false, seatPreference: 'front', assignedDate: day(), assignedTime: '09:30' });
  expect(bookingB).toMatchObject({ callerPhone: caller, phone: contactB, goriAddress: addressB, seats: 2, luggage: false, dog: true, seatPreference: 'back', assignedDate: day(), assignedTime: '09:30' });
  await expect(passengers(page, inquiry.id)).toHaveCount(0);
  const after = await capacity();
  expect(after.bookedSeats).toBe(before.bookedSeats + 5);
  expect(after.bookingCount).toBe(before.bookingCount + 2);
  const completed = await adminApi.post('/api/integrations/android/calls', { headers: deviceHeaders, data: { ...inquiry.event, phase: 'completed', durationSeconds: 95 } });
  expect(completed.status()).toBe(200);
  for (const [phone, address, own, other] of [[contactA, addressA, bookingA, bookingB], [contactB, addressB, bookingB, bookingA]] as const) {
    const saved = await detail(phone);
    expect(saved.profile).toMatchObject({ phone, goriPickupAddress: address });
    expect(saved.bookings.find(booking => booking.id === own.id)).toMatchObject(own);
    expect(saved.bookings.map(booking => booking.id)).not.toContain(other.id);
  }
  const converted = await adminApi.get('/api/admin/calls?scope=converted');
  expect(converted.ok()).toBeTruthy();
  expect((await converted.json() as { calls: CallInquiry[] }).calls.find(call => call.id === inquiry.id)).toMatchObject({ phone: caller, phase: 'completed' });
});

test('a lost group response keeps the passenger drafts and retries the same operation without duplicate orders', async ({ page }) => {
  test.setTimeout(45_000);
  const caller = '555880301', contactA = '555880302', contactB = '555880303';
  const inquiry = await incoming(caller);
  const before = await capacity('11:00');
  const requests: { key: string | undefined; body: unknown }[] = [];
  let committed: Booking[] = [];
  await page.route(`**/api/admin/calls/${inquiry.id}/convert-group`, async route => {
    requests.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    const result = await response.json() as { bookings: Booking[] };
    bookingIds.push(...result.bookings.map(booking => booking.id));
    if (requests.length === 1) {
      committed = result.bookings;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await openIncoming(page);
  const first = callRow(page, inquiry.id);
  await fillPassenger(first, contactA, 'გორი, პასუხის დაკარგვის პირველი მისამართი 302');
  await chooseTomorrow(first, '11:00');
  const second = await addPassenger(page, inquiry.id, 2);
  await fillPassenger(second, contactB, 'გორი, პასუხის დაკარგვის მეორე მისამართი 303');
  await groupConfirm(page, inquiry.id).click();
  await expect(passengers(page, inquiry.id).getByRole('alert')).toBeVisible();
  expect(committed).toHaveLength(2);
  // An acknowledged server commit stays safe to replay even if an operator's
  // retry occurs after the original departure. Mock Date only; queue polling
  // retains its real timers and the isolated server clock stays unchanged.
  await page.clock.setFixedTime(new Date(`${day()}T11:01:00+04:00`));
  // Wait for a real queue refresh: the server has already removed the call from
  // incoming, but unacknowledged passenger drafts must remain available to retry.
  await page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/calls' && url.searchParams.get('scope') === 'incoming';
  });
  await expect(passengers(page, inquiry.id)).toHaveCount(2);
  await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(contactA));
  await expect(second.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(contactB));
  await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toBeDisabled();
  await expect(second.getByLabel('აყვანის მისამართი გორში', { exact: true })).toBeDisabled();
  await expect(passengers(page, inquiry.id).getByRole('button', { name: 'მგზავრის დამატება', exact: true })).toHaveCount(0);
  await expect(second.getByRole('button', { name: 'მგზავრის წაშლა', exact: true })).toBeDisabled();
  await expect(passengers(page, inquiry.id).getByRole('button', { name: 'განმეორებით გაგზავნა', exact: true })).toBeEnabled();
  const retried = await confirmGroup(page, inquiry.id, true);
  expect(retried.map(booking => booking.id)).toEqual(committed.map(booking => booking.id));
  expect(requests).toHaveLength(2);
  expect(requests[0].key).toBeTruthy();
  expect(requests[1]).toEqual(requests[0]);
  await expect(passengers(page, inquiry.id)).toHaveCount(0);
  const after = await capacity('11:00');
  expect(after.bookingCount).toBe(before.bookingCount + 2);
  expect(after.bookedSeats).toBe(before.bookedSeats + 2);
  for (const [phone, ownId] of [[contactA, committed[0].id], [contactB, committed[1].id]] as const) {
    expect((await detail(phone)).bookings.filter(booking => booking.callerPhone === caller).map(booking => booking.id)).toEqual([ownId]);
  }
});

test('removing the middle passenger preserves the first and third drafts and saves only the remaining orders', async ({ page }) => {
  const inquiry = await incoming('555880401');
  await openIncoming(page);
  const first = callRow(page, inquiry.id);
  await fillPassenger(first, '555880402', 'გორი, ჯგუფში დარჩენილი პირველი მისამართი 402');
  await chooseTomorrow(first);
  const second = await addPassenger(page, inquiry.id, 2);
  await fillPassenger(second, '555880403', 'გორი, მოსაშორებელი მეორე მისამართი 403');
  await times(second).getByRole('button', { name: '10:00', exact: true }).click();
  const third = await addPassenger(page, inquiry.id, 3);
  await fillPassenger(third, '555880404', 'გორი, ჯგუფში დარჩენილი მესამე მისამართი 404');
  await options(third).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  const thirdId = await third.getAttribute('data-passenger-id');
  expect(thirdId).toBeTruthy();
  await second.getByRole('button', { name: 'მგზავრის წაშლა', exact: true }).click();
  await expect(passengers(page, inquiry.id)).toHaveCount(2);
  const retained = passengers(page, inquiry.id).nth(1);
  await expect(retained).toHaveAttribute('data-passenger-id', thirdId!);
  await expect(retained.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display('555880404'));
  await expect(retained.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, ჯგუფში დარჩენილი მესამე მისამართი 404');
  await expect(options(retained).getByRole('button', { name: 'ძაღლი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const bookings = await confirmGroup(page, inquiry.id);
  expect(bookings.map(booking => booking.phone)).toEqual(['555880402', '555880404']);
  expect(bookings.map(booking => booking.assignedTime)).toEqual(['09:30', '09:30']);
});

test('a definitive conversion by another operator removes the stale group without creating another set of orders', async ({ page }) => {
  const caller = '555880451';
  const inquiry = await incoming(caller);
  const before = await capacity('14:00');
  await openIncoming(page);
  const first = callRow(page, inquiry.id);
  await fillPassenger(first, '555880452', 'გორი, სხვა ოპერატორის შემდეგ შესანარჩუნებელი პირველი პროექტი 452');
  await chooseTomorrow(first, '14:00');
  const second = await addPassenger(page, inquiry.id, 2);
  await fillPassenger(second, '555880453', 'გორი, სხვა ოპერატორის შემდეგ შესანარჩუნებელი მეორე პროექტი 453');
  await expect(groupConfirm(page, inquiry.id)).toBeEnabled();
  // A concurrent operator resolves this inquiry before the visible draft is
  // received by the server. Hold the visible request until the competing real
  // API transaction commits; this also avoids a race with queue polling.
  let releaseRequest: () => void = () => {};
  let requestStarted: () => void = () => {};
  const held = new Promise<void>(resolve => { releaseRequest = resolve; });
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const pattern = `**/api/admin/calls/${inquiry.id}/convert-group`;
  await page.route(pattern, async route => { requestStarted(); await held; await route.continue(); });
  const refused = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/calls/${inquiry.id}/convert-group` && response.request().method() === 'POST');
  await groupConfirm(page, inquiry.id).click();
  await started;
  let bookings: Booking[] = [];
  try {
    const competing = await adminApi.post(`/api/admin/calls/${inquiry.id}/convert-group`, {
      headers: { 'Idempotency-Key': `multiple-passenger-competing-${inquiry.id}` },
      data: { bookings: ['555880454', '555880455'].map(phone => ({
        name: '', phone, seats: 1, direction: 'gori-tbilisi', goriAddress: `გორი, სხვა ოპერატორის დადასტურებული მისამართი ${phone}`,
        requestedDate: day(), requestedTime: '14:00',
      })) },
    });
    expect(competing.status()).toBe(201);
    ({ bookings } = await competing.json() as { bookings: Booking[] });
    bookingIds.push(...bookings.map(booking => booking.id));
  } finally { releaseRequest(); }
  const conflict = await refused;
  await page.unroute(pattern);
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: 'CALL_CONVERTED' });
  await expect(passengers(page, inquiry.id)).toHaveCount(0);
  await expect(page.locator('.admin-call-completion-notice[role="status"]')).toBeVisible();
  const after = await capacity('14:00');
  expect(after.bookingCount).toBe(before.bookingCount + 2);
  expect(after.bookedSeats).toBe(before.bookedSeats + 2);
  for (const booking of bookings) expect((await detail(booking.phone)).bookings.find(value => value.id === booking.id)?.deletedAt).toBeNull();
});

test('a later shared-caller inquiry can cancel one passenger order without cancelling its sibling or losing new drafts', async ({ page }) => {
  test.setTimeout(45_000);
  const caller = '555880501', contactA = '555880502', contactB = '555880503';
  const initial = await incoming(caller);
  await openIncoming(page);
  const first = callRow(page, initial.id);
  await fillPassenger(first, contactA, 'გორი, აქტიური ჯგუფის პირველი მისამართი 502');
  await chooseTomorrow(first, '12:00');
  const second = await addPassenger(page, initial.id, 2);
  await fillPassenger(second, contactB, 'გორი, აქტიური ჯგუფის მეორე მისამართი 503');
  const [bookingA, bookingB] = await confirmGroup(page, initial.id);
  const next = await incoming(caller);
  const nextRow = callRow(page, next.id);
  await expect(activeBooking(nextRow, bookingA.id)).toBeVisible();
  await expect(activeBooking(nextRow, bookingB.id)).toBeVisible();
  await nextRow.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, ხელახლა დასარეკი შენარჩუნებული მისამართი 504');
  await chooseTomorrow(nextRow, '13:00');
  const extra = await addPassenger(page, next.id, 2);
  await fillPassenger(extra, '555880504', 'გორი, ახალი ჯგუფის დამატებითი მისამართი 504');
  await options(extra).getByRole('button', { name: 'ბარგი', exact: true }).click();
  const cancel = activeBooking(nextRow, bookingA.id);
  await cancel.getByRole('button', { name: 'ჯავშნის გაუქმება', exact: true }).click();
  const cancelled = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/calls/${next.id}/bookings/${bookingA.id}/delete`);
  await cancel.getByRole('button', { name: 'დიახ, გააუქმე', exact: true }).click();
  expect((await cancelled).ok()).toBeTruthy();
  await expect(activeBooking(nextRow, bookingA.id)).toHaveCount(0);
  await expect(activeBooking(nextRow, bookingB.id)).toBeVisible();
  await expect(passengers(page, next.id)).toHaveCount(2);
  await expect(nextRow.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, ხელახლა დასარეკი შენარჩუნებული მისამართი 504');
  await expect(times(nextRow).getByRole('button', { name: '13:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(extra.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display('555880504'));
  await expect(options(extra).getByRole('button', { name: 'ბარგი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await detail(contactA)).bookings.find(booking => booking.id === bookingA.id)?.deletedAt).toBeTruthy();
  expect((await detail(contactB)).bookings.find(booking => booking.id === bookingB.id)?.deletedAt).toBeNull();
});

for (const width of [320, 390]) {
  test(`multiple-passenger controls fit ${width}px and keep large readable operator actions`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const inquiry = await incoming(`555881${width}`);
    await openIncoming(page);
    const first = callRow(page, inquiry.id);
    await fillPassenger(first, `555882${width}`, `გორი, მობილური ჯგუფის პირველი მისამართი ${width}`);
    await chooseTomorrow(first);
    const second = await addPassenger(page, inquiry.id, 2);
    await fillPassenger(second, `555883${width}`, `გორი, მობილური ჯგუფის მეორე მისამართი ${width}`);
    await expect(groupConfirm(page, inquiry.id)).toBeEnabled();
    const appearance = await passengers(page, inquiry.id).evaluateAll(elements => {
      const buttons = elements.flatMap(element => Array.from(element.querySelectorAll<HTMLButtonElement>('button')))
        .filter(button => button.getClientRects().length > 0);
      return {
        targets: buttons.map(button => { const rect = button.getBoundingClientRect(); return { text: button.textContent?.trim(), width: rect.width, height: rect.height, font: Number.parseFloat(getComputedStyle(button).fontSize) }; }),
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(appearance.targets.length).toBeGreaterThan(30);
    for (const button of appearance.targets) {
      expect(button.height, `${button.text} needs a large touch target`).toBeGreaterThanOrEqual(48);
      expect(button.width, `${button.text} needs a large touch target`).toBeGreaterThanOrEqual(48);
      expect(button.font, `${button.text} needs readable operator text`).toBeGreaterThanOrEqual(16);
    }
    expect(appearance.overflow, 'Time carousels may scroll locally, but the page must fit the screen').toBeLessThanOrEqual(2);
  });
}
