import { test as base, expect, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Booking, CallInquiry, Direction, PassengerProfile, PublicConfig } from '../src/api';
import { createDatabase } from '../server/database';

const EMPLOYEE = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const TIMES = ['06:00', '07:00', '08:00', '08:30', '09:00', '09:30', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00'];
const DIRECTION_LABELS: Record<Direction, string> = {
  'gori-tbilisi': 'გორი → თბილისი',
  'tbilisi-gori': 'თბილისი → გორი',
};

const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(`Runtime: ${error.message}`));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const source = `${message.location().url} ${message.text()}`;
      if (/\/favicon\.ico\b/.test(source)) return;
      errors.push(`Console: ${source}`);
    });
    await use(errors);
    expect(errors, 'The UI should not log console errors or throw runtime errors').toEqual([]);
  }, { auto: true }],
});

let adminApi: APIRequestContext;
let publicConfig: PublicConfig;

function futureDate(days = 2): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  const date = new Date(`${part('year')}-${part('month')}-${part('day')}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test.beforeAll(async ({ playwright, baseURL }) => {
  adminApi = await playwright.request.newContext({ baseURL });
  const session = await adminApi.get('/api/auth/session');
  expect(session.ok()).toBeTruthy();
  const { needsSetup } = await session.json() as { needsSetup: boolean };
  // Playwright restarts a worker after a failure, while the isolated server DB remains.
  const auth = await adminApi.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: EMPLOYEE });
  expect(auth.ok(), 'The isolated test employee must be created or signed in').toBeTruthy();
  const config = await adminApi.get('/api/public/config');
  expect(config.ok()).toBeTruthy();
  publicConfig = await config.json() as PublicConfig;
  expect(publicConfig.stops.length).toBeGreaterThan(0);
});

test.afterAll(async () => { await adminApi?.dispose(); });

async function login(page: Page) {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'მოგესალმებით', exact: true })).toBeVisible();
  await page.getByLabel('მომხმარებლის სახელი', { exact: true }).fill(EMPLOYEE.login);
  await page.getByLabel('პაროლი', { exact: true }).fill(EMPLOYEE.password);
  const response = page.waitForResponse(value => value.url().endsWith('/api/auth/login') && value.request().method() === 'POST');
  await page.getByRole('button', { name: 'შესვლა', exact: true }).click();
  expect((await response).ok()).toBeTruthy();
  await expect(page.locator('.auth-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'ჯავშნები', exact: true })).toBeVisible();
}

function bookingRow(page: Page, name: string) {
  return page.locator('.admin-booking-table tbody tr').filter({ has: page.getByText(name, { exact: true }) });
}

function bookingRowById(page: Page, id: number) {
  return page.locator(`.admin-booking-table tbody tr[data-booking-id="${id}"]`);
}

async function openAdminView(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true })
    .getByRole('button', { name: name === 'შემოსული' ? /^შემოსული/ : name, exact: name !== 'შემოსული' }).click();
}

async function chooseAdminDate(page: Page, day: string) {
  await page.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true }).fill(day);
}

async function chooseAdminTime(page: Page, time: string) {
  await page.locator('.admin-time-strip').getByRole('button', { name: new RegExp(`^${time}\\s`) }).click();
}

async function openAuthenticatedAdmin(page: Page) {
  // Reuse the synthetic fixture's authenticated session for extra feature cases.
  // The existing login/logout scenario still exercises the real sign-in form.
  await page.context().addCookies((await adminApi.storageState()).cookies);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'ჯავშნები', exact: true })).toBeVisible();
}

async function openManualOrder(page: Page) {
  await page.getByRole('button', { name: 'ახალი ჯავშანი', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ახალი ჯავშანი', exact: true });
  await expect(dialog.getByLabel('ტელეფონის ნომერი', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveCount(0);
  return dialog;
}

function operatorGroup(dialog: Locator, name: 'მიმართულება' | 'ადგილების რაოდენობა' | 'თარიღი' | 'დრო') {
  return dialog.getByRole('group', { name, exact: true });
}

async function chooseOperatorDirection(dialog: Locator, direction: Direction) {
  const button = operatorGroup(dialog, 'მიმართულება').getByRole('button', { name: DIRECTION_LABELS[direction], exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function chooseOperatorSeats(dialog: Locator, seats: number) {
  const group = operatorGroup(dialog, 'ადგილების რაოდენობა');
  await expect(group.getByRole('button')).toHaveCount(8);
  const button = group.getByRole('button', { name: `${seats} ადგილი`, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

function operatorDayButton(dialog: Locator, day: string) {
  const [, month, date] = day.split('-');
  return operatorGroup(dialog, 'თარიღი').getByRole('button', { name: new RegExp(`^(დღეს|ხვალ), ${date}/${month}$`) });
}

async function chooseOperatorDay(dialog: Locator, day: string) {
  const button = operatorDayButton(dialog, day);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function chooseOperatorTime(dialog: Locator, time: string) {
  const button = operatorGroup(dialog, 'დრო').getByRole('button', { name: time, exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

function isProfileResponse(response: Response, canonicalPhone: string): boolean {
  const url = new URL(response.url());
  return url.pathname === '/api/admin/passengers/profile' && url.searchParams.get('phone') === canonicalPhone;
}

async function seedConfirmedProfile(input: {
  phone: string; name: string; address: string; pickupStopId?: number;
}) {
  const response = await adminApi.post('/api/admin/bookings', { data: {
    name: input.name, phone: input.phone, seats: 4,
    direction: input.pickupStopId ? 'tbilisi-gori' : 'gori-tbilisi',
    pickupStopId: input.pickupStopId ?? null,
    goriAddress: input.address, requestedDate: futureDate(1), requestedTime: '21:00',
  } });
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({
    name: input.name, phone: input.phone, status: 'confirmed', seats: 4,
  });
}

function incomingCallRow(page: Page, id: number) {
  return page.locator(`.admin-calls-table tbody tr[data-call-id="${id}"]`);
}

function displayedPassengerPhone(phone: string): string {
  return `${phone.slice(0, 3)} ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7)}`;
}

function passengerRow(page: Page, phone: string) {
  return page.locator(`tr[data-passenger-phone="${phone}"]`);
}

async function seedPassengerTrip(input: {
  phone: string; name: string; address: string; seats?: number; pickupStopId?: number; waiting?: boolean;
}) {
  const response = await adminApi.post(input.waiting ? '/api/bookings' : '/api/admin/bookings', { data: {
    phone: input.phone, name: input.name, seats: input.seats ?? 1,
    direction: input.pickupStopId ? 'tbilisi-gori' : 'gori-tbilisi',
    pickupStopId: input.pickupStopId ?? null, goriAddress: input.address,
    requestedDate: futureDate(1), requestedTime: '21:00',
  } });
  expect(response.ok()).toBeTruthy();
  return await response.json() as Booking;
}

async function openPassengerHistory(page: Page, phone: string) {
  await passengerRow(page, phone).getByRole('link', {
    name: `${displayedPassengerPhone(phone)}: მგზავრობის ისტორია`, exact: true,
  }).first().click();
  await expect(page).toHaveURL(new RegExp(`/admin/passengers/${phone}$`));
  await expect(page.getByRole('heading', { name: displayedPassengerPhone(phone), exact: true })).toBeVisible();
  return page.getByRole('table', { name: 'მგზავრობის ისტორია', exact: true });
}

async function searchPassengerDirectory(page: Page, value: string) {
  const response = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/passengers' && url.searchParams.get('search') === value;
  });
  await page.getByRole('textbox', { name: 'მისამართი ან ტელეფონი', exact: true }).fill(value);
  expect((await response).ok()).toBeTruthy();
}

function passengerHistoryFilter(page: Page, name: 'წარსული' | 'დაგეგმილი' | 'ყველა' | 'დასადასტურებელი' | 'წაშლილი') {
  return page.getByRole('group', { name: 'მგზავრობის ისტორიის ფილტრი', exact: true })
    .getByRole('button', { name: new RegExp(`^${name}(?:\\s|\\d|$)`) });
}

async function chooseCallDay(row: Locator, name: 'დღეს' | 'ხვალ') {
  const button = row.getByRole('group', { name: 'დღე', exact: true }).getByRole('button', { name: new RegExp(`^${name}(?:\\s|\\d|$)`) });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function chooseCallTime(row: Locator, time: string) {
  const button = row.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: time, exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function chooseCallSeats(row: Locator, seats: number) {
  const group = row.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true });
  await expect(group.getByRole('button')).toHaveCount(8);
  const button = group.getByRole('button', { name: new RegExp(`^${seats}(?: ადგილი)?$`) });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function seedAnsweredCall(phone: string | null, eventId: string, deviceName = 'Inline browser fixture') {
  const paired = await adminApi.post('/api/admin/devices', { data: { name: deviceName } });
  expect(paired.status()).toBe(201);
  const { token } = await paired.json() as { token: string };
  const event = { eventId, kind: 'incoming', phase: 'answered', phone: phone === null ? null : `+995${phone}`, occurredAt: new Date().toISOString(), durationSeconds: 0 };
  const headers = { Authorization: `Bearer ${token}` };
  const response = await adminApi.post('/api/integrations/android/calls', { headers, data: event });
  expect(response.status()).toBe(201);
  return { id: (await response.json() as { id: number }).id, event, headers };
}

type PrintedDocument = { html: string; text: string; headings: string[]; rows: string[][] };
type PrintBrowserWindow = Window & { __greenTaxiPrintedDocuments?: PrintedDocument[] };

async function captureNativePrinting(page: Page) {
  await page.addInitScript(() => {
    const topWindow = window.top as PrintBrowserWindow;
    topWindow.__greenTaxiPrintedDocuments ??= [];
    // This script also runs in attached same-origin print frames. Capture the exact
    // document at the native-print boundary without opening the OS print dialog.
    window.print = () => {
      topWindow.__greenTaxiPrintedDocuments!.push({
        html: document.documentElement.outerHTML,
        text: document.body?.innerText ?? '',
        headings: Array.from(document.querySelectorAll('thead th'), cell => cell.textContent?.trim() ?? ''),
        rows: Array.from(document.querySelectorAll('tbody tr'), row =>
          Array.from(row.querySelectorAll('td'), cell => cell.textContent?.trim() ?? '')),
      });
    };
  });
}

async function printedDocuments(page: Page): Promise<PrintedDocument[]> {
  return page.evaluate(() => (window as PrintBrowserWindow).__greenTaxiPrintedDocuments ?? []);
}

type PrintableFixture = {
  name: string; phone: string; displayedPhone: string; seats: number;
  direction: Direction; time: string; goriAddress: string;
};

async function clearScheduledFixtureDay(day: string) {
  // New operator bookings share the two-day window. Keep each print fixture
  // independent of earlier scenarios in this disposable test database.
  const response = await adminApi.get(`/api/admin/bookings?${new URLSearchParams({ scope: 'scheduled', date: day })}`);
  expect(response.ok()).toBeTruthy();
  for (const booking of (await response.json() as { bookings: Booking[] }).bookings) {
    expect((await adminApi.post(`/api/admin/bookings/${booking.id}/delete`, { data: {} })).ok()).toBeTruthy();
  }
}

async function setHistoricalFixtureDate(id: number, day: string) {
  // API-created fixtures can represent an existing earlier trip without trying
  // to book an elapsed departure. Use only this run's disposable server DB.
  const dbPath = test.info().config.metadata.fixtureDatabasePath;
  expect(typeof dbPath).toBe('string');
  expect(basename(dbPath)).toBe('greentaxi.sqlite');
  const fixtureDirectory = dirname(resolve(dbPath));
  expect(dirname(fixtureDirectory)).toBe(resolve(tmpdir()));
  expect(basename(fixtureDirectory)).toMatch(/^greentaxi-e2e-[^/]+$/);
  expect(dbPath).toBe(join(fixtureDirectory, 'greentaxi.sqlite'));
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) expect(existsSync(dbPath)).toBeTruthy();
  const database = await createDatabase({ dbPath, databaseUrl, production: false });
  try {
    const changed = await database.prepare("UPDATE bookings SET requested_date=?,assigned_date=? WHERE id=? AND status='confirmed' AND source='employee'").run(day, day, id);
    expect(changed.changes).toBe(1);
  } finally { await database.close(); }
}

async function seedPrintableDay(day: string, phonePrefix: string, namePrefix: string) {
  await clearScheduledFixtureDay(day);
  const expected: PrintableFixture[] = Array.from({ length: 20 }, (_, index) => {
    const phone = `${phonePrefix}${String(index + 1).padStart(3, '0')}`;
    return {
      name: `${namePrefix} ${index === 0 ? 'პირველი მგზავრი' : String(index + 1).padStart(2, '0')}`,
      phone, displayedPhone: `${phone.slice(0, 3)} ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7)}`,
      seats: index < 18 ? index % 4 + 1 : index === 18 ? 2 : 3,
      direction: index < 18 ? 'gori-tbilisi' : 'tbilisi-gori',
      time: index < 6 || index === 18 ? '08:30' : index < 12 || index === 19 ? '09:30' : '10:00',
      goriAddress: `გორი, ბეჭდვის სრული სატესტო მისამართი ${index + 1}, კორპუსი 7, სადარბაზო 2, სართული 3, ბინა 19; შეინარჩუნეთ მისამართის სრული ტექსტი${index === 0 ? '; ორიენტირი: <span>სატესტო ტექსტი</span>' : ''}`,
    };
  });
  for (const row of expected) {
    const response = await adminApi.post('/api/admin/bookings', { data: {
      name: row.name, phone: row.phone, seats: row.seats, direction: row.direction,
      goriAddress: row.goriAddress, requestedDate: day, requestedTime: row.time,
      ...(row.direction === 'tbilisi-gori' ? { pickupStopId: publicConfig.stops[0].id } : {}),
    } });
    expect(response.ok()).toBeTruthy();
  }
  const excludedNames = [`${namePrefix} წაშლილი`, `${namePrefix} მოლოდინში`, `${namePrefix} სხვა თარიღი`];
  const common = { direction: 'gori-tbilisi', seats: 4, goriAddress: 'გორი, ბეჭდვაში გამორიცხული მისამართი', requestedTime: '08:30' };
  const deleted = await adminApi.post('/api/admin/bookings', { data: { ...common, name: excludedNames[0], phone: `${phonePrefix}900`, requestedDate: day } });
  expect(deleted.ok()).toBeTruthy();
  const { id } = await deleted.json() as { id: number };
  expect((await adminApi.post(`/api/admin/bookings/${id}/delete`, { data: {} })).ok()).toBeTruthy();
  expect((await adminApi.post('/api/bookings', { data: { ...common, name: excludedNames[1], phone: `${phonePrefix}901`, requestedDate: day } })).ok()).toBeTruthy();
  const moved = await adminApi.post('/api/admin/bookings', { data: { ...common, name: excludedNames[2], phone: `${phonePrefix}902`, requestedDate: day } });
  expect(moved.ok()).toBeTruthy();
  const movedId = (await moved.json() as { id: number }).id;
  await setHistoricalFixtureDate(movedId, futureDate(0));
  return { expected, excludedNames };
}

async function expectPublicStep(page: Page, name: 'მგზავრობა' | 'მისამართი' | 'კონტაქტი') {
  const current = page.getByRole('list', { name: 'დაჯავშნის ეტაპები', exact: true }).locator('[aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText(name);
}

async function choosePublicSeats(page: Page, count: number) {
  const seats = page.getByRole('spinbutton', { name: 'ადგილების რაოდენობა', exact: true });
  const decrease = page.getByRole('button', { name: 'ადგილების რაოდენობის შემცირება', exact: true });
  const increase = page.getByRole('button', { name: 'ადგილების რაოდენობის გაზრდა', exact: true });
  await expect(seats).toHaveValue('1');
  await expect(decrease).toBeDisabled();
  for (let value = 1; value < count; value++) await increase.click();
  await expect(seats).toHaveValue(String(count));
  if (count === 4) await expect(increase).toBeDisabled();
}

async function continuePublicBooking(page: Page, name: 'მისამართი' | 'კონტაქტი') {
  await page.getByRole('button', { name: 'გაგრძელება', exact: true }).click();
  await expectPublicStep(page, name);
}

async function fillPublicForm(page: Page, input: {
  direction: Direction; seats: number; name: string; date?: string; time?: string;
}) {
  const day = input.date ?? futureDate();
  const address = 'გორი, სატესტო ქუჩა 12';
  await page.goto('/');
  await expectPublicStep(page, 'მგზავრობა');
  await page.getByRole('button', { name: DIRECTION_LABELS[input.direction], exact: true }).click();
  await page.getByLabel('მგზავრობის თარიღი', { exact: true }).fill(day);
  await expect(page.getByRole('group', { name: 'მგზავრობის დრო', exact: true }).getByRole('button')).toHaveText(TIMES);
  await choosePublicSeats(page, input.seats);
  await page.getByRole('button', { name: input.time ?? '08:30', exact: true }).click();
  await continuePublicBooking(page, 'მისამართი');
  if (input.direction === 'gori-tbilisi') {
    await page.getByLabel('ჩასხდომის მისამართი გორში', { exact: true }).fill(address);
    await expect(page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true })).toHaveCount(0);
    await expect(page.locator('.booking-fixed-location')).toContainText(publicConfig.didubeName);
    await expect(page.locator('.booking-fixed-location')).toContainText(publicConfig.didubeAddress);
  } else {
    await page.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill(address);
    await page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[0].id));
    await expect(page.locator('.booking-fixed-location')).toHaveCount(0);
  }
  await continuePublicBooking(page, 'კონტაქტი');
  await page.getByLabel('სახელი და გვარი', { exact: true }).fill(input.name);
  await page.getByLabel('ტელეფონის ნომერი', { exact: true }).fill('+995555000123');
  return { day, address };
}

async function submitPublicForm(page: Page): Promise<number> {
  const pending = page.waitForResponse(response => response.url().endsWith('/api/bookings') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'ჯავშნის გაგზავნა', exact: true }).click();
  const response = await pending;
  expect(response.ok()).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'თქვენი განაცხადი მიღებულია', exact: true })).toBeVisible();
  await expect(page.locator('.booking-pending-note')).toBeVisible();
  return (await response.json() as { id: number }).id;
}

for (const direction of Object.keys(DIRECTION_LABELS) as Direction[]) {
  for (const seats of [1, 2, 3, 4]) {
    test(`guest booking: ${direction}, ${seats} seat(s) enters the queue with correct addresses`, async ({ page }) => {
      const name = `სატესტო მგზავრი ${direction} ${seats}`;
      const { day, address } = await fillPublicForm(page, { direction, seats, name });
      if (direction === 'gori-tbilisi' && seats === 1) {
        await page.screenshot({ path: '/tmp/greentaxi-public-desktop.png', fullPage: true });
      }
      const id = await submitPublicForm(page);
      await expect(page.locator('.booking-success-summary')).toContainText(`${seats} ადგილი`);
      const incoming = await adminApi.get('/api/admin/bookings?scope=incoming');
      expect(incoming.ok()).toBeTruthy();
      const saved = (await incoming.json() as { bookings: Booking[] }).bookings.find(booking => booking.id === id);
      expect(saved).toMatchObject({
        name, phone: '555000123', direction, seats, goriAddress: address, requestedDate: day,
        requestedTime: '08:30', status: 'waiting', assignedDate: null, assignedTime: null,
        pickupStopId: direction === 'tbilisi-gori' ? publicConfig.stops[0].id : null,
        pickupStopName: direction === 'tbilisi-gori' ? publicConfig.stops[0].name : null,
      });
    });
  }
}

test('public booking validates each step and preserves every field when going back', async ({ page }) => {
  const name = 'სატესტო ეტაპებით უკან დაბრუნებული მგზავრი';
  const phone = '555074101';
  const address = 'გორი, ეტაპების სატესტო მისამართი';
  const day = futureDate(6);
  const posts: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/bookings' && request.method() === 'POST') posts.push(request.url());
  });
  await page.goto('/');
  await expectPublicStep(page, 'მგზავრობა');
  await page.getByRole('button', { name: DIRECTION_LABELS['tbilisi-gori'], exact: true }).click();
  await page.getByLabel('მგზავრობის თარიღი', { exact: true }).fill(day);
  await expect(page.getByRole('group', { name: 'მგზავრობის დრო', exact: true }).getByRole('button')).toHaveText(TIMES);
  await choosePublicSeats(page, 4);
  await page.getByRole('button', { name: 'ადგილების რაოდენობის შემცირება', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'ადგილების რაოდენობა', exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: 'გაგრძელება', exact: true }).click();
  await expectPublicStep(page, 'მგზავრობა');
  await expect(page.getByRole('alert')).toBeVisible();
  expect(posts, 'Journey validation must not create an order').toHaveLength(0);
  await page.getByRole('button', { name: '09:30', exact: true }).click();
  await continuePublicBooking(page, 'მისამართი');
  await page.getByRole('button', { name: 'გაგრძელება', exact: true }).click();
  await expectPublicStep(page, 'მისამართი');
  await expect(page.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  expect(posts, 'Address validation must not create an order').toHaveLength(0);
  await page.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill(address);
  await page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[0].id));
  await continuePublicBooking(page, 'კონტაქტი');
  await page.getByLabel('სახელი და გვარი', { exact: true }).fill(name);
  await page.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(`+995${phone}`);
  await page.getByLabel('ტელეფონის ნომერი', { exact: true }).blur();
  await page.getByRole('button', { name: 'უკან', exact: true }).click();
  await expectPublicStep(page, 'მისამართი');
  await expect(page.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(address);
  await expect(page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true })).toHaveValue(String(publicConfig.stops[0].id));
  await page.getByRole('button', { name: 'უკან', exact: true }).click();
  await expectPublicStep(page, 'მგზავრობა');
  await expect(page.getByRole('button', { name: DIRECTION_LABELS['tbilisi-gori'], exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('მგზავრობის თარიღი', { exact: true })).toHaveValue(day);
  await expect(page.getByRole('spinbutton', { name: 'ადგილების რაოდენობა', exact: true })).toHaveValue('3');
  await expect(page.getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await continuePublicBooking(page, 'მისამართი');
  await continuePublicBooking(page, 'კონტაქტი');
  await expect(page.getByLabel('სახელი და გვარი', { exact: true })).toHaveValue(name);
  await expect(page.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('555 07 41 01');
  await page.getByLabel('ტელეფონის ნომერი', { exact: true }).fill('123');
  await page.getByRole('button', { name: 'ჯავშნის გაგზავნა', exact: true }).click();
  await expectPublicStep(page, 'კონტაქტი');
  await expect(page.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert')).toBeVisible();
  expect(posts, 'Invalid contact information must not create an order').toHaveLength(0);
  await page.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
  const id = await submitPublicForm(page);
  expect(posts).toHaveLength(1);
  const incoming = await adminApi.get('/api/admin/bookings?scope=incoming');
  expect(incoming.ok()).toBeTruthy();
  expect((await incoming.json() as { bookings: Booking[] }).bookings.find(booking => booking.id === id)).toMatchObject({
    name, phone, direction: 'tbilisi-gori', seats: 3, goriAddress: address,
    requestedDate: day, requestedTime: '09:30', pickupStopId: publicConfig.stops[0].id,
    status: 'waiting', assignedDate: null, assignedTime: null,
  });
});

test('public booking prevents concurrent submits and retries a lost response with the same idempotency key', async ({ page }) => {
  const name = 'სატესტო დაკარგული პასუხის ხელახალი გაგზავნა';
  const posts: { key: string | undefined; payload: unknown }[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/bookings' && request.method() === 'POST') {
      posts.push({ key: request.headers()['idempotency-key'], payload: request.postDataJSON() });
    }
  });
  await fillPublicForm(page, { direction: 'gori-tbilisi', seats: 2, name, date: futureDate(7) });
  const errorMessage = 'სატესტო პასუხი დაიკარგა — სცადეთ ხელახლა';
  await page.evaluate(message => {
    const originalFetch = window.fetch;
    let attempts = 0;
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    (window as Window & { __releasePublicBookingResponse?: () => void }).__releasePublicBookingResponse = release;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.pathname !== '/api/bookings' || method !== 'POST') return originalFetch.call(window, input, init);
      const first = ++attempts === 1;
      const response = await originalFetch.call(window, input, init);
      if (!first) return response;
      // The real server has already accepted the request. Hold the response while
      // checking the submit lock, then model a lost response as a local failure.
      // Drain its body first so Chromium completes the real network response.
      await response.arrayBuffer();
      await hold;
      return new Response(JSON.stringify({ error: message }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    };
  }, errorMessage);
  const firstResponse = page.waitForResponse(response => response.url().endsWith('/api/bookings') && response.request().method() === 'POST');
  await page.locator('form').evaluate(form => {
    for (let attempt = 0; attempt < 2; attempt++) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  const accepted = await firstResponse;
  expect(accepted.ok()).toBeTruthy();
  const firstId = (await accepted.json() as { id: number }).id;
  await expect(page.locator('form button[type="submit"]')).toBeDisabled();
  expect(posts, 'Two simultaneous submit events must cause only one in-flight POST').toHaveLength(1);
  expect(posts[0].key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  await page.evaluate(() => (window as Window & { __releasePublicBookingResponse?: () => void }).__releasePublicBookingResponse?.());
  await expect(page.getByRole('alert')).toContainText(errorMessage);
  await expectPublicStep(page, 'კონტაქტი');
  await expect(page.getByLabel('სახელი და გვარი', { exact: true })).toHaveValue(name);
  await expect(page.getByRole('button', { name: 'ჯავშნის გაგზავნა', exact: true })).toBeEnabled();
  const retriedId = await submitPublicForm(page);
  expect(retriedId).toBe(firstId);
  expect(posts).toHaveLength(2);
  expect(posts[1].key).toBe(posts[0].key);
  expect(posts[1].payload).toEqual(posts[0].payload);
  const incoming = await adminApi.get(`/api/admin/bookings?${new URLSearchParams({ scope: 'incoming', search: name })}`);
  expect(incoming.ok()).toBeTruthy();
  expect((await incoming.json() as { bookings: Booking[] }).bookings).toEqual([
    expect.objectContaining({ id: firstId, name, status: 'waiting', seats: 2, phone: '555000123' }),
  ]);
});

test('staff login persists across reload and logout closes access', async ({ page }) => {
  await login(page);
  await expect(page.locator('.admin-user')).toContainText(EMPLOYEE.name);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'ჯავშნები', exact: true })).toBeVisible();
  await expect(page.locator('.admin-user')).toContainText(EMPLOYEE.name);
  const logout = page.waitForResponse(response => response.url().endsWith('/api/auth/logout'));
  await page.getByRole('button', { name: 'გასვლა', exact: true }).click();
  expect((await logout).ok()).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'მოგესალმებით', exact: true })).toBeVisible();
  const protectedResponse = await page.context().request.get('/api/admin/bookings?scope=incoming');
  expect(protectedResponse.status()).toBe(401);
});

test('production session metadata allows existing staff login without an activation code', async ({ page }) => {
  // Production reports the setup-token policy even after its first account exists.
  // Keep the local server and real login endpoint; override only that session metadata.
  await page.route('**/api/auth/session', async route => {
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    const session = await response.json();
    expect(session.user).toBeNull();
    await route.fulfill({ response, json: { ...session, needsSetup: false, requiresSetupToken: true } });
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'მოგესალმებით', exact: true })).toBeVisible();
  await expect(page.getByLabel('აქტივაციის კოდი', { exact: true })).toHaveCount(0);
  await page.getByLabel('მომხმარებლის სახელი', { exact: true }).fill(EMPLOYEE.login);
  await page.getByLabel('პაროლი', { exact: true }).fill(EMPLOYEE.password);
  const pending = page.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'შესვლა', exact: true }).click();
  const response = await pending;
  expect(response.request().postDataJSON()).toMatchObject({ login: EMPLOYEE.login, password: EMPLOYEE.password });
  expect(response.request().postDataJSON()).not.toHaveProperty('setupToken');
  expect(response.ok()).toBeTruthy();
  await expect(page.locator('.auth-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'ჯავშნები', exact: true })).toBeVisible();
  await expect(page.locator('.admin-user')).toContainText(EMPLOYEE.name);
});

test('production first-user session metadata requires an activation code before submitting setup', async ({ page }) => {
  // Exercise first-run browser validation without creating or changing any real account.
  await page.route('**/api/auth/session', async route => {
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await route.fulfill({ response, json: { ...await response.json(), needsSetup: true, requiresSetupToken: true } });
  });
  const setupRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/auth/setup' && request.method() === 'POST') setupRequests.push(request.url());
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'პირველი თანამშრომელი', exact: true })).toBeVisible();
  await page.getByLabel('სახელი', { exact: true }).fill('სატესტო პირველი თანამშრომელი');
  await page.getByLabel('მომხმარებლის სახელი', { exact: true }).fill('first_user_test');
  await page.getByLabel('პაროლი', { exact: true }).fill(EMPLOYEE.password);
  const activationCode = page.getByLabel('აქტივაციის კოდი', { exact: true });
  await expect(activationCode).toBeVisible();
  await expect(activationCode).toHaveAttribute('required', '');
  expect(await activationCode.evaluate(element => (element as HTMLInputElement).validity.valueMissing)).toBe(true);
  await page.getByRole('button', { name: 'ანგარიშის შექმნა', exact: true }).click();
  await expect(activationCode).toBeFocused();
  await expect(page.getByRole('heading', { name: 'პირველი თანამშრომელი', exact: true })).toBeVisible();
  expect(setupRequests, 'An empty required activation code must prevent the setup POST').toEqual([]);
});

test('operator confirms an incoming guest booking, deletes it and restores its data', async ({ page }) => {
  const name = 'სატესტო სრული ციკლი';
  const day = futureDate(1);
  await fillPublicForm(page, { direction: 'gori-tbilisi', seats: 3, name, date: day, time: '09:30' });
  const id = await submitPublicForm(page);
  await login(page);
  await openAdminView(page, 'შემოსული');
  const row = bookingRow(page, name);
  await expect(row).toBeVisible();
  await expect(row).toContainText('ელოდება დადასტურებას');
  await page.screenshot({ path: '/tmp/greentaxi-admin.png', fullPage: true });
  await page.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true }).fill(name);
  await expect(page.locator('.admin-booking-table tbody tr')).toHaveCount(1);
  await row.getByRole('button', { name: 'დამატება', exact: true }).click();
  const confirmDialog = page.getByRole('dialog', { name: 'განაცხადის დამატება', exact: true });
  await expect(operatorDayButton(confirmDialog, day)).toHaveAttribute('aria-pressed', 'true');
  await chooseOperatorTime(confirmDialog, '09:30');
  const confirmed = page.waitForResponse(response => response.url().endsWith(`/api/admin/bookings/${id}/confirm`));
  await confirmDialog.getByRole('button', { name: 'დამატება და დადასტურება', exact: true }).click();
  expect((await confirmed).ok()).toBeTruthy();
  await expect(confirmDialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await openAdminView(page, 'ჯავშნები');
  await chooseAdminDate(page, day);
  await chooseAdminTime(page, '09:30');
  await expect(row).toBeVisible();
  await expect(row).toContainText('დადასტურებული');
  await expect(row.locator('.admin-seat-badge')).toHaveText('3');
  await row.getByRole('button', { name: `${name}: რედაქტირება`, exact: true }).click();
  const editDialog = page.getByRole('dialog', { name: 'ჯავშნის რედაქტირება', exact: true });
  await expect(editDialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveCount(0);
  const editedAddress = 'გორი, ძველი სახელის შენარჩუნების სატესტო მისამართი';
  await editDialog.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill(editedAddress);
  const edited = page.waitForResponse(response => response.url().endsWith(`/api/admin/bookings/${id}`) && response.request().method() === 'PATCH');
  await editDialog.getByRole('button', { name: 'ცვლილებების შენახვა', exact: true }).click();
  const editResponse = await edited;
  expect(editResponse.ok()).toBeTruthy();
  expect(editResponse.request().postDataJSON()).not.toHaveProperty('name');
  expect(await editResponse.json()).toMatchObject({ id, name, seats: 3, goriAddress: editedAddress });
  await expect(editDialog).toHaveCount(0);
  await row.getByRole('button', { name: `${name}: სხვა მოქმედებები`, exact: true }).click();
  await row.getByRole('button', { name: 'წაშლა', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'ჯავშნის წაშლა', exact: true });
  const deleted = page.waitForResponse(response => response.url().endsWith(`/api/admin/bookings/${id}/delete`));
  await deleteDialog.getByRole('button', { name: 'წაშლა', exact: true }).click();
  expect((await deleted).ok()).toBeTruthy();
  await expect(deleteDialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await openAdminView(page, 'ისტორია');
  await expect(row).toBeVisible();
  await expect(row.locator('.admin-seat-badge')).toHaveText('3');
  // The original trip is historical from the browser's perspective. Restoring
  // it must keep its active original slot instead of selecting a new future day.
  await page.clock.setFixedTime(new Date(`${futureDate(5)}T12:00:00Z`));
  await row.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  const restoreDialog = page.getByRole('dialog', { name: 'ჯავშნის აღდგენა', exact: true });
  const original = restoreDialog.getByRole('group', { name: 'აღდგენის დრო', exact: true }).getByRole('button', { name: 'თავდაპირველი დროის შენარჩუნება', exact: true });
  await expect(original).toBeEnabled();
  await expect(original).toHaveAttribute('aria-pressed', 'true');
  await expect(operatorGroup(restoreDialog, 'თარიღი')).toHaveCount(0);
  await expect(operatorGroup(restoreDialog, 'დრო')).toHaveCount(0);
  await expect(restoreDialog).toContainText('09:30');
  const restored = page.waitForResponse(response => response.url().endsWith(`/api/admin/bookings/${id}/restore`));
  await restoreDialog.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  const restoredResponse = await restored;
  expect(restoredResponse.ok()).toBeTruthy();
  expect(restoredResponse.request().postDataJSON()).toEqual({});
  expect(await restoredResponse.json()).toMatchObject({
    id, name, seats: 3, status: 'confirmed', deletedAt: null,
    assignedDate: day, assignedTime: '09:30', goriAddress: editedAddress,
  });
  await expect(restoreDialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await openAdminView(page, 'ჯავშნები');
  await chooseAdminDate(page, day);
  await expect(row).toBeVisible();
  await expect(row).toContainText('დადასტურებული');
});

for (const [index, direction] of (Object.keys(DIRECTION_LABELS) as Direction[]).entries()) {
  test(`an unnamed manual staff order with eight seats is confirmed in ${direction}`, async ({ page }) => {
    const phone = `55500045${6 + index}`;
    const day = futureDate(1);
    const address = `გორი, რვა ადგილის სატესტო მისამართი ${index + 1}`;
    await openAuthenticatedAdmin(page);
    const dialog = await openManualOrder(page);
    await expect(dialog.locator('input[type="date"]')).toHaveCount(0);
    await expect(operatorGroup(dialog, 'თარიღი').getByRole('button')).toHaveCount(2);
    await expect(operatorGroup(dialog, 'თარიღი').getByRole('button', { name: /^ზეგ,/ })).toHaveCount(0);
    await chooseOperatorDirection(dialog, direction);
    await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(`+995${phone}`);
    await chooseOperatorSeats(dialog, 8);
    await dialog.getByLabel(direction === 'gori-tbilisi' ? 'აყვანის მისამართი გორში' : 'ჩამოსვლის მისამართი გორში', { exact: true }).fill(address);
    if (direction === 'tbilisi-gori') {
      await dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[0].id));
    }
    await chooseOperatorDay(dialog, day);
    const hours = operatorGroup(dialog, 'დრო');
    await expect(hours.getByRole('button')).toHaveCount(18);
    for (const time of TIMES) await expect(hours.getByRole('button', { name: time, exact: true })).toBeVisible();
    const hourBounds = await hours.evaluate(group => {
      const bounds = group.getBoundingClientRect();
      return {
        scrollHeight: group.scrollHeight, clientHeight: group.clientHeight,
        outside: Array.from(group.querySelectorAll('button')).filter(button => {
          const rect = button.getBoundingClientRect();
          return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1;
        }).length,
      };
    });
    expect(hourBounds.scrollHeight, 'Active hours should be visible together without a scrolling hour picker').toBeLessThanOrEqual(hourBounds.clientHeight + 1);
    expect(hourBounds.outside, 'Every active hour must fit inside the hour picker').toBe(0);
    await chooseOperatorTime(dialog, '09:30');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
    const response = await saved;
    expect(response.ok()).toBeTruthy();
    expect(response.request().postDataJSON()).not.toHaveProperty('name');
    const booking = await response.json() as Booking;
    expect(booking).toMatchObject({
      name: '', phone, seats: 8, direction, goriAddress: address,
      pickupStopId: direction === 'tbilisi-gori' ? publicConfig.stops[0].id : null,
      status: 'confirmed', requestedDate: day, requestedTime: '09:30', assignedDate: day, assignedTime: '09:30',
    });
    await expect(dialog).toHaveCount(0);
    if (direction === 'tbilisi-gori') await page.locator('.admin-filters').getByRole('combobox').first().selectOption(direction);
    await chooseAdminDate(page, day);
    await chooseAdminTime(page, '09:30');
    const row = bookingRowById(page, booking.id);
    await expect(row).toBeVisible();
    await expect(row).toContainText('დადასტურებული');
    await expect(row).toContainText('555 00 04 ' + String(56 + index));
    await expect(row.locator('.admin-seat-badge')).toHaveText('8');
  });
}

test('operator hours use Tbilisi time, keep a future choice on ticks and refresh today and tomorrow at midnight', async ({ page }) => {
  await page.clock.install({ time: new Date('2030-05-04T10:00:00Z') });
  await page.clock.pauseAt(new Date('2030-05-04T10:00:01Z'));
  const posts: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/admin/bookings' && request.method() === 'POST') posts.push(request.url());
  });
  await openAuthenticatedAdmin(page);
  const dialog = await openManualOrder(page);
  const hours = operatorGroup(dialog, 'დრო');
  const days = operatorGroup(dialog, 'თარიღი');
  await expect(operatorDayButton(dialog, '2030-05-04')).toHaveAttribute('aria-pressed', 'true');
  await expect(hours.getByRole('button')).toHaveText(['15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00']);
  await expect(hours.getByRole('button', { name: '11:00', exact: true })).toHaveCount(0);
  await expect(hours.getByRole('button', { name: '14:00', exact: true })).toHaveCount(0);
  await dialog.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, საათის ცვლილების სატესტო მისამართი');
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill('555073701');
  await chooseOperatorDay(dialog, '2030-05-05');
  await expect(hours.getByRole('button')).toHaveText(TIMES);
  await chooseOperatorTime(dialog, '08:30');
  await page.clock.fastForward(3_599_000);
  await expect(operatorDayButton(dialog, '2030-05-05')).toHaveAttribute('aria-pressed', 'true');
  await expect(hours.getByRole('button', { name: '08:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await chooseOperatorDay(dialog, '2030-05-04');
  await expect(hours.getByRole('button')).toHaveText(['16:00', '17:00', '18:00', '19:00', '20:00', '21:00']);
  await chooseOperatorTime(dialog, '16:00');
  await page.clock.fastForward(60 * 60 * 1000);
  await expect(hours.getByRole('button')).toHaveText(['17:00', '18:00', '19:00', '20:00', '21:00']);
  await expect(hours.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true })).toBeDisabled();
  await page.clock.fastForward(8 * 60 * 60 * 1000);
  await expect(days.getByRole('button')).toHaveCount(2);
  for (const day of ['2030-05-05', '2030-05-06']) await expect(operatorDayButton(dialog, day)).toBeVisible();
  await expect(days.getByRole('button', { name: /^ზეგ,/ })).toHaveCount(0);
  await expect(operatorDayButton(dialog, '2030-05-07')).toHaveCount(0);
  await expect(operatorDayButton(dialog, '2030-05-04')).toHaveCount(0);
  await expect(operatorDayButton(dialog, '2030-05-05')).toHaveAttribute('aria-pressed', 'true');
  await expect(hours.getByRole('button')).toHaveText(TIMES);
  await expect(hours.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(dialog.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, საათის ცვლილების სატესტო მისამართი');
  await dialog.getByRole('button', { name: 'გაუქმება', exact: true }).click();
  await chooseAdminDate(page, '2030-05-07');
  const clamped = await openManualOrder(page);
  await expect(operatorDayButton(clamped, '2030-05-05')).toHaveAttribute('aria-pressed', 'true');
  await expect(operatorDayButton(clamped, '2030-05-07')).toHaveCount(0);
  expect(posts, 'Clock updates must never submit an order').toEqual([]);
});

test('operator rejects a newly disabled hour and requires an explicit alternative before retrying', async ({ page, browserErrors }) => {
  const day = futureDate(1);
  const phone = '555073702';
  await openAuthenticatedAdmin(page);
  const dialog = await openManualOrder(page);
  await dialog.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, გამორთული დროის სატესტო მისამართი');
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
  await chooseOperatorSeats(dialog, 8);
  await chooseOperatorDay(dialog, day);
  await chooseOperatorTime(dialog, '08:30');
  try {
    expect((await adminApi.put('/api/admin/schedule/date', { data: { direction: 'gori-tbilisi', date: day, times: TIMES.filter(time => time !== '08:30') } })).ok()).toBeTruthy();
    const rejected = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
    const failure = await rejected;
    expect(failure.status()).toBe(409);
    expect(await failure.json()).toMatchObject({ code: 'SLOT_INACTIVE' });
    await expect(dialog.getByRole('alert')).toBeVisible();
    const hours = operatorGroup(dialog, 'დრო');
    await expect(hours.getByRole('button', { name: '08:30', exact: true })).toHaveCount(0);
    await expect(hours.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true })).toBeDisabled();
    const unchanged = await adminApi.get(`/api/admin/bookings?${new URLSearchParams({ scope: 'scheduled', date: day, search: phone })}`);
    expect(unchanged.ok()).toBeTruthy();
    expect((await unchanged.json() as { bookings: Booking[] }).bookings).toEqual([]);
    await chooseOperatorTime(dialog, '10:00');
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
    const saved = await accepted;
    expect(saved.ok()).toBeTruthy();
    expect(await saved.json()).toMatchObject({ name: '', phone, seats: 8, status: 'confirmed', assignedDate: day, assignedTime: '10:00' });
    await expect(dialog).toHaveCount(0);
  } finally {
    expect((await adminApi.delete(`/api/admin/schedule/date?${new URLSearchParams({ direction: 'gori-tbilisi', date: day })}`)).ok()).toBeTruthy();
    // This scenario deliberately receives the asserted real HTTP409. Ignore only
    // Chromium's matching resource-status message; every other error still fails.
    for (let index = browserErrors.length - 1; index >= 0; index--) {
      if (/^Console: https?:\/\/[^\s]+\/api\/admin\/bookings Failed to load resource:.*\b409\b/.test(browserErrors[index])) browserErrors.splice(index, 1);
    }
  }
});

test('direction, date and time filters change the actual scheduled order list', async ({ page }) => {
  const day = futureDate(1);
  const nextDay = futureDate(0);
  const fixtures = [
    { name: 'ფილტრის ტესტი პირველი', direction: 'gori-tbilisi', requestedDate: day, requestedTime: '08:00' },
    { name: 'ფილტრის ტესტი მეორე', direction: 'gori-tbilisi', requestedDate: day, requestedTime: '09:00' },
    { name: 'ფილტრის ტესტი მესამე', direction: 'gori-tbilisi', requestedDate: nextDay, requestedTime: '08:00' },
    { name: 'ფილტრის ტესტი მეოთხე', direction: 'tbilisi-gori', requestedDate: day, requestedTime: '08:00' },
  ];
  for (const input of fixtures) {
    const response = await adminApi.post('/api/admin/bookings', { data: {
      ...input, requestedDate: day, phone: '+995555000789', seats: 2, goriAddress: 'გორი, სატესტო ქუჩა 36',
      ...(input.direction === 'tbilisi-gori' ? { pickupStopId: publicConfig.stops[0].id } : {}),
    } });
    expect(response.ok()).toBeTruthy();
    if (input.requestedDate !== day) await setHistoricalFixtureDate((await response.json() as Booking).id, input.requestedDate);
  }
  await login(page);
  await page.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true }).fill('ფილტრის ტესტი');
  await chooseAdminDate(page, day);
  const rows = page.locator('.admin-booking-table tbody tr');
  await expect(rows).toHaveCount(2);
  await chooseAdminTime(page, '08:00');
  await expect(rows).toHaveCount(1);
  await expect(bookingRow(page, fixtures[0].name)).toBeVisible();
  await expect(bookingRow(page, fixtures[1].name)).toHaveCount(0);
  await chooseAdminTime(page, '09:00');
  await expect(rows).toHaveCount(1);
  await expect(bookingRow(page, fixtures[1].name)).toBeVisible();
  await expect(bookingRow(page, fixtures[0].name)).toHaveCount(0);
  await chooseAdminDate(page, nextDay);
  await expect(rows).toHaveCount(1);
  await expect(bookingRow(page, fixtures[2].name)).toBeVisible();
  await page.locator('.admin-filters').getByRole('combobox').first().selectOption('tbilisi-gori');
  await chooseAdminDate(page, day);
  await chooseAdminTime(page, '08:00');
  await expect(rows).toHaveCount(1);
  await expect(bookingRow(page, fixtures[3].name)).toBeVisible();
  await expect(bookingRow(page, fixtures[2].name)).toHaveCount(0);
});

test('answered Android SIM inquiry is deduplicated, restored and converted into a confirmed order', async ({ page }) => {
  const deviceResponse = await adminApi.post('/api/admin/devices', { data: { name: 'Redmi Android15 browser test' } });
  expect(deviceResponse.status()).toBe(201);
  const { device, token } = await deviceResponse.json() as { device: { id: number }; token: string };
  expect(Boolean(token)).toBeTruthy();
  const caller = '555000901';
  const displayedCaller = '555 00 09 01';
  const event = {
    eventId: 'browser-answered-sim-001', kind: 'incoming', phase: 'completed', phone: `+995${caller}`,
    occurredAt: new Date().toISOString(), durationSeconds: 67,
  };
  const headers = { Authorization: `Bearer ${token}` };
  const ignored = await adminApi.post('/api/integrations/android/calls', {
    headers, data: { ...event, eventId: 'browser-missed-sim-001', kind: 'missed', durationSeconds: 0 },
  });
  expect(ignored.ok()).toBeTruthy();
  expect(await ignored.json()).toEqual({ ignored: true });
  const accepted = await adminApi.post('/api/integrations/android/calls', { headers, data: event });
  expect(accepted.status()).toBe(201);
  const inquiry = await accepted.json() as { id: number; duplicate: boolean };
  expect(inquiry.duplicate).toBe(false);
  const duplicate = await adminApi.post('/api/integrations/android/calls', { headers, data: event });
  expect(duplicate.status()).toBe(200);
  expect(await duplicate.json()).toEqual({ id: inquiry.id, duplicate: true });
  const beforeConversion = await adminApi.get('/api/admin/calls?scope=incoming');
  expect(beforeConversion.ok()).toBeTruthy();
  expect((await beforeConversion.json() as { calls: { id: number }[] }).calls).toHaveLength(1);

  await login(page);
  await openAdminView(page, 'შემოსული');
  const callRows = page.locator('.admin-calls-table tbody tr');
  const callRow = incomingCallRow(page, inquiry.id);
  await expect(callRows).toHaveCount(1);
  await expect(callRow.getByLabel('გამგზავრების ქალაქი', { exact: true })).toHaveValue('gori-tbilisi');
  await expect(callRow.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(displayedCaller);
  await expect(callRow).toContainText('1:07');
  await expect(callRow).toContainText('Redmi Android15 browser test');
  await expect(page.locator('.admin-calls-table thead')).not.toContainText('ბოლო გაჩერება თბილისში');
  await expect(page.locator('.admin-calls-table thead')).not.toContainText('ბოლო მისამართი გორში');
  await page.screenshot({ path: '/tmp/greentaxi-admin-phone.png', fullPage: true });
  const rejected = page.waitForResponse(response => response.url().endsWith(`/api/admin/calls/${inquiry.id}/delete`) && response.request().method() === 'POST');
  await callRow.getByRole('button', { name: 'უარი', exact: true }).click();
  expect((await rejected).ok()).toBeTruthy();
  await expect(callRow).toHaveCount(0);
  // A second operator's restoration must reach the still-open incoming queue.
  expect((await adminApi.post(`/api/admin/calls/${inquiry.id}/restore`, { data: {} })).ok()).toBeTruthy();
  await expect(callRow).toBeVisible();
  const rejectedAgain = page.waitForResponse(response => response.url().endsWith(`/api/admin/calls/${inquiry.id}/delete`) && response.request().method() === 'POST');
  await callRow.getByRole('button', { name: 'უარი', exact: true }).click();
  expect((await rejectedAgain).ok()).toBeTruthy();
  await expect(callRow).toHaveCount(0);
  await openAdminView(page, 'ისტორია');
  await expect(callRow).toBeVisible();
  await callRow.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  const restoreDialog = page.getByRole('dialog', { name: 'სატელეფონო განაცხადის აღდგენა', exact: true });
  await restoreDialog.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  await expect(restoreDialog).toHaveCount(0);
  await expect(callRow).toHaveCount(0);
  await openAdminView(page, 'შემოსული');
  await expect(callRow).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(callRow.getByLabel('მგზავრის სახელი', { exact: true })).toHaveCount(0);
  await expect(callRow.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('');
  await expect(callRow.getByRole('button', { name: 'დადასტურება', exact: true })).toBeDisabled();
  const day = futureDate(1);
  await chooseCallSeats(callRow, 8);
  await callRow.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, სატესტო ქუჩა 48');
  await chooseCallDay(callRow, 'ხვალ');
  await chooseCallTime(callRow, '11:00');
  const converted = page.waitForResponse(response => response.url().endsWith(`/api/admin/calls/${inquiry.id}/convert`));
  await callRow.getByRole('button', { name: 'დადასტურება', exact: true }).click();
  const convertedResponse = await converted;
  expect(convertedResponse.ok()).toBeTruthy();
  const saved = await convertedResponse.json() as Booking;
  expect(saved).toMatchObject({
    name: '', phone: caller, seats: 8, status: 'confirmed',
    assignedDate: day, assignedTime: '11:00', goriAddress: 'გორი, სატესტო ქუჩა 48',
  });
  expect(convertedResponse.request().postDataJSON()).not.toHaveProperty('name');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(callRow).toHaveCount(0);
  const linkedResponse = await adminApi.get('/api/admin/calls?scope=converted');
  expect(linkedResponse.ok()).toBeTruthy();
  expect((await linkedResponse.json() as { calls: { id: number; bookingId: number }[] }).calls)
    .toEqual([expect.objectContaining({ id: inquiry.id, bookingId: saved.id })]);
  await openAdminView(page, 'ჯავშნები');
  await chooseAdminDate(page, day);
  await chooseAdminTime(page, '11:00');
  await expect(bookingRowById(page, saved.id)).toBeVisible();
  await expect(bookingRowById(page, saved.id)).toContainText('დადასტურებული');
  const revoked = await adminApi.patch(`/api/admin/devices/${device.id}`, { data: { active: false } });
  expect(revoked.ok()).toBeTruthy();
  const denied = await adminApi.post('/api/integrations/android/calls', {
    headers, data: { ...event, eventId: 'browser-after-revoke' },
  });
  expect(denied.status()).toBe(401);
});

test('restore confirmed order requires explicit alternative when its previous slot is disabled', async ({ page }) => {
  const name = 'სატესტო გამორთული სლოტის აღდგენა';
  const day = futureDate(1);
  const created = await adminApi.post('/api/admin/bookings', { data: {
    name, phone: '+995555000501', seats: 2, direction: 'gori-tbilisi',
    requestedDate: day, requestedTime: '09:30', goriAddress: 'გორი, სატესტო ქუჩა 60',
  } });
  expect(created.ok()).toBeTruthy();
  const booking = await created.json() as Booking;
  expect(booking.status).toBe('confirmed');
  expect((await adminApi.post(`/api/admin/bookings/${booking.id}/delete`, { data: {} })).ok()).toBeTruthy();
  const override = await adminApi.put('/api/admin/schedule/date', {
    data: { direction: 'gori-tbilisi', date: day, times: ['07:00', '10:00'] },
  });
  expect(override.ok()).toBeTruthy();
  try {
    await openAuthenticatedAdmin(page);
    await openAdminView(page, 'ისტორია');
    await page.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true }).fill(name);
    const row = bookingRow(page, name);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'აღდგენა', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'ჯავშნის აღდგენა', exact: true });
    const time = operatorGroup(dialog, 'დრო');
    await chooseOperatorDay(dialog, day);
    await expect(time.getByRole('button')).toHaveText(['07:00', '10:00']);
    await expect(time.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(dialog.locator('.admin-form-hint')).toContainText('ჯავშანი ავტომატურად არ გადაიტანება');
    await expect(dialog.getByRole('button', { name: 'აღდგენა', exact: true })).toBeDisabled();
    const unchanged = await adminApi.get(`/api/admin/bookings?${new URLSearchParams({ scope: 'deleted', search: name })}`);
    expect(unchanged.ok()).toBeTruthy();
    expect((await unchanged.json() as { bookings: Booking[] }).bookings)
      .toEqual([expect.objectContaining({ id: booking.id, assignedDate: day, assignedTime: '09:30' })]);
    await chooseOperatorTime(dialog, '07:00');
    await expect(dialog.getByRole('button', { name: 'აღდგენა', exact: true })).toBeEnabled();
    const restored = page.waitForResponse(response => response.url().endsWith(`/api/admin/bookings/${booking.id}/restore`));
    await dialog.getByRole('button', { name: 'აღდგენა', exact: true }).click();
    const response = await restored;
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toMatchObject({
      id: booking.id, name, seats: 2, status: 'confirmed', deletedAt: null,
      requestedDate: day, requestedTime: '09:30', assignedDate: day, assignedTime: '07:00',
    });
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await openAdminView(page, 'ჯავშნები');
    await chooseAdminDate(page, day);
    await chooseAdminTime(page, '07:00');
    await expect(row).toBeVisible();
    await expect(row.locator('.admin-time-value')).toHaveText('07:00');
  } finally {
    expect((await adminApi.delete(`/api/admin/schedule/date?${new URLSearchParams({ direction: 'gori-tbilisi', date: day })}`)).ok()).toBeTruthy();
  }
});

test('restore waiting request succeeds when every slot on its requested day is disabled', async ({ page }) => {
  const name = 'სატესტო მოლოდინის აღდგენა';
  const day = futureDate(6);
  const created = await adminApi.post('/api/bookings', { data: {
    name, phone: '+995555000601', seats: 4, direction: 'gori-tbilisi',
    requestedDate: day, requestedTime: '09:30', goriAddress: 'გორი, სატესტო ქუჩა 72',
  } });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json() as { id: number };
  expect((await adminApi.post(`/api/admin/bookings/${id}/delete`, { data: {} })).ok()).toBeTruthy();
  expect((await adminApi.put('/api/admin/schedule/date', {
    data: { direction: 'gori-tbilisi', date: day, times: [] },
  })).ok()).toBeTruthy();
  const schedule = await adminApi.get(`/api/admin/schedule?${new URLSearchParams({ direction: 'gori-tbilisi', date: day })}`);
  expect(schedule.ok()).toBeTruthy();
  expect((await schedule.json() as { slots: unknown[] }).slots).toEqual([]);
  await login(page);
  await openAdminView(page, 'ისტორია');
  await page.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true }).fill(name);
  const row = bookingRow(page, name);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ჯავშნის აღდგენა', exact: true });
  await expect(dialog.getByLabel('დრო', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('თარიღი', { exact: true })).toHaveCount(0);
  await expect(dialog.locator('.admin-form-hint')).toContainText('შემოსულების რიგში დაბრუნდება');
  await expect(dialog.getByRole('button', { name: 'აღდგენა', exact: true })).toBeEnabled();
  const restored = page.waitForResponse(response => response.url().endsWith(`/api/admin/bookings/${id}/restore`));
  await dialog.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  const response = await restored;
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({
    id, name, seats: 4, status: 'waiting', deletedAt: null,
    requestedDate: day, requestedTime: '09:30', assignedDate: null, assignedTime: null,
    goriAddress: 'გორი, სატესტო ქუჩა 72',
  });
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await openAdminView(page, 'შემოსული');
  await expect(row).toBeVisible();
  await expect(row).toContainText('ელოდება დადასტურებას');
  await expect(row.locator('.admin-time-value')).toHaveText('09:30');
});

test('public booking stays within a mobile viewport in both directions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('მგზავრობის თარიღი', { exact: true }).fill(futureDate());
  await expect(page.getByRole('group', { name: 'მგზავრობის დრო', exact: true }).getByRole('button')).toHaveCount(18);
  async function expectMobileWidth() {
    const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    expect(dimensions.html).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
  }
  for (const direction of Object.keys(DIRECTION_LABELS) as Direction[]) {
    await page.getByRole('button', { name: DIRECTION_LABELS[direction], exact: true }).click();
    await expect(page.getByRole('group', { name: 'მგზავრობის დრო', exact: true }).getByRole('button')).toHaveCount(18);
    await expectPublicStep(page, 'მგზავრობა');
    await expectMobileWidth();
    await page.getByRole('button', { name: '08:30', exact: true }).click();
    await continuePublicBooking(page, 'მისამართი');
    await expectMobileWidth();
    await page.getByLabel(direction === 'gori-tbilisi' ? 'ჩასხდომის მისამართი გორში' : 'ჩამოსვლის მისამართი გორში', { exact: true }).fill('გორი, მობილური სატესტო მისამართი');
    if (direction === 'tbilisi-gori') await page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[0].id));
    await continuePublicBooking(page, 'კონტაქტი');
    await expectMobileWidth();
    await expect(page.getByRole('button', { name: 'ჯავშნის გაგზავნა', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'უკან', exact: true }).click();
    await expectPublicStep(page, 'მისამართი');
    await page.getByRole('button', { name: 'უკან', exact: true }).click();
  }
  await page.getByRole('button', { name: DIRECTION_LABELS['gori-tbilisi'], exact: true }).click();
  await expect(page.getByRole('group', { name: 'მგზავრობის დრო', exact: true }).getByRole('button')).toHaveCount(18);
  await page.screenshot({ path: '/tmp/greentaxi-public-mobile.png', fullPage: true });
});

test('passenger profile autofill accepts Georgian phone formats and keeps fresh trip fields', async ({ page }) => {
  const phone = '555010101';
  const name = 'სატესტო შენახული მგზავრი';
  const address = 'გორი, პროფილის სატესტო მისამართი 101';
  const stop = publicConfig.stops[1];
  expect(stop).toBeTruthy();
  await seedConfirmedProfile({ phone, name, address, pickupStopId: stop.id });
  // An unverified public request with the same number must not replace verified details.
  const publicRequest = await adminApi.post('/api/bookings', { data: {
    phone: '555010101', name: 'სატესტო დაუდასტურებელი სახელი', seats: 2,
    direction: 'gori-tbilisi', goriAddress: 'გორი, სხვა დაუდასტურებელი მისამართი',
    requestedDate: futureDate(), requestedTime: '08:30',
  } });
  expect(publicRequest.ok()).toBeTruthy();
  await openAuthenticatedAdmin(page);
  const formats = ['555 010 101', '995555010101', '+995 555 010 101'];
  for (const [index, formatted] of formats.entries()) {
    const dialog = await openManualOrder(page);
    await chooseOperatorDirection(dialog, 'tbilisi-gori');
    const freshDate = futureDate(1);
    const freshTime = '08:30';
    await chooseOperatorDay(dialog, freshDate);
    await chooseOperatorTime(dialog, freshTime);
    await expect(operatorGroup(dialog, 'ადგილების რაოდენობა').getByRole('button', { name: '1 ადგილი', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const lookup = page.waitForResponse(response => isProfileResponse(response, phone));
    await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(formatted);
    await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).blur();
    const response = await lookup;
    expect(response.ok()).toBeTruthy();
    expect((await response.json() as { profile: PassengerProfile | null }).profile)
      .toMatchObject({ phone, name, goriAddress: address, pickupStopId: stop.id });
    await expect(dialog.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('555 01 01 01');
    await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(address);
    await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue(String(stop.id));
    await expect(operatorDayButton(dialog, freshDate)).toHaveAttribute('aria-pressed', 'true');
    await expect(operatorGroup(dialog, 'დრო').getByRole('button', { name: freshTime, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(operatorGroup(dialog, 'ადგილების რაოდენობა').getByRole('button', { name: '1 ადგილი', exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (index < formats.length - 1) {
      await dialog.getByRole('button', { name: 'გაუქმება', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const profile = await adminApi.get(`/api/admin/passengers/profile?phone=${phone}`);
      expect(profile.ok()).toBeTruthy();
      expect((await profile.json() as { profile: PassengerProfile }).profile.name).toBe(name);
    } else {
      const saved = page.waitForResponse(value => value.url().endsWith('/api/admin/bookings') && value.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
      const savedResponse = await saved;
      expect(savedResponse.ok()).toBeTruthy();
      expect(await savedResponse.json()).toMatchObject({
        phone, name: '', goriAddress: address, pickupStopId: stop.id, seats: 1,
        status: 'confirmed', assignedDate: freshDate, assignedTime: freshTime,
      });
      await expect(dialog).toHaveCount(0);
      const profile = await adminApi.get(`/api/admin/passengers/profile?phone=${phone}`);
      expect(profile.ok()).toBeTruthy();
      expect((await profile.json() as { profile: PassengerProfile }).profile.name).toBe(name);
    }
  }
});

test('passenger profile autofill clears old automatic values for an unknown number but preserves manual values', async ({ page }) => {
  const phone = '555010111';
  const name = 'სატესტო ავტომატური მონაცემები';
  const address = 'გორი, პროფილის სატესტო მისამართი 111';
  const stop = publicConfig.stops[1];
  await seedConfirmedProfile({ phone, name, address, pickupStopId: stop.id });
  await openAuthenticatedAdmin(page);
  const dialog = await openManualOrder(page);
  await chooseOperatorDirection(dialog, 'tbilisi-gori');
  const known = page.waitForResponse(response => isProfileResponse(response, phone));
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
  expect((await known).ok()).toBeTruthy();
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(address);
  await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue(String(stop.id));
  const unknownPhone = '555019991';
  const unknown = page.waitForResponse(response => isProfileResponse(response, unknownPhone));
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(unknownPhone);
  const unknownResponse = await unknown;
  expect(unknownResponse.ok()).toBeTruthy();
  expect(await unknownResponse.json()).toEqual({ profile: null });
  await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue('');
  const manualAddress = 'გორი, ხელით შეყვანილი მისამართი 112';
  await dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill(manualAddress);
  await dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[2].id));
  const anotherPhone = '555019992';
  const anotherUnknown = page.waitForResponse(response => isProfileResponse(response, anotherPhone));
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(anotherPhone);
  expect((await anotherUnknown).ok()).toBeTruthy();
  await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(manualAddress);
  await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue(String(publicConfig.stops[2].id));
});

test('passenger profile autofill never overwrites manual edits or a deliberate clear when lookup arrives late', async ({ page }) => {
  const phone = '555010202';
  await seedConfirmedProfile({
    phone, name: 'სატესტო ძველი პროფილის სახელი',
    address: 'გორი, ძველი პროფილის მისამართი 202', pickupStopId: publicConfig.stops[1].id,
  });
  await openAuthenticatedAdmin(page);
  let releaseLookup!: () => void;
  let reportBackendReady!: () => void;
  const heldResponse = new Promise<void>(resolve => { releaseLookup = resolve; });
  const backendReady = new Promise<void>(resolve => { reportBackendReady = resolve; });
  await page.route(/\/api\/admin\/passengers\/profile\?/, async route => {
    if (new URL(route.request().url()).searchParams.get('phone') !== phone) { await route.continue(); return; }
    const response = await route.fetch();
    reportBackendReady();
    await heldResponse;
    await route.fulfill({ response });
  });
  const dialog = await openManualOrder(page);
  await chooseOperatorDirection(dialog, 'tbilisi-gori');
  await chooseOperatorDay(dialog, futureDate(1));
  await chooseOperatorTime(dialog, '08:30');
  const lookup = page.waitForResponse(response => isProfileResponse(response, phone));
  try {
    await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
    await backendReady;
    await dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill('სატესტო დროებითი მისამართი');
    await dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).clear();
    await dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[2].id));
  } finally { releaseLookup(); }
  const response = await lookup;
  expect(response.ok()).toBeTruthy();
  expect((await response.json() as { profile: PassengerProfile | null }).profile?.name).toBe('სატესტო ძველი პროფილის სახელი');
  await expect(dialog.locator('.admin-profile-feedback')).toContainText('მისამართები ნაპოვნია.');
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue(String(publicConfig.stops[2].id));
  const manualAddress = 'გორი, ოპერატორის ახალი მისამართი 203';
  await dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill(manualAddress);
  const saved = page.waitForResponse(value => value.url().endsWith('/api/admin/bookings') && value.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
  const savedResponse = await saved;
  expect(savedResponse.ok()).toBeTruthy();
  expect(await savedResponse.json()).toMatchObject({
    phone, name: '', goriAddress: manualAddress, pickupStopId: publicConfig.stops[2].id,
  });
});

test('live inline call keeps city-specific pickup addresses and manual choices across slow polls and completion', async ({ page }) => {
  test.setTimeout(45_000);
  const phone = '555010303';
  const displayedPhone = '555 01 03 03';
  const name = 'სატესტო ნაცნობი დამრეკავი';
  const pickupAddress = 'გორი, დამრეკავის შენახული აყვანის მისამართი 303';
  const dropoffAddress = 'გორი, უფრო ახალი ჩამოსვლის მისამართი 304';
  const stop = publicConfig.stops[1];
  // A newer arrival in Gori must never replace the independently remembered Gori pickup.
  await seedConfirmedProfile({ phone, name, address: pickupAddress });
  await seedConfirmedProfile({ phone, name, address: dropoffAddress, pickupStopId: stop.id });
  const { id, event, headers } = await seedAnsweredCall(phone, 'profile-known-caller-303', 'Profile browser caller device');
  const initialCalls = await adminApi.get('/api/admin/calls?scope=incoming');
  expect(initialCalls.ok()).toBeTruthy();
  expect((await initialCalls.json() as { calls: CallInquiry[] }).calls.find(call => call.id === id)).toMatchObject({
    id, phone, phase: 'answered', durationSeconds: 0,
    passengerProfile: { phone, name, goriAddress: dropoffAddress, goriPickupAddress: pickupAddress, pickupStopId: stop.id, pickupStopName: stop.name },
  });
  await openAuthenticatedAdmin(page);
  let reportSlowQueueReady!: () => void;
  const slowQueueReady = new Promise<void>(resolve => { reportSlowQueueReady = resolve; });
  await page.route('**/api/admin/calls?*', async route => {
    if (new URL(route.request().url()).searchParams.get('scope') !== 'incoming') { await route.continue(); return; }
    const response = await route.fetch();
    reportSlowQueueReady();
    // Responses slower than the refresh interval must still arrive and update the row.
    await new Promise(resolve => setTimeout(resolve, 2_500));
    await route.fulfill({ response });
  });
  await openAdminView(page, 'შემოსული');
  await slowQueueReady;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const row = incomingCallRow(page, id);
  const city = row.getByLabel('გამგზავრების ქალაქი', { exact: true });
  await expect(row).toBeVisible();
  await expect(row).toHaveCount(1);
  await expect(row.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(displayedPhone);
  await expect(row).toContainText('მიმდინარეობს');
  await expect(row.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(pickupAddress);
  await expect(row.getByRole('link', { name: `${displayedPhone}: დარეკვა`, exact: true })).toHaveAttribute('href', `tel:+995${phone}`);
  const manualPickup = 'გორი, ოპერატორის ხელით შესწორებული აყვანის მისამართი 305';
  await row.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill(manualPickup);
  await city.selectOption('tbilisi-gori');
  await expect(row.getByLabel('აყვანის გაჩერება თბილისში', { exact: true })).toHaveValue(String(stop.id));
  await expect(row.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(dropoffAddress);
  await city.selectOption('gori-tbilisi');
  await expect(row.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(manualPickup);
  await city.selectOption('tbilisi-gori');
  const manualDropoff = 'გორი, ზარის შესწორებული ჩამოსვლის მისამართი 306';
  const chosenStop = publicConfig.stops[2];
  await row.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill(manualDropoff);
  await row.getByLabel('აყვანის გაჩერება თბილისში', { exact: true }).selectOption(String(chosenStop.id));
  const customDay = futureDate(10);
  await row.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true }).fill(customDay);
  await chooseCallTime(row, '08:30');
  await chooseCallSeats(row, 8);
  await page.locator('.admin-calls-card').screenshot({ path: '/tmp/greentaxi-known-live-card.png' });
  const completed = await adminApi.post('/api/integrations/android/calls', {
    headers, data: { ...event, phase: 'completed', phone: `995${phone}`, durationSeconds: 31 },
  });
  expect(completed.status()).toBe(200);
  expect(await completed.json()).toEqual({ id, duplicate: true });
  await expect(row).toContainText('0:31', { timeout: 15_000 });
  await expect(row).toContainText('დასრულებულია');
  await expect(row).not.toContainText('მიმდინარეობს');
  await expect(row).toHaveCount(1);
  await expect(city).toHaveValue('tbilisi-gori');
  await expect(row.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(manualDropoff);
  await expect(row.getByLabel('აყვანის გაჩერება თბილისში', { exact: true })).toHaveValue(String(chosenStop.id));
  await expect(row.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true })).toHaveValue(customDay);
  await expect(row.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '08:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(row.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true }).getByRole('button', { name: /^8(?: ადგილი)?$/ })).toHaveAttribute('aria-pressed', 'true');

  let releaseConversion!: () => void;
  let reportConverted!: () => void;
  const heldConversion = new Promise<void>(resolve => { releaseConversion = resolve; });
  const conversionSaved = new Promise<void>(resolve => { reportConverted = resolve; });
  const conversionPosts: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === `/api/admin/calls/${id}/convert` && request.method() === 'POST') conversionPosts.push(request.url());
  });
  await page.route(`**/api/admin/calls/${id}/convert`, async route => {
    const response = await route.fetch();
    reportConverted();
    await heldConversion;
    await route.fulfill({ response });
  });
  const converted = page.waitForResponse(response => response.url().endsWith(`/api/admin/calls/${id}/convert`));
  try {
    // Two clicks in one browser task exercise the synchronous submission guard.
    await row.getByRole('button', { name: 'დადასტურება', exact: true }).evaluate(button => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await conversionSaved;
    expect(conversionPosts).toHaveLength(1);
  } finally { releaseConversion(); }
  const response = await converted;
  expect(response.ok()).toBeTruthy();
  const booking = await response.json() as Booking;
  expect(booking).toMatchObject({
    phone, name: '', goriAddress: manualDropoff, pickupStopId: chosenStop.id,
    direction: 'tbilisi-gori', seats: 8, status: 'confirmed', assignedDate: customDay, assignedTime: '08:30',
  });
  await expect(row).toHaveCount(0);
  const retry = await adminApi.post(`/api/admin/calls/${id}/convert`, { data: { seats: 1, requestedDate: futureDate(1), requestedTime: '09:00' } });
  expect(retry.ok()).toBeTruthy();
  expect(await retry.json()).toMatchObject({ id: booking.id, seats: 8, assignedDate: customDay, assignedTime: '08:30' });
  const trusted = await adminApi.get(`/api/admin/passengers/profile?phone=${phone}`);
  expect(trusted.ok()).toBeTruthy();
  expect((await trusted.json() as { profile: PassengerProfile }).profile).toMatchObject({
    name, goriPickupAddress: pickupAddress, goriAddress: manualDropoff, pickupStopId: chosenStop.id,
  });
});

test('inline calendar and carousel hide elapsed hours and require a new choice after a slot is disabled', async ({ page, browserErrors }) => {
  const phone = '555010607';
  const { id } = await seedAnsweredCall(phone, 'inline-inactive-slot-607');
  await page.clock.install({ time: new Date('2030-05-04T10:00:00Z') });
  await page.clock.pauseAt(new Date('2030-05-04T10:00:01Z'));
  await openAuthenticatedAdmin(page);
  await openAdminView(page, 'შემოსული');
  const row = incomingCallRow(page, id);
  const hours = row.getByRole('group', { name: 'დრო', exact: true });
  const confirmation = row.getByRole('button', { name: 'დადასტურება', exact: true });
  await expect(row).toBeVisible();
  await row.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, პირდაპირი დადასტურების სატესტო მისამართი 607');
  await expect(hours.getByRole('button', { name: /^\d{2}:\d{2}$/ })).toHaveText(['15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00']);
  await expect(hours.getByRole('button', { name: '11:00', exact: true })).toHaveCount(0);
  await expect(hours.getByRole('button', { name: '14:00', exact: true })).toHaveCount(0);
  await expect(confirmation).toBeDisabled();
  await chooseCallDay(row, 'ხვალ');
  await expect(hours.getByRole('button', { name: /^\d{2}:\d{2}$/ })).toHaveText(TIMES);
  await chooseCallTime(row, '08:30');
  const calendar = row.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true });
  await expect(calendar).toHaveAttribute('min', '2030-05-04');
  await expect(calendar).not.toHaveAttribute('max');
  await calendar.fill('2030-05-03');
  await expect(calendar).toHaveValue('2030-05-05');
  await expect(hours.getByRole('button', { name: '08:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const customDay = '2030-05-07';
  await calendar.fill(customDay);
  await chooseCallTime(row, '08:30');
  await chooseCallSeats(row, 8);
  try {
    expect((await adminApi.put('/api/admin/schedule/date', { data: { direction: 'gori-tbilisi', date: customDay, times: TIMES.filter(time => time !== '08:30') } })).ok()).toBeTruthy();
    const rejected = page.waitForResponse(response => response.url().endsWith(`/api/admin/calls/${id}/convert`) && response.request().method() === 'POST');
    await confirmation.click();
    const failure = await rejected;
    expect(failure.status()).toBe(409);
    expect(await failure.json()).toMatchObject({ code: 'SLOT_INACTIVE' });
    await expect(row.getByRole('alert')).toBeVisible();
    await expect(hours.getByRole('button', { name: '08:30', exact: true })).toHaveCount(0);
    await expect(hours.locator('button[aria-pressed="true"]')).toHaveCount(0);
    await expect(confirmation).toBeDisabled();
    const unchanged = await adminApi.get(`/api/admin/bookings?${new URLSearchParams({ scope: 'scheduled', date: customDay, search: phone })}`);
    expect(unchanged.ok()).toBeTruthy();
    expect((await unchanged.json() as { bookings: Booking[] }).bookings).toEqual([]);
    await chooseCallTime(row, '10:00');
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/admin/calls/${id}/convert`) && response.request().method() === 'POST');
    await confirmation.click();
    const converted = await saved;
    expect(converted.ok()).toBeTruthy();
    expect(await converted.json()).toMatchObject({ phone, name: '', seats: 8, assignedDate: customDay, assignedTime: '10:00', status: 'confirmed' });
    await expect(row).toHaveCount(0);
  } finally {
    expect((await adminApi.delete(`/api/admin/schedule/date?${new URLSearchParams({ direction: 'gori-tbilisi', date: customDay })}`)).ok()).toBeTruthy();
    for (let index = browserErrors.length - 1; index >= 0; index--) {
      if (new RegExp(`^Console: https?://[^\\s]+/api/admin/calls/${id}/convert Failed to load resource:.*\\b409\\b`).test(browserErrors[index])) browserErrors.splice(index, 1);
    }
  }
});

