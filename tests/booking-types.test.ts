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
  // Whole-car bookings require concrete cars explicitly assigned by an operator.
  for (const [id, time] of [[1, '08:30'], [2, '09:30']] as const) {
    const current = await request(`/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=${time}`);
    assert.equal(current.data.drivers.length, 0);
    const assigned = await request('/admin/trips/drivers', 'POST', { direction: 'gori-tbilisi', date: DAY, time, expectedRevision: current.data.revision, action: 'add', driver: { kind: 'roster', id } });
    assert.equal(assigned.status, 201);
  }
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
    assert.equal((await f.request(`/admin/bookings/${created.id}/move`, 'POST', { date: DAY, time: '09:30' })).data.code, 'TRIP_CHANGED');
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

test('schedule updates retain explicitly assigned reserved cars, including disabled departures', async () => {
  await isolated(async f => {
    const path = `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`;
    const car = (await successful(f, path)).drivers[0];
    const created = await successful(f, '/admin/bookings', 'POST', input({ bookingType: 'whole_car', assignedVehicleKey: car.key }));
    const original = await successful(f, `/admin/schedule?direction=gori-tbilisi&date=${DAY}`);
    const shiftedTimes = ['07:30', ...original.baseTimes];
    const change = (times: string[]) => ({ direction: 'gori-tbilisi', date: DAY, times });

    // Adding/removing unrelated departures never reflows explicit assignments.
    await successful(f, '/admin/schedule/date', 'PUT', change(shiftedTimes));
    await successful(f, '/admin/schedule/base', 'PUT', change(shiftedTimes));
    await successful(f, `/admin/schedule/date?direction=gori-tbilisi&date=${DAY}`, 'DELETE');
    const retained = await successful(f, path);
    assert.equal(retained.drivers.find((row: any) => row.key === car.key).reservedBookingId, created.id);

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

async function wholeOptions(f: Fixture, time = '08:30', date = DAY): Promise<import('../src/api.js').WholeCarOptions> {
  return successful(f, `/admin/trips/whole-car-options?direction=gori-tbilisi&date=${date}&time=${time}`);
}
function rosterChoice(options: import('../src/api.js').WholeCarOptions, id: number) {
  const driver = options.drivers.find(driver => driver.driverId === id);
  assert.ok(driver, `Roster driver ${id} must be offered`);
  return { bookingType: 'whole_car', assignedVehicleKey: driver.key, expectedVehicleRevision: driver.revision };
}
async function inquiry(f: Fixture, eventId: string) {
  const device = await successful(f, '/admin/devices', 'POST', { name: 'Whole-car picker test' });
  const result = await f.request('/integrations/android/calls', 'POST', { eventId, kind: 'incoming', phase: 'answered', phone: '599800100', occurredAt: '2030-01-01T10:00:00+04:00', durationSeconds: 0 }, { Authorization: `Bearer ${device.token}` }, false);
  assert.equal(result.status, 201);
  return result.data.id as number;
}

test('whole-car options expose the complete daily queue including nonworking drivers without changing any data', async () => {
  await isolated(async f => {
    const context = { direction: 'gori-tbilisi', date: DAY, time: '08:30' };
    const original = await wholeOptions(f);
    const daily = await successful(f, `/admin/drivers/schedule?direction=gori-tbilisi&date=${DAY}`);
    assert.deepEqual(original.drivers.map(driver => driver.driverId), daily.drivers.map((driver: any) => driver.id));
    assert.equal(original.active, true);
    assert.equal(original.drivers.length, 43);
    assert.equal(original.drivers.find(driver => driver.driverId === 3)?.assignedTime, null);
    assert.equal(original.drivers.find(driver => driver.driverId === 2)?.assignedTime, '09:30');
    const capacity = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    const added = await successful(f, '/admin/trips/drivers', 'POST', { ...context, expectedRevision: capacity.revision, action: 'add', driver: { kind: 'temporary', name: 'სხვა მანქანა', capacity: 6 } });
    const temporary = added.drivers.find((driver: any) => driver.kind === 'temporary');
    await successful(f, '/admin/drivers/5/day', 'PATCH', { direction: context.direction, date: DAY, declined: true });
    const before = JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides ORDER BY driver_id,date').all());
    const options = await wholeOptions(f);
    assert.equal(options.drivers.length, 44);
    assert.equal(options.drivers.find(driver => driver.driverId === 5)?.declined, true);
    assert.deepEqual(options.drivers.filter(driver => driver.kind === 'roster').map(driver => driver.driverId), daily.drivers.map((driver: any) => driver.id));
    assert.deepEqual(options.drivers.at(-1), { key: temporary.key, driverId: null, kind: 'temporary', name: 'სხვა მანქანა', capacity: 6, queuePosition: null, assignedTime: '08:30', declined: false, revision: options.drivers.at(-1)!.revision });
    assert.equal((await wholeOptions(f, '09:30')).drivers.some(driver => driver.key === temporary.key), false);
    assert.equal(options.drivers.find(driver => driver.driverId === 3)?.revision, original.drivers.find(driver => driver.driverId === 3)?.revision, 'Other drivers and temporary cars must not invalidate a selected driver');
    assert.notEqual(rosterChoice(await wholeOptions(f, '09:30'), 3).expectedVehicleRevision, rosterChoice(options, 3).expectedVehicleRevision);
    assert.notEqual(rosterChoice(await wholeOptions(f, '08:30', '2030-01-01'), 3).expectedVehicleRevision, rosterChoice(options, 3).expectedVehicleRevision);
    assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides ORDER BY driver_id,date').all()), before);
    assert.equal((await f.request('/admin/trips/whole-car-options?direction=gori-tbilisi&date=2030-01-02&time=08:30', 'GET', undefined, {}, false)).status, 401);
    for (const query of ['direction=tbilisi-gori&date=2030-01-02&time=08:30', 'direction=gori-tbilisi&date=2030-02-30&time=08:30', 'direction=gori-tbilisi&date=2030-01-02&time=25:00']) {
      assert.equal((await f.request(`/admin/trips/whole-car-options?${query}`)).status, 400);
    }
  });
});

test('saving an unassigned whole-car choice assigns and reserves its actual capacity atomically, while invalid forms leave no assignment', async () => {
  await isolated(async f => {
    const choice = rosterChoice(await wholeOptions(f), 3);
    const before = JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides ORDER BY driver_id,date').all());
    const auditBefore = await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get();
    const missing = { ...choice }; delete (missing as Partial<typeof missing>).expectedVehicleRevision;
    assert.equal((await f.request('/admin/bookings', 'POST', input(missing))).data.code, 'TRIP_CHANGED');
    assert.equal((await f.request('/admin/bookings', 'POST', input({ ...choice, goriAddress: 'x' }))).status, 400);
    assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides ORDER BY driver_id,date').all()), before);
    assert.deepEqual(await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), auditBefore);
    const created = await successful(f, '/admin/bookings', 'POST', input({ ...choice, seats: 1 }));
    assert.equal(created.seats, 8);
    assert.equal(created.assignedVehicleName, 'გოჩა');
    const assigned = await f.db.prepare('SELECT declined,assignment_mode,manual_time FROM driver_day_overrides WHERE driver_id=? AND date=?').get(3, DAY);
    assert.deepEqual({ ...assigned }, { declined: 0, assignment_mode: 'manual', manual_time: '08:30' });
    const plan = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    assert.equal(plan.drivers.find((driver: any) => driver.key === choice.assignedVehicleKey).reservedBookingId, created.id);
    assert.equal(plan.drivers.find((driver: any) => driver.key === choice.assignedVehicleKey).freeSeats, 0);
    await successful(f, `/admin/bookings/${created.id}/delete`, 'POST', {});
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 3)?.reservedBookingId, undefined);
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 3)?.assignedTime, '08:30');
  });
});

