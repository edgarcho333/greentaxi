import { test as base, expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import type { Booking, CallInquiry, Direction, PassengerProfile, PublicConfig } from '../src/api';

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
  await expect(dialog.getByLabel('დრო', { exact: true })).toBeEnabled();
  return dialog;
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
    goriAddress: input.address, requestedDate: futureDate(9), requestedTime: '21:00',
  } });
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({
    name: input.name, phone: input.phone, status: 'confirmed', seats: 4,
  });
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

async function seedPrintableDay(day: string, phonePrefix: string, namePrefix: string) {
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
  expect((await adminApi.post(`/api/admin/bookings/${movedId}/move`, { data: { date: futureDate(30), time: '08:30' } })).ok()).toBeTruthy();
  return { expected, excludedNames };
}

async function fillPublicForm(page: Page, input: {
  direction: Direction; seats: number; name: string; date?: string; time?: string;
}) {
  const day = input.date ?? futureDate();
  const address = 'გორი, სატესტო ქუჩა 12';
  await page.goto('/');
  await page.getByRole('button', { name: DIRECTION_LABELS[input.direction], exact: true }).click();
  await page.getByLabel('მგზავრობის თარიღი', { exact: true }).fill(day);
  await expect(page.getByRole('group', { name: 'მგზავრობის დრო', exact: true }).getByRole('button')).toHaveText(TIMES);
  const seats = page.getByLabel('ადგილების რაოდენობა', { exact: true });
  await expect(seats.locator('option')).toHaveText(['1 ადგილი', '2 ადგილი', '3 ადგილი', '4 ადგილი']);
  await seats.selectOption(String(input.seats));
  await page.getByRole('button', { name: input.time ?? '08:30', exact: true }).click();
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
  const day = futureDate();
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
  await expect(confirmDialog.getByLabel('თარიღი', { exact: true })).toHaveValue(day);
  await expect(confirmDialog.getByLabel('დრო', { exact: true })).toBeEnabled();
  await confirmDialog.getByLabel('დრო', { exact: true }).selectOption('09:30');
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
  await row.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  const restoreDialog = page.getByRole('dialog', { name: 'ჯავშნის აღდგენა', exact: true });
  await expect(restoreDialog.getByLabel('დრო', { exact: true })).toBeEnabled();
  await expect(restoreDialog.getByLabel('დრო', { exact: true })).toHaveValue('09:30');
  const restored = page.waitForResponse(response => response.url().endsWith(`/api/admin/bookings/${id}/restore`));
  await restoreDialog.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  const restoredResponse = await restored;
  expect(restoredResponse.ok()).toBeTruthy();
  expect(await restoredResponse.json()).toMatchObject({
    id, name, seats: 3, status: 'confirmed', deletedAt: null,
    assignedDate: day, assignedTime: '09:30', goriAddress: 'გორი, სატესტო ქუჩა 12',
  });
  await expect(restoreDialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await openAdminView(page, 'ჯავშნები');
  await expect(row).toBeVisible();
  await expect(row).toContainText('დადასტურებული');
});

test('a manual staff order is immediately confirmed with four seats', async ({ page }) => {
  const name = 'სატესტო ხელით შექმნილი';
  const day = futureDate(3);
  await login(page);
  await page.getByRole('button', { name: 'ახალი ჯავშანი', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ახალი ჯავშანი', exact: true });
  await dialog.getByLabel('მგზავრის სახელი', { exact: true }).fill(name);
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill('+995555000456');
  const seats = dialog.getByLabel('ადგილების რაოდენობა', { exact: true });
  await expect(seats.locator('option')).toHaveText(['1 ადგილი', '2 ადგილი', '3 ადგილი', '4 ადგილი']);
  await seats.selectOption('4');
  await dialog.getByLabel(/^აყვანის მისამართი გორში/).fill('გორი, სატესტო ქუჩა 24');
  await dialog.getByLabel('თარიღი', { exact: true }).fill(day);
  await expect(dialog.getByLabel('დრო', { exact: true })).toBeEnabled();
  await dialog.getByLabel('დრო', { exact: true }).selectOption('10:00');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ name, phone: '555000456', seats: 4, status: 'confirmed', assignedDate: day, assignedTime: '10:00' });
  await expect(dialog).toHaveCount(0);
  await chooseAdminDate(page, day);
  const row = bookingRow(page, name);
  await expect(row).toBeVisible();
  await expect(row).toContainText('დადასტურებული');
  await expect(row.locator('.admin-seat-badge')).toHaveText('4');
});

