import { test as base, expect, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import { existsSync } from 'node:fs';
import { addDays, directions, today, type Booking, type Direction, type PassengerDetail, type PassengerProfile, type PublicConfig, type Schedule, type TripCapacity } from '../src/api';
import { operatorSessionPath } from './helpers/operator-session';

// Only the disposable database created by playwright.config.ts is used here.
const EMPLOYEE = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const GROUP_PATH = '/api/admin/bookings/group';
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'Independent manual passengers must not throw runtime errors').toEqual([]);
  }, { auto: true }],
});
let api: APIRequestContext;
let config: PublicConfig;
const bookingIds: number[] = [];
const changedSchedules = new Set<string>();
const travelDate = () => addDays(today(), 1);

test.beforeAll(async ({ playwright, baseURL }, info) => {
  const sessionPath = operatorSessionPath(info.config.metadata.fixtureDatabasePath);
  api = await playwright.request.newContext({ baseURL, ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}) });
  const session = await api.get('/api/auth/session');
  expect(session.ok()).toBeTruthy();
  const { user, needsSetup } = await session.json() as { user: { login: string } | null; needsSetup: boolean };
  if (user?.login !== EMPLOYEE.login) expect((await api.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: EMPLOYEE })).ok()).toBeTruthy();
  const response = await api.get('/api/public/config');
  expect(response.ok()).toBeTruthy();
  config = await response.json() as PublicConfig;
  expect(config.stops.some(stop => stop.active)).toBeTruthy();
});
test.afterEach(async () => {
  for (const id of new Set(bookingIds.splice(0))) expect((await api.post(`/api/admin/bookings/${id}/delete`)).ok()).toBeTruthy();
  for (const direction of changedSchedules) {
    expect((await api.delete(`/api/admin/schedule/date?${new URLSearchParams({ direction, date: travelDate() })}`)).ok()).toBeTruthy();
  }
  changedSchedules.clear();
});
test.afterAll(async () => { await api?.dispose(); });