test('a whole-car choice can transfer an active driver from another hour but cannot steal a foreign whole-car reservation', async () => {
  await isolated(async f => {
    const choice = rosterChoice(await wholeOptions(f), 2);
    const created = await successful(f, '/admin/bookings', 'POST', input(choice));
    assert.equal(created.seats, 7);
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 2)?.assignedTime, '08:30');
    assert.equal((await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=09:30`)).drivers.some((driver: any) => driver.driverId === 2), false);
    const otherHour = await wholeOptions(f, '09:30');
    assert.equal(otherHour.drivers.find(driver => driver.driverId === 2)?.reservedBookingId, created.id);
    const stolen = await f.request('/admin/bookings', 'POST', input({ ...rosterChoice(otherHour, 2), requestedTime: '09:30' }));
    assert.equal(stolen.data.code, 'VEHICLE_RESERVED');
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 2)?.assignedTime, '08:30');
  });
});

test('stale whole-car selections and revisions replayed for another date or hour cannot move a driver', async () => {
  await isolated(async f => {
    const choice = rosterChoice(await wholeOptions(f), 3);
    const plan = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=10:00`);
    await successful(f, '/admin/trips/drivers', 'POST', { direction: 'gori-tbilisi', date: DAY, time: '10:00', expectedRevision: plan.revision, action: 'add', driver: { kind: 'roster', id: 3 } });
    assert.equal((await f.request('/admin/bookings', 'POST', input(choice))).data.code, 'TRIP_CHANGED');
    const current = rosterChoice(await wholeOptions(f), 3);
    for (const override of [{ requestedTime: '09:30' }, { requestedDate: '2030-01-01' }]) {
      assert.equal((await f.request('/admin/bookings', 'POST', input({ ...current, ...override }))).data.code, 'TRIP_CHANGED');
    }
    await successful(f, '/admin/drivers/3/day', 'PATCH', { direction: 'gori-tbilisi', date: DAY, declined: true });
    assert.equal((await f.request('/admin/bookings', 'POST', input(current))).data.code, 'TRIP_CHANGED');
    assert.equal((await f.db.prepare('SELECT manual_time FROM driver_day_overrides WHERE driver_id=? AND date=?').get(3, DAY))?.manual_time, '10:00');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM bookings').get())?.count, 0);
  });
});

