import { existsSync } from 'node:fs';
import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Booking, CallInquiry } from '../src/api';
import { operatorSessionPath } from './helpers/operator-session';

const employee = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors, 'Incoming call status changes must not interrupt operator forms').toEqual([]);
  }, { auto: true }],
});
let api: APIRequestContext;
let headers: Record<string, string>;
let deviceId: number;
let sequence = 0;
const calls: number[] = [];

test.beforeAll(async ({ playwright, baseURL }, info) => {
  const sessionPath = operatorSessionPath(info.config.metadata.fixtureDatabasePath);
  api = await playwright.request.newContext({ baseURL, ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}) });
  const session = await (await api.get('/api/auth/session')).json();
  if (!session.user) expect((await api.post(session.needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: employee })).ok()).toBeTruthy();
  const response = await api.post('/api/admin/devices', { data: { name: 'All-incoming disposable Samsung fixture' } });
  expect(response.status()).toBe(201);
  const paired = await response.json();
  deviceId = paired.device.id;
  headers = { Authorization: `Bearer ${paired.token}` };
});
test.afterEach(async () => {
  for (const id of calls.splice(0)) expect((await api.post(`/api/admin/calls/${id}/delete`)).ok()).toBeTruthy();
});
test.afterAll(async () => {
  if (deviceId) expect((await api.patch(`/api/admin/devices/${deviceId}`, { data: { active: false } })).ok()).toBeTruthy();
  await api?.dispose();
});

