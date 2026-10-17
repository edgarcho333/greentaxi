import { existsSync } from 'node:fs';
import { operatorSessionPath } from './helpers/operator-session';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { addDays, today, type TripCapacity } from '../src/api';

let api: APIRequestContext;
const createdIds: number[] = [];
const seededCars: { date: string; time: string; key: string }[] = [];
const employee = { login: 'browser_test', name: 'სატესტო თანამშრომელი', password: 'test-only-local-password-123' };
test.beforeAll(async ({ playwright, baseURL }, info) => {
  const sessionPath = operatorSessionPath(info.config.metadata.fixtureDatabasePath);
  api = await playwright.request.newContext({ baseURL, ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}) });
  const session = await (await api.get('/api/auth/session')).json();
  if (!session.user) expect((await api.post(session.needsSetup ? '/api/auth/setup' : '/api/auth/login', { data: employee })).ok()).toBeTruthy();
});
test.afterAll(async () => {
  for (const id of createdIds) await api.post(`/api/admin/bookings/${id}/delete`);
  for (const car of seededCars) {
    const trip = await (await api.get(`/api/admin/trips/capacity?${new URLSearchParams({ direction: 'gori-tbilisi', date: car.date, time: car.time })}`)).json() as TripCapacity;
    const removed = await api.post('/api/admin/trips/drivers', { data: {
      direction: 'gori-tbilisi', date: car.date, time: car.time, expectedRevision: trip.revision, action: 'remove', removeKey: car.key,
    } });
    expect(removed.ok()).toBeTruthy();
  }
  await api.dispose();
});

test('operator creates a parcel without seats and an exclusive booking with an assigned car', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().addCookies((await api.storageState()).cookies);
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ახალი ჯავშანი', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }).getByRole('button', { name: 'გზავნილი', exact: true }).click();
  await expect(dialog.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('group', { name: 'სასურველი ადგილი', exact: true })).toHaveCount(0);
  await dialog.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('სატესტო გზავნილის მისამართი');
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill('599800101');
  await dialog.getByRole('button', { name: /^ხვალ,/ }).click();
  await dialog.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '08:30', exact: true }).click();
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const parcel = await response.json(); createdIds.push(parcel.id);
  expect(parcel.bookingType).toBe('parcel'); expect(parcel.seats).toBe(0);
  await expect(dialog).toHaveCount(0);

  // Queue membership no longer implies a trip assignment. Seed one real roster
  // car explicitly before checking the whole-car form.
  const tripDate = addDays(today(), 1);
  const trip = await (await api.get(`/api/admin/trips/capacity?direction=gori-tbilisi&date=${tripDate}&time=08:30`)).json() as TripCapacity;
  if (!trip.drivers.some(car => car.active && !car.reservedBookingId)) {
    const driver = trip.availableDrivers.find(driver => !driver.declined && !driver.assignedTime)!;
    expect(driver).toBeTruthy();
    const saved = await api.post('/api/admin/trips/drivers', { data: {
      direction: 'gori-tbilisi', date: tripDate, time: '08:30', expectedRevision: trip.revision,
      action: 'add', driver: { kind: 'roster', id: driver.id },
    } });
    expect(saved.ok()).toBeTruthy();
    seededCars.push({ date: tripDate, time: '08:30', key: `roster:${driver.id}` });
  }
  await page.getByRole('button', { name: 'ახალი ჯავშანი', exact: true }).click();
  await dialog.getByRole('group', { name: 'დამატებითი სერვისები', exact: true }).getByRole('button', { name: 'მთლიანი მანქანა', exact: true }).click();
  await dialog.getByLabel('აყვანის მისამართი გორში', { exact: true }).fill('სატესტო მთლიანი მანქანის მისამართი');
  await dialog.getByLabel('ტელეფონის ნომერი', { exact: true }).fill('599800102');
  await dialog.getByRole('button', { name: /^ხვალ,/ }).click();
  await dialog.getByRole('group', { name: 'დრო', exact: true }).getByRole('button', { name: '08:30', exact: true }).click();
  const capacity = await (await api.get(`/api/admin/trips/capacity?direction=gori-tbilisi&date=${addDays(today(), 1)}&time=08:30`)).json();
  const car = capacity.drivers.find((item: { active: boolean; reservedBookingId?: number }) => item.active && !item.reservedBookingId);
  expect(car).toBeTruthy();
  await expect(dialog.getByLabel('დანიშნული მანქანა', { exact: true })).toBeEnabled();
  await dialog.getByLabel('დანიშნული მანქანა', { exact: true }).selectOption(car.key);
  const wholeResponse = page.waitForResponse(response => response.url().endsWith('/api/admin/bookings') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'შექმნა და დადასტურება', exact: true }).click();
  const result = await wholeResponse;
  expect(result.status()).toBe(201);
  const whole = await result.json(); createdIds.push(whole.id);
  expect(whole.assignedVehicleKey).toBe(car.key); expect(whole.seats).toBe(car.capacity);
  await page.reload();
  const stored = await (await api.get('/api/admin/bookings')).json();
  expect(stored.bookings.find((item: { id: number }) => item.id === parcel.id).seats).toBe(0);
  expect(stored.bookings.find((item: { id: number }) => item.id === whole.id).assignedVehicleKey).toBe(car.key);
  expect(errors).toEqual([]);
});

test('parcel and whole-car controls sit with luggage and dog and fit mobile operator forms', async ({ page }) => {
  await page.context().addCookies((await api.storageState()).cookies);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/admin');
    await page.getByRole('button', { name: 'ახალი ჯავშანი', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const services = dialog.getByRole('group', { name: 'დამატებითი სერვისები', exact: true });
    for (const name of ['ბარგი', 'ძაღლი', 'გზავნილი', 'მთლიანი მანქანა']) await expect(services.getByRole('button', { name, exact: true })).toBeVisible();
    await services.getByRole('button', { name: 'გზავნილი', exact: true }).click();
    await expect(dialog.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true })).toHaveCount(0);
    await services.getByRole('button', { name: 'მთლიანი მანქანა', exact: true }).click();
    await expect(dialog.getByLabel('დანიშნული მანქანა', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await services.getByRole('button', { name: 'მთლიანი მანქანა', exact: true }).click();
    await expect(dialog.getByRole('group', { name: 'ადგილების რაოდენობა', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'გაუქმება', exact: true }).click();
  }
});
