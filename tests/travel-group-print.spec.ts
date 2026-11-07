import { existsSync } from 'node:fs';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { addDays, today, type Booking } from '../src/api';
import { operatorSessionPath } from './helpers/operator-session';

const employee = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
let api: APIRequestContext;
const ids: number[] = [];
const day = () => addDays(today(), 1);
const formatted = (phone: string) => `${phone.slice(0, 3)} ${phone.slice(3, 5)} ${phone.slice(5, 7)} ${phone.slice(7)}`;
type Printed = { headings: string[]; rows: { id: string | null; cells: string[]; group: string | null }[]; phoneSize: number; text: string };
type PrintWindow = Window & { __travelGroupPrints?: Printed[] };

test.beforeAll(async ({ playwright, baseURL }, info) => {
  const state = operatorSessionPath(info.config.metadata.fixtureDatabasePath);
  api = await playwright.request.newContext({ baseURL, ...(existsSync(state) ? { storageState: state } : {}) });
  const session = await (await api.get('/api/auth/session')).json();
  if (!session.user) expect((await api.post(session.needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: employee })).ok()).toBeTruthy();
});
test.afterEach(async () => { for (const id of ids.splice(0)) expect((await api.post(`/api/admin/bookings/${id}/delete`)).ok()).toBeTruthy(); });
test.afterAll(async () => { await api?.dispose(); });

