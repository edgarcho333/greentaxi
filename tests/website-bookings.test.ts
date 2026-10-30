import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createDatabase, postgresPoolOptions } from '../server/database.js';
import { createApp } from '../server/index.js';

const DAY = '2030-01-02';
const BASE = '/admin/website-bookings';

// PostgreSQL runs use an isolated disposable schema; ordinary runs use SQLite.
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'greentaxi-website-inbox-'));
  let pool: pg.Pool | undefined, schema: string | undefined, databaseUrl = '';
  if (process.env.TEST_DATABASE_URL) {
    schema = `website_inbox_${randomBytes(8).toString('hex')}`;
    pool = new pg.Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL));
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(process.env.TEST_DATABASE_URL);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connection.toString();
  }
  const db = await createDatabase({ dbPath: join(directory, 'test.sqlite'), databaseUrl, production: false });
  let currentTime = new Date('2030-01-01T04:00:00Z');
  const service = await createApp({ database: db, production: false, now: () => currentTime });
  const server = await new Promise<Server>(resolve => { const listener = service.app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, authenticated = true) {
    const result = await fetch(`${base}/api${path}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authenticated && cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: result.status, data: await result.json() as any, headers: result.headers };
  }
  async function ok(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
    const result = await request(path, method, body, headers);
    assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: ${result.status} ${result.data.code ?? ''}`);
    return result.data;
  }
  const setup = await request('/auth/setup', 'POST', { login: 'website_operator', name: 'Website fixture', password: 'website-inbox-test-password-123' });
  assert.equal(setup.status, 201); cookie = setup.headers.get('set-cookie')!.split(';')[0];
  return { db, request, ok, setNow(value: string) { currentTime = new Date(value); }, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await service.close();
    if (pool && schema) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    rmSync(directory, { recursive: true, force: true });
  } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function isolated(operation: (f: Fixture) => Promise<void>) { const f = await fixture(); try { await operation(f); } finally { await f.close(); } }
function input(extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'საიტის მგზავრი', phone: '555970001', seats: 2, direction: 'gori-tbilisi', requestedDate: DAY, requestedTime: '09:30', goriAddress: 'გორი, პირველი სახლი 15', ...extras };
}
function key(value: string = randomUUID()) { return { 'Idempotency-Key': `website-${value}` }; }
async function pending(f: Fixture, extras: Record<string, unknown> = {}) {
  const created = await f.request('/bookings', 'POST', input(extras), {}, false);
  assert.equal(created.status, 201);
  return (await f.ok(`${BASE}?pageSize=50`)).bookings.find((row: any) => row.id === created.data.id);
}
async function edit(f: Fixture, row: any, fields: Record<string, unknown>, headers = key()) {
  return f.request(`${BASE}/${row.id}`, 'PATCH', { expectedUpdatedAt: row.updatedAt, ...fields }, headers);
}
async function options(f: Fixture, time = '09:30') { return f.ok(`/admin/trips/whole-car-options?direction=gori-tbilisi&date=${DAY}&time=${time}`); }
async function capacity(f: Fixture, time = '09:30') { return f.ok(`/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=${time}`); }

test('website inbox is staff-only and contains only oldest-first live public requests, with independent counts and pagination', async () => {
  await isolated(async f => {
    assert.equal((await f.request(BASE, 'GET', undefined, {}, false)).status, 401);
    for (const [suffix, method] of [['', 'PATCH'], ['/confirm', 'POST'], ['/reject', 'POST']]) {
      assert.equal((await f.request(`${BASE}/1${suffix}`, method, { expectedUpdatedAt: '2030' }, key(), false)).status, 401);
    }
    const first = await pending(f, { requestedTime: '14:00' });
    assert.equal((await f.request(`${BASE}/${first.id}`, 'GET', undefined, {}, false)).status, 401);
    assert.deepEqual(await f.ok(`${BASE}/${first.id}`), first);
    const second = await pending(f, { requestedTime: '08:30' });
    const third = await pending(f, { requestedTime: '09:30' });
    const rest = [];
    for (let index = 0; index < 13; index++) rest.push(await pending(f));
    const employee = await f.ok('/admin/bookings', 'POST', input());
    await f.db.prepare("UPDATE bookings SET status='waiting',assigned_date=NULL,assigned_time=NULL WHERE id=?").run(employee.id);
    const deleted = await pending(f); await f.ok(`${BASE}/${deleted.id}/reject`, 'POST', { expectedUpdatedAt: deleted.updatedAt }, key());
    const confirmed = await pending(f); await f.ok(`${BASE}/${confirmed.id}/confirm`, 'POST', { expectedUpdatedAt: confirmed.updatedAt }, key());
    for (const id of [deleted.id, confirmed.id]) {
      const processed = await f.request(`${BASE}/${id}`);
      assert.equal(processed.status, 409); assert.equal(processed.data.code, 'BOOKING_CHANGED');
    }
    const device = await f.ok('/admin/devices', 'POST', { name: 'Website separation test' });
    const call = await f.request('/integrations/android/calls', 'POST', { eventId: 'separate-call', kind: 'incoming', phase: 'answered', phone: '555970099', occurredAt: '2030-01-01T08:00:00+04:00', durationSeconds: 0 }, { Authorization: `Bearer ${device.token}` }, false);
    assert.equal(call.status, 201);
    const page1 = await f.ok(`${BASE}?page=1&pageSize=15`);
    assert.equal(page1.total, 16); assert.equal(page1.page, 1); assert.equal(page1.pageSize, 15);
    assert.deepEqual(page1.bookings.map((row: any) => row.id), [first.id, second.id, third.id, ...rest.slice(0, 12).map(row => row.id)]);
    assert.deepEqual((await f.ok(`${BASE}?page=2&pageSize=15`)).bookings.map((row: any) => row.id), [rest[12].id]);
    assert.deepEqual((await f.ok('/admin/bookings?scope=incoming&excludeSource=public')).bookings.map((row: any) => row.id), [employee.id]);
    const counts = await f.ok('/admin/incoming-counts');
    assert.equal(counts.calls, 1); assert.equal(counts.website, 16); assert.equal(counts.bookings, 17); assert.equal(counts.total, 18);
    assert.equal(counts.lastWebsiteId, rest[12].id);
  });
});