test('a large incoming queue paginates, shares schedules and preserves edits when rows leave the page', async ({ page }) => {
  const timestamp = new Date().toISOString();
  const calls: CallInquiry[] = Array.from({ length: 763 }, (_, index) => ({
    id: 100_001 + index, phone: `555${String(index).padStart(6, '0')}`,
    occurredAt: timestamp, durationSeconds: 15, deviceName: 'Synthetic large-queue fixture',
    createdAt: timestamp, deletedAt: null, bookingId: null, phase: 'completed', passengerProfile: null,
  }));
  await page.route('**/api/admin/calls?*', async route => {
    if (new URL(route.request().url()).searchParams.get('scope') !== 'incoming') { await route.continue(); return; }
    await route.fulfill({ json: { calls } });
  });
  await openAuthenticatedAdmin(page);
  const scheduleRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/admin/schedule' && request.method() === 'GET') scheduleRequests.push(url.search);
  });
  await openAdminView(page, 'შემოსული');
  const rows = page.locator('.admin-calls-table tbody tr');
  await expect(rows).toHaveCount(15);
  await expect(page.locator('.admin-calls-card .admin-call-count')).toHaveText('763');
  const first = incomingCallRow(page, calls[0].id);
  const address = 'გორი, დიდ რიგში შენარჩუნებული ხელით შეყვანილი მისამართი';
  await first.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill(address);
  await chooseCallDay(first, 'ხვალ');
  await chooseCallTime(first, '09:30');
  await chooseCallSeats(first, 8);
  await chooseCallDay(incomingCallRow(page, calls[1].id), 'ხვალ');
  await chooseCallTime(incomingCallRow(page, calls[1].id), '08:30');
  const pagination = page.getByRole('navigation', { name: 'სატელეფონო განაცხადების გვერდები', exact: true });
  await pagination.getByRole('button', { name: 'შემდეგი გვერდი', exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(rows).toHaveCount(15);
  await pagination.getByRole('button', { name: 'წინა გვერდი', exact: true }).click();
  await expect(first.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(address);
  await expect(first.getByRole('group', { name: 'დღე', exact: true }).getByRole('button', { name: /^ხვალ(?:\s|\d|$)/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(first.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(first.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true }).getByRole('button', { name: /^8(?: ადგილი)?$/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('ზარები გვერდზე', { exact: true }).selectOption('30');
  await expect(rows).toHaveCount(30);
  expect(scheduleRequests.length, 'Hundreds of callers must not trigger a schedule request for every row').toBeLessThanOrEqual(3);
  const counts = new Map<string, number>();
  for (const key of scheduleRequests) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const count of counts.values()) expect(count, 'Rows sharing direction/date should share one loaded schedule').toBe(1);
});

test('a late caller number fills an untouched row but preserves a manually cleared phone and address', async ({ page }) => {
  const phone = '555010609';
  const savedPickup = 'გორი, მოგვიანებით ამოცნობილი ნომრის შენახული აყვანის მისამართი';
  await seedConfirmedProfile({ phone, name: 'სატესტო მოგვიანებით ამოცნობილი მგზავრი', address: savedPickup });
  const automaticCall = await seedAnsweredCall(null, 'inline-late-identity-auto-609');
  const manualCall = await seedAnsweredCall(null, 'inline-late-identity-manual-610');
  await openAuthenticatedAdmin(page);
  await openAdminView(page, 'შემოსული');
  const automatic = incomingCallRow(page, automaticCall.id);
  const manual = incomingCallRow(page, manualCall.id);
  await expect(automatic.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('');
  await expect(automatic.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('');
  const manualPhone = manual.getByLabel('ტელეფონის ნომერი', { exact: true });
  await manualPhone.fill('555010610');
  await manualPhone.clear();
  const manualAddress = 'გორი, დამალულ ნომერთან ხელით შენარჩუნებული მისამართი';
  await manual.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill(manualAddress);
  for (const call of [automaticCall, manualCall]) {
    const completed = await adminApi.post('/api/integrations/android/calls', {
      headers: call.headers, data: { ...call.event, phone: `+995${phone}`, phase: 'completed', durationSeconds: 22 },
    });
    expect(completed.ok()).toBeTruthy();
  }
  await expect(automatic).toContainText('დასრულებულია');
  await expect(automatic.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('555 01 06 09');
  await expect(automatic.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(savedPickup);
  await expect(manual).toContainText('დასრულებულია');
  await expect(manualPhone).toHaveValue('');
  await expect(manual.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(manualAddress);
  await expect(manual.getByRole('button', { name: 'დადასტურება', exact: true })).toBeDisabled();
  await chooseCallDay(automatic, 'ხვალ');
  await chooseCallTime(automatic, '08:30');
  const converted = page.waitForResponse(response => response.url().endsWith(`/api/admin/calls/${automaticCall.id}/convert`));
  await automatic.getByRole('button', { name: 'დადასტურება', exact: true }).click();
  const response = await converted;
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ phone, goriAddress: savedPickup, seats: 1, status: 'confirmed' });
  await expect(automatic).toHaveCount(0);
  await manual.getByRole('button', { name: 'უარი', exact: true }).click();
  await expect(manual).toHaveCount(0);
});

test('passenger profile autofill leaves an inactive remembered stop unselected until an active stop is chosen', async ({ page }) => {
  const phone = '555010404';
  const name = 'სატესტო გამორთული გაჩერების პროფილი';
  const address = 'გორი, პროფილის სატესტო მისამართი 404';
  const addedStop = await adminApi.post('/api/admin/stops', { data: {
    name: 'სატესტო დროებით მოქმედი გაჩერება', address: 'თბილისი, სატესტო მისამართი 404',
  } });
  expect(addedStop.ok()).toBeTruthy();
  const { id } = await addedStop.json() as { id: number };
  await seedConfirmedProfile({ phone, name, address, pickupStopId: id });
  expect((await adminApi.patch(`/api/admin/stops/${id}`, { data: { active: false } })).ok()).toBeTruthy();
  await openAuthenticatedAdmin(page);
  const dialog = await openManualOrder(page);
  await chooseOperatorDirection(dialog, 'tbilisi-gori');
  await chooseOperatorDay(dialog, futureDate(1));
  await chooseOperatorTime(dialog, '08:30');
  const lookup = page.waitForResponse(response => isProfileResponse(response, phone));
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
  const response = await lookup;
  expect(response.ok()).toBeTruthy();
  expect((await response.json() as { profile: PassengerProfile | null }).profile)
    .toMatchObject({ phone, name, goriAddress: address, pickupStopId: null });
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(address);
  const stop = dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true });
  await expect(stop).toHaveValue('');
  await expect(stop.locator(`option[value="${id}"]`)).toHaveCount(0);
  expect(await stop.evaluate(element => (element as HTMLSelectElement).validity.valueMissing)).toBe(true);
  await stop.selectOption(String(publicConfig.stops[0].id));
  const saved = page.waitForResponse(value => value.url().endsWith('/api/admin/bookings') && value.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
  const savedResponse = await saved;
  expect(savedResponse.ok()).toBeTruthy();
  expect(await savedResponse.json()).toMatchObject({ phone, name: '', pickupStopId: publicConfig.stops[0].id, status: 'confirmed' });
});

test('public phone entry never looks up or fills trusted passenger details and cannot replace their profile', async ({ page }) => {
  const phone = '555010505';
  const profileName = 'სატესტო დაცული პროფილის სახელი';
  const profileAddress = 'გორი, დაცული პროფილის მისამართი 505';
  const profileStop = publicConfig.stops[1];
  await seedConfirmedProfile({ phone, name: profileName, address: profileAddress, pickupStopId: profileStop.id });
  const profileRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.includes('/passengers/profile')) profileRequests.push(request.url());
  });
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: DIRECTION_LABELS['tbilisi-gori'], exact: true }).click();
  await page.getByLabel('მგზავრობის თარიღი', { exact: true }).fill(futureDate());
  await expect(page.getByRole('group', { name: 'მგზავრობის დრო', exact: true }).getByRole('button')).toHaveCount(18);
  await page.getByRole('button', { name: '08:30', exact: true }).click();
  await continuePublicBooking(page, 'მისამართი');
  await expect(page.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true })).toHaveValue('');
  const manualName = 'სატესტო საჯარო განაცხადის სახელი';
  const manualAddress = 'გორი, საჯარო განაცხადის მისამართი 506';
  await page.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill(manualAddress);
  await page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[0].id));
  await continuePublicBooking(page, 'კონტაქტი');
  await page.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(`+995 ${phone}`);
  await page.getByLabel('ტელეფონის ნომერი', { exact: true }).blur();
  // Run past the admin lookup debounce to catch accidental reuse on the public form.
  await page.clock.runFor(1_000);
  await expect(page.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('555 01 05 05');
  await expect(page.getByLabel('სახელი და გვარი', { exact: true })).toHaveValue('');
  expect(profileRequests, 'The public form must not request a protected passenger profile').toEqual([]);
  await page.getByRole('button', { name: 'უკან', exact: true }).click();
  await expectPublicStep(page, 'მისამართი');
  await expect(page.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(manualAddress);
  await expect(page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true })).toHaveValue(String(publicConfig.stops[0].id));
  await continuePublicBooking(page, 'კონტაქტი');
  await expect(page.getByLabel('სახელი და გვარი', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('555 01 05 05');
  await page.getByLabel('სახელი და გვარი', { exact: true }).fill(manualName);
  const id = await submitPublicForm(page);
  const incoming = await adminApi.get('/api/admin/bookings?scope=incoming');
  expect(incoming.ok()).toBeTruthy();
  expect((await incoming.json() as { bookings: Booking[] }).bookings.find(booking => booking.id === id))
    .toMatchObject({ phone, name: manualName, goriAddress: manualAddress, status: 'waiting' });
  const trusted = await adminApi.get(`/api/admin/passengers/profile?phone=${phone}`);
  expect(trusted.ok()).toBeTruthy();
  expect((await trusted.json() as { profile: PassengerProfile | null }).profile)
    .toMatchObject({ phone, name: profileName, goriAddress: profileAddress, pickupStopId: profileStop.id });
  expect(profileRequests).toEqual([]);
});

