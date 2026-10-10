import { test as base, expect, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Booking, CallInquiry, PassengerDetail, TripCapacity } from '../src/api';
import { createDatabase } from '../server/database';
import { operatorSessionPath } from './helpers/operator-session';

// This suite uses the existing employee and the disposable Playwright database.
// Soft-delete every created inquiry/order so other suites retain their own fixtures.
const EMPLOYEE = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'Caller/contact and active-order controls must not throw runtime errors').toEqual([]);
  }, { auto: true }],
});
let adminApi: APIRequestContext;
let deviceHeaders: Record<string, string>;
let sequence = 0;
const inquiryIds: number[] = [];
const bookingIds: number[] = [];

test.beforeAll(async ({ playwright, baseURL }, testInfo) => {
  adminApi = await playwright.request.newContext({ baseURL });
  const session = await adminApi.get('/api/auth/session');
  expect(session.ok()).toBeTruthy();
  const { needsSetup } = await session.json() as { needsSetup: boolean };
  expect((await adminApi.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: EMPLOYEE })).ok()).toBeTruthy();
  const sessionPath = operatorSessionPath(testInfo.config.metadata.fixtureDatabasePath);
  writeFileSync(sessionPath, JSON.stringify(await adminApi.storageState()), { mode: 0o600 });
  chmodSync(sessionPath, 0o600);
  const response = await adminApi.post('/api/admin/devices', { data: { name: 'Caller/contact disposable Redmi fixture' } });
  expect(response.status()).toBe(201);
  const { token } = await response.json() as { token: string };
  expect(Boolean(token)).toBeTruthy();
  deviceHeaders = { Authorization: `Bearer ${token}` };
});
test.afterEach(async () => {
  for (const id of inquiryIds.splice(0)) expect((await adminApi.post(`/api/admin/calls/${id}/delete`)).ok()).toBeTruthy();
  for (const id of bookingIds.splice(0)) expect((await adminApi.post(`/api/admin/bookings/${id}/delete`)).ok()).toBeTruthy();
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
function bookingRow(page: Page, id: number): Locator { return page.locator(`.admin-booking-table tbody tr[data-booking-id="${id}"]`); }
function activeBooking(row: Locator, id: number): Locator { return row.locator(`[data-active-booking-id="${id}"]`); }
function options(container: Locator) { return container.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }); }
function preference(container: Locator) { return container.getByRole('group', { name: 'სასურველი ადგილი', exact: true }); }
function isProfile(response: Response, phone: string) {
  const url = new URL(response.url());
  return url.pathname === '/api/admin/passengers/profile' && url.searchParams.get('phone') === phone;
}
async function openAdmin(page: Page, path = '/admin') {
  await page.context().addCookies((await adminApi.storageState()).cookies);
  await page.goto(path);
  await expect(page.locator('.auth-card')).toHaveCount(0);
  if (path === '/admin') await expect(page.getByRole('heading', { name: 'ჯავშნები', exact: true })).toBeVisible();
}
async function view(page: Page, label: 'შემოსული' | 'ჯავშნები' | 'ისტორია') {
  const menu = page.getByRole('button', { name: 'მენიუს გახსნა', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true })
    .getByRole('button', { name: label === 'შემოსული' ? /^შემოსული/ : label, exact: label !== 'შემოსული' }).click();
}
async function incoming(phone: string, phase: 'answered' | 'completed' = 'answered') {
  const event = {
    eventId: `caller-contact-browser-${++sequence}`, kind: 'incoming', phase, phone: `+995${phone}`,
    occurredAt: new Date().toISOString(), durationSeconds: phase === 'completed' ? 42 : 0,
  };
  const response = await adminApi.post('/api/integrations/android/calls', { headers: deviceHeaders, data: event });
  expect(response.status()).toBe(201);
  const result = await response.json() as { id: number };
  inquiryIds.push(result.id);
  return { id: result.id, event };
}
async function seed(phone: string, extra: Record<string, unknown> = {}, waiting = false): Promise<Booking> {
  const response = await adminApi.post(waiting ? '/api/bookings' : '/api/admin/bookings', { data: {
    name: waiting ? 'სატესტო დასადასტურებელი მგზავრი' : '', phone, seats: 1,
    direction: 'gori-tbilisi', goriAddress: `გორი, სატესტო მისამართი ${phone}`,
    requestedDate: day(), requestedTime: '21:00', ...extra,
  } });
  expect(response.ok()).toBeTruthy();
  const booking = await response.json() as Booking;
  bookingIds.push(booking.id);
  return booking;
}
async function fixtureDate(id: number, date: string, time = '06:00') {
  const dbPath = test.info().config.metadata.fixtureDatabasePath;
  expect(typeof dbPath).toBe('string');
  const directory = dirname(resolve(dbPath));
  expect(basename(dbPath)).toBe('greentaxi.sqlite');
  expect(dirname(directory)).toBe(resolve(tmpdir()));
  expect(basename(directory)).toMatch(/^greentaxi-e2e-[^/]+$/);
  expect(dbPath).toBe(join(directory, 'greentaxi.sqlite'));
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) expect(existsSync(dbPath)).toBeTruthy();
  const db = await createDatabase({ dbPath, databaseUrl, production: false });
  try {
    expect((await db.prepare("UPDATE bookings SET requested_date=?,requested_time=?,assigned_date=CASE WHEN status='confirmed' THEN ? ELSE NULL END,assigned_time=CASE WHEN status='confirmed' THEN ? ELSE NULL END WHERE id=?")
      .run(date, time, date, time, id)).changes).toBe(1);
  } finally { await db.close(); }
}
async function chooseCallTomorrow(row: Locator, time: string) {
  await row.getByRole('group', { name: 'დღე', exact: true }).getByRole('button', { name: /^ხვალ/ }).click();
  await row.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: time, exact: true }).click();
}
async function convert(page: Page, row: Locator, id: number): Promise<Booking> {
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/calls/${id}/convert` && response.request().method() === 'POST');
  await row.getByRole('button', { name: 'დადასტურება', exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  const booking = await response.json() as Booking;
  bookingIds.push(booking.id);
  return booking;
}
async function tripCapacity(time: string): Promise<TripCapacity> {
  const response = await adminApi.get(`/api/admin/trips/capacity?${new URLSearchParams({ direction: 'gori-tbilisi', date: day(), time })}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as TripCapacity;
}