test('pending website editing saves all booking fields and direction/date/hour without confirmation or profile side effects', async () => {
  await isolated(async f => {
    const row = await pending(f);
    const stops = (await f.ok('/public/config')).stops;
    const result = await edit(f, row, { phone: '+995 555 970 002', callerPhone: '555970003', direction: 'tbilisi-gori', requestedDate: '2030-01-01', requestedTime: '14:00', goriAddress: 'გორი, ახალი სახლი 22', pickupStopId: stops[0].id, seats: 3, luggage: true, dog: true, seatPreference: 'back' });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.fromEntries(['phone', 'callerPhone', 'direction', 'requestedDate', 'requestedTime', 'goriAddress', 'pickupStopId', 'seats', 'luggage', 'dog', 'seatPreference', 'status', 'assignedDate', 'assignedTime'].map(field => [field, result.data[field]])), {
      phone: '555970002', callerPhone: '555970003', direction: 'tbilisi-gori', requestedDate: '2030-01-01', requestedTime: '14:00', goriAddress: 'გორი, ახალი სახლი 22', pickupStopId: stops[0].id, seats: 3, luggage: true, dog: true, seatPreference: 'back', status: 'waiting', assignedDate: null, assignedTime: null,
    });
    assert.notEqual(result.data.updatedAt, row.updatedAt);
    assert.deepEqual(await f.ok(`${BASE}/${row.id}`), result.data, 'Reload by ID returns the latest stored fields after the phone changes');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM passenger_profiles').get())!.count, 0);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM passenger_addresses').get())!.count, 0);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_trip_assignments').get())!.count, 0);
    assert.equal((await f.ok('/admin/bookings?scope=scheduled')).bookings.length, 0);
    const confirmed = await f.ok(`${BASE}/${row.id}/confirm`, 'POST', { expectedUpdatedAt: result.data.updatedAt }, key());
    assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.assignedDate, '2030-01-01'); assert.equal(confirmed.assignedTime, '14:00');
    assert.equal((await f.ok(BASE)).total, 0);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM passenger_profiles').get())!.count, 1);
  });
});

test('parcel edits use zero seats and hide passenger preference while remaining pending until explicit confirmation', async () => {
  await isolated(async f => {
    const row = await pending(f);
    const edited = await edit(f, row, { bookingType: 'parcel', seats: 8, seatPreference: 'front', luggage: true, dog: true });
    assert.equal(edited.status, 200); assert.equal(edited.data.bookingType, 'parcel'); assert.equal(edited.data.seats, 0); assert.equal(edited.data.seatPreference, null); assert.equal(edited.data.status, 'waiting');
    assert.equal((await capacity(f)).bookingCount, 0);
    const confirmed = await f.ok(`${BASE}/${row.id}/confirm`, 'POST', { expectedUpdatedAt: edited.data.updatedAt }, key());
    assert.equal(confirmed.seats, 0); assert.equal(confirmed.luggage, true); assert.equal(confirmed.dog, true);
    const plan = await capacity(f); assert.equal(plan.bookedSeats, 0); assert.equal(plan.bookingCount, 1);
  });
});

