import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { addDays, today, type DriverSchedule } from '../src/api';
import { operatorSessionPath } from './helpers/operator-session';

const employee = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
let api: APIRequestContext;
const createdIds: number[] = [];
type Printed = { headings: string[]; rows: { id: number; cells: string[] }[]; phoneSize: number; fits: boolean; text: string };
type PrintWindow = Window & { __driversPrints?: Printed[] };

async function schedule(): Promise<DriverSchedule> {
  const response = await api.get(`/api/admin/drivers/schedule?direction=gori-tbilisi&date=${today()}`);
  expect(response.ok()).toBeTruthy(); return response.json();
}
async function createDriver(name: string, phone: string | null, capacity = 7): Promise<number> {
  const response = await api.post('/api/admin/drivers', { headers: { 'Idempotency-Key': randomUUID() }, data: { name, phone, capacity } });
  expect(response.status()).toBe(201);
  const { driver } = await response.json(); createdIds.push(driver.id); return driver.id;
}
async function archiveDriver(id: number) {
  const driver = (await schedule()).drivers.find(item => item.id === id);
  if (!driver) return;
  const response = await api.delete(`/api/admin/drivers/${id}`, { headers: { 'Idempotency-Key': randomUUID() }, data: { expectedRevision: driver.revision } });
  expect(response.ok()).toBeTruthy();
}
async function openSettings(page: Page) {
  await page.context().addCookies((await api.storageState()).cookies);
  await page.goto('/admin');
  const navigation = page.getByRole('navigation', { name: 'ადმინისტრატორის ნავიგაცია', exact: true });
  const mobileMenu = page.getByRole('button', { name: 'მენიუს გახსნა', exact: true });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await navigation.getByRole('button', { name: 'პარამეტრები', exact: true }).click();
}

test.beforeAll(async ({ playwright, baseURL }, info) => {
  const state = operatorSessionPath(info.config.metadata.fixtureDatabasePath);
  api = await playwright.request.newContext({ baseURL, ...(existsSync(state) ? { storageState: state } : {}) });
  const session = await (await api.get('/api/auth/session')).json();
  if (!session.user) expect((await api.post(session.needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: employee })).ok()).toBeTruthy();
});
test.afterEach(async () => { for (const id of createdIds.splice(0).reverse()) await archiveDriver(id); });
test.afterAll(async () => { await api?.dispose(); });

test('Settings prints the complete fresh roster in the permanent queue, including declined drivers and excluding deleted ones', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const storage = window.top as PrintWindow; storage.__driversPrints ??= [];
    window.print = () => {
      const report = document.querySelector<HTMLElement>('.drivers-print-report')!;
      storage.__driversPrints!.push({
        headings: Array.from(report.querySelectorAll('thead th'), cell => cell.textContent?.trim() ?? ''),
        rows: Array.from(report.querySelectorAll('tbody tr[data-print-driver-id]'), row => ({ id: Number(row.getAttribute('data-print-driver-id')), cells: Array.from(row.querySelectorAll('td'), cell => cell.textContent?.trim() ?? '') })),
        phoneSize: Number.parseFloat(getComputedStyle(report.querySelector('.drivers-print-phone')!).fontSize),
        fits: report.scrollWidth <= report.clientWidth,
        text: document.body.innerText,
      });
    };
  });
  const first = await createDriver('საბეჭდი პირველი მძღოლი', '555884101', 6);
  const declined = await createDriver('საბეჭდი მეორე მძღოლი', null, 8);
  const archived = await createDriver('საბეჭდი წაშლილი მძღოლი', '555884102');
  await archiveDriver(archived);
  expect((await api.patch(`/api/admin/drivers/${declined}/day`, { data: { direction: 'gori-tbilisi', date: today(), declined: true } })).ok()).toBeTruthy();

  await openSettings(page);
  // Neither the selected trip direction nor another calendar day should turn a
  // full permanent roster report into the visible daily/active subset.
  const filters = page.locator('.admin-config-schedule-filters');
  await filters.getByLabel('მიმართულება', { exact: true }).selectOption('tbilisi-gori');
  await filters.getByLabel('თარიღი', { exact: true }).fill(addDays(today(), 3));
  const trigger = page.getByRole('button', { name: 'ყველა მძღოლის ბეჭდვა', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'ყველა მძღოლის ბეჭდვა', exact: true });
  const preview = dialog.getByRole('article', { name: 'ყველა მძღოლის დასაბეჭდი სია', exact: true });
  const before = await schedule();
  await expect(preview.locator('tbody tr')).toHaveCount(before.drivers.length);
  await expect(preview.locator('tbody tr').first()).toHaveAttribute('data-print-driver-id', String(declined));
  await expect(preview.locator(`[data-print-driver-id="${archived}"]`)).toHaveCount(0);
  await expect(preview.locator(`[data-print-driver-id="${declined}"]`)).toContainText('—');
  await expect(preview.locator(`[data-print-driver-id="${first}"]`)).toContainText('555 88 41 01');

  // Changes after opening preview must still be included in the actual print.
  expect((await api.patch(`/api/admin/drivers/${first}/phone`, { data: { phone: '555884103' } })).ok()).toBeTruthy();
  const latest = await createDriver('საბეჭდი ბოლოს დამატებული მძღოლი', '555884104');
  await dialog.getByRole('button', { name: 'ბეჭდვა / PDF', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as PrintWindow).__driversPrints?.length ?? 0)).toBe(1);
  const printed = await page.evaluate(() => (window as PrintWindow).__driversPrints![0]);
  expect(printed.headings).toEqual(['რიგი', 'მძღოლი', 'ტელეფონის ნომერი', 'ადგილები']);
  expect(printed.rows).toHaveLength(before.drivers.length + 1);
  expect(printed.rows.slice(0, 3).map(row => row.id)).toEqual([latest, declined, first]);
  expect(printed.rows.some(row => row.id === archived)).toBe(false);
  expect(printed.rows.find(row => row.id === first)?.cells).toEqual(['3', 'საბეჭდი პირველი მძღოლი', '555 88 41 03', '6']);
  expect(printed.rows.find(row => row.id === declined)?.cells).toEqual(['2', 'საბეჭდი მეორე მძღოლი', '—', '8']);
  expect(printed.rows.every(row => row.cells.length === 4)).toBeTruthy();
  expect(printed.phoneSize).toBeCloseTo(14 * 96 / 72, 1);
  expect(printed.fits).toBe(true);
  expect(printed.text).not.toContain(employee.login);
  expect(printed.text).not.toContain('პაროლი');
  await dialog.getByRole('button', { name: 'დახურვა', exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(errors).toEqual([]);
});

test('a failed driver list cannot print and retry loads the full list', async ({ page }) => {
  await openSettings(page);
  await page.route('**/api/admin/drivers/schedule?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'სია დროებით მიუწვდომელია.' }) }));
  await page.getByRole('button', { name: 'ყველა მძღოლის ბეჭდვა', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ყველა მძღოლის ბეჭდვა', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('სია დროებით მიუწვდომელია.');
  await expect(dialog.getByRole('button', { name: 'ბეჭდვა / PDF', exact: true })).toBeDisabled();
  await expect(dialog.locator('.drivers-print-report')).toHaveCount(0);
  await page.unroute('**/api/admin/drivers/schedule?**');
  await dialog.getByRole('button', { name: 'ხელახლა ცდა', exact: true }).click();
  await expect(dialog.locator('[data-print-driver-id]')).toHaveCount((await schedule()).drivers.length);
  await expect(dialog.getByRole('button', { name: 'ბეჭდვა / PDF', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
});
