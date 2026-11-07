import { existsSync } from 'node:fs';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { addDays, today, type Booking, type DriverDashboard, type TripCapacity, type WholeCarOptions } from '../src/api';
import { formatPhone } from '../shared/phone';
import { operatorSessionPath } from './helpers/operator-session';

const employee = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
const driver = { id: 37, phone: '599941037' };
const wholeDriver = 36;
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors).toEqual([]);
  }, { auto: true }],
});
let admin: APIRequestContext;
let driverApi: APIRequestContext;
const created = new Set<number>();
const assigned = new Map<number, Set<string>>();
let sequence = 0;
const date = () => addDays(today(), 1);

async function capacity(time: string): Promise<TripCapacity> {
  const response = await admin.get(`/api/admin/trips/capacity?${new URLSearchParams({ direction: 'gori-tbilisi', date: date(), time })}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
function rememberAssignment(id: number, time: string) {
  const times = assigned.get(id) ?? new Set<string>(); times.add(time); assigned.set(id, times);
}
async function assign(id = driver.id, time = '09:30') {
  expect((await admin.patch(`/api/admin/drivers/${id}/day`, { data: { direction: 'gori-tbilisi', date: date(), declined: false } })).ok()).toBeTruthy();
  const trip = await capacity(time);
  if (!trip.drivers.some(value => value.key === `roster:${id}`)) {
    expect((await admin.post('/api/admin/trips/drivers', { data: {
      direction: 'gori-tbilisi', date: date(), time, expectedRevision: trip.revision,
      action: 'add', driver: { kind: 'roster', id },
    } })).status()).toBe(201);
  }
  rememberAssignment(id, time);
}
function input(phone: string, address: string, seats: number, changes: Record<string, unknown> = {}) {
  return { phone, callerPhone: '599941099', seats, direction: 'gori-tbilisi', requestedDate: date(), requestedTime: '09:30', goriAddress: address, ...changes };
}
async function group(values: ReturnType<typeof input>[]): Promise<Booking[]> {
  const response = await admin.post('/api/admin/bookings/group', { headers: { 'Idempotency-Key': `browser-travel-party-${++sequence}` }, data: { bookings: values } });
  expect(response.status(), await response.text()).toBe(201);
  const rows = (await response.json()).bookings as Booking[];
  rows.forEach(row => created.add(row.id));
  if (rows.length > 1) {
    expect(new Set(rows.map(row => row.travelGroupId)).size).toBe(1);
    expect(rows[0].travelGroupId).toBeTruthy();
  }
  return rows;
}
async function remove(id: number) {
  expect((await admin.post(`/api/admin/bookings/${id}/delete`)).ok()).toBeTruthy(); created.delete(id);
}
async function open(page: Page) {
  await page.context().addCookies((await driverApi.storageState()).cookies);
  await page.goto('/driver');
  await expect(page.locator('[data-driver-portal]')).toBeVisible();
  await page.getByRole('group', { name: 'დღეები', exact: true }).getByRole('button', { name: 'ხვალ', exact: true }).click();
  await expect(page.locator('[data-driver-bookings]')).toHaveAttribute('data-date', date());
}
async function refresh(page: Page) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/driver/dashboard');
  await page.getByRole('button', { name: 'ჯავშნების განახლება', exact: true }).click();
  await response;
}

test.beforeAll(async ({ playwright, baseURL }, info) => {
  const path = operatorSessionPath(info.config.metadata.fixtureDatabasePath);
  admin = await playwright.request.newContext({ baseURL, ...(existsSync(path) ? { storageState: path } : {}) });
  const session = await (await admin.get('/api/auth/session')).json();
  if (!session.user) expect((await admin.post(session.needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: employee })).ok()).toBeTruthy();
  expect((await admin.patch(`/api/admin/drivers/${driver.id}/phone`, { data: { phone: driver.phone } })).ok()).toBeTruthy();
  driverApi = await playwright.request.newContext({ baseURL });
  expect((await driverApi.post('/api/driver/auth/login', { data: { phone: driver.phone } })).ok()).toBeTruthy();
});
test.afterEach(async () => {
  for (const id of [...created]) await remove(id);
  for (const [id, times] of assigned) for (const time of times) {
    const trip = await capacity(time);
    if (trip.drivers.some(value => value.key === `roster:${id}`)) expect((await admin.post('/api/admin/trips/drivers', { data: {
      direction: 'gori-tbilisi', date: date(), time, expectedRevision: trip.revision, action: 'remove', removeKey: `roster:${id}`,
    } })).ok()).toBeTruthy();
  }
  assigned.clear();
});
test.afterAll(async () => {
  if (admin) expect((await admin.patch(`/api/admin/drivers/${driver.id}/phone`, { data: { phone: null } })).ok()).toBeTruthy();
  await driverApi?.dispose(); await admin?.dispose();
});

test('a same-car party has one driver card with both pickup phones, while another batch stays separate and changes retain exact seat totals', async ({ page }) => {
  await assign(); await assign(driver.id, '14:00');
  const [first, second] = await group([
    input('555969101', 'გორი, ერთობლივი პირველი მისამართი', 1, { luggage: true }),
    input('555969102', 'გორი, ერთობლივი მეორე მისამართი', 2, { dog: true }),
  ]);
  const independentResponse = await admin.post('/api/admin/bookings', { data: input('555969103', 'გორი, დამოუკიდებელი მისამართი', 1) });
  expect(independentResponse.status()).toBe(201);
  const independent = await independentResponse.json() as Booking; created.add(independent.id);
  await open(page);
  const party = page.locator('[data-driver-travel-group]');
  await expect(party).toHaveCount(1);
  await expect(party).toContainText('ერთ მანქანაში');
  await expect(party.locator('[data-driver-group-seat-count]')).toHaveText('3');
  await expect(page.locator('[data-driver-seat-count]')).toHaveText('4');
  await expect(page.locator('[data-driver-booking-count]')).toHaveText('2');
  for (const [index, booking] of [first, second].entries()) {
    const child = party.locator(`[data-driver-booking="${booking.id}"]`);
    await expect(child).toContainText(`აყვანა ${index + 1}`);
    await expect(child).toContainText(booking.goriAddress);
    await expect(child.locator('a[href^="tel:"]')).toHaveText(formatPhone(booking.phone));
    await expect(child.locator('a[href^="tel:"]')).toHaveAttribute('href', `tel:+995${booking.phone}`);
  }
  await expect(party.locator(`[data-driver-booking="${first.id}"]`)).toContainText('ბარგი');
  await expect(party.locator(`[data-driver-booking="${second.id}"]`)).toContainText('ძაღლი');
  await expect(party.locator(`[data-driver-booking="${independent.id}"]`)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await party.screenshot({ path: '/tmp/greentaxi-driver-same-car-group.png' });

  expect((await admin.post(`/api/admin/bookings/${second.id}/move`, { data: { date: date(), time: '14:00' } })).ok()).toBeTruthy();
  await refresh(page);
  await expect(party).toHaveCount(0);
  await expect(page.locator('[data-driver-seat-count]')).toHaveText('2');
  await page.getByRole('group', { name: 'რეისის დრო', exact: true }).getByRole('button', { name: '14:00', exact: true }).click();
  await expect(page.locator(`[data-driver-booking="${second.id}"]`)).toBeVisible();
  await expect(page.locator('[data-driver-seat-count]')).toHaveText('2');
  await expect(party).toHaveCount(0);
  await remove(second.id);
  await refresh(page);
  await expect(page.locator(`[data-driver-booking="${second.id}"]`)).toHaveCount(0);
  await expect(page.locator('[data-driver-seat-count]')).toHaveText('0');
});

test('a group larger than this car warns the driver, and hidden whole-car members do not create a group or expose their contact', async ({ page }) => {
  await assign();
  const large = await group([input('555969201', 'გორი, დიდი ჯგუფი პირველი', 8), input('555969202', 'გორი, დიდი ჯგუფი მეორე', 8)]);
  const options = await admin.get(`/api/admin/trips/whole-car-options?direction=gori-tbilisi&date=${date()}&time=09:30`);
  expect(options.ok()).toBeTruthy();
  const vehicle = (await options.json() as WholeCarOptions).drivers.find(value => value.key === `roster:${wholeDriver}`)!;
  expect(vehicle).toBeTruthy();
  const mixed = await group([
    input('555969203', 'გორი, საერთო ჯგუფის ხილული მისამართი', 1),
    input('555969204', 'გორი, ფარული მთლიანი მანქანის მისამართი', 1, { bookingType: 'whole_car', assignedVehicleKey: vehicle.key, expectedVehicleRevision: vehicle.revision }),
  ]);
  rememberAssignment(wholeDriver, '09:30');
  await open(page);
  await expect(page.locator('[data-driver-travel-group]')).toHaveCount(1);
  await expect(page.locator('[data-driver-group-capacity-warning]')).toContainText('დაუკავშირდით ოპერატორს');
  await expect(page.locator('[data-driver-group-seat-count]')).toHaveText('16');
  await expect(page.locator('[data-driver-seat-count]')).toHaveText('17');
  await expect(page.locator('[data-driver-booking-count]')).toHaveText('2');
  for (const child of large) await expect(page.locator(`[data-driver-booking="${child.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-driver-booking="${mixed[0].id}"]`)).toBeVisible();
  await expect(page.locator(`[data-driver-booking="${mixed[1].id}"]`)).toHaveCount(0);
  const dashboard = await driverApi.get(`/api/driver/dashboard?date=${date()}`);
  expect(dashboard.ok()).toBeTruthy();
  const body = await dashboard.text();
  expect(body).not.toContain(mixed[1].phone);
  const dto = JSON.parse(body) as DriverDashboard;
  expect(dto.bookings.find(value => value.id === mixed[0].id)?.travelGroupId).toBeNull();
  expect(dto.bookings.find(value => value.id === mixed[0].id)?.travelGroupOrder).toBeNull();
});
