import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createApp } from '../server/index.js';
import { createDatabase, postgresPoolOptions } from '../server/database.js';

const DAY = '2030-01-02';
const PASSWORD = 'multi-passenger-test-password';
const CALLER = '568694879';
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** TEST_DATABASE_URL uses a private disposable schema; ordinary runs use SQLite. */
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'greentaxi-group-api-'));
  let administration: pg.Pool | undefined;
  let databaseUrl: string | undefined;
  let schema: string | undefined;
  if (process.env.TEST_DATABASE_URL) {
    schema = `greentaxi_group_${randomBytes(8).toString('hex')}`;
    administration = new pg.Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL));
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(process.env.TEST_DATABASE_URL);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connection.toString();
  }
  const db = await createDatabase({ dbPath: join(directory, 'test.sqlite'), databaseUrl, production: false });
  let currentTime = new Date('2030-01-01T00:00:00Z');
  const service = await createApp({ database: db, production: false, now: () => currentTime, deferPhoneMigration: false });
  const server = await new Promise<Server>(resolve => {
    const listener = service.app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function request(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}, authenticated = true) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(authenticated && cookie ? { Cookie: cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any, headers: response.headers };
  }
  const setup = await request('/auth/setup', 'POST', { name: 'ჯგუფის ოპერატორი', login: 'group_operator', password: PASSWORD });
  assert.equal(setup.status, 201);
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
  return {
    ...service, request, base, databaseUrl,
    setNow(value: string) { currentTime = new Date(value); },
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await service.close();
      if (administration && schema) {
        await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
        await administration.end();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function isolated(operation: (f: Fixture) => Promise<void>) {
  const f = await fixture();
  try { await operation(f); } finally { await f.close(); }
}
function input(overrides: Record<string, unknown> = {}) {
  return { phone: '599111221', seats: 2, direction: 'gori-tbilisi', requestedDate: DAY, requestedTime: '08:30', goriAddress: 'პირველი სახლი 12', ...overrides };
}
function groupKey(value: string) { return { 'Idempotency-Key': `group-test-${value}` }; }
async function successful(f: Fixture, path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
  const result = await f.request(path, method, body, headers);
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: ${result.status} ${result.data.code ?? ''}`);
  return result.data;
}

test('parcel persists zero seats without affecting passenger seats', async () => {
  await isolated(async f => {
    const created = await successful(f, '/admin/bookings', 'POST', input({ bookingType: 'parcel', seats: 8, seatPreference: 'front' }));
    assert.equal(created.bookingType, 'parcel'); assert.equal(created.seats, 0); assert.equal(created.seatPreference, null);
    const capacity = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    assert.equal(capacity.bookedSeats, 0); assert.equal(capacity.bookingCount, 1);
    const edited = await successful(f, `/admin/bookings/${created.id}`, 'PATCH', { goriAddress: 'ახალი მისამართი' });
    assert.equal(edited.seats, 0); assert.equal(edited.bookingType, 'parcel');
    const converted = await successful(f, `/admin/bookings/${created.id}`, 'PATCH', { bookingType: 'passenger', seats: 2 });
    assert.equal(converted.seats, 2); assert.equal(converted.assignedVehicleKey, null);
    assert.equal((await f.request('/admin/bookings', 'POST', input({ bookingType: 'invalid' }))).status, 400);
    const publicResult = await f.request('/bookings', 'POST', input({ bookingType: 'parcel', seats: 0 }), {}, false);
    assert.equal(publicResult.status, 400);
  });
});

test('whole car reserves the selected assigned vehicle exclusively and release/restore respect conflicts', async () => {
  await isolated(async f => {
    const path = `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`;
    let plan = await successful(f, path);
    const car = plan.drivers[0]; assert.ok(car);
    const whole = { bookingType: 'whole_car', assignedVehicleKey: car.key, seats: 1 };
    const created = await successful(f, '/admin/bookings', 'POST', input(whole));
    assert.equal(created.seats, car.capacity); assert.equal(created.assignedVehicleName, car.name);
    plan = await successful(f, path);
    assert.equal(plan.drivers.find((item: any) => item.key === car.key).reservedBookingId, created.id);
    assert.equal(plan.drivers.find((item: any) => item.key === car.key).freeSeats, 0);
    assert.equal((await f.request('/admin/bookings', 'POST', input(whole))).data.code, 'VEHICLE_RESERVED');
    assert.equal((await f.request('/admin/bookings', 'POST', input({ ...whole, assignedVehicleKey: 'roster:9999' }))).data.code, 'VEHICLE_UNAVAILABLE');
    await successful(f, `/admin/bookings/${created.id}`, 'PATCH', { phone: '599222333' });
    assert.equal((await f.request(`/admin/bookings/${created.id}/move`, 'POST', { date: DAY, time: '09:30' })).data.code, 'VEHICLE_UNAVAILABLE');
    assert.equal((await f.request('/admin/trips/drivers', 'POST', { direction: 'gori-tbilisi', date: DAY, time: '08:30', expectedRevision: plan.revision, action: 'remove', removeKey: car.key })).data.code, 'VEHICLE_RESERVED');
    await successful(f, `/admin/bookings/${created.id}/delete`, 'POST', {});
    const replacement = await successful(f, '/admin/bookings', 'POST', input(whole));
    assert.equal((await f.request(`/admin/bookings/${created.id}/restore`, 'POST', {})).data.code, 'VEHICLE_RESERVED');
    await successful(f, `/admin/bookings/${replacement.id}/delete`, 'POST', {});
    await successful(f, `/admin/bookings/${created.id}/restore`, 'POST', {});
    const stored = await successful(f, '/admin/bookings');
    assert.equal(stored.bookings.find((booking: any) => booking.id === created.id).assignedVehicleKey, car.key);
  });
});

test('call conversion accepts a mixed parcel/whole-car group atomically', async () => {
  await isolated(async f => {
    const device = await successful(f, '/admin/devices', 'POST', { name: 'Booking types fixture' });
    const inquiry = await f.request('/integrations/android/calls', 'POST', { eventId: 'booking-kinds-group', kind: 'incoming', phase: 'answered', phone: '599800100', occurredAt: '2030-01-01T10:00:00+04:00', durationSeconds: 0 }, { Authorization: `Bearer ${device.token}` }, false);
    assert.equal(inquiry.status, 201);
    const plan = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    const car = plan.drivers[0];
    const children = [input({ bookingType: 'parcel' }), input({ bookingType: 'whole_car', assignedVehicleKey: car.key })];
    const result = await successful(f, `/admin/calls/${inquiry.data.id}/convert-group`, 'POST', { bookings: children }, groupKey('kinds'));
    assert.equal(result.bookings[0].seats, 0);
    assert.equal(result.bookings[1].assignedVehicleKey, car.key);
    const replay = await successful(f, `/admin/calls/${inquiry.data.id}/convert-group`, 'POST', { bookings: children }, groupKey('kinds'));
    assert.deepEqual(replay.bookings.map((row: any) => row.id), result.bookings.map((row: any) => row.id));
    const newPlan = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=09:30`);
    const newCar = newPlan.drivers[0];
    assert.ok(newCar);
    const moved = await successful(f, `/admin/bookings/${result.bookings[1].id}/move`, 'POST', { date: DAY, time: '09:30', assignedVehicleKey: newCar.key });
    assert.equal(moved.assignedVehicleKey, newCar.key);
    const freed = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    assert.equal(freed.drivers.find((row: any) => row.key === car.key).reservedBookingId, undefined);
  });
});