test('whole-car editing never activates a declined driver or reserves a seat; explicit confirmation reserves real vehicle capacity', async () => {
  await isolated(async f => {
    await f.ok('/admin/drivers/1/day', 'PATCH', { direction: 'gori-tbilisi', date: DAY, declined: true });
    const car = (await options(f)).drivers.find((driver: any) => driver.driverId === 1); assert.ok(car);
    const row = await pending(f);
    const edited = await edit(f, row, { bookingType: 'whole_car', seats: 1, assignedVehicleKey: car.key, expectedVehicleRevision: car.revision });
    assert.equal(edited.status, 200); assert.equal(edited.data.status, 'waiting'); assert.equal(edited.data.seats, car.capacity);
    assert.equal((await options(f)).drivers.find((driver: any) => driver.driverId === 1).declined, true);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_trip_assignments').get())!.count, 0);
    assert.equal((await capacity(f)).bookedSeats, 0);
    const missingChoice = await f.request(`${BASE}/${row.id}/confirm`, 'POST', { expectedUpdatedAt: edited.data.updatedAt }, key());
    assert.equal(missingChoice.status, 409); assert.equal(missingChoice.data.code, 'TRIP_CHANGED');
    const confirmed = await f.ok(`${BASE}/${row.id}/confirm`, 'POST', { expectedUpdatedAt: edited.data.updatedAt, assignedVehicleKey: car.key, expectedVehicleRevision: car.revision }, key());
    assert.equal(confirmed.seats, car.capacity); assert.equal(confirmed.status, 'confirmed');
    const plan = await capacity(f); assert.equal(plan.bookedSeats, car.capacity); assert.equal(plan.drivers.find((driver: any) => driver.key === car.key).reservedBookingId, row.id);
    assert.equal((await options(f)).drivers.find((driver: any) => driver.driverId === 1).declined, false);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_trip_assignments WHERE driver_id=1 AND date=? AND time=?').get(DAY, '09:30'))!.count, 1);
    await f.ok(`/admin/bookings/${row.id}/delete`, 'POST', {});
    assert.equal((await capacity(f)).drivers.find((driver: any) => driver.key === car.key).reservedBookingId, undefined);
  });
});

test('two pending whole-car requests may select one car but confirmation rechecks exclusivity atomically', async () => {
  await isolated(async f => {
    const car = (await options(f)).drivers[0];
    const first = await pending(f), second = await pending(f);
    const edited1 = await edit(f, first, { bookingType: 'whole_car', assignedVehicleKey: car.key, expectedVehicleRevision: car.revision });
    const edited2 = await edit(f, second, { bookingType: 'whole_car', assignedVehicleKey: car.key, expectedVehicleRevision: car.revision });
    assert.equal(edited1.status, 200); assert.equal(edited2.status, 200);
    const results = await Promise.all([edited1.data, edited2.data].map(row => f.request(`${BASE}/${row.id}/confirm`, 'POST', { expectedUpdatedAt: row.updatedAt, assignedVehicleKey: car.key, expectedVehicleRevision: car.revision }, key())));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const conflict = results.find(result => result.status === 409)!;
    assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'VEHICLE_RESERVED');
    const loser = results[0].status === 409 ? edited1.data : edited2.data;
    const retained = (await f.ok(BASE)).bookings.find((row: any) => row.id === loser.id);
    assert.equal(retained.status, 'waiting'); assert.equal(retained.updatedAt, loser.updatedAt); assert.equal(retained.assignedDate, null);
    assert.equal((await capacity(f)).bookingCount, 1);
  });
});

test('a website customer future calendar date survives operator editing and confirmation beyond the manual today/tomorrow window', async () => {
  await isolated(async f => {
    const row = await pending(f, { requestedDate: '2030-01-20' });
    const edited = await edit(f, row, { phone: '555970008', requestedTime: '14:00' });
    assert.equal(edited.status, 200); assert.equal(edited.data.requestedDate, '2030-01-20');
    const confirmed = await f.ok(`${BASE}/${row.id}/confirm`, 'POST', { expectedUpdatedAt: edited.data.updatedAt }, key());
    assert.equal(confirmed.assignedDate, '2030-01-20'); assert.equal(confirmed.assignedTime, '14:00');
  });
});