test('the immutable SIM caller and edited order contact are saved separately, remembered and unaffected by Android completion', async ({ page }) => {
  const caller = '555870101';
  const contact = '555870102';
  const address = 'გორი, ორი ნომრის სატესტო მისამართი 101';
  const inquiry = await incoming(caller);
  await openAdmin(page);
  await view(page, 'შემოსული');
  const row = callRow(page, inquiry.id);
  await expect(row.getByLabel('ზარის ნომერი', { exact: true })).toHaveText(display(caller));
  await expect(row.locator('input[aria-label="ზარის ნომერი"]')).toHaveCount(0);
  await row.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(`+995 ${display(contact)}`);
  await row.getByLabel('ტელეფონის ნომერი', { exact: true }).blur();
  await row.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill(address);
  await chooseCallTomorrow(row, '09:30');
  await row.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true }).getByRole('button', { name: /^3(?: ადგილი)?$/ }).click();
  await options(row).getByRole('button', { name: 'ბარგი', exact: true }).click();
  await options(row).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await preference(row).getByRole('button', { name: 'წინ', exact: true }).click();
  const booking = await convert(page, row, inquiry.id);
  expect(booking).toMatchObject({ phone: contact, callerPhone: caller, seats: 3, luggage: true, dog: true, seatPreference: 'front', goriAddress: address, assignedTime: '09:30' });
  await expect(row).toHaveCount(0);
  const replay = await adminApi.post('/api/integrations/android/calls', {
    headers: deviceHeaders, data: { ...inquiry.event, phase: 'completed', durationSeconds: 80 },
  });
  expect(replay.status()).toBe(200);
  const converted = await adminApi.get('/api/admin/calls?scope=converted');
  expect((await converted.json() as { calls: CallInquiry[] }).calls.find(call => call.id === inquiry.id))
    .toMatchObject({ phone: caller, bookingPhone: contact, phase: 'completed', bookingId: booking.id });
  const detail = await adminApi.get(`/api/admin/passengers/${contact}`);
  expect((await detail.json() as PassengerDetail).bookings.find(value => value.id === booking.id)).toMatchObject({ phone: contact, callerPhone: caller });
  // Habitual hours are inferred from actual past departures, not a newly planned
  // journey. Represent that completed trip, plus a separate still-active order.
  await fixtureDate(booking.id, day(-1), '09:30');
  const upcoming = await seed(contact, { goriAddress: address, requestedTime: '09:30' });
  const next = await incoming(caller);
  const nextRow = callRow(page, next.id);
  await expect(nextRow.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(contact));
  await expect(nextRow.getByLabel('ზარის ნომერი', { exact: true })).toHaveText(display(caller));
  await expect(nextRow.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(address);
  await nextRow.getByRole('group', { name: 'დღე', exact: true }).getByRole('button', { name: /^ხვალ/ }).click();
  await expect(nextRow.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(activeBooking(nextRow, upcoming.id)).toBeVisible();
  await expect(activeBooking(nextRow, booking.id)).toHaveCount(0);
});