test('an operator can turn an incoming passenger request into a whole-car booking before confirmation', async () => {
  await isolated(async f => {
    const incoming = await f.request('/bookings', 'POST', input({ name: 'სატესტო მგზავრი' }), {}, false);
    assert.equal(incoming.status, 201);
    const plan = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    const car = plan.drivers[0];
    const edited = await successful(f, `/admin/bookings/${incoming.data.id}`, 'PATCH', { bookingType: 'whole_car', assignedVehicleKey: car.key });
    assert.equal(edited.status, 'waiting');
    const confirmed = await successful(f, `/admin/bookings/${edited.id}/confirm`, 'POST', { date: DAY, time: '08:30' });
    assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.assignedVehicleKey, car.key);
  });
});

test('schedule updates cannot silently move a reserved car, while a disabled departure retains its booking', async () => {
  await isolated(async f => {
    const path = `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`;
    const car = (await successful(f, path)).drivers[0];
    const created = await successful(f, '/admin/bookings', 'POST', input({ bookingType: 'whole_car', assignedVehicleKey: car.key }));
    const original = await successful(f, `/admin/schedule?direction=gori-tbilisi&date=${DAY}`);
    const shiftedTimes = ['07:30', ...original.baseTimes];
    const change = (times: string[]) => ({ direction: 'gori-tbilisi', date: DAY, times });

    const dateChange = await f.request('/admin/schedule/date', 'PUT', change(shiftedTimes));
    assert.equal(dateChange.status, 409); assert.equal(dateChange.data.code, 'VEHICLE_UNAVAILABLE');
    const baseChange = await f.request('/admin/schedule/base', 'PUT', change(shiftedTimes));
    assert.equal(baseChange.status, 409); assert.equal(baseChange.data.code, 'VEHICLE_UNAVAILABLE');
    const unchanged = await successful(f, `/admin/schedule?direction=gori-tbilisi&date=${DAY}`);
    assert.deepEqual(unchanged.baseTimes, original.baseTimes); assert.equal(unchanged.overrideTimes, null);

    // A date override isolates this day's reservation from changes to the base.
    await successful(f, '/admin/schedule/date', 'PUT', change(original.baseTimes));
    await successful(f, '/admin/schedule/base', 'PUT', change(shiftedTimes));
    const reset = await f.request(`/admin/schedule/date?direction=gori-tbilisi&date=${DAY}`, 'DELETE');
    assert.equal(reset.status, 409); assert.equal(reset.data.code, 'VEHICLE_UNAVAILABLE');
    assert.deepEqual((await successful(f, `/admin/schedule?direction=gori-tbilisi&date=${DAY}`)).overrideTimes, original.baseTimes);

    await successful(f, '/admin/schedule/date', 'PUT', change(original.baseTimes.filter((value: string) => value !== '08:30')));
    const closed = await successful(f, path);
    assert.equal(closed.active, false);
    assert.equal(closed.drivers.find((row: any) => row.key === car.key).reservedBookingId, created.id);
    assert.equal(closed.bookedSeats, car.capacity); assert.equal(closed.freeSeats, 0);
    const edited = await successful(f, `/admin/bookings/${created.id}`, 'PATCH', { phone: '599222333' });
    assert.equal(edited.assignedVehicleKey, car.key);
    assert.equal((await f.request('/admin/bookings', 'POST', input({ bookingType: 'whole_car', assignedVehicleKey: car.key }))).status, 409);
    const decline = await f.request(`/admin/drivers/${car.driverId}/day`, 'PATCH', { direction: 'gori-tbilisi', date: DAY, declined: true });
    assert.equal(decline.status, 409);

    // Reopening the departure preserves the same concrete car and reservation.
    await successful(f, `/admin/schedule/date?direction=gori-tbilisi&date=${DAY}`, 'DELETE');
    const reopened = await successful(f, path);
    assert.equal(reopened.active, true);
    assert.equal(reopened.drivers.find((row: any) => row.key === car.key).reservedBookingId, created.id);
  });
});

test('base schedule changes retain historical whole-car assignments without blocking new departure times', async () => {
  await isolated(async f => {
    const path = `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`;
    const car = (await successful(f, path)).drivers[0];
    const created = await successful(f, '/admin/bookings', 'POST', input({ bookingType: 'whole_car', assignedVehicleKey: car.key }));
    const schedule = await successful(f, `/admin/schedule?direction=gori-tbilisi&date=${DAY}`);
    f.setNow('2030-01-03T00:00:00Z');
    await successful(f, '/admin/schedule/base', 'PUT', { direction: 'gori-tbilisi', times: ['07:30', ...schedule.baseTimes] });
    const capacity = await successful(f, path);
    assert.equal(capacity.drivers.find((row: any) => row.key === car.key).reservedBookingId, created.id);
    assert.equal(capacity.uncoveredSeats, 0);
    const stored = await successful(f, '/admin/bookings');
    assert.equal(stored.bookings.find((row: any) => row.id === created.id).assignedVehicleName, car.name);
  });
});
