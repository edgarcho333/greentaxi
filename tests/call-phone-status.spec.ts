import { existsSync } from 'node:fs';
import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { CallDevice } from '../src/api';
import { operatorSessionPath } from './helpers/operator-session';

const employee = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'Phone delivery status must not throw browser runtime errors').toEqual([]);
  }, { auto: true }],
});
let api: APIRequestContext;
const deviceIds: number[] = [];

test.beforeAll(async ({ playwright, baseURL }, info) => {
  const sessionPath = operatorSessionPath(info.config.metadata.fixtureDatabasePath);
  api = await playwright.request.newContext({ baseURL, ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}) });
  const session = await (await api.get('/api/auth/session')).json();
  if (!session.user) expect((await api.post(session.needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: employee })).ok()).toBeTruthy();
});
test.afterEach(async () => {
  for (const id of deviceIds.splice(0)) expect((await api.patch(`/api/admin/devices/${id}`, { data: { active: false } })).ok()).toBeTruthy();
});
test.afterAll(async () => { await api?.dispose(); });

async function device(name: string): Promise<{ device: CallDevice; token: string }> {
  const response = await api.post('/api/admin/devices', { data: { name } });
  expect(response.status()).toBe(201);
  const paired = await response.json() as { device: CallDevice; token: string };
  deviceIds.push(paired.device.id); return paired;
}
async function heartbeat(token: string, pendingCount = 3, lastError: string | null = 'network', appVersion = '0.2.2', monitoring = true) {
  const response = await api.post('/api/integrations/android/heartbeat', {
    headers: { Authorization: `Bearer ${token}` }, data: {
      appVersion, androidVersion: '11', monitoring, pendingCount,
      oldestPendingAt: pendingCount ? new Date(Date.now() - 60_000).toISOString() : null, lastError,
    },
  });
  expect(response.status()).toBe(200);
}
async function devices(): Promise<CallDevice[]> { return (await (await api.get('/api/admin/devices/status')).json()).devices; }
const summary = (page: Page): Locator => page.locator('[data-call-phone-status]');
const phone = (page: Page, id: number): Locator => summary(page).locator(`[data-call-phone-device="${id}"]`);
async function open(page: Page) {
  await page.context().addCookies((await api.storageState()).cookies);
  await page.goto('/admin');
  await expect(page.locator('.auth-card')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true }).getByRole('button', { name: /^შემოსული/ }).click();
  await expect(summary(page)).toBeVisible();
}

test('phone status separates live queue reports from legacy apps without inventing calls or exposing pairing tokens', async ({ page }) => {
  const a02 = await device('Samsung A02 სტატუსის ტესტი');
  const legacy = await device('Galaxy A14 ძველი აპის ტესტი');
  const before = await (await api.get('/api/admin/incoming-counts')).json();
  await heartbeat(a02.token, 3);
  await open(page);
  await expect(phone(page, a02.device.id).locator('[data-call-phone-connection]')).toHaveAttribute('data-connection-state', 'online');
  await expect(phone(page, a02.device.id)).toContainText('ტელეფონი კავშირზეა');
  await expect(phone(page, a02.device.id).locator('[data-call-phone-stale-help]')).toHaveCount(0);
  await expect(phone(page, a02.device.id).locator('[data-call-phone-pending]')).toHaveText('გასაგზავნია: 3');
  await expect(phone(page, legacy.device.id).locator('[data-call-phone-connection]')).toHaveAttribute('data-connection-state', 'unknown');
  await expect(phone(page, legacy.device.id)).toContainText('სტატუსი უცნობია');
  await expect(phone(page, legacy.device.id)).toContainText('დააყენეთ Green Taxi Samsung 2');
  await expect(phone(page, legacy.device.id).getByRole('link', { name: 'ახალი აპის ჩამოტვირთვა: Green Taxi Samsung 2', exact: true })).toHaveAttribute('href', '/downloads/GreenTaxi-Samsung-2.apk');
  await expect(phone(page, legacy.device.id).locator('[data-call-phone-pending]')).toHaveCount(0);
  const text = await summary(page).innerText();
  expect(text).not.toContain(a02.token); expect(text).not.toContain(legacy.token);
  expect(await (await api.get('/api/admin/incoming-counts')).json()).toEqual(before);
  await page.screenshot({ path: '/tmp/greentaxi-call-phone-status-desktop.png', fullPage: true });
});