test('direction, date and time filters change the actual scheduled order list', async ({ page }) => {
  const day = futureDate();
  const nextDay = futureDate(3);
  const fixtures = [
    { name: 'ფილტრის ტესტი პირველი', direction: 'gori-tbilisi', requestedDate: day, requestedTime: '08:00' },
    { name: 'ფილტრის ტესტი მეორე', direction: 'gori-tbilisi', requestedDate: day, requestedTime: '09:00' },
    { name: 'ფილტრის ტესტი მესამე', direction: 'gori-tbilisi', requestedDate: nextDay, requestedTime: '08:00' },
    { name: 'ფილტრის ტესტი მეოთხე', direction: 'tbilisi-gori', requestedDate: day, requestedTime: '08:00' },
  ];
  for (const input of fixtures) {
    const response = await adminApi.post('/api/admin/bookings', { data: {
      ...input, phone: '+995555000789', seats: 2, goriAddress: 'გორი, სატესტო ქუჩა 36',
      ...(input.direction === 'tbilisi-gori' ? { pickupStopId: publicConfig.stops[0].id } : {}),
    } });
    expect(response.ok()).toBeTruthy();
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
  const callRow = callRows.filter({ has: page.getByText(displayedCaller, { exact: true }) });
  await expect(callRows).toHaveCount(1);
  await expect(callRow).toContainText('SIM ზარი');
  await expect(callRow).toContainText('1:07');
  await expect(callRow).toContainText('Redmi Android15 browser test');
  await page.screenshot({ path: '/tmp/greentaxi-admin-phone.png', fullPage: true });
  await callRow.getByRole('button', { name: `${displayedCaller}: ზარის წაშლა`, exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'სატელეფონო განაცხადის წაშლა', exact: true });
  await deleteDialog.getByRole('button', { name: 'წაშლა', exact: true }).click();
  await expect(deleteDialog).toHaveCount(0);
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
  await callRow.getByRole('button', { name: 'ჯავშნის შექმნა', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ზარის მიხედვით ჯავშნის შექმნა', exact: true });
  await expect(dialog.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(displayedCaller);
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel(/^აყვანის მისამართი გორში/)).toHaveValue('');
  const name = 'სატესტო სატელეფონო ჯავშანი';
  const day = futureDate(4);
  await dialog.getByLabel('მგზავრის სახელი', { exact: true }).fill(name);
  await dialog.getByLabel('ადგილების რაოდენობა', { exact: true }).selectOption('4');
  await dialog.getByLabel(/^აყვანის მისამართი გორში/).fill('გორი, სატესტო ქუჩა 48');
  await dialog.getByLabel('თარიღი', { exact: true }).fill(day);
  await expect(dialog.getByLabel('დრო', { exact: true })).toBeEnabled();
  await dialog.getByLabel('დრო', { exact: true }).selectOption('11:00');
  const converted = page.waitForResponse(response => response.url().endsWith(`/api/admin/calls/${inquiry.id}/convert`));
  await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
  const convertedResponse = await converted;
  expect(convertedResponse.ok()).toBeTruthy();
  const saved = await convertedResponse.json() as Booking;
  expect(saved).toMatchObject({
    name, phone: caller, seats: 4, status: 'confirmed',
    assignedDate: day, assignedTime: '11:00', goriAddress: 'გორი, სატესტო ქუჩა 48',
  });
  await expect(dialog).toHaveCount(0);
  await expect(callRow).toHaveCount(0);
  const linkedResponse = await adminApi.get('/api/admin/calls?scope=converted');
  expect(linkedResponse.ok()).toBeTruthy();
  expect((await linkedResponse.json() as { calls: { id: number; bookingId: number }[] }).calls)
    .toEqual([expect.objectContaining({ id: inquiry.id, bookingId: saved.id })]);
  await openAdminView(page, 'ჯავშნები');
  await chooseAdminDate(page, day);
  await chooseAdminTime(page, '11:00');
  await expect(bookingRow(page, name)).toBeVisible();
  await expect(bookingRow(page, name)).toContainText('დადასტურებული');
  const revoked = await adminApi.patch(`/api/admin/devices/${device.id}`, { data: { active: false } });
  expect(revoked.ok()).toBeTruthy();
  const denied = await adminApi.post('/api/integrations/android/calls', {
    headers, data: { ...event, eventId: 'browser-after-revoke' },
  });
  expect(denied.status()).toBe(401);
});

test('restore confirmed order requires explicit alternative when its previous slot is disabled', async ({ page }) => {
  const name = 'სატესტო გამორთული სლოტის აღდგენა';
  const day = futureDate(5);
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
  await login(page);
  await openAdminView(page, 'ისტორია');
  await page.getByRole('textbox', { name: 'მგზავრის სახელი ან ტელეფონი', exact: true }).fill(name);
  const row = bookingRow(page, name);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'აღდგენა', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ჯავშნის აღდგენა', exact: true });
  const time = dialog.getByLabel('დრო', { exact: true });
  await expect(time).toBeEnabled();
  await expect(time).toHaveValue('');
  await expect(time.locator('option')).toHaveText(['აირჩიეთ მოქმედი დრო', '07:00', '10:00']);
  await expect(dialog.locator('.admin-notice')).toContainText('ჯავშნის გადატანა ავტომატურად არ მოხდება');
  await expect(dialog.getByRole('button', { name: 'აღდგენა', exact: true })).toBeDisabled();
  const unchanged = await adminApi.get(`/api/admin/bookings?${new URLSearchParams({ scope: 'deleted', search: name })}`);
  expect(unchanged.ok()).toBeTruthy();
  expect((await unchanged.json() as { bookings: Booking[] }).bookings)
    .toEqual([expect.objectContaining({ id: booking.id, assignedDate: day, assignedTime: '09:30' })]);
  await time.selectOption('07:00');
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
  for (const direction of Object.keys(DIRECTION_LABELS) as Direction[]) {
    await page.getByRole('button', { name: DIRECTION_LABELS[direction], exact: true }).click();
    await expect(page.getByRole('group', { name: 'მგზავრობის დრო', exact: true }).getByRole('button')).toHaveCount(18);
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      html: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.html).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
    await expect(page.getByRole('button', { name: 'ჯავშნის გაგზავნა', exact: true })).toBeVisible();
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
    await dialog.getByLabel('მიმართულება', { exact: true }).selectOption('tbilisi-gori');
    await expect(dialog.getByLabel('დრო', { exact: true })).toBeEnabled();
    const freshDate = await dialog.getByLabel('თარიღი', { exact: true }).inputValue();
    const freshTime = await dialog.getByLabel('დრო', { exact: true }).inputValue();
    expect(freshDate).not.toBe(futureDate(9));
    expect(freshTime).not.toBe('21:00');
    await expect(dialog.getByLabel('ადგილების რაოდენობა', { exact: true })).toHaveValue('1');
    const lookup = page.waitForResponse(response => isProfileResponse(response, phone));
    await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(formatted);
    await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).blur();
    const response = await lookup;
    expect(response.ok()).toBeTruthy();
    expect((await response.json() as { profile: PassengerProfile | null }).profile)
      .toMatchObject({ phone, name, goriAddress: address, pickupStopId: stop.id });
    await expect(dialog.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('555 01 01 01');
    await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveValue(name);
    await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(address);
    await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue(String(stop.id));
    await expect(dialog.getByLabel('თარიღი', { exact: true })).toHaveValue(freshDate);
    await expect(dialog.getByLabel('დრო', { exact: true })).toHaveValue(freshTime);
    await expect(dialog.getByLabel('ადგილების რაოდენობა', { exact: true })).toHaveValue('1');
    if (index < formats.length - 1) {
      await dialog.getByRole('button', { name: 'გაუქმება', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    } else {
      const saved = page.waitForResponse(value => value.url().endsWith('/api/admin/bookings') && value.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
      const savedResponse = await saved;
      expect(savedResponse.ok()).toBeTruthy();
      expect(await savedResponse.json()).toMatchObject({
        phone, name, goriAddress: address, pickupStopId: stop.id, seats: 1,
        status: 'confirmed', assignedDate: freshDate, assignedTime: freshTime,
      });
      await expect(dialog).toHaveCount(0);
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
  await dialog.getByLabel('მიმართულება', { exact: true }).selectOption('tbilisi-gori');
  const known = page.waitForResponse(response => isProfileResponse(response, phone));
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
  expect((await known).ok()).toBeTruthy();
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveValue(name);
  await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(address);
  await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue(String(stop.id));
  const unknownPhone = '555019991';
  const unknown = page.waitForResponse(response => isProfileResponse(response, unknownPhone));
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(unknownPhone);
  const unknownResponse = await unknown;
  expect(unknownResponse.ok()).toBeTruthy();
  expect(await unknownResponse.json()).toEqual({ profile: null });
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue('');
  const manualName = 'სატესტო ხელით შეყვანილი სახელი';
  const manualAddress = 'გორი, ხელით შეყვანილი მისამართი 112';
  await dialog.getByLabel('მგზავრის სახელი', { exact: true }).fill(manualName);
  await dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill(manualAddress);
  await dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[2].id));
  const anotherPhone = '555019992';
  const anotherUnknown = page.waitForResponse(response => isProfileResponse(response, anotherPhone));
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(anotherPhone);
  expect((await anotherUnknown).ok()).toBeTruthy();
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveValue(manualName);
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
  await dialog.getByLabel('მიმართულება', { exact: true }).selectOption('tbilisi-gori');
  const lookup = page.waitForResponse(response => isProfileResponse(response, phone));
  const manualName = 'სატესტო ოპერატორის ახალი სახელი';
  try {
    await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
    await backendReady;
    await dialog.getByLabel('მგზავრის სახელი', { exact: true }).fill(manualName);
    await dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill('სატესტო დროებითი მისამართი');
    await dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).clear();
    await dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[2].id));
  } finally { releaseLookup(); }
  const response = await lookup;
  expect(response.ok()).toBeTruthy();
  expect((await response.json() as { profile: PassengerProfile | null }).profile?.name).toBe('სატესტო ძველი პროფილის სახელი');
  await expect(dialog.locator('.admin-profile-feedback')).toContainText('მგზავრი ნაპოვნია');
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveValue(manualName);
  await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue(String(publicConfig.stops[2].id));
  const manualAddress = 'გორი, ოპერატორის ახალი მისამართი 203';
  await dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill(manualAddress);
  const saved = page.waitForResponse(value => value.url().endsWith('/api/admin/bookings') && value.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
  const savedResponse = await saved;
  expect(savedResponse.ok()).toBeTruthy();
  expect(await savedResponse.json()).toMatchObject({
    phone, name: manualName, goriAddress: manualAddress, pickupStopId: publicConfig.stops[2].id,
  });
});

test('live Android call shows a known profile, updates the same row on completion and preserves manual conversion edits', async ({ page }) => {
  const phone = '555010303';
  const displayedPhone = '555 01 03 03';
  const name = 'სატესტო ნაცნობი დამრეკავი';
  const address = 'გორი, დამრეკავის შენახული მისამართი 303';
  const stop = publicConfig.stops[1];
  await seedConfirmedProfile({ phone, name, address, pickupStopId: stop.id });
  const paired = await adminApi.post('/api/admin/devices', { data: { name: 'Profile browser caller device' } });
  expect(paired.ok()).toBeTruthy();
  const { token } = await paired.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  const event = {
    eventId: 'profile-known-caller-303', kind: 'incoming', phase: 'answered', phone: `+995${phone}`,
    occurredAt: new Date().toISOString(), durationSeconds: 0,
  };
  const eventResponse = await adminApi.post('/api/integrations/android/calls', {
    headers, data: event,
  });
  expect(eventResponse.status()).toBe(201);
  const { id } = await eventResponse.json() as { id: number };
  const initialCalls = await adminApi.get('/api/admin/calls?scope=incoming');
  expect(initialCalls.ok()).toBeTruthy();
  expect((await initialCalls.json() as { calls: CallInquiry[] }).calls.find(call => call.id === id)).toMatchObject({
    id, phone, phase: 'answered', durationSeconds: 0,
    passengerProfile: { phone, name, goriAddress: address, pickupStopId: stop.id, pickupStopName: stop.name },
  });
  await openAuthenticatedAdmin(page);
  let reportSlowQueueReady!: () => void;
  const slowQueueReady = new Promise<void>(resolve => { reportSlowQueueReady = resolve; });
  await page.route('**/api/admin/calls?*', async route => {
    if (new URL(route.request().url()).searchParams.get('scope') !== 'incoming') { await route.continue(); return; }
    const response = await route.fetch();
    reportSlowQueueReady();
    // Delay every queue response beyond the poll interval, including focus-triggered refreshes.
    // The card cannot appear if polling repeatedly aborts these real responses.
    await new Promise(resolve => setTimeout(resolve, 2_500));
    await route.fulfill({ response });
  });
  await openAdminView(page, 'შემოსული');
  await slowQueueReady;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const rows = page.locator('.admin-calls-table tbody tr');
  const row = rows.filter({ has: page.getByText(displayedPhone, { exact: true }) });
  await expect(row).toBeVisible();
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(name);
  await expect(row).toContainText(address);
  await expect(row).toContainText(stop.name);
  await expect(row).toContainText('ზარი მიმდინარეობს');
  await expect(row.getByRole('link', { name: `${displayedPhone}: დარეკვა`, exact: true })).toHaveAttribute('href', `tel:+995${phone}`);
  await page.locator('.admin-calls-card').screenshot({ path: '/tmp/greentaxi-known-live-card.png' });
  const completed = await adminApi.post('/api/integrations/android/calls', {
    headers, data: { ...event, phase: 'completed', phone: `995${phone}`, durationSeconds: 31 },
  });
  expect(completed.status()).toBe(200);
  expect(await completed.json()).toEqual({ id, duplicate: true });
  // Keep the page open: the actual queue refresh must update the existing card.
  await expect(row).toContainText('0:31', { timeout: 15_000 });
  await expect(row).toContainText('ზარი დასრულებულია');
  await expect(row).not.toContainText('ზარი მიმდინარეობს');
  await expect(row).toHaveCount(1);
  const finishedCalls = await adminApi.get('/api/admin/calls?scope=incoming');
  expect(finishedCalls.ok()).toBeTruthy();
  const finished = (await finishedCalls.json() as { calls: CallInquiry[] }).calls.filter(call => call.id === id);
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({ id, phone, phase: 'completed', durationSeconds: 31, passengerProfile: { name, goriAddress: address } });

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
  const lookup = page.waitForResponse(response => isProfileResponse(response, phone));
  await row.getByRole('button', { name: 'ჯავშნის შექმნა', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ზარის მიხედვით ჯავშნის შექმნა', exact: true });
  const manualName = 'სატესტო ზარის შესწორებული სახელი';
  const manualAddress = 'გორი, ზარის შესწორებული მისამართი 304';
  let freshDate = '';
  let freshTime = '';
  try {
    // The trusted profile included in the card fills the form before the held lookup resolves.
    await expect(dialog.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(displayedPhone);
    await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveValue(name);
    await expect(dialog.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue(address);
    await dialog.getByLabel('მიმართულება', { exact: true }).selectOption('tbilisi-gori');
    await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue(String(stop.id));
    await expect(dialog.getByLabel('ადგილების რაოდენობა', { exact: true })).toHaveValue('1');
    await expect(dialog.getByLabel('თარიღი', { exact: true })).toHaveValue(futureDate(0));
    await expect(dialog.getByLabel('დრო', { exact: true })).toBeEnabled();
    freshDate = await dialog.getByLabel('თარიღი', { exact: true }).inputValue();
    freshTime = await dialog.getByLabel('დრო', { exact: true }).inputValue();
    expect(freshTime).not.toBe('21:00');
    await backendReady;
    await dialog.getByLabel('მგზავრის სახელი', { exact: true }).fill(manualName);
    await dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill(manualAddress);
    await dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[2].id));
  } finally { releaseLookup(); }
  expect((await lookup).ok()).toBeTruthy();
  await expect(dialog.locator('.admin-profile-feedback')).toContainText('მგზავრი ნაპოვნია');
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveValue(manualName);
  await expect(dialog.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue(manualAddress);
  await expect(dialog.getByLabel('აყვანის ადგილი თბილისში', { exact: true })).toHaveValue(String(publicConfig.stops[2].id));
  await expect(dialog.getByLabel('თარიღი', { exact: true })).toHaveValue(freshDate);
  await expect(dialog.getByLabel('დრო', { exact: true })).toHaveValue(freshTime);
  await expect(dialog.getByLabel('ადგილების რაოდენობა', { exact: true })).toHaveValue('1');
  const converted = page.waitForResponse(value => value.url().endsWith(`/api/admin/calls/${id}/convert`));
  await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
  const response = await converted;
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({
    phone, name: manualName, goriAddress: manualAddress, pickupStopId: publicConfig.stops[2].id,
    direction: 'tbilisi-gori', seats: 1, status: 'confirmed', assignedDate: freshDate, assignedTime: freshTime,
  });
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
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
  await dialog.getByLabel('მიმართულება', { exact: true }).selectOption('tbilisi-gori');
  const lookup = page.waitForResponse(response => isProfileResponse(response, phone));
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(phone);
  const response = await lookup;
  expect(response.ok()).toBeTruthy();
  expect((await response.json() as { profile: PassengerProfile | null }).profile)
    .toMatchObject({ phone, name, goriAddress: address, pickupStopId: null });
  await expect(dialog.getByLabel('მგზავრის სახელი', { exact: true })).toHaveValue(name);
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
  expect(await savedResponse.json()).toMatchObject({ phone, name, pickupStopId: publicConfig.stops[0].id, status: 'confirmed' });
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
  await expect(page.getByRole('group', { name: 'მგზავრობის დრო', exact: true }).getByRole('button')).toHaveCount(18);
  await page.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(`+995 ${phone}`);
  await page.getByLabel('ტელეფონის ნომერი', { exact: true }).blur();
  // Run past the admin lookup debounce to catch accidental reuse on the public form.
  await page.clock.runFor(1_000);
  await expect(page.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue('555 01 05 05');
  await expect(page.getByLabel('სახელი და გვარი', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true })).toHaveValue('');
  expect(profileRequests, 'The public form must not request a protected passenger profile').toEqual([]);
  const manualName = 'სატესტო საჯარო განაცხადის სახელი';
  const manualAddress = 'გორი, საჯარო განაცხადის მისამართი 506';
  await page.getByLabel('სახელი და გვარი', { exact: true }).fill(manualName);
  await page.getByLabel('ჩამოსვლის მისამართი გორში', { exact: true }).fill(manualAddress);
  await page.getByLabel('ჩასხდომის ადგილი თბილისში', { exact: true }).selectOption(String(publicConfig.stops[0].id));
  await page.getByLabel('მგზავრობის თარიღი', { exact: true }).fill(futureDate());
  await expect(page.getByRole('group', { name: 'მგზავრობის დრო', exact: true }).getByRole('button')).toHaveCount(18);
  await page.getByRole('button', { name: '08:30', exact: true }).click();
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
  const day = futureDate(14);
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
  await expect(createDialog.getByLabel('მგზავრის სახელი', { exact: true })).toBeVisible();
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
  const day = futureDate(18);
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
  const reportDay = futureDate(26);
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
