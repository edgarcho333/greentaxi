import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createDatabase, postgresPoolOptions } from '../server/database.js';
import { createApp } from '../server/index.js';

const DAY = '2030-01-02';
const PHONE = '555960001';
// Preserve every pre-group booking field when an artificial version-sixteen fixture is upgraded.
const pre020BookingColumns = 'id,name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,didube_name,didube_address,requested_date,requested_time,assigned_date,assigned_time,status,deleted_at,source,created_at,updated_at,booking_type,assigned_vehicle_key,assigned_vehicle_name,caller_phone,luggage,dog,seat_preference';
async function storage(postgres = !!process.env.TEST_DATABASE_URL) {
  const directory = mkdtempSync(join(tmpdir(), 'greentaxi-multi-hour-'));
  const dbPath = join(directory, 'test.sqlite');
  let pool: pg.Pool | undefined, schema: string | undefined;
  let databaseUrl = '';
  if (postgres) {
    schema = `multi_hour_${randomBytes(8).toString('hex')}`;
    pool = new pg.Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL!));
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(process.env.TEST_DATABASE_URL!);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connection.toString();
  }
  return { open: () => createDatabase({ dbPath, databaseUrl, production: false }), async close() {
    if (pool && schema) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    rmSync(directory, { recursive: true, force: true });
  } };
}
async function fixture() {
  const stored = await storage();
  const db = await stored.open();
  const service = await createApp({ database: db, production: false, now: () => new Date('2030-01-01T04:00:00Z') });
  const server = await new Promise<Server>(resolve => { const listener = service.app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let staff = '', driver = '';
  async function request(path: string, method = 'GET', body?: unknown, role: 'staff' | 'driver' | 'none' = 'staff', headers: Record<string, string> = {}) {
    const cookie = role === 'staff' ? staff : role === 'driver' ? driver : '';
    const response = await fetch(`${base}/api${path}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any, headers: response.headers };
  }
  async function ok(path: string, method = 'GET', body?: unknown, role: 'staff' | 'driver' = 'staff', headers?: Record<string, string>) {
    const result = await request(path, method, body, role, headers);
    assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: ${result.status} ${result.data.code ?? ''}`);
    return result.data;
  }
  const setup = await request('/auth/setup', 'POST', { login: 'multi_hour_operator', name: 'Test operator', password: 'multi-hour-test-password-123' });
  assert.equal(setup.status, 201); staff = setup.headers.get('set-cookie')!.split(';')[0];
  await ok('/admin/schedule/base', 'PUT', { direction: 'gori-tbilisi', times: ['09:30', '14:00', '16:00'] });
  await ok('/admin/drivers/1/phone', 'PATCH', { phone: PHONE });
  return { ...service, db, request, ok, async login() {
    const result = await request('/driver/auth/login', 'POST', { phone: PHONE }, 'none');
    assert.equal(result.status, 200); driver = result.headers.get('set-cookie')!.split(';')[0];
  }, async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await service.close(); await stored.close(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function isolated(operation: (f: Fixture) => Promise<void>) { const f = await fixture(); try { await operation(f); } finally { await f.close(); } }
const query = (time: string) => `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=${time}`;
async function change(f: Fixture, time: string, action: string, id?: number, removeKey?: string) {
  const current = await f.ok(query(time));
  return f.request('/admin/trips/drivers', 'POST', { direction: 'gori-tbilisi', date: DAY, time, expectedRevision: current.revision, action, ...(id ? { driver: { kind: 'roster', id } } : {}), ...(removeKey ? { removeKey } : {}) });
}
async function assign(f: Fixture, time: string, id = 1) { const result = await change(f, time, 'add', id); assert.equal(result.status, 201); return result.data; }
const input = (time: string, extras: Record<string, unknown> = {}): Record<string, unknown> => ({ phone: '555960111', seats: 2, direction: 'gori-tbilisi', requestedDate: DAY, requestedTime: time, goriAddress: 'გორი, სახლი 15', ...extras });
async function wholeInput(f: Fixture, time: string, id = 1) {
  const options = await f.ok(`/admin/trips/whole-car-options?direction=gori-tbilisi&date=${DAY}&time=${time}`);
  const choice = options.drivers.find((row: any) => row.driverId === id); assert.ok(choice);
  return input(time, { bookingType: 'whole_car', assignedVehicleKey: choice.key, expectedVehicleRevision: choice.revision });
}

test('one driver has independent departures, capacity and scoped remove/replace without moving the other hours', async () => {
  await isolated(async f => {
    await assign(f, '09:30'); await assign(f, '14:00');
    const schedule = await f.ok(`/admin/drivers/schedule?direction=gori-tbilisi&date=${DAY}`);
    assert.deepEqual(schedule.drivers.find((row: any) => row.id === 1).assignedTimes, ['09:30', '14:00']);
    for (const time of ['09:30', '14:00']) assert.equal((await f.ok(query(time))).totalSeats, 7);
    assert.equal((await change(f, '14:00', 'add', 1)).data.code, 'DRIVER_ALREADY_ASSIGNED');
    const replaced = await change(f, '09:30', 'replace', 2, 'roster:1'); assert.equal(replaced.status, 200);
    assert.deepEqual((await f.ok(query('09:30'))).drivers.map((row: any) => row.driverId), [2]);
    assert.deepEqual((await f.ok(query('14:00'))).drivers.map((row: any) => row.driverId), [1]);
    assert.equal((await change(f, '14:00', 'remove', undefined, 'roster:1')).status, 200);
    assert.equal((await f.ok(query('14:00'))).totalSeats, 0);
    assert.equal((await f.ok(query('09:30'))).totalSeats, 7);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_trip_assignments WHERE driver_id=? AND date=?').get(1, DAY))?.count, 0);
  });
});

test('whole-car exclusivity, cancellation, restore and movement affect only that vehicle departure', async () => {
  await isolated(async f => {
    const first = await f.ok('/admin/bookings', 'POST', await wholeInput(f, '09:30'));
    const second = await f.ok('/admin/bookings', 'POST', await wholeInput(f, '14:00'));
    assert.equal(first.seats, 7); assert.equal(second.seats, 7);
    assert.equal((await f.request('/admin/bookings', 'POST', await wholeInput(f, '14:00'))).data.code, 'VEHICLE_RESERVED');
    assert.equal((await change(f, '09:30', 'remove', undefined, 'roster:1')).data.code, 'VEHICLE_RESERVED');
    await f.ok(`/admin/bookings/${first.id}/delete`, 'POST', {});
    assert.equal((await f.ok(query('09:30'))).drivers[0].reservedBookingId, undefined);
    assert.equal((await f.ok(query('14:00'))).drivers[0].reservedBookingId, second.id);
    await f.ok(`/admin/bookings/${first.id}/restore`, 'POST', {});
    const target = await wholeInput(f, '16:00');
    await f.ok(`/admin/bookings/${first.id}/move`, 'POST', { date: DAY, time: '16:00', assignedVehicleKey: target.assignedVehicleKey, expectedVehicleRevision: target.expectedVehicleRevision });
    assert.equal((await f.ok(query('16:00'))).drivers[0].reservedBookingId, first.id);
    assert.equal((await f.ok(query('14:00'))).drivers[0].reservedBookingId, second.id);
    assert.deepEqual((await f.ok(`/admin/drivers/schedule?direction=gori-tbilisi&date=${DAY}`)).drivers.find((row: any) => row.id === 1).assignedTimes, ['09:30', '14:00', '16:00']);
  });
});

test('a mixed driver day shares ordinary customers only outside that driver own exclusive hours', async () => {
  await isolated(async f => {
    await assign(f, '09:30'); await assign(f, '14:00');
    const passenger = await f.ok('/admin/bookings', 'POST', input('09:30', { callerPhone: '555960999' }));
    const parcel = await f.ok('/admin/bookings', 'POST', input('09:30', { bookingType: 'parcel' }));
    const hiddenShared = await f.ok('/admin/bookings', 'POST', input('14:00'));
    const own = await f.ok('/admin/bookings', 'POST', await wholeInput(f, '14:00'));
    const foreign = await f.ok('/admin/bookings', 'POST', await wholeInput(f, '09:30', 2));
    const unassigned = await f.ok('/admin/bookings', 'POST', input('16:00'));
    await f.login();
    const dashboard = await f.ok(`/driver/dashboard?date=${DAY}`, 'GET', undefined, 'driver');
    assert.equal(dashboard.bookingScope, 'mixed');
    assert.deepEqual(dashboard.trips.map((row: any) => row.time), ['09:30', '14:00']);
    assert.deepEqual(dashboard.bookings.map((row: any) => row.id), [passenger.id, parcel.id, own.id]);
    assert.equal(dashboard.bookings[0].callerPhone, '555960999');
    for (const id of [hiddenShared.id, foreign.id, unassigned.id]) assert.ok(!dashboard.bookings.some((row: any) => row.id === id));
    assert.equal((await f.request('/driver/attendance', 'PATCH', { date: DAY, working: false }, 'driver')).data.code, 'VEHICLE_RESERVED');
    await f.ok(`/admin/bookings/${own.id}/delete`, 'POST', {});
    await f.ok('/driver/attendance', 'PATCH', { date: DAY, working: false }, 'driver');
    assert.deepEqual((await f.ok(`/driver/dashboard?date=${DAY}`, 'GET', undefined, 'driver')).bookings, []);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_trip_assignments WHERE driver_id=? AND date=?').get(1, DAY))?.count, 2);
    await f.ok('/driver/attendance', 'PATCH', { date: DAY, working: true }, 'driver');
    assert.deepEqual((await f.ok(`/driver/dashboard?date=${DAY}`, 'GET', undefined, 'driver')).bookings.map((row: any) => row.id), [passenger.id, parcel.id, hiddenShared.id]);
  });
});

test('an inactive driver can receive two whole-car group siblings from the same initial snapshot and replay once', async () => {
  await isolated(async f => {
    await f.ok('/admin/drivers/1/day', 'PATCH', { direction: 'gori-tbilisi', date: DAY, declined: true });
    const inputs = [await wholeInput(f, '09:30'), await wholeInput(f, '14:00')];
    const headers = { 'Idempotency-Key': 'same-driver-two-hours' };
    const created = await f.ok('/admin/bookings/group', 'POST', { bookings: inputs }, 'staff', headers);
    assert.equal(created.bookings.length, 2);
    assert.deepEqual((await f.ok('/admin/bookings/group', 'POST', { bookings: inputs }, 'staff', headers)).bookings, created.bookings);
    for (const [index, time] of ['09:30', '14:00'].entries()) assert.equal((await f.ok(query(time))).drivers[0].reservedBookingId, created.bookings[index].id);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM bookings').get())?.count, 2);
  });
  await isolated(async f => {
    const choice = await wholeInput(f, '09:30');
    const result = await f.request('/admin/bookings/group', 'POST', { bookings: [choice, choice] }, 'staff', { 'Idempotency-Key': 'same-hour-conflict' });
    assert.equal(result.status, 409); assert.equal(result.data.code, 'VEHICLE_RESERVED');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM bookings').get())?.count, 0);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_trip_assignments').get())?.count, 0);
  });
});

test('stale and concurrent plan edits reject atomically, while fresh additions preserve already assigned hours', async () => {
  await isolated(async f => {
    await assign(f, '09:30');
    const plan = await f.ok(query('14:00'));
    const body = { direction: 'gori-tbilisi', date: DAY, time: '14:00', expectedRevision: plan.revision, action: 'add', driver: { kind: 'roster', id: 1 } };
    const results = await Promise.all([f.request('/admin/trips/drivers', 'POST', body), f.request('/admin/trips/drivers', 'POST', body)]);
    assert.deepEqual(results.map(row => row.status).sort(), [201, 409]);
    const final = await f.ok(`/admin/drivers/schedule?direction=gori-tbilisi&date=${DAY}`);
    assert.deepEqual(final.drivers.find((row: any) => row.id === 1).assignedTimes, ['09:30', '14:00']);
    const driver = final.drivers.find((row: any) => row.id === 1);
    assert.equal((await f.request('/admin/drivers/1', 'DELETE', { expectedRevision: driver.revision })).data.code, 'DRIVER_ASSIGNED');
  });
});

for (const dialect of ['sqlite', 'postgres'] as const) {
  test(`${dialect} multi-hour migration preserves all version-sixteen rows and backfills declined and working assignments exactly once`, { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL }, async () => {
    const stored = await storage(dialect === 'postgres'); let db = await stored.open();
    try {
      await db.exec('ALTER TABLE bookings DROP COLUMN travel_group_id; ALTER TABLE bookings DROP COLUMN travel_group_order; ALTER TABLE call_inquiries DROP COLUMN call_status; ALTER TABLE call_inquiries DROP COLUMN ringing_hash; DROP TABLE call_device_heartbeats; DROP TABLE driver_trip_assignments;');
      await db.prepare('DELETE FROM schema_versions WHERE version>=?').run(17);
      for (const [id, declined, time] of [[1, 0, '09:30'], [2, 1, '14:00']] as const) {
        await db.prepare("INSERT INTO driver_day_overrides(driver_id,date,declined,assignment_mode,manual_time,updated_at) VALUES (?,?,?,'manual',?,'2030-01-01T00:00:00Z')").run(id, DAY, declined, time);
      }
      await db.prepare("INSERT INTO users(login,name,password_hash,created_at) VALUES ('preserved','Staff','private-test-hash','2030')").run();
      await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ('preserved-session',1,1894060800000)").run();
      const tables = ['drivers', 'driver_accounts', 'driver_sessions', 'users', 'sessions', 'settings', 'stops', 'bookings', 'driver_day_overrides', 'audit_log', 'schema_versions'];
      const snapshots = new Map<string, string>();
      for (const table of tables) snapshots.set(table, JSON.stringify(await db.prepare(`SELECT ${table === 'bookings' ? pre020BookingColumns : '*'} FROM ${table} ORDER BY 1`).all()));
      await db.close();
      for (let pass = 0; pass < 2; pass++) {
        db = await stored.open();
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 20);
        for (const [table, snapshot] of snapshots) assert.equal(JSON.stringify(await db.prepare(`SELECT ${table === 'bookings' ? pre020BookingColumns : '*'} FROM ${table}${table === 'schema_versions' ? ' WHERE version<17' : ''} ORDER BY 1`).all()), snapshot, table);
        const assignments = await db.prepare('SELECT driver_id,date,time FROM driver_trip_assignments ORDER BY driver_id').all();
        assert.deepEqual(assignments.map(row => ({ ...row })), [{ driver_id: 1, date: DAY, time: '09:30' }, { driver_id: 2, date: DAY, time: '14:00' }]);
        if (!pass) await db.close();
      }
      await assert.rejects(db.prepare("INSERT INTO driver_trip_assignments(driver_id,date,time,created_at) VALUES (1,?,'25:00','2030')").run(DAY), /check constraint|CHECK constraint/i);
      await assert.rejects(db.prepare("INSERT INTO driver_trip_assignments(driver_id,date,time,created_at) VALUES (1,?,'09:30','2030')").run(DAY), /unique|duplicate/i);
    } finally { await db.close(); await stored.close(); }
  });
}