test('a stale phone report is clearly historical instead of claiming its last queue count is live', async ({ page }) => {
  const a02 = await device('Samsung A02 ძველი ანგარიშის ტესტი');
  const stopped = await device('Samsung A14 გამორთული მონიტორინგის ტესტი');
  await heartbeat(a02.token, 4);
  await heartbeat(stopped.token, 0, null, '0.2.3', false);
  const rows = await devices();
  const lastReport = new Date(Date.now() - 5 * 60_000).toISOString();
  const stale = rows.map(row => row.id === a02.device.id ? { ...row, connectionState: 'stale', lastSeenAt: new Date(Date.now() - 30_000).toISOString(), heartbeat: { ...row.heartbeat!, receivedAt: lastReport } } : row);
  await page.route('**/api/admin/devices/status', route => route.fulfill({ json: { devices: stale } }));
  await open(page);
  const card = phone(page, a02.device.id);
  await expect(card.locator('[data-call-phone-connection]')).toHaveAttribute('data-connection-state', 'stale');
  await expect(card).toContainText('სტატუსი არ განახლებულა');
  await expect(card).not.toContainText('კავშირი შესამოწმებელია');
  await expect(card).not.toContainText('ტელეფონი კავშირზეა');
  await expect(card.locator('[data-call-phone-pending]')).toHaveText('ბოლო ანგარიშში გასაგზავნი: 4');
  await expect(card).toContainText('ბოლო სტატუსი:');
  await expect(card.locator('[data-call-phone-stale-help]')).toContainText('გახსენით აპი და შეამოწმეთ მონიტორინგი.');
  await expect(card.locator('[data-call-phone-last-call]')).toContainText('ბოლო მიღებული ზარი:');
  const stoppedCard = phone(page, stopped.device.id);
  await expect(stoppedCard.locator('[data-call-phone-connection]')).toHaveAttribute('data-connection-state', 'stale');
  await expect(stoppedCard.locator('[data-call-phone-connection]')).toHaveText('ბოლო ანგარიშში გამორთულია');
  await expect(stoppedCard).not.toContainText('სტატუსი არ განახლებულა');
  await expect(stoppedCard.locator('[data-call-phone-pending]')).toHaveText('ბოლო ანგარიშში გასაგზავნი: 0');
  await summary(page).screenshot({ path: '/tmp/greentaxi-call-status-stale.png' });
});

test('the all-incoming update preserves pairing for the pilot and ordinary receiver and is hidden for the current version', async ({ page }) => {
  const previous = await device('Samsung A14 0.3.1 განახლების ტესტი');
  const pilot = await device('Samsung A55 0.3.0-pilot აღდგენის ტესტი');
  const current = await device('Samsung A14 0.3.2 განახლების ტესტი');
  await heartbeat(previous.token, 0, null, '0.3.1');
  await heartbeat(pilot.token, 2, 'network', '0.3.0-pilot');
  await heartbeat(current.token, 0, null, '0.3.2');
  await open(page);
  const previousCard = phone(page, previous.device.id);
  await expect(previousCard.locator('[data-call-phone-update]')).toContainText('დაკავშირება შენარჩუნდება');
  await expect(previousCard.getByRole('link', { name: 'აპის განახლება 0.3.2: Green Taxi Samsung 2', exact: true })).toHaveAttribute('href', '/downloads/GreenTaxi-Samsung-2.apk');
  await expect(previousCard).not.toContainText('ხელახლა დააკავშირეთ ტელეფონი');
  await expect(previousCard.locator('[data-call-phone-stale-help]')).toHaveCount(0);
  const pilotCard = phone(page, pilot.device.id);
  await expect(pilotCard.getByRole('link', { name: 'აპის განახლება 0.3.2: Green Taxi Samsung 2', exact: true })).toHaveAttribute('href', '/downloads/GreenTaxi-Samsung-2.apk');
  await expect(pilotCard.locator('[data-call-phone-update]')).toContainText('ტელეფონის აპად აირჩიეთ Samsung');
  await expect(pilotCard.locator('[data-call-phone-update]')).toContainText('გაუგზავნელი ზარები შენარჩუნდება');
  await expect(pilotCard).not.toContainText('ხელახლა დააკავშირეთ ტელეფონი');
  await expect(pilotCard.locator('[data-call-phone-pending]')).toHaveText('გასაგზავნია: 2');
  await expect(phone(page, current.device.id).locator('[data-call-phone-update]')).toHaveCount(0);
  await expect(phone(page, current.device.id).getByRole('link')).toHaveCount(0);
  await expect(phone(page, current.device.id).locator('[data-call-phone-connection]')).toHaveAttribute('data-connection-state', 'online');
});