function row(page: Page, id: number): Locator { return page.locator(`.admin-calls-table tbody tr[data-call-id="${id}"]`); }
function passengers(page: Page, id: number): Locator { return page.locator(`.admin-calls-table tbody tr[data-call-parent-id="${id}"]`); }
function display(phone: string) { return `${phone.slice(0, 3)} ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7)}`; }
async function open(page: Page) {
  await page.context().addCookies((await api.storageState()).cookies);
  await page.goto('/admin');
  await expect(page.locator('.auth-card')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true })
    .getByRole('button', { name: /^შემოსული/ }).click();
}
function event(phone: string, phase: 'ringing' | 'answered' | 'completed' = 'ringing', kind = 'incoming') {
  return { eventId: `all-incoming-browser-${++sequence}`, phone, phase, kind, occurredAt: new Date().toISOString(), durationSeconds: 0 };
}
async function send(data: ReturnType<typeof event>) {
  const response = await api.post('/api/integrations/android/calls', { headers, data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as { id: number; ignored?: boolean };
}
async function incoming(phone: string) {
  const data = event(phone);
  const result = await send(data);
  expect(result.id).toBeGreaterThan(0);
  calls.push(result.id);
  return { id: result.id, data };
}
async function bookingIds() { return ((await (await api.get('/api/admin/bookings')).json()).bookings as Booking[]).map(value => value.id); }
async function expectNoProfile(phone: string) {
  expect((await (await api.get(`/api/admin/passengers/profile?phone=${phone}`)).json()).profile).toBeNull();
}

test('ringing, answer and completion update one card while preserving both passenger drafts and a chosen whole car', async ({ page }) => {
  test.setTimeout(45_000);
  const before = await bookingIds();
  const caller = '555889101', contact = '555889102', secondContact = '555889103';
  const call = await incoming(caller);
  await open(page);
  const first = row(page, call.id);
  await expect(first.locator('[data-call-status="ringing"]')).toHaveText('რეკავს');
  await first.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(contact);
  await first.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, პირველი დამოუკიდებელი მისამართი');
  await first.getByRole('group', { name: 'დღე', exact: true }).getByRole('button', { name: /^ხვალ/ }).click();
  await first.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '09:30', exact: true }).click();
  await first.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true }).getByRole('button', { name: /^3(?: ადგილი)?$/ }).click();
  await first.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }).getByRole('button', { name: 'ბარგი', exact: true }).click();
  await first.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }).getByRole('button', { name: 'ძაღლი', exact: true }).click();
  await first.getByRole('group', { name: 'სასურველი ადგილი', exact: true }).getByRole('button', { name: 'წინ', exact: true }).click();
  await first.getByRole('button', { name: 'მგზავრის დამატება', exact: true }).click();
  await expect(passengers(page, call.id)).toHaveCount(2);
  const second = passengers(page, call.id).nth(1);
  await second.getByLabel('ტელეფონის ნომერი', { exact: true }).fill(secondContact);
  await second.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('გორი, მეორე დამოუკიდებელი მისამართი');
  await second.getByRole('button', { name: 'მთლიანი მანქანა', exact: true }).click();
  await second.locator('[data-whole-car-picker]').click();
  const picker = page.locator('[data-whole-car-dialog]');
  await picker.locator('[data-whole-car-driver]:not(:disabled)').first().click();
  if (await picker.locator('[data-whole-car-confirm]').isVisible()) await picker.locator('[data-whole-car-confirm]').click();
  await expect(picker).toHaveCount(0);
  const chosenDriver = await second.locator('[data-whole-car-selected-name]').innerText();

  for (const [phase, seconds, label] of [['answered', 0, 'მიმდინარეობს'], ['completed', 72, 'დასრულებულია']] as const) {
    expect((await send({ ...call.data, phase, durationSeconds: seconds })).id).toBe(call.id);
    await expect(first.locator(`[data-call-status="${phase}"]`)).toContainText(label);
    await expect(passengers(page, call.id)).toHaveCount(2);
    await expect(first.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(contact));
    await expect(first.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, პირველი დამოუკიდებელი მისამართი');
    await expect(first.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true }).getByRole('button', { name: /^3(?: ადგილი)?$/ })).toHaveAttribute('aria-pressed', 'true');
    for (const service of ['ბარგი', 'ძაღლი']) await expect(first.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }).getByRole('button', { name: service, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(first.getByRole('group', { name: 'სასურველი ადგილი', exact: true }).getByRole('button', { name: 'წინ', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(second.getByLabel('ტელეფონის ნომერი', { exact: true })).toHaveValue(display(secondContact));
    await expect(second.getByLabel('აყვანის მისამართი გორში', { exact: true })).toHaveValue('გორი, მეორე დამოუკიდებელი მისამართი');
    await expect(second.getByRole('button', { name: 'მთლიანი მანქანა', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(second.locator('[data-whole-car-selected-name]')).toHaveText(chosenDriver);
    for (const passenger of [first, second]) {
      await expect(passenger.getByRole('group', { name: 'დღე', exact: true }).getByRole('button', { name: /^ხვალ/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(passenger.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '09:30', exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
  }
  await expect(first.locator('[data-call-status="completed"] small')).toHaveText('1:12');
  expect(await bookingIds()).toEqual(before);
  for (const phone of [caller, contact, secondContact]) await expectNoProfile(phone);
  const list = (await (await api.get('/api/admin/calls?scope=incoming')).json()).calls as CallInquiry[];
  expect(list.filter(value => value.id === call.id)).toHaveLength(1);
  expect(list.find(value => value.id === call.id)).toMatchObject({ bookingId: null, callStatus: 'completed' });
});

test('missed and rejected calls remain available without bookings and later phone status never reopens an operator-deleted card', async ({ page }) => {
  const before = await bookingIds();
  const missed = await incoming('555889201');
  const rejected = event('555889202', 'completed', 'rejected');
  const rejectedResult = await send(rejected);
  calls.push(rejectedResult.id);
  await open(page);
  await expect(row(page, missed.id).locator('[data-call-status="ringing"]')).toHaveText('რეკავს');
  expect((await send({ ...missed.data, kind: 'missed', phase: 'completed' })).id).toBe(missed.id);
  await expect(row(page, missed.id).locator('[data-call-status="missed"]')).toHaveText('გამოტოვებული');
  await expect(row(page, rejectedResult.id).locator('[data-call-status="rejected"]')).toHaveText('უარყოფილი');
  await expect(row(page, missed.id).locator('.admin-call-status small')).toHaveCount(0);
  await expect(row(page, rejectedResult.id).locator('.admin-call-status small')).toHaveCount(0);
  await row(page, missed.id).getByRole('button', { name: 'უარი', exact: true }).click();
  await expect(row(page, missed.id)).toHaveCount(0);
  expect((await send({ ...missed.data, kind: 'missed', phase: 'completed' })).id).toBe(missed.id);
  await page.locator('.admin-calls-card').getByRole('button', { name: 'განახლება', exact: true }).click();
  await expect(row(page, rejectedResult.id)).toBeVisible();
  await expect(row(page, missed.id)).toHaveCount(0);
  const deleted = (await (await api.get('/api/admin/calls?scope=deleted')).json()).calls as CallInquiry[];
  expect(deleted.find(value => value.id === missed.id)).toMatchObject({ callStatus: 'missed' });
  expect((await send(event('555889203', 'completed', 'outgoing'))).ignored).toBe(true);
  expect(await bookingIds()).toEqual(before);
  for (const phone of ['555889201', '555889202', '555889203']) await expectNoProfile(phone);
});