test('fixed-clock edits advance versions, reject stale operators and safely replay identical mutation keys', async () => {
  await isolated(async f => {
    const row = await pending(f), headers = key('edit-replay');
    const body = { expectedUpdatedAt: row.updatedAt, phone: '555970004' };
    const first = await f.request(`${BASE}/${row.id}`, 'PATCH', body, headers); assert.equal(first.status, 200);
    const replay = await f.request(`${BASE}/${row.id}`, 'PATCH', body, headers); assert.equal(replay.status, 200); assert.deepEqual(replay.data, first.data);
    const reused = await f.request(`${BASE}/${row.id}`, 'PATCH', { ...body, phone: '555970005' }, headers); assert.equal(reused.status, 409);
    for (const [suffix, method] of [['', 'PATCH'], ['/confirm', 'POST'], ['/reject', 'POST']]) {
      const stale = await f.request(`${BASE}/${row.id}${suffix}`, method, { expectedUpdatedAt: row.updatedAt, phone: '555970099' }, key());
      assert.equal(stale.status, 409); assert.equal(stale.data.code, 'BOOKING_CHANGED');
    }
    const second = await edit(f, first.data, { phone: '555970006' }); assert.equal(second.status, 200);
    assert.ok(second.data.updatedAt > first.data.updatedAt); assert.ok(first.data.updatedAt > row.updatedAt);
    const confirmBody = { expectedUpdatedAt: second.data.updatedAt }, confirmKey = key('confirm-replay');
    const confirmed = await f.request(`${BASE}/${row.id}/confirm`, 'POST', confirmBody, confirmKey); assert.equal(confirmed.status, 200);
    f.setNow('2030-01-03T04:00:00Z');
    assert.deepEqual((await f.request(`${BASE}/${row.id}/confirm`, 'POST', confirmBody, confirmKey)).data, confirmed.data);
    assert.equal((await f.request(`${BASE}/${row.id}/confirm`, 'POST', confirmBody, key())).data.code, 'BOOKING_CHANGED');
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE booking_id=? AND action='website.confirm'").get(row.id))!.count, 1);
  });
});

test('rejecting an incoming request is a reversible soft deletion and retries never delete another order', async () => {
  await isolated(async f => {
    const row = await pending(f), another = await pending(f), headers = key('reject-replay');
    const body = { expectedUpdatedAt: row.updatedAt };
    const rejected = await f.request(`${BASE}/${row.id}/reject`, 'POST', body, headers); assert.equal(rejected.status, 200);
    assert.equal(rejected.data.status, 'waiting'); assert.ok(rejected.data.deletedAt);
    assert.deepEqual((await f.request(`${BASE}/${row.id}/reject`, 'POST', body, headers)).data, rejected.data);
    assert.equal((await f.request(`${BASE}/${row.id}`, 'PATCH', body, key())).data.code, 'BOOKING_CHANGED');
    assert.deepEqual((await f.ok(BASE)).bookings.map((item: any) => item.id), [another.id]);
    await f.ok(`/admin/bookings/${row.id}/restore`, 'POST', {});
    assert.equal((await f.ok(BASE)).total, 2);
  });
});

test('website mutations require an idempotency key and revision, validate future active slots, and cannot touch other sources', async () => {
  await isolated(async f => {
    const row = await pending(f);
    for (const [suffix, method] of [['', 'PATCH'], ['/confirm', 'POST'], ['/reject', 'POST']]) {
      assert.equal((await f.request(`${BASE}/${row.id}${suffix}`, method, { expectedUpdatedAt: row.updatedAt })).status, 400);
      assert.equal((await f.request(`${BASE}/${row.id}${suffix}`, method, {}, key())).status, 400);
    }
    const employee = await f.ok('/admin/bookings', 'POST', input());
    const foreign = await f.request(`${BASE}/${employee.id}`);
    assert.equal(foreign.status, 404); assert.equal(foreign.data.code, 'NOT_FOUND');
    for (const [suffix, method] of [['', 'PATCH'], ['/confirm', 'POST'], ['/reject', 'POST']]) {
      assert.equal((await f.request(`${BASE}/${employee.id}${suffix}`, method, { expectedUpdatedAt: employee.updatedAt }, key())).status, 404);
    }
    for (const fields of [{ direction: 'invalid' }, { seats: 0 }, { requestedDate: '2030-02-30' }, { requestedTime: '25:00' }, { phone: 'bad' }, { bookingType: 'invalid' }]) {
      assert.equal((await edit(f, row, fields)).status, 400);
    }
    const inactive = await edit(f, row, { requestedTime: '09:45' }); assert.equal(inactive.status, 409); assert.equal(inactive.data.code, 'SLOT_INACTIVE');
    const past = await edit(f, row, { requestedDate: '2030-01-01', requestedTime: '06:00' }); assert.equal(past.status, 400); assert.equal(past.data.code, 'SLOT_PAST');
    await f.ok('/admin/schedule/date', 'PUT', { direction: 'gori-tbilisi', date: DAY, times: ['14:00'] });
    const disabled = await f.request(`${BASE}/${row.id}/confirm`, 'POST', { expectedUpdatedAt: row.updatedAt }, key());
    assert.equal(disabled.status, 409); assert.equal(disabled.data.code, 'SLOT_INACTIVE');
    assert.equal((await f.ok(BASE)).bookings.find((item: any) => item.id === row.id).updatedAt, row.updatedAt);
  });
});