test('waiting whole-car edits store only a choice and confirmation explicitly binds the selected driver', async () => {
  await isolated(async f => {
    await successful(f, '/admin/drivers/3/day', 'PATCH', { direction: 'gori-tbilisi', date: DAY, declined: true });
    const incoming = await f.request('/bookings', 'POST', input({ name: 'მომავალი მგზავრი' }), {}, false);
    assert.equal(incoming.status, 201);
    const choice = rosterChoice(await wholeOptions(f), 3);
    const edited = await successful(f, `/admin/bookings/${incoming.data.id}`, 'PATCH', choice);
    assert.equal(edited.status, 'waiting'); assert.equal(edited.seats, 8);
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 3)?.assignedTime, null);
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 3)?.declined, true);
    await successful(f, `/admin/bookings/${edited.id}`, 'PATCH', { phone: '599333444' });
    const noChoice = await f.request(`/admin/bookings/${edited.id}/confirm`, 'POST', { date: DAY, time: '08:30' });
    assert.equal(noChoice.data.code, 'TRIP_CHANGED');
    const confirmed = await successful(f, `/admin/bookings/${edited.id}/confirm`, 'POST', { date: DAY, time: '08:30', ...rosterChoice(await wholeOptions(f), 3) });
    assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.seats, 8);
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 3)?.assignedTime, '08:30');
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 3)?.declined, false);
  });
});