test('a shared family caller remembers the last contact without merging the two contact profiles or trip histories', async ({ page }) => {
  const caller = '555870201';
  const first = '555870202';
  const second = '555870203';
  const addressA = 'გორი, ოჯახის პირველი დამოუკიდებელი მისამართი 202';
  const addressB = 'გორი, ოჯახის მეორე დამოუკიდებელი მისამართი 203';
  const firstBooking = await seed(first, { callerPhone: caller, goriAddress: addressA, requestedTime: '08:30' });
  const secondBooking = await seed(second, { callerPhone: caller, goriAddress: addressB, requestedTime: '10:00' });
  const inquiry = await incoming(caller);
  await openAdmin(page);
  await view(page, 'შემოსული');
  const row = callRow(page, inquiry.id);
  await expect(row.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(second));
  await expect(row.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(addressB);
  await expect(activeBooking(row, firstBooking.id)).toBeVisible();
  await expect(activeBooking(row, secondBooking.id)).toBeVisible();
  const lookup = page.waitForResponse(response => isProfile(response, first));
  await row.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(first);
  expect((await lookup).ok()).toBeTruthy();
  await expect(row.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(addressA);
  for (const [phone, own, other, address] of [[first, firstBooking, secondBooking, addressA], [second, secondBooking, firstBooking, addressB]] as const) {
    const response = await adminApi.get(`/api/admin/passengers/${phone}`);
    expect(response.ok()).toBeTruthy();
    const detail = await response.json() as PassengerDetail;
    expect(detail.profile).toMatchObject({ phone, goriPickupAddress: address });
    expect(detail.bookings.map(booking => booking.id)).toContain(own.id);
    expect(detail.bookings.map(booking => booking.id)).not.toContain(other.id);
  }
});

test('incoming calls show all active dates and waiting orders, and cancelling one synchronizes duplicate cards without losing the draft', async ({ page }) => {
  test.setTimeout(45_000);
  const caller = '555870301';
  const contact = '555870302';
  const confirmed = await seed(contact, { callerPhone: caller, seats: 6, requestedTime: '20:00' });
  const earlierToday = await seed(caller);
  await fixtureDate(earlierToday.id, day(0));
  const waiting = await seed(contact, { requestedTime: '20:00' }, true);
  const farFuture = await seed(contact);
  await fixtureDate(farFuture.id, day(10));
  const historical = await seed(contact);
  await fixtureDate(historical.id, day(-1));
  const deleted = await seed(contact);
  expect((await adminApi.post(`/api/admin/bookings/${deleted.id}/delete`)).ok()).toBeTruthy();
  const unrelated = await seed('555870399');
  const first = await incoming(caller);
  const duplicate = await incoming(caller, 'completed');
  const before = await tripCapacity('20:00');
  await openAdmin(page);
  await view(page, 'შემოსული');
  const row = callRow(page, first.id);
  const duplicateRow = callRow(page, duplicate.id);
  for (const target of [row, duplicateRow]) {
    for (const booking of [confirmed, earlierToday, waiting, farFuture]) await expect(activeBooking(target, booking.id)).toBeVisible();
    for (const booking of [historical, deleted, unrelated]) await expect(activeBooking(target, booking.id)).toHaveCount(0);
  }
  await expect(activeBooking(row, waiting.id)).toContainText('ელოდება დადასტურებას');
  const address = 'გორი, გაუქმების შემდეგ შესანარჩუნებელი ახალი მისამართი 301';
  await row.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill(address);
  await chooseCallTomorrow(row, '11:00');
  await row.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true }).getByRole('button', { name: /^5(?: ადგილი)?$/ }).click();
  await options(row).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await preference(row).getByRole('button', { name: 'შუაში', exact: true }).click();
  const card = activeBooking(row, confirmed.id);
  await card.getByRole('button', { name: 'ჯავშნის გაუქმება', exact: true }).click();
  const cancelled = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/calls/${first.id}/bookings/${confirmed.id}/delete`);
  await card.getByRole('button', { name: 'დიახ, გააუქმე', exact: true }).click();
  expect((await cancelled).ok()).toBeTruthy();
  for (const target of [row, duplicateRow]) {
    await expect(target).toBeVisible();
    await expect(activeBooking(target, confirmed.id)).toHaveCount(0);
    await expect(activeBooking(target, waiting.id)).toBeVisible();
  }
  await expect(row.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(address);
  await expect(row.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(contact));
  await expect(row.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '11:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(row.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true }).getByRole('button', { name: /^5(?: ადგილი)?$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(options(row).getByRole('button', { name: 'ძაღლი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(preference(row).getByRole('button', { name: 'შუაში', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const after = await tripCapacity('20:00');
  expect(after.bookedSeats).toBe(before.bookedSeats - 6);
  expect(after.freeSeats).toBe(Math.max(0, after.totalSeats - after.bookedSeats));
  const history = await adminApi.get(`/api/admin/passengers/${contact}`);
  const saved = (await history.json() as PassengerDetail).bookings.find(booking => booking.id === confirmed.id)!;
  expect(saved.deletedAt).toBeTruthy();
  expect(saved.status).toBe('confirmed');
});

test('manual notes survive editing, deletion and restoration and appear in passenger history and the actual printed document', async ({ page }) => {
  test.setTimeout(45_000);
  const caller = '555870401';
  const contact = '555870402';
  type PrintedWindow = Window & { __callerNotesPrinted?: { text: string; rows: string[][]; headings: number }[] };
  await page.addInitScript(() => {
    const top = window.top as PrintedWindow;
    top.__callerNotesPrinted ??= [];
    window.print = () => top.__callerNotesPrinted!.push({ text: document.body.innerText, headings: document.querySelectorAll('thead th').length,
      rows: Array.from(document.querySelectorAll('tbody tr'), row => Array.from(row.querySelectorAll('td'), td => td.textContent?.trim() || '')) });
  });
  await openAdmin(page);
  await page.getByRole('button', { name: 'ახალი ჯავშანი', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ახალი ჯავშანი', exact: true });
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(contact);
  await dialog.getByLabel('ზარის ნომერი', { exact: true }).fill(caller);
  await dialog.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, სერვისების სატესტო მისამართი 401');
  await dialog.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true }).getByRole('button', { name: '4 ადგილი', exact: true }).click();
  await dialog.getByRole('group', { name: 'თარიღი', exact: true }).getByRole('button', { name: /^ხვალ,/ }).click();
  await dialog.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '09:30', exact: true }).click();
  await options(dialog).getByRole('button', { name: 'ბარგი', exact: true }).click();
  await options(dialog).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await preference(dialog).getByRole('button', { name: 'წინ', exact: true }).click();
  const create = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/bookings' && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
  const created = await create;
  expect(created.ok()).toBeTruthy();
  const booking = await created.json() as Booking;
  bookingIds.push(booking.id);
  expect(booking).toMatchObject({ phone: contact, callerPhone: caller, seats: 4, luggage: true, dog: true, seatPreference: 'front' });
  await page.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true }).fill(day());
  await page.locator('.admin-time-strip').getByRole('button', { name: /^09:30\s/ }).click();
  const row = bookingRow(page, booking.id);
  await expect(row).toContainText(display(contact));
  await expect(row).toContainText(display(caller));
  await row.getByRole('button', { name: `${display(contact)}: რედაქტირება`, exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'ჯავშნის რედაქტირება', exact: true });
  await expect(options(edit).getByRole('button', { name: 'ბარგი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(options(edit).getByRole('button', { name: 'ძაღლი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await options(edit).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await preference(edit).getByRole('button', { name: 'უკან', exact: true }).click();
  const changed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/bookings/${booking.id}` && response.request().method() === 'PATCH');
  await edit.getByRole('button', { name: 'ცვლილებების შენახვა', exact: true }).click();
  expect(await (await changed).json()).toMatchObject({ seats: 4, callerPhone: caller, phone: contact, luggage: true, dog: false, seatPreference: 'back' });
  expect((await adminApi.post(`/api/admin/bookings/${booking.id}/delete`)).ok()).toBeTruthy();
  await view(page, 'ისტორია');
  await expect(row).toBeVisible();
  await expect(row.getByLabel('დამატებითი სერვისები და ადგილი', { exact: true })).toContainText('ადგილი: უკან');
  await row.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  const restore = page.getByRole('dialog', { name: 'ჯავშნის აღდგენა', exact: true });
  const restored = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/bookings/${booking.id}/restore`);
  await restore.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  expect(await (await restored).json()).toMatchObject({ deletedAt: null, seats: 4, luggage: true, dog: false, seatPreference: 'back', callerPhone: caller, phone: contact });
  await openAdmin(page, `/admin/passengers/${contact}`);
  await page.getByRole('group', { name: 'მგზავრობის ისტორიის ფილტრი', exact: true }).getByRole('button', { name: /^ყველა/ }).click();
  const trip = page.getByRole('table', { name: 'მგზავრობის ისტორია', exact: true }).locator(`tr[data-booking-id="${booking.id}"]`);
  await expect(trip).toContainText(display(caller));
  await expect(trip.getByLabel('დამატებითი სერვისები და ადგილი', { exact: true })).toContainText('ბარგი');
  await expect(trip).toContainText('ადგილი: უკან');
  await expect(trip).not.toContainText('ძაღლი');
  await view(page, 'ჯავშნები');
  await page.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true }).fill(day());
  await page.locator('.admin-time-strip').getByRole('button', { name: /^09:30\s/ }).click();
  await page.getByRole('button', { name: 'ჯავშნების ბეჭდვა', exact: true }).click();
  const print = page.getByRole('dialog', { name: 'ჯავშნების ბეჭდვა', exact: true });
  await expect(print.getByRole('button', { name: 'ბეჭდვა / PDF', exact: true })).toBeEnabled();
  await print.getByRole('button', { name: 'ბეჭდვა / PDF', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as PrintedWindow).__callerNotesPrinted?.length || 0)).toBe(1);
  const printed = await page.evaluate(() => (window as PrintedWindow).__callerNotesPrinted![0]);
  expect(printed.headings).toBe(7);
  const printedRow = printed.rows.find(cells => cells.join(' ').includes(display(contact)))!;
  expect(printedRow).toHaveLength(7);
  expect(printedRow[3]).toContain(display(caller));
  expect(printedRow[5]).toBe('4');
  expect(printedRow[6]).toContain('ბარგი');
  expect(printedRow[6]).toContain('ადგილი: უკან');
  expect(printedRow[6]).not.toContain('ძაღლი');
});

test('a late contact lookup cannot replace a newer contact, address, preferred time or manually selected notes', async ({ page }) => {
  const caller = '555870501';
  const slow = '555870502';
  const current = '555870503';
  await seed(slow, { goriAddress: 'გორი, დაგვიანებული სხვა პროფილი 502', requestedTime: '08:30' });
  await seed(current, { goriAddress: 'გორი, მიმდინარე პროფილი 503', requestedTime: '10:00' });
  const inquiry = await incoming(caller);
  let releaseSlow: () => void = () => {};
  let observeSlow: () => void = () => {};
  let finishSlow: () => void = () => {};
  const held = new Promise<void>(resolve => { releaseSlow = resolve; });
  const started = new Promise<void>(resolve => { observeSlow = resolve; });
  const finished = new Promise<void>(resolve => { finishSlow = resolve; });
  await page.route(`**/api/admin/passengers/profile?phone=${slow}`, async route => {
    const response = await route.fetch();
    observeSlow();
    await held;
    await route.fulfill({ response }).catch(() => { /* Aborting a stale request is an equally valid outcome. */ });
    finishSlow();
  });
  await openAdmin(page);
  await view(page, 'შემოსული');
  const row = callRow(page, inquiry.id);
  await row.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(slow);
  await started;
  const updated = page.waitForResponse(response => isProfile(response, current));
  await row.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(current);
  expect((await updated).ok()).toBeTruthy();
  await expect(row.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, მიმდინარე პროფილი 503');
  await chooseCallTomorrow(row, '11:00');
  await options(row).getByRole('button', { name: 'ბარგი', exact: true }).click();
  await preference(row).getByRole('button', { name: 'შუაში', exact: true }).click();
  releaseSlow();
  await finished;
  // A normal queue refresh after the old response must also retain current edits.
  await expect.poll(async () => {
    const phone = await row.getByLabel('ტელეფონის ნომერი', { exact: true }).inputValue();
    const address = await row.getByLabel('აყვანის მისამართი გორში', { exact: true }).inputValue();
    return { phone: phone.replace(/\D/g, ''), address };
  }).toEqual({ phone: current, address: 'გორი, მიმდინარე პროფილი 503' });
  await expect(row.getByLabel('ზარის ნომერი', { exact: true })).toHaveText(display(caller));
  await expect(row.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '11:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(options(row).getByRole('button', { name: 'ბარგი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(preference(row).getByRole('button', { name: 'შუაში', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a late active-order response cannot show or cancel orders for a replaced contact', async ({ page }) => {
  const caller = '555870601';
  const previous = '555870602';
  const current = '555870603';
  const oldBooking = await seed(previous, { requestedTime: '08:30' });
  const currentBooking = await seed(current, { requestedTime: '10:00' });
  const inquiry = await incoming(caller);
  let release: () => void = () => {};
  let reportStarted: () => void = () => {};
  let reportFinished: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { reportStarted = resolve; });
  const finished = new Promise<void>(resolve => { reportFinished = resolve; });
  await page.route(`**/api/admin/calls/${inquiry.id}/bookings?phone=${previous}`, async route => {
    const response = await route.fetch();
    reportStarted();
    await held;
    await route.fulfill({ response }).catch(() => { /* The old contact's response can be safely aborted. */ });
    reportFinished();
  });
  await openAdmin(page);
  await view(page, 'შემოსული');
  const row = callRow(page, inquiry.id);
  await row.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(previous);
  await started;
  await row.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(current);
  await expect(activeBooking(row, currentBooking.id)).toBeVisible();
  release();
  await finished;
  await expect(activeBooking(row, oldBooking.id)).toHaveCount(0);
  const card = activeBooking(row, currentBooking.id);
  await card.getByRole('button', { name: 'ჯავშნის გაუქმება', exact: true }).click();
  const cancelled = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/calls/${inquiry.id}/bookings/${currentBooking.id}/delete`);
  await card.getByRole('button', { name: 'დიახ, გააუქმე', exact: true }).click();
  const response = await cancelled;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON()).toMatchObject({ phone: current });
  const previousDetail = await adminApi.get(`/api/admin/passengers/${previous}`);
  expect((await previousDetail.json() as PassengerDetail).bookings.find(value => value.id === oldBooking.id)?.deletedAt).toBeNull();
  await expect(row).toBeVisible();
});