function cards(dialog: Locator): Locator { return dialog.locator('[data-manual-passenger-id]'); }
function group(card: Locator, name: string): Locator { return card.getByRole('group', { name, exact: true }); }
function services(card: Locator): Locator { return group(card, 'დამატებითი სერვისები'); }
function times(card: Locator): Locator { return group(card, 'დრო'); }
function seats(card: Locator): Locator { return group(card, 'ადგილების რაოდენობა'); }
function confirm(dialog: Locator): Locator { return dialog.getByRole('button', { name: /^ყველა ჯავშნის დადასტურება/ }); }
function retry(dialog: Locator): Locator { return dialog.getByRole('button', { name: 'განმეორებით გაგზავნა', exact: true }); }
function display(phone: string): string { return `${phone.slice(0, 3)} ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7)}`; }
function isProfile(response: Response, phone: string): boolean {
  const url = new URL(response.url());
  return url.pathname === '/api/admin/passengers/profile' && url.searchParams.get('phone') === phone;
}
function isGroupResponse(response: Response): boolean { return new URL(response.url()).pathname === GROUP_PATH && response.request().method() === 'POST'; }
async function openManual(page: Page): Promise<Locator> {
  await page.context().addCookies((await api.storageState()).cookies);
  await page.goto('/admin');
  await expect(page.locator('.auth-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'ახალი ჯავშანი', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ახალი ჯავშანი', exact: true });
  await expect(cards(dialog)).toHaveCount(1);
  await expect(cards(dialog).first()).toHaveAttribute('aria-label', 'მგზავრი 1');
  await expect(cards(dialog).first().getByLabel('ტელეფონის ნომერი', { exact: true })).toBeEnabled();
  return dialog;
}
async function fillContact(page: Page, card: Locator, phone: string, address: string, direction: Direction = 'gori-tbilisi'): Promise<void> {
  const profile = page.waitForResponse(response => isProfile(response, phone));
  await card.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
  expect((await profile).ok()).toBeTruthy();
  await card.getByLabel('ტელეფონის ნომერი', { exact: true }).blur();
  await card.getByLabel(direction === 'gori-tbilisi' ? 'აყვანის მისამართი გორში' : 'ჩამოსვლის მისამართი გორში', { exact: true }).fill(address);
}
async function chooseTrip(card: Locator, time: string, direction: Direction = 'gori-tbilisi'): Promise<void> {
  await group(card, 'მიმართულება').getByRole('button', { name: directions[direction], exact: true }).click();
  await group(card, 'თარიღი').getByRole('button', { name: /^ხვალ,/ }).click();
  await times(card).getByRole('button', { name: time, exact: true }).click();
  if (direction === 'tbilisi-gori') await card.getByLabel('აყვანის ადგილი თბილისში', { exact: true }).selectOption(String(config.stops.find(stop => stop.active)!.id));
}
async function addPassenger(dialog: Locator, count: number): Promise<Locator> {
  await dialog.getByRole('button', { name: 'მგზავრის დამატება', exact: true }).click();
  await expect(cards(dialog)).toHaveCount(count);
  const card = cards(dialog).nth(count - 1);
  await expect(card).toHaveAttribute('aria-label', `მგზავრი ${count}`);
  await expect(card.getByLabel('ტელეფონის ნომერი', { exact: true })).toBeEnabled();
  return card;
}
async function saveGroup(page: Page, dialog: Locator, replay = false): Promise<Booking[]> {
  const saved = page.waitForResponse(isGroupResponse);
  await expect(replay ? retry(dialog) : confirm(dialog)).toBeEnabled();
  await (replay ? retry(dialog) : confirm(dialog)).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const { bookings } = await response.json() as { bookings: Booking[] };
  bookingIds.push(...bookings.map(booking => booking.id));
  await expect(dialog).toHaveCount(0);
  return bookings;
}
async function capacity(time: string): Promise<TripCapacity> {
  const response = await api.get(`/api/admin/trips/capacity?${new URLSearchParams({ direction: 'gori-tbilisi', date: travelDate(), time })}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as TripCapacity;
}
async function profile(phone: string): Promise<PassengerProfile | null> {
  const response = await api.get(`/api/admin/passengers/profile?${new URLSearchParams({ phone })}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json() as { profile: PassengerProfile | null }).profile;
}
async function scheduled(phone: string, direction: Direction = 'gori-tbilisi'): Promise<Booking[]> {
  const response = await api.get(`/api/admin/bookings?${new URLSearchParams({ scope: 'scheduled', date: travelDate(), direction, search: phone })}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json() as { bookings: Booking[] }).bookings;
}
async function seed(phone: string, address: string): Promise<Booking> {
  const response = await api.post('/api/admin/bookings', { data: {
    phone, seats: 1, direction: 'gori-tbilisi', requestedDate: travelDate(), requestedTime: '21:00', goriAddress: address,
  } });
  expect(response.status()).toBe(201);
  const booking = await response.json() as Booking;
  bookingIds.push(booking.id);
  return booking;
}

test('manual passengers inherit only the first journey and shared caller, and removing the middle card preserves stable drafts', async ({ page }) => {
  const dialog = await openManual(page);
  const first = cards(dialog).first();
  await fillContact(page, first, '555890101', 'გორი, ხელით დამატებული პირველი მგზავრი 101');
  await chooseTrip(first, '09:30');
  await first.getByLabel('ზარის ნომერი', { exact: true }).fill('555890100');
  await first.getByLabel('ზარის ნომერი', { exact: true }).blur();
  await seats(first).getByRole('button', { name: '4 ადგილი', exact: true }).click();
  await services(first).getByRole('button', { name: 'ბარგი', exact: true }).click();
  await services(first).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await group(first, 'სასურველი ადგილი').getByRole('button', { name: 'წინ', exact: true }).click();
  const second = await addPassenger(dialog, 2);
  await expect(second.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('');
  await expect(second.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('');
  await expect(second.getByLabel('ზარის ნომერი', { exact: true })).toHaveValue(display('555890100'));
  await expect(times(second).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(seats(second).getByRole('button', { name: '1 ადგილი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['ბარგი', 'ძაღლი', 'გზავნილი', 'მთლიანი მანქანა']) await expect(services(second).getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');
  for (const name of ['წინ', 'უკან', 'შუაში']) await expect(group(second, 'სასურველი ადგილი').getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(confirm(dialog)).toBeDisabled();
  await fillContact(page, second, '555890102', 'გორი, მოსაშორებელი მეორე მგზავრი 102');
  await times(second).getByRole('button', { name: '10:00', exact: true }).click();
  await group(second, 'თარიღი').getByRole('button', { name: /^დღეს,/ }).click();
  await expect(group(first, 'თარიღი').getByRole('button', { name: /^ხვალ,/ })).toHaveAttribute('aria-pressed', 'true');
  const third = await addPassenger(dialog, 3);
  const thirdId = await third.getAttribute('data-manual-passenger-id');
  expect(thirdId).toBeTruthy();
  await expect(group(third, 'თარიღი').getByRole('button', { name: /^ხვალ,/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(times(third).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await fillContact(page, third, '555890103', 'გორი, დარჩენილი მესამე მგზავრი 103');
  await services(third).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await second.getByRole('button', { name: 'მგზავრის წაშლა', exact: true }).click();
  await expect(cards(dialog)).toHaveCount(2);
  const retained = cards(dialog).nth(1);
  await expect(retained).toHaveAttribute('data-manual-passenger-id', thirdId!);
  await expect(retained.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display('555890103'));
  await expect(retained.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, დარჩენილი მესამე მგზავრი 103');
  await expect(services(retained).getByRole('button', { name: 'ძაღლი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const bookings = await saveGroup(page, dialog);
  expect(bookings.map(booking => booking.phone)).toEqual(['555890101', '555890103']);
  expect(bookings.map(booking => booking.seats)).toEqual([4, 1]);
  expect(bookings.map(booking => booking.callerPhone)).toEqual(['555890100', '555890100']);
  expect(await profile('555890102')).toBeNull();
});

test('a manual group creates separate confirmed orders, contacts and services on independent trips', async ({ page }) => {
  const before = await capacity('11:00');
  const dialog = await openManual(page);
  const first = cards(dialog).first();
  await fillContact(page, first, '555890201', 'გორი, ჯგუფის პირველი ასაყვანი მისამართი 201');
  await chooseTrip(first, '11:00');
  await first.getByLabel('ზარის ნომერი', { exact: true }).fill('555890200');
  await first.getByLabel('ზარის ნომერი', { exact: true }).blur();
  await seats(first).getByRole('button', { name: '3 ადგილი', exact: true }).click();
  await services(first).getByRole('button', { name: 'ბარგი', exact: true }).click();
  await group(first, 'სასურველი ადგილი').getByRole('button', { name: 'უკან', exact: true }).click();
  const second = await addPassenger(dialog, 2);
  await chooseTrip(second, '12:00', 'tbilisi-gori');
  await fillContact(page, second, '555890202', 'გორი, მეორე მგზავრის ჩამოსვლის მისამართი 202', 'tbilisi-gori');
  await seats(second).getByRole('button', { name: '2 ადგილი', exact: true }).click();
  await services(second).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  const third = await addPassenger(dialog, 3);
  await fillContact(page, third, '555890203', 'გორი, ცალკე გზავნილის მისამართი 203');
  await times(third).getByRole('button', { name: '13:00', exact: true }).click();
  await services(third).getByRole('button', { name: 'გზავნილი', exact: true }).click();
  await expect(seats(third)).toHaveCount(0);
  const bookings = await saveGroup(page, dialog);
  expect(bookings).toHaveLength(3);
  expect(new Set(bookings.map(booking => booking.id)).size).toBe(3);
  expect(bookings[0]).toMatchObject({ phone: '555890201', seats: 3, direction: 'gori-tbilisi', assignedDate: travelDate(), assignedTime: '11:00', goriAddress: 'გორი, ჯგუფის პირველი ასაყვანი მისამართი 201', luggage: true, dog: false, seatPreference: 'back', bookingType: 'passenger' });
  expect(bookings[1]).toMatchObject({ phone: '555890202', seats: 2, direction: 'tbilisi-gori', assignedTime: '12:00', goriAddress: 'გორი, მეორე მგზავრის ჩამოსვლის მისამართი 202', pickupStopId: config.stops.find(stop => stop.active)!.id, luggage: false, dog: true });
  expect(bookings[2]).toMatchObject({ phone: '555890203', seats: 0, direction: 'gori-tbilisi', assignedTime: '13:00', bookingType: 'parcel', luggage: false, dog: false });
  for (const booking of bookings) {
    expect(booking).toMatchObject({ name: '', status: 'confirmed', callerPhone: '555890200', assignedDate: travelDate() });
    expect((await scheduled(booking.phone, booking.direction)).map(row => row.id)).toEqual([booking.id]);
    const detailResponse = await api.get(`/api/admin/passengers/${booking.phone}`);
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json() as PassengerDetail;
    expect(detail.bookings.map(row => row.id)).toEqual([booking.id]);
    expect(await profile(booking.phone)).not.toBeNull();
  }
  const after = await capacity('11:00');
  expect(after.bookingCount).toBe(before.bookingCount + 1);
  expect(after.bookedSeats).toBe(before.bookedSeats + 3);
  await page.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true }).fill(travelDate());
  await page.locator('.admin-time-strip').getByRole('button', { name: /^11:00\s/ }).click();
  const row = page.locator(`[data-booking-id="${bookings[0].id}"]`);
  await expect(row).toContainText(display('555890201'));
  await expect(row).toContainText('ბარგი');
});

test('late profile responses and a removed passenger cannot overwrite another manual card or its dirty fields', async ({ page }) => {
  const firstPhone = '555890301', slowPhone = '555890302', removedPhone = '555890303', currentPhone = '555890304';
  for (const [phone, address] of [[firstPhone, 'გორი, შენახული პირველი მისამართი 301'], [slowPhone, 'გორი, დაგვიანებული მეორე მისამართი 302'], [removedPhone, 'გორი, წაშლილი ბარათის მისამართი 303'], [currentPhone, 'გორი, მიმდინარე ახალი პროფილი 304']]) await seed(phone, address);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Set<string>();
  const completed = new Set<string>();
  await page.route('**/api/admin/passengers/profile?**', async route => {
    const phone = new URL(route.request().url()).searchParams.get('phone')!;
    if (![slowPhone, removedPhone].includes(phone)) { await route.continue(); return; }
    const response = await route.fetch();
    started.add(phone);
    await held;
    try { await route.fulfill({ response }); } catch { /* Removed or changed contacts abort their old lookup. */ }
    completed.add(phone);
  });
  const dialog = await openManual(page);
  const first = cards(dialog).first();
  await fillContact(page, first, firstPhone, 'გორი, დროებითი ხელით შეყვანილი მისამართი');
  await chooseTrip(first, '14:00');
  await first.getByLabel('აყვანის მისამართი გორში', { exact: true }).clear();
  await seats(first).getByRole('button', { name: '4 ადგილი', exact: true }).click();
  const second = await addPassenger(dialog, 2);
  const third = await addPassenger(dialog, 3);
  const secondId = await second.getAttribute('data-manual-passenger-id');
  const removedId = await third.getAttribute('data-manual-passenger-id');
  try {
    await second.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(slowPhone);
    await third.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(removedPhone);
    await expect.poll(() => started.size).toBe(2);
    await second.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, მეორე ბარათის ხელით შენარჩუნებული მისამართი');
    await times(second).getByRole('button', { name: '15:00', exact: true }).click();
    await services(second).getByRole('button', { name: 'ძაღლი', exact: true }).click();
    const lookup = page.waitForResponse(response => isProfile(response, currentPhone));
    await second.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(currentPhone);
    expect((await lookup).ok()).toBeTruthy();
    await third.getByRole('button', { name: 'მგზავრის წაშლა', exact: true }).click();
  } finally { release(); }
  await expect.poll(() => completed.size).toBe(2);
  await expect(cards(dialog)).toHaveCount(2);
  await expect(dialog.locator(`[data-manual-passenger-id="${removedId}"]`)).toHaveCount(0);
  await expect(second).toHaveAttribute('data-manual-passenger-id', secondId!);
  await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(firstPhone));
  await expect(first.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('');
  await expect(seats(first).getByRole('button', { name: '4 ადგილი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(times(first).getByRole('button', { name: '14:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(second.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(currentPhone));
  await expect(second.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, მეორე ბარათის ხელით შენარჩუნებული მისამართი');
  await expect(times(second).getByRole('button', { name: '15:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(services(second).getByRole('button', { name: 'ძაღლი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(confirm(dialog)).toBeDisabled();
});

test('a stale slot rejects the entire manual group, preserves the other card and allows an explicit correction', async ({ page }) => {
  const before = await capacity('16:00');
  const dialog = await openManual(page);
  const first = cards(dialog).first();
  await fillContact(page, first, '555890401', 'გორი, ატომური ჯგუფის პირველი მისამართი 401');
  await chooseTrip(first, '16:00');
  await seats(first).getByRole('button', { name: '3 ადგილი', exact: true }).click();
  const second = await addPassenger(dialog, 2);
  await fillContact(page, second, '555890402', 'გორი, გამოსასწორებელი საათის მისამართი 402');
  await times(second).getByRole('button', { name: '17:00', exact: true }).click();
  const scheduleResponse = await api.get(`/api/admin/schedule?direction=gori-tbilisi&date=${travelDate()}`);
  const schedule = await scheduleResponse.json() as Schedule;
  changedSchedules.add('gori-tbilisi');
  expect((await api.put('/api/admin/schedule/date', { data: { direction: 'gori-tbilisi', date: travelDate(), times: schedule.slots.filter(slot => slot.active && slot.time !== '17:00').map(slot => slot.time) } })).ok()).toBeTruthy();
  const rejected = page.waitForResponse(isGroupResponse);
  await confirm(dialog).click();
  const response = await rejected;
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'SLOT_INACTIVE' });
  await expect(dialog.locator('[data-manual-group-error]')).toBeVisible();
  for (const phone of ['555890401', '555890402']) {
    expect(await scheduled(phone)).toEqual([]);
    expect(await profile(phone)).toBeNull();
  }
  const afterFailure = await capacity('16:00');
  expect(afterFailure.bookingCount).toBe(before.bookingCount);
  expect(afterFailure.bookedSeats).toBe(before.bookedSeats);
  await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toBeEnabled();
  await expect(first.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, ატომური ჯგუფის პირველი მისამართი 401');
  await expect(times(first).getByRole('button', { name: '16:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(seats(first).getByRole('button', { name: '3 ადგილი', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(second.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, გამოსასწორებელი საათის მისამართი 402');
  await times(second).getByRole('button', { name: '18:00', exact: true }).click();
  const bookings = await saveGroup(page, dialog);
  expect(bookings.map(booking => booking.assignedTime)).toEqual(['16:00', '18:00']);
  expect((await capacity('16:00')).bookedSeats).toBe(before.bookedSeats + 3);
});

test('an uncertain manual group stays locked through network and server failures and retries the same commit without duplicates', async ({ page }) => {
  test.setTimeout(45_000);
  const before = await capacity('19:00');
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let committed: Booking[] = [];
  let releaseAbort!: () => void;
  const held = new Promise<void>(resolve => { releaseAbort = resolve; });
  await page.route(`**${GROUP_PATH}`, async route => {
    attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
    if (attempts.length === 2) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'დროებითი სატესტო სერვერის შეცდომა' }) });
      return;
    }
    if (attempts.length === 3) {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'დროებითი სატესტო ავტორიზაციის შეცდომა' }) });
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    const result = await response.json() as { bookings: Booking[] };
    bookingIds.push(...result.bookings.map(booking => booking.id));
    if (attempts.length === 1) { committed = result.bookings; await held; await route.abort('failed'); }
    else await route.fulfill({ response });
  });
  const dialog = await openManual(page);
  const first = cards(dialog).first();
  await fillContact(page, first, '555890501', 'გორი, დაკარგული პასუხის პირველი მისამართი 501');
  await chooseTrip(first, '19:00');
  const second = await addPassenger(dialog, 2);
  await fillContact(page, second, '555890502', 'გორი, დაკარგული პასუხის მეორე მისამართი 502');
  try {
    await confirm(dialog).click();
    await expect.poll(() => committed.length).toBe(2);
    await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toBeDisabled();
    await dialog.locator('form').evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    expect(attempts).toHaveLength(1);
  } finally { releaseAbort(); }
  await expect(dialog.locator('[data-manual-group-pending]')).toBeVisible();
  await expect(retry(dialog)).toBeEnabled();
  await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toBeDisabled();
  await expect(second.getByLabel('აყვანის მისამართი გორში', { exact: true })).toBeDisabled();
  await expect(second.getByRole('button', { name: 'მგზავრის წაშლა', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'მგზავრის დამატება', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'დახურვა', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  const failedAgain = page.waitForResponse(isGroupResponse);
  await retry(dialog).click();
  expect((await failedAgain).status()).toBe(503);
  await expect(retry(dialog)).toBeEnabled();
  await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toBeDisabled();
  const refusedRetry = page.waitForResponse(isGroupResponse);
  await retry(dialog).click();
  expect((await refusedRetry).status()).toBe(401);
  await expect(retry(dialog)).toBeEnabled();
  await expect(dialog.locator('[data-manual-group-pending]')).toBeVisible();
  await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toBeDisabled();
  await expect(second.getByRole('button', { name: 'მგზავრის წაშლა', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'მგზავრის დამატება', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'დახურვა', exact: true })).toBeDisabled();
  // A retry must use its frozen request even after the client clock passes the
  // trip. The local server still owns the original acknowledged transaction.
  await page.clock.setFixedTime(new Date(`${travelDate()}T19:01:00+04:00`));
  const retried = await saveGroup(page, dialog, true);
  expect(retried.map(booking => booking.id)).toEqual(committed.map(booking => booking.id));
  expect(attempts).toHaveLength(4);
  expect(attempts[0].key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[2]).toEqual(attempts[0]);
  expect(attempts[3]).toEqual(attempts[0]);
  for (const booking of committed) expect((await scheduled(booking.phone)).map(row => row.id)).toEqual([booking.id]);
  const after = await capacity('19:00');
  expect(after.bookingCount).toBe(before.bookingCount + 2);
  expect(after.bookedSeats).toBe(before.bookedSeats + 2);
});

test('closing an unsaved manual group creates no orders or saved profiles and reopening starts with one blank passenger', async ({ page }) => {
  const before = await capacity('20:00');
  const posts: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && ['/api/admin/bookings', GROUP_PATH].includes(path)) posts.push(path);
  });
  const dialog = await openManual(page);
  const first = cards(dialog).first();
  await fillContact(page, first, '555890601', 'გორი, გაუგზავნელი პირველი მისამართი 601');
  await chooseTrip(first, '20:00');
  const second = await addPassenger(dialog, 2);
  await fillContact(page, second, '555890602', 'გორი, გაუგზავნელი მეორე მისამართი 602');
  await services(second).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await expect(confirm(dialog)).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(posts).toEqual([]);
  for (const phone of ['555890601', '555890602']) {
    expect(await scheduled(phone)).toEqual([]);
    expect(await profile(phone)).toBeNull();
  }
  const after = await capacity('20:00');
  expect(after.bookingCount).toBe(before.bookingCount);
  expect(after.bookedSeats).toBe(before.bookedSeats);
  await page.getByRole('button', { name: 'ახალი ჯავშანი', exact: true }).click();
  await expect(cards(dialog)).toHaveCount(1);
  await expect(cards(dialog).first().getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('');
  await expect(cards(dialog).first().getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('');
});

for (const width of [1440, 320, 390]) {
  test(`manual group cards fit ${width}px with readable fields and large add, remove and save controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const dialog = await openManual(page);
    const first = cards(dialog).first();
    await fillContact(page, first, `555891${String(width).padStart(3, '0').slice(-3)}`, `გორი, დიდი ღილაკების პირველი მისამართი ${width}`);
    await chooseTrip(first, '09:00');
    const second = await addPassenger(dialog, 2);
    await fillContact(page, second, `555892${String(width).padStart(3, '0').slice(-3)}`, `გორი, დიდი ღილაკების მეორე მისამართი ${width}`);
    await expect(confirm(dialog)).toBeEnabled();
    for (const action of [dialog.getByRole('button', { name: 'მგზავრის დამატება', exact: true }), second.getByRole('button', { name: 'მგზავრის წაშლა', exact: true }), confirm(dialog)]) {
      const appearance = await action.evaluate(button => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height, font: parseFloat(getComputedStyle(button).fontSize) };
      });
      expect(appearance.width, 'Manual group actions need generous touch targets').toBeGreaterThanOrEqual(48);
      expect(appearance.height, 'Manual group actions need generous touch targets').toBeGreaterThanOrEqual(48);
      expect(appearance.font, 'Manual group actions must remain readable').toBeGreaterThanOrEqual(16);
    }
    const layout = await dialog.evaluate(element => ({
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      dialogOverflow: element.scrollWidth - element.clientWidth,
      outsideCards: Array.from(element.querySelectorAll('[data-manual-passenger-id]')).filter(card => { const rect = card.getBoundingClientRect(); return rect.left < 0 || rect.right > innerWidth + 1; }).length,
      fields: Array.from(element.querySelectorAll('input[type=tel],textarea')).map(field => parseFloat(getComputedStyle(field).fontSize)),
      overflowingServiceButtons: Array.from(element.querySelectorAll('.operator-booking-options-services button')).filter(button => button.scrollWidth > button.clientWidth + 2).map(button => button.textContent?.trim()),
      addressLabels: Array.from(element.querySelectorAll<HTMLElement>('.admin-operator-location > label')).filter(label => label.querySelector('textarea')).map(label => {
        const style = getComputedStyle(label);
        const textRects = Array.from(label.childNodes).filter(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()).flatMap(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          return Array.from(range.getClientRects()).map(rect => ({ top: rect.top, bottom: rect.bottom }));
        });
        return { display: style.display, direction: style.flexDirection, textBottom: Math.max(...textRects.map(rect => rect.bottom)), textareaTop: label.querySelector('textarea')!.getBoundingClientRect().top, textLines: textRects.length };
      }),
    }));
    expect(layout.pageOverflow).toBeLessThanOrEqual(2);
    expect(layout.dialogOverflow).toBeLessThanOrEqual(2);
    expect(layout.outsideCards).toBe(0);
    expect(Math.min(...layout.fields)).toBeGreaterThanOrEqual(16);
    expect(layout.overflowingServiceButtons, 'Every service label must fit inside its own button, including the nested parcel and whole-car controls').toEqual([]);
    expect(layout.addressLabels).toHaveLength(2);
    for (const label of layout.addressLabels) {
      expect(label.display, 'Address labels must stack their entire caption above the input').toBe('flex');
      expect(label.direction).toBe('column');
      expect(label.textLines).toBeGreaterThan(0);
      expect(label.textBottom, 'A wrapped Georgian address caption must not disappear behind the textarea').toBeLessThanOrEqual(label.textareaTop + 0.5);
    }
    await dialog.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: `/tmp/manual-group-${width === 1440 ? 'desktop' : width}.png` });
    await dialog.getByRole('button', { name: 'მგზავრის დამატება', exact: true }).scrollIntoViewIfNeeded();
    await expect(confirm(dialog)).toBeInViewport();
    await page.screenshot({ path: `/tmp/manual-group-${width === 1440 ? 'desktop' : width}-actions.png` });
  });
}