test('moving and restoring a whole-car booking may reassign its own driver across hours and dates without retaining a reservation on the old trip', async () => {
  await isolated(async f => {
    const created = await successful(f, '/admin/bookings', 'POST', input(rosterChoice(await wholeOptions(f), 3)));
    const moved = await successful(f, `/admin/bookings/${created.id}/move`, 'POST', { date: DAY, time: '09:30', ...rosterChoice(await wholeOptions(f, '09:30'), 3) });
    assert.equal(moved.assignedTime, '09:30');
    const oldTrip = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    assert.equal(oldTrip.drivers.some((driver: any) => driver.reservedBookingId === created.id), false);
    const targetDay = '2030-01-01';
    const nextDate = await successful(f, `/admin/bookings/${created.id}/move`, 'POST', { date: targetDay, time: '10:00', ...rosterChoice(await wholeOptions(f, '10:00', targetDay), 3) });
    assert.equal(nextDate.assignedDate, targetDay);
    assert.equal((await wholeOptions(f, '09:30')).drivers.find(driver => driver.driverId === 3)?.assignedTime, '09:30', 'Moving dates preserves the old explicit day plan');
    assert.equal((await wholeOptions(f, '09:30')).drivers.find(driver => driver.driverId === 3)?.reservedBookingId, undefined);
    await successful(f, `/admin/bookings/${created.id}/delete`, 'POST', {});
    const plan = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${targetDay}&time=12:00`);
    await successful(f, '/admin/trips/drivers', 'POST', { direction: 'gori-tbilisi', date: targetDay, time: '12:00', expectedRevision: plan.revision, action: 'add', driver: { kind: 'roster', id: 3 } });
    f.setNow('2030-01-03T00:00:00Z');
    assert.equal((await f.request(`/admin/bookings/${created.id}/restore`, 'POST', {})).data.code, 'TRIP_CHANGED');
    const restored = await successful(f, `/admin/bookings/${created.id}/restore`, 'POST', { ...rosterChoice(await wholeOptions(f, '10:00', targetDay), 3) });
    assert.equal(restored.deletedAt, null); assert.equal(restored.assignedTime, '10:00');
  });
});

test('confirmed edits and individual call conversion bind a chosen unassigned driver in the same transaction', async () => {
  await isolated(async f => {
    const passenger = await successful(f, '/admin/bookings', 'POST', input());
    const changed = await successful(f, `/admin/bookings/${passenger.id}`, 'PATCH', rosterChoice(await wholeOptions(f), 3));
    assert.equal(changed.seats, 8); assert.equal(changed.bookingType, 'whole_car');
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 3)?.reservedBookingId, passenger.id);
    const callId = await inquiry(f, 'whole-car-single');
    const converted = await successful(f, `/admin/calls/${callId}/convert`, 'POST', input(rosterChoice(await wholeOptions(f), 4)));
    assert.equal(converted.seats, 7);
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 4)?.reservedBookingId, converted.id);
  });
});

test('group conversion accepts distinct unassigned drivers from one snapshot and replays without duplicate assignments', async () => {
  await isolated(async f => {
    const callId = await inquiry(f, 'whole-car-siblings');
    const options = await wholeOptions(f);
    const children = [3, 4].map(id => input(rosterChoice(options, id)));
    const result = await successful(f, `/admin/calls/${callId}/convert-group`, 'POST', { bookings: children }, groupKey('whole-car-siblings'));
    assert.deepEqual(result.bookings.map((row: any) => row.seats), [8, 7]);
    const replay = await successful(f, `/admin/calls/${callId}/convert-group`, 'POST', { bookings: children }, groupKey('whole-car-siblings'));
    assert.deepEqual(replay.bookings.map((row: any) => row.id), result.bookings.map((row: any) => row.id));
    const bindings = await f.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='trip.driver.add' AND details LIKE '%whole-car-booking%'").get();
    assert.equal(bindings?.count, 2);
  });
});

test('group conflicts roll back sibling bookings, assignments and contact changes together', async () => {
  await isolated(async f => {
    const callId = await inquiry(f, 'whole-car-group-conflict');
    const oldTrip = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=10:00`);
    await successful(f, '/admin/trips/drivers', 'POST', { direction: 'gori-tbilisi', date: DAY, time: '10:00', expectedRevision: oldTrip.revision, action: 'add', driver: { kind: 'roster', id: 3 } });
    await successful(f, '/admin/drivers/3/day', 'PATCH', { direction: 'gori-tbilisi', date: DAY, declined: true });
    const choice = rosterChoice(await wholeOptions(f), 3);
    const before = JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides ORDER BY driver_id,date').all());
    const audit = await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get();
    const failed = await f.request(`/admin/calls/${callId}/convert-group`, 'POST', { bookings: [input(choice), input(choice)] }, groupKey('whole-car-conflict'));
    assert.equal(failed.data.code, 'VEHICLE_RESERVED');
    assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides ORDER BY driver_id,date').all()), before);
    assert.deepEqual(await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), audit);
    for (const table of ['bookings', 'call_booking_links', 'passenger_profiles', 'passenger_addresses', 'idempotency']) assert.equal((await f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())?.count, 0, table);
    assert.equal((await f.db.prepare('SELECT booking_id FROM call_inquiries WHERE id=?').get(callId))?.booking_id, null);
  });
});