test('printing all orders for a day includes every confirmed row beyond pagination and search with complete pickup addresses and totals', async ({ page }) => {
  const day = futureDate(1);
  const { expected, excludedNames } = await seedPrintableDay(day, '555040', 'სატესტო მთელი დღის ბეჭდვა');
  const selected = expected.filter(row => row.direction === 'gori-tbilisi');
  await captureNativePrinting(page);
  await openAuthenticatedAdmin(page);
  await chooseAdminDate(page, day);
  const visibleRows = page.locator('.admin-booking-table tbody tr');
  await expect(visibleRows).toHaveCount(15);
  const toolbar = page.locator('.admin-filters');
  const create = toolbar.getByRole('button', { name: 'ახალი ჯავშანი', exact: true });
  const toolbarPrint = toolbar.getByRole('button', { name: 'ჯავშნების ბეჭდვა', exact: true });
  for (const [action, label] of [[create, 'ახალი ჯავშანი'], [toolbarPrint, 'ბეჭდვა']] as const) {
    await expect(action).toBeVisible();
    await expect(action).toContainText(label);
    const appearance = await action.evaluate(button => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const visibleColors = [style.backgroundColor, ...(style.backgroundImage.match(/rgba?\([^)]+\)/g) ?? [])]
        .map(color => color.match(/[\d.]+/g)?.map(Number) ?? [])
        .filter(channels => channels.length >= 3 && (channels.length < 4 || channels[3] > 0));
      return { height: rect.height, green: visibleColors.length > 0 && visibleColors.every(channels => channels[1] > channels[0] && channels[1] > channels[2]) };
    });
    expect(appearance.height, 'Primary toolbar actions should remain large enough to use').toBeGreaterThanOrEqual(44);
    expect(appearance.green, 'Create and print should both remain visibly green actions').toBeTruthy();
  }
  const searchBox = toolbar.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true });
  expect((await searchBox.boundingBox())!.width, 'Search should leave room for the labeled primary actions').toBeLessThan(page.viewportSize()!.width / 4);
  await create.click();
  const createDialog = page.getByRole('dialog', { name: 'ახალი ჯავშანი', exact: true });
  await expect(createDialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveCount(0);
  await expect(createDialog.getByLabel('ტელეფონის ნომერი', { exact: true })).toBeVisible();
  await createDialog.getByRole('button', { name: 'დახურვა', exact: true }).click();
  await expect(createDialog).toHaveCount(0);
  await page.getByRole('button', { name: 'შემდეგი გვერდი', exact: true }).click();
  await expect(visibleRows).toHaveCount(3);
  await page.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true }).fill(selected[0].name);
  await expect(visibleRows).toHaveCount(1);
  await chooseAdminTime(page, '09:30');
  await expect(visibleRows).toHaveCount(0);
  await page.getByRole('button', { name: 'ჯავშნების ბეჭდვა', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ჯავშნების ბეჭდვა', exact: true });
  await expect(dialog.getByLabel('საბეჭდი თარიღი', { exact: true })).toHaveValue(day);
  await expect(dialog.getByLabel('საბეჭდი მიმართულება', { exact: true })).toHaveValue('gori-tbilisi');
  await expect(dialog.getByLabel('ბეჭდვის რეჟიმი', { exact: true })).toHaveValue('selected');
  await expect(dialog.getByLabel('საბეჭდი დრო', { exact: true })).toHaveValue('09:30');
  await dialog.getByLabel('ბეჭდვის რეჟიმი', { exact: true }).selectOption('all');
  const print = dialog.getByRole('button', { name: 'ბეჭდვა / PDF', exact: true });
  await expect(print).toBeEnabled();
  const dialogLayout = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
  expect(dialogLayout.width, 'A desktop print dialog should use the available width for the report').toBeGreaterThanOrEqual(1000);
  expect(dialogLayout.top).toBeGreaterThanOrEqual(0);
  expect(dialogLayout.bottom).toBeLessThanOrEqual(dialogLayout.viewportHeight);
  expect(dialogLayout.scrollHeight, 'Long reports should scroll inside their preview without scrolling the whole dialog').toBeLessThanOrEqual(dialogLayout.clientHeight + 2);
  expect(dialogLayout.scrollWidth, 'The report should not create a horizontal scrollbar on the whole dialog').toBeLessThanOrEqual(dialogLayout.clientWidth + 2);
  await print.click();
  await expect.poll(async () => (await printedDocuments(page)).length).toBe(1);
  const [document] = await printedDocuments(page);
  expect(document.headings).toEqual(['№', 'დრო', 'მგზავრი', 'ტელეფონი', 'მიმართულება', 'ადგილები', 'ჩასხდომის მისამართი']);
  expect(document.rows).toHaveLength(18);
  for (const row of selected) {
    const printed = document.rows.find(cells => cells.includes(row.name));
    expect(printed, `Every selected-day order must print, including ${row.name}`).toBeDefined();
    expect(printed).toHaveLength(7);
    expect(printed).toEqual(expect.arrayContaining([row.time, row.displayedPhone, DIRECTION_LABELS[row.direction], String(row.seats)]));
    expect(printed!.join(' ')).toContain(row.goriAddress);
  }
  expect(document.text).not.toContain(publicConfig.didubeName);
  expect(document.text).not.toContain(publicConfig.didubeAddress);
  for (const name of [...excludedNames, ...expected.filter(row => row.direction === 'tbilisi-gori').map(row => row.name)]) {
    expect(document.text).not.toContain(name);
  }
  const text = document.text.replace(/\s+/g, ' ');
  const humanDate = day.split('-').reverse().join('/');
  expect(text).toContain(humanDate);
  expect(text).toContain('ყველა დრო');
  expect(text).toContain('სულ ჯავშნები: 18');
  expect(text).toContain('სულ ადგილები: 43');
  // Export the exact captured print document with its copied styles for visual review.
  const paper = await page.context().newPage();
  try {
    await paper.setViewportSize({ width: 1123, height: 794 });
    // A base URL does not change about:blank's origin; navigate first so the
    // captured document can load the application's actual fonts without CORS.
    await paper.goto(new URL('/', page.url()).href, { waitUntil: 'load' });
    await paper.setContent(document.html, { waitUntil: 'load' });
    await paper.emulateMedia({ media: 'print' });
    await paper.evaluate(async () => {
      await Promise.all(['400 12px "Dachi The Lynx"', ...[400, 500, 600, 700, 800].map(weight => `${weight} 12px "FiraGO"`)].map(face => window.document.fonts.load(face)));
      await window.document.fonts.ready;
    });
    await expect(paper.getByRole('table', { name: 'მგზავრებისა და მისამართების სია', exact: true }).getByRole('row')).toHaveCount(19);
    await paper.pdf({ path: '/tmp/greentaxi-booking-report.pdf', printBackground: true, preferCSSPageSize: true });
    await paper.screenshot({ path: '/tmp/greentaxi-booking-report-print.png', fullPage: true });
  } finally { await paper.close(); }
});