test('a failed browser refresh stops claiming the phone is online and preserves only its last reported queue', async ({ page }) => {
  const a02 = await device('Samsung A02 კავშირის შეცდომის ტესტი');
  await heartbeat(a02.token, 2);
  await open(page);
  const card = phone(page, a02.device.id);
  await expect(card.locator('[data-call-phone-connection]')).toHaveAttribute('data-connection-state', 'online');
  await page.route('**/api/admin/devices/status', route => route.abort('failed'));
  await summary(page).getByRole('button', { name: 'ზარების ტელეფონების სტატუსის განახლება', exact: true }).click();
  await expect(card.locator('[data-call-phone-connection]')).toHaveAttribute('data-connection-state', 'unknown');
  await expect(card).toContainText('სტატუსი ვერ განახლდა');
  await expect(card.locator('[data-call-phone-pending]')).toHaveText('ბოლო ანგარიშში გასაგზავნი: 2');
  await expect(summary(page)).toContainText('ტელეფონების სტატუსი ვერ განახლდა');
});

test('device settings show app diagnostics separately from the last received call and keep codes private', async ({ page }) => {
  const a02 = await device('Samsung A02 დიაგნოსტიკის ტესტი');
  await heartbeat(a02.token, 5);
  await open(page);
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true }).getByRole('button', { name: 'პარამეტრები', exact: true }).click();
  const settings = page.locator(`[data-call-device-settings="${a02.device.id}"]`);
  await expect(settings).toBeVisible();
  await expect(settings).toContainText('ბოლო მიღებული ზარი:');
  const diagnostics = settings.locator('[data-call-phone-diagnostics]');
  await expect(diagnostics).toContainText('ბოლო სტატუსი');
  await expect(diagnostics).toContainText('აპის ვერსია'); await expect(diagnostics).toContainText('0.2.2');
  await expect(diagnostics).toContainText('Android'); await expect(diagnostics).toContainText('11');
  await expect(diagnostics).toContainText('ინტერნეტთან კავშირი ვერ დამყარდა');
  await expect(diagnostics.locator('[data-call-phone-pending]')).toHaveText('გასაგზავნია: 5');
  expect(await settings.innerText()).not.toContain(a02.token);
  await settings.screenshot({ path: '/tmp/greentaxi-call-phone-status-settings.png' });
});

test('settings still create a one-time pairing code, hide it and revoke the same device with status polling active', async ({ page }) => {
  await device('Galaxy A14 პარამეტრების გახსნის ტესტი');
  await open(page);
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true }).getByRole('button', { name: 'პარამეტრები', exact: true }).click();
  await page.getByRole('textbox', { name: 'ტელეფონის სახელი', exact: true }).fill('Samsung A02 ახალი დაკავშირების ტესტი');
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/devices' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'დაკავშირების კოდის შექმნა', exact: true }).click();
  const result = await created; expect(result.status()).toBe(201);
  const paired = await result.json() as { device: CallDevice; token: string };
  deviceIds.push(paired.device.id);
  await expect(page.locator('.admin-config-token')).toHaveText(paired.token);
  const settings = page.locator(`[data-call-device-settings="${paired.device.id}"]`);
  await expect(settings.locator('[data-call-phone-connection]')).toHaveAttribute('data-connection-state', 'unknown');
  await page.getByRole('button', { name: 'კოდის დამალვა', exact: true }).click();
  await expect(page.locator('.admin-config-token')).toHaveCount(0);
  const revoked = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/devices/${paired.device.id}` && response.request().method() === 'PATCH');
  await settings.getByRole('button', { name: 'წვდომის გაუქმება', exact: true }).click();
  expect((await revoked).status()).toBe(200);
  await expect(settings.locator('[data-call-phone-connection]')).toHaveAttribute('data-connection-state', 'disabled');
  await expect(settings).toContainText('წვდომა გაუქმებულია');
  await expect(settings.getByRole('button', { name: 'წვდომის გაუქმება', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'ტელეფონების ბოლო კავშირის განახლება', exact: true }).click();
  await expect(settings.locator('[data-call-phone-connection]')).toHaveAttribute('data-connection-state', 'disabled');
  const rejected = await api.post('/api/integrations/android/heartbeat', {
    headers: { Authorization: `Bearer ${paired.token}` }, data: {
      appVersion: '0.2.2', androidVersion: '11', monitoring: true, pendingCount: 0, oldestPendingAt: null, lastError: null,
    },
  });
  expect(rejected.status()).toBe(401);
});

test('phone names, connection text and reported queue fit a narrow screen', async ({ page }) => {
  const a02 = await device('Samsung Galaxy A02 მიმღები ტელეფონი გრძელი სახელით');
  await heartbeat(a02.token, 12);
  await open(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.locator('.admin-sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
  const card = phone(page, a02.device.id);
  await expect(card).toBeVisible();
  await expect(card.locator('[data-call-phone-pending]')).toHaveText('გასაგზავნია: 12');
  const fits = await summary(page).evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1;
  });
  expect(fits).toBeTruthy();
  await page.screenshot({ path: '/tmp/greentaxi-call-phone-status-mobile.png', fullPage: true, animations: 'disabled' });
});