test('inactive departures retain an existing whole-car choice but reject fresh selections', async () => {
  await isolated(async f => {
    const created = await successful(f, '/admin/bookings', 'POST', input(rosterChoice(await wholeOptions(f), 3)));
    const schedule = await successful(f, `/admin/schedule?direction=gori-tbilisi&date=${DAY}`);
    await successful(f, '/admin/schedule/date', 'PUT', { direction: 'gori-tbilisi', date: DAY, times: schedule.baseTimes.filter((time: string) => time !== '08:30') });
    const options = await wholeOptions(f);
    assert.equal(options.active, false);
    assert.equal(options.drivers.find(driver => driver.driverId === 3)?.reservedBookingId, created.id);
    await successful(f, `/admin/bookings/${created.id}`, 'PATCH', { phone: '599222333' });
    assert.equal((await f.request(`/admin/bookings/${created.id}`, 'PATCH', rosterChoice(options, 4))).data.code, 'SLOT_INACTIVE');
    assert.equal((await wholeOptions(f)).drivers.find(driver => driver.driverId === 4)?.assignedTime, null);
  });
});

test('an explicit whole-car save activates only the selected driver day, and invalid forms never activate it', async () => {
  await isolated(async f => {
    const oldTrip = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=10:00`);
    await successful(f, '/admin/trips/drivers', 'POST', { direction: 'gori-tbilisi', date: DAY, time: '10:00', expectedRevision: oldTrip.revision, action: 'add', driver: { kind: 'roster', id: 3 } });
    for (const date of [DAY, '2030-01-01']) await successful(f, '/admin/drivers/3/day', 'PATCH', { direction: 'gori-tbilisi', date, declined: true });
    const options = await wholeOptions(f);
    assert.equal(options.drivers.find(driver => driver.driverId === 3)?.declined, true);
    const choice = rosterChoice(options, 3);
    const before = JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides WHERE driver_id=? ORDER BY date').all(3));
    assert.equal((await f.request('/admin/bookings', 'POST', input({ ...choice, goriAddress: 'x' }))).status, 400);
    const missingRevision = { bookingType: choice.bookingType, assignedVehicleKey: choice.assignedVehicleKey };
    assert.equal((await f.request('/admin/bookings', 'POST', input(missingRevision))).data.code, 'TRIP_CHANGED');
    assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides WHERE driver_id=? ORDER BY date').all(3)), before);
    const saved = await successful(f, '/admin/bookings', 'POST', input(choice));
    assert.equal(saved.seats, 8);
    const today = await f.db.prepare('SELECT declined,manual_time FROM driver_day_overrides WHERE driver_id=? AND date=?').get(3, DAY);
    assert.deepEqual({ ...today }, { declined: 0, manual_time: '08:30' });
    assert.equal((await f.db.prepare('SELECT declined FROM driver_day_overrides WHERE driver_id=? AND date=?').get(3, '2030-01-01'))?.declined, 1);
    const audit = await f.db.prepare("SELECT details FROM audit_log WHERE action='trip.driver.add' AND details LIKE '%whole-car-booking%' ORDER BY id DESC").get();
    assert.equal(JSON.parse(audit!.details).activated, true);
    const trip = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    assert.equal(trip.drivers.find((driver: any) => driver.driverId === 3).reservedBookingId, saved.id);
  });
});