for (const width of [320, 390]) {
  test(`incoming operator controls are large, readable and fit ${width}px without page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const caller = `555870${width}`;
    const booking = await seed(caller, { requestedTime: '09:30' });
    const inquiry = await incoming(caller);
    await openAdmin(page);
    await view(page, 'შემოსული');
    const row = callRow(page, inquiry.id);
    await expect(activeBooking(row, booking.id)).toBeVisible();
    await chooseCallTomorrow(row, '09:30');
    await options(row).getByRole('button', { name: 'ბარგი', exact: true }).click();
    const appearance = await row.evaluate(element => {
      const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('button')).filter(button => button.getClientRects().length > 0);
      return {
        targets: buttons.map(button => { const rect = button.getBoundingClientRect(); return { text: button.textContent?.trim(), width: rect.width, height: rect.height, font: Number.parseFloat(getComputedStyle(button).fontSize) }; }),
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(appearance.targets.length).toBeGreaterThan(15);
    for (const button of appearance.targets) {
      expect(button.height, `${button.text} needs a large touch target`).toBeGreaterThanOrEqual(48);
      expect(button.width, `${button.text} needs a large touch target`).toBeGreaterThanOrEqual(48);
      expect(button.font, `${button.text} should use legible operator text`).toBeGreaterThanOrEqual(16);
    }
    expect(appearance.overflow, 'Only the local time carousel may scroll horizontally').toBeLessThanOrEqual(2);
    const accept = row.getByRole('button', { name: 'დადასტურება', exact: true });
    await expect(accept).toBeEnabled();
    for (const button of [accept, options(row).getByRole('button', { name: 'ბარგი', exact: true })]) {
      const colors = await button.evaluate(element => {
        const style = getComputedStyle(element);
        const parse = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
        const luminance = (channels: number[]) => channels.slice(0, 3).map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
        const foreground = parse(style.color);
        const background = parse(style.backgroundColor);
        const first = luminance(foreground), second = luminance(background);
        return { green: background[1] > background[0] && background[1] > background[2], contrast: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) };
      });
      expect(colors.green, 'Selected options and accepting should be visibly green').toBeTruthy();
      expect(colors.contrast, 'Enabled operator actions need readable text contrast').toBeGreaterThanOrEqual(4.5);
    }
  });
}