function input(phone: string, address: string, seats: number) {
  return { phone, callerPhone: '555899100', seats, direction: 'gori-tbilisi', goriAddress: address, requestedDate: day(), requestedTime: '10:00' };
}
async function openDay(page: Page) {
  await page.context().addCookies((await api.storageState()).cookies);
  await page.goto('/admin');
  await page.getByLabel('აირჩიეთ სხვა თარიღი', { exact: true }).fill(day());
}
function row(page: Page, id: number) { return page.locator(`.admin-booking-table tr[data-booking-id="${id}"]`); }
async function printSnapshot(page: Page, capture = false): Promise<Printed> {
  const previous = await page.evaluate(() => (window as PrintWindow).__travelGroupPrints?.length ?? 0);
  await page.getByRole('button', { name: 'ჯავშნების ბეჭდვა', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ჯავშნების ბეჭდვა', exact: true });
  await dialog.getByLabel('ბეჭდვის რეჟიმი', { exact: true }).selectOption('all');
  if (capture) {
    await expect(dialog.locator('[data-print-travel-group]')).toHaveCount(2);
    await dialog.locator('.booking-print-report').screenshot({ path: '/tmp/greentaxi-same-car-print.png' });
  }
  await dialog.getByRole('button', { name: 'ბეჭდვა / PDF', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as PrintWindow).__travelGroupPrints?.length ?? 0)).toBe(previous + 1);
  const result = await page.evaluate(() => (window as PrintWindow).__travelGroupPrints!.at(-1)!);
  await dialog.getByRole('button', { name: 'დახურვა', exact: true }).click();
  return result;
}

test('same-car markers preserve separate contacts and the portrait print layout, and disappear when a companion moves or is cancelled', async ({ page }) => {
  test.setTimeout(45_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const storage = window.top as PrintWindow;
    storage.__travelGroupPrints ??= [];
    window.print = () => storage.__travelGroupPrints!.push({
      headings: Array.from(document.querySelectorAll('thead th'), cell => cell.textContent?.trim() ?? ''),
      rows: Array.from(document.querySelectorAll('tbody tr[data-print-booking-id]'), row => ({
        id: row.getAttribute('data-print-booking-id'),
        cells: Array.from(row.querySelectorAll('td'), cell => cell.textContent?.trim() ?? ''),
        group: row.querySelector('[data-print-travel-group]')?.textContent?.trim() ?? null,
      })),
      phoneSize: Number.parseFloat(getComputedStyle(document.querySelector('.booking-print-phone')!).fontSize),
      text: document.body.innerText,
    });
  });

  const created = await api.post('/api/admin/bookings/group', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { bookings: [
    input('555899101', 'გორი, ერთად პირველი აყვანის ადგილი 101', 2),
    input('555899102', 'გორი, ერთად მეორე აყვანის ადგილი 102', 1),
  ] } });
  expect(created.status()).toBe(201);
  const together = (await created.json()).bookings as Booking[];
  ids.push(...together.map(booking => booking.id));
  expect(together).toHaveLength(2);
  expect(together[0].travelGroupId).toBeTruthy();
  expect(together[1].travelGroupId).toBe(together[0].travelGroupId);
  const separateResponse = await api.post('/api/admin/bookings', { data: input('555899103', 'გორი, დამოუკიდებელი აყვანის ადგილი 103', 1) });
  expect(separateResponse.status()).toBe(201);
  const separate = await separateResponse.json() as Booking;
  ids.push(separate.id);

  await openDay(page);
  for (const booking of together) {
    await expect(row(page, booking.id).locator('[data-admin-travel-group]')).toContainText('ერთ მანქანაში');
    await expect(row(page, booking.id)).toContainText(formatted(booking.phone));
    await expect(row(page, booking.id)).toContainText(booking.goriAddress);
  }
  await expect(row(page, separate.id).locator('[data-admin-travel-group]')).toHaveCount(0);
  expect(await row(page, together[0].id).getAttribute('data-travel-group')).toBe(await row(page, together[1].id).getAttribute('data-travel-group'));
  const ordered = await page.locator('.admin-booking-table tbody tr[data-booking-id]').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-booking-id'))));
  expect(Math.abs(ordered.indexOf(together[0].id) - ordered.indexOf(together[1].id))).toBe(1);

  const firstPrint = await printSnapshot(page, true);
  expect(firstPrint.headings).toEqual(['მისამართი', 'ადგილები', 'ტელეფონის ნომერი', 'საათი', 'ნომერი']);
  const printed = together.map(booking => firstPrint.rows.find(row => row.id === String(booking.id))!);
  expect(printed.every(row => row.cells.length === 5)).toBeTruthy();
  expect(printed[0].group).toBe(printed[1].group);
  expect(printed[0].group).toContain('ერთ მანქანაში');
  for (const [index, booking] of together.entries()) {
    expect(printed[index].cells[0]).toContain(booking.goriAddress);
    expect(printed[index].cells[1]).toBe(String(booking.seats));
    expect(printed[index].cells[2]).toContain(formatted(booking.phone));
  }
  expect(firstPrint.rows.find(row => row.id === String(separate.id))!.group).toBeNull();
  expect(firstPrint.phoneSize).toBeCloseTo(14 * 96 / 72, 1);

  expect((await api.post(`/api/admin/bookings/${together[1].id}/move`, { data: { date: day(), time: '11:00' } })).ok()).toBeTruthy();
  await openDay(page);
  for (const booking of together) await expect(row(page, booking.id).locator('[data-admin-travel-group]')).toHaveCount(0);
  const movedPrint = await printSnapshot(page);
  for (const booking of together) expect(movedPrint.rows.find(row => row.id === String(booking.id))!.group).toBeNull();
  expect(movedPrint.rows.find(row => row.id === String(together[1].id))!.cells[3]).toBe('11:00');

  expect((await api.post(`/api/admin/bookings/${together[1].id}/delete`)).ok()).toBeTruthy();
  await openDay(page);
  await expect(row(page, together[0].id)).toBeVisible();
  await expect(row(page, together[1].id)).toHaveCount(0);
  await expect(row(page, together[0].id).locator('[data-admin-travel-group]')).toHaveCount(0);
  const cancelledPrint = await printSnapshot(page);
  expect(cancelledPrint.rows.some(row => row.id === String(together[1].id))).toBe(false);
  expect(cancelledPrint.rows.find(row => row.id === String(together[0].id))!.cells[1]).toBe('2');
  expect(errors).toEqual([]);
});