test('printing a selected half-hour slot includes both directions while excluding other times and dates', async ({ page }) => {
  const day = futureDate(1);
  const { expected, excludedNames } = await seedPrintableDay(day, '555041', 'სატესტო არჩეული დროის ბეჭდვა');
  await captureNativePrinting(page);
  await openAuthenticatedAdmin(page);
  await chooseAdminDate(page, day);
  await chooseAdminTime(page, '08:30');
  await page.getByRole('button', { name: 'ჯავშნების ბეჭდვა', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ჯავშნების ბეჭდვა', exact: true });
  await expect(dialog.getByLabel('ბეჭდვის რეჟიმი', { exact: true })).toHaveValue('selected');
  await expect(dialog.getByLabel('საბეჭდი დრო', { exact: true })).toHaveValue('08:30');
  await dialog.getByLabel('საბეჭდი მიმართულება', { exact: true }).selectOption('both');
  for (const [index, time] of ['08:30', '09:30'].entries()) {
    await dialog.getByLabel('საბეჭდი დრო', { exact: true }).fill(time);
    const print = dialog.getByRole('button', { name: 'ბეჭდვა / PDF', exact: true });
    await expect(print).toBeEnabled();
    await print.click();
    await expect.poll(async () => (await printedDocuments(page)).length).toBe(index + 1);
    const document = (await printedDocuments(page))[index];
    const selected = expected.filter(row => row.time === time);
    expect(selected).toHaveLength(7);
    expect(document.headings).toEqual(['№', 'დრო', 'მგზავრი', 'ტელეფონი', 'მიმართულება', 'ადგილები', 'ჩასხდომის მისამართი']);
    expect(document.rows).toHaveLength(7);
    for (const row of selected) {
      const printed = document.rows.find(cells => cells.includes(row.name));
      expect(printed).toHaveLength(7);
      expect(printed).toEqual(expect.arrayContaining([time, row.displayedPhone, DIRECTION_LABELS[row.direction], String(row.seats)]));
      if (row.direction === 'tbilisi-gori') {
        expect(printed!.join(' ')).toContain(publicConfig.stops[0].name);
        expect(printed!.join(' ')).toContain(publicConfig.stops[0].address);
        expect(printed!.join(' ')).not.toContain(row.goriAddress);
      } else {
        expect(printed!.join(' ')).toContain(row.goriAddress);
      }
    }
    for (const name of [...excludedNames, ...expected.filter(row => row.time !== time).map(row => row.name)]) expect(document.text).not.toContain(name);
    const text = document.text.replace(/\s+/g, ' ');
    expect(text).toContain('ორივე მიმართულება');
    expect(text).toContain('სულ ჯავშნები: 7');
    expect(text).toContain(`სულ ადგილები: ${selected.reduce((sum, row) => sum + row.seats, 0)}`);
  }
});

test('printing stays blocked for an empty day or a failed fresh report and recovers without opening native print', async ({ page }) => {
  const emptyDay = futureDate(22);
  const reportDay = futureDate(1);
  await clearScheduledFixtureDay(reportDay);
  const created = await adminApi.post('/api/admin/bookings', { data: {
    name: 'სატესტო შეცდომამდე საბეჭდი ჯავშანი', phone: '555042001', seats: 1,
    direction: 'gori-tbilisi', requestedDate: reportDay, requestedTime: '08:30', goriAddress: 'გორი, ბეჭდვის შეცდომის სატესტო მისამართი',
  } });
  expect(created.ok()).toBeTruthy();
  await captureNativePrinting(page);
  await openAuthenticatedAdmin(page);
  await chooseAdminDate(page, emptyDay);
  await page.getByRole('button', { name: 'ჯავშნების ბეჭდვა', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ჯავშნების ბეჭდვა', exact: true });
  const print = dialog.getByRole('button', { name: 'ბეჭდვა / PDF', exact: true });
  await expect(dialog.getByRole('heading', { name: 'არჩეული პირობებით ჯავშნები არ არის', exact: true })).toBeVisible();
  await expect(print).toBeDisabled();
  expect(await printedDocuments(page)).toHaveLength(0);
  await dialog.getByLabel('საბეჭდი თარიღი', { exact: true }).fill(reportDay);
  await expect(print).toBeEnabled();
  const errorMessage = 'სატესტო შეცდომა — საბეჭდი ანგარიში ვერ ჩაიტვირთა';
  await page.evaluate(({ day, message }) => {
    const originalFetch = window.fetch;
    (window as Window & { __restorePrintFetch?: () => void }).__restorePrintFetch = () => { window.fetch = originalFetch; };
    // Return a real HTTP-error Response to the application's existing request handler.
    // Keeping this local avoids unrelated browser resource-error logs for the intentional fault.
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === '/api/admin/bookings' && url.searchParams.get('scope') === 'scheduled' && url.searchParams.get('date') === day) {
        return Promise.resolve(new Response(JSON.stringify({ error: message }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
      }
      return originalFetch.call(window, input, init);
    };
  }, { day: reportDay, message: errorMessage });
  await print.click();
  await expect(dialog.getByRole('alert')).toContainText(errorMessage);
  await expect(print).toBeDisabled();
  expect(await printedDocuments(page)).toHaveLength(0);
  await expect(page.locator('#greentaxi-print-frame')).toHaveCount(0);
  await page.evaluate(() => (window as Window & { __restorePrintFetch?: () => void }).__restorePrintFetch?.());
  await dialog.getByRole('alert').getByRole('button', { name: 'საბეჭდი მონაცემების განახლება', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(print).toBeEnabled();
  expect(await printedDocuments(page)).toHaveLength(0);
});

test('passenger directory shows pickup addresses and opens read-only trip history with separate states', async ({ page }) => {
  const phone = '590886101';
  const legacyName = 'სატესტო ისტორიის ძველი სახელი';
  const address = 'გორი, ისტორიის სატესტო მისამართი 101';
  const past = await seedPassengerTrip({ phone: `+995${phone}`, name: legacyName, address: 'გორი, წარსული მისამართი 11', seats: 2 });
  await setHistoricalFixtureDate(past.id, futureDate(-1));
  const tbilisi = await seedPassengerTrip({ phone: `00995${phone}`, name: legacyName, address: 'გორი, ჩამოსვლის მისამართი 22', seats: 3, pickupStopId: publicConfig.stops[0].id });
  const upcoming = await seedPassengerTrip({ phone, name: legacyName, address, seats: 8 });
  const waiting = await seedPassengerTrip({ phone, name: 'სატესტო დაუდასტურებელი სახელი', address: 'გორი, დაუდასტურებელი მისამართი 33', waiting: true });
  const deleted = await seedPassengerTrip({ phone, name: legacyName, address, seats: 2 });
  expect((await adminApi.post(`/api/admin/bookings/${deleted.id}/delete`, { data: {} })).ok()).toBeTruthy();
  const otherPhone = '590886102';
  const unrelated = await seedPassengerTrip({ phone: otherPhone, name: 'სხვა მგზავრის ძველი სახელი', address: 'გორი, სხვა მგზავრის მისამართი 102' });

  await openAuthenticatedAdmin(page);
  const mutations: string[] = [];
  page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  await openAdminView(page, 'მგზავრები');
  await expect(page).toHaveURL(/\/admin\/passengers$/);
  await searchPassengerDirectory(page, address);
  const row = passengerRow(page, phone);
  await expect(row).toBeVisible();
  await expect(row).toContainText(address);
  await expect(row).toContainText(displayedPassengerPhone(phone));
  await expect(row).not.toContainText(legacyName);
  await expect(row.locator('td').nth(2)).toHaveText('4');
  await expect(row.locator('td').nth(3)).toHaveText('14');
  await expect(page.getByRole('table', { name: 'მგზავრების სია', exact: true }).locator('thead th').first()).toHaveText('მისამართი');
  await expect(row.locator('a[href^="tel:"]')).toHaveAttribute('href', `tel:+995${phone}`);
  await expect(passengerRow(page, otherPhone)).toHaveCount(0);

  const table = await openPassengerHistory(page, phone);
  await expect(passengerHistoryFilter(page, 'წარსული')).toHaveAttribute('aria-pressed', 'true');
  await expect(table.locator('tbody tr[data-booking-id]')).toHaveCount(1);
  await expect(table.locator(`tr[data-booking-id="${past.id}"]`)).toContainText(past.goriAddress);
  await expect(page.locator('body')).not.toContainText(legacyName);
  await expect(page.locator('body')).toContainText(address);
  await expect(page.locator('body')).toContainText(publicConfig.stops[0].name);

  await passengerHistoryFilter(page, 'დაგეგმილი').click();
  await expect(table.locator('tbody tr[data-booking-id]')).toHaveCount(2);
  await expect(table.locator(`tr[data-booking-id="${upcoming.id}"]`)).toBeVisible();
  await expect(table.locator(`tr[data-booking-id="${tbilisi.id}"]`)).toContainText(publicConfig.stops[0].name);
  await passengerHistoryFilter(page, 'დასადასტურებელი').click();
  await expect(table.locator('tbody tr[data-booking-id]')).toHaveCount(1);
  await expect(table.locator(`tr[data-booking-id="${waiting.id}"]`)).toBeVisible();
  await passengerHistoryFilter(page, 'წაშლილი').click();
  await expect(table.locator('tbody tr[data-booking-id]')).toHaveCount(1);
  await expect(table.locator(`tr[data-booking-id="${deleted.id}"]`)).toBeVisible();
  await passengerHistoryFilter(page, 'ყველა').click();
  await expect(table.locator('tbody tr[data-booking-id]')).toHaveCount(5);
  await expect(table.locator(`tr[data-booking-id="${unrelated.id}"]`)).toHaveCount(0);
  expect(mutations, 'Directory, passenger details and history filters must be read-only').toEqual([]);
});

test('passenger history navigation keeps directory search and pagination through browser back and forward', async ({ page }) => {
  const marker = 'გორი, გვერდების ისტორიის სატესტო მისამართი';
  const phones = Array.from({ length: 16 }, (_, index) => `590887${String(index + 1).padStart(3, '0')}`);
  for (const [index, phone] of phones.entries()) {
    await seedPassengerTrip({ phone, name: `სატესტო გვერდის ძველი სახელი ${index}`, address: `${marker} ${index + 1}` });
  }
  await openAuthenticatedAdmin(page);
  await openAdminView(page, 'მგზავრები');
  const search = page.getByRole('textbox', { name: 'მისამართი ან ტელეფონი', exact: true });
  await searchPassengerDirectory(page, marker);
  const rows = page.getByRole('table', { name: 'მგზავრების სია', exact: true }).locator('tbody tr[data-passenger-phone]');
  await expect(rows).toHaveCount(15);
  await expect(page.getByRole('combobox', { name: 'მგზავრები: ჩანაწერები გვერდზე', exact: true })).toHaveValue('15');
  await page.getByRole('button', { name: 'მგზავრები: შემდეგი გვერდი', exact: true }).click();
  await expect(rows).toHaveCount(1);
  const phone = await rows.first().getAttribute('data-passenger-phone');
  expect(phone).toBeTruthy();
  await openPassengerHistory(page, phone!);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/passengers$/);
  await expect(search).toHaveValue(marker);
  await expect(rows).toHaveCount(1);
  await expect(passengerRow(page, phone!)).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: displayedPassengerPhone(phone!), exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: displayedPassengerPhone(phone!), exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'მგზავრების სიაში დაბრუნება', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/passengers$/);
  await expect(page.getByRole('heading', { name: 'მგზავრების სია', exact: true })).toBeVisible();
  // A full reload starts fresh directory state, while browser navigation above
  // must preserve the original in-memory search and second page.
});

test('direct passenger history URL requires sign-in and returns to the requested passenger', async ({ page }) => {
  const phone = '590886201';
  const address = 'გორი, მხოლოდ თანამშრომლისთვის მისამართი 201';
  await seedPassengerTrip({ phone, name: 'სატესტო პირდაპირი შესვლის ძველი სახელი', address });
  await page.goto(`/admin/passengers/${phone}`);
  await expect(page.getByRole('heading', { name: 'მოგესალმებით', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(address);
  await expect(page.getByRole('table', { name: 'მგზავრობის ისტორია', exact: true })).toHaveCount(0);
  await page.getByLabel('მომხმარებლის სახელი', { exact: true }).fill(EMPLOYEE.login);
  await page.getByLabel('პაროლი', { exact: true }).fill(EMPLOYEE.password);
  await page.getByRole('button', { name: 'შესვლა', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/passengers/${phone}$`));
  await expect(page.getByRole('heading', { name: displayedPassengerPhone(phone), exact: true })).toBeVisible();
  await expect(page.locator('body')).toContainText(address);
  await page.reload();
  await expect(page.getByRole('heading', { name: displayedPassengerPhone(phone), exact: true })).toBeVisible();
});

test('slow passenger detail cannot replace another passenger and history stays usable on a narrow screen', async ({ page }) => {
  const firstPhone = '590886301';
  const secondPhone = '590886302';
  const marker = 'გორი, მობილური ისტორიის მისამართი';
  const first = await seedPassengerTrip({ phone: firstPhone, name: 'პირველი სატესტო ძველი სახელი', address: `${marker} 301` });
  const second = await seedPassengerTrip({ phone: secondPhone, name: 'მეორე სატესტო ძველი სახელი', address: `${marker} 302` });
  await setHistoricalFixtureDate(first.id, futureDate(-1));
  await setHistoricalFixtureDate(second.id, futureDate(-1));
  await openAuthenticatedAdmin(page);
  await page.setViewportSize({ width: 320, height: 850 });
  await page.getByRole('button', { name: 'მენიუს გახსნა', exact: true }).click();
  await openAdminView(page, 'მგზავრები');
  await searchPassengerDirectory(page, marker);
  await expect(passengerRow(page, firstPhone)).toBeVisible();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolveGate => { releaseFirst = resolveGate; });
  let firstRequested!: () => void;
  const requestStarted = new Promise<void>(resolveRequest => { firstRequested = resolveRequest; });
  await page.route(`**/api/admin/passengers/${firstPhone}`, async route => {
    const response = await route.fetch();
    firstRequested();
    await firstGate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await passengerRow(page, firstPhone).getByRole('link', { name: `${displayedPassengerPhone(firstPhone)}: მგზავრობის ისტორია`, exact: true }).first().click();
    await requestStarted;
    await page.getByRole('button', { name: 'მგზავრების სიაში დაბრუნება', exact: true }).click();
    const table = await openPassengerHistory(page, secondPhone);
    await expect(table.locator(`tr[data-booking-id="${second.id}"]`)).toBeVisible();
    releaseFirst();
    await expect(page.getByRole('heading', { name: displayedPassengerPhone(secondPhone), exact: true })).toBeVisible();
    await expect(table.locator(`tr[data-booking-id="${first.id}"]`)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(`${marker} 301`);
    await expect(page.locator('body')).toContainText(`${marker} 302`);
    expect(await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))).toEqual({ viewport: 320, document: 320 });
    await passengerHistoryFilter(page, 'დაგეგმილი').click();
    await expect(table.locator('tbody tr[data-booking-id]')).toHaveCount(0);
    await passengerHistoryFilter(page, 'წარსული').click();
    await expect(table.locator(`tr[data-booking-id="${second.id}"]`)).toBeVisible();
  } finally {
    releaseFirst();
    await page.unroute(`**/api/admin/passengers/${firstPhone}`);
  }
});
