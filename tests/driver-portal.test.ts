import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createDatabase, postgresPoolOptions } from '../server/database.js';
import { createDriverAccount, DriverAccountError, driverPasswordMatches, hashDriverPassword } from '../server/driver-accounts.js';
import { createApp } from '../server/index.js';
import { buildDriverSchedule, INITIAL_DRIVER_ROSTER } from '../shared/driver-rotation.js';

const TODAY = '2030-01-01';
const TOMORROW = '2030-01-02';
const DRIVER_PASSWORD = '2468';
const DRIVER_PHONES = ['599920001', '599920002'] as const;
const EMPLOYEE_PASSWORD = 'portal-employee-test-password';
const cookieValue = (header: string) => header.split(';')[0];

async function storage(postgres = !!process.env.TEST_DATABASE_URL) {
  const directory = mkdtempSync(join(tmpdir(), 'greentaxi-driver-portal-'));
  const dbPath = join(directory, 'test.sqlite');
  let administration: pg.Pool | undefined;
  let schema: string | undefined;
  let databaseUrl = '';
  if (postgres) {
    schema = `driver_portal_${randomBytes(8).toString('hex')}`;
    administration = new pg.Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL!));
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(process.env.TEST_DATABASE_URL!);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connection.toString();
  }
  return {
    open: () => createDatabase({ dbPath, databaseUrl, production: false }),
    async close() {
      if (administration && schema) { await administration.query(`DROP SCHEMA "${schema}" CASCADE`); await administration.end(); }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function fixture(production = false) {
  const stored = await storage();
  const database = await stored.open();
  await createDriverAccount(database, { driverId: 1, login: 'operator', password: DRIVER_PASSWORD });
  await createDriverAccount(database, { driverId: 2, login: 'driver_two', password: DRIVER_PASSWORD });
  let currentTime = new Date('2030-01-01T00:00:00Z');
  const service = await createApp({ database, production, setupToken: 'portal-fixture-setup-token', now: () => currentTime, deferPhoneMigration: false });
  const server = await new Promise<Server>(resolve => { const listener = service.app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let employeeCookie = ''; let driverCookie = '';
  async function request(path: string, method = 'GET', body?: unknown, actor: 'employee' | 'driver' | 'none' = 'none', headers: Record<string, string> = {}) {
    const cookie = actor === 'employee' ? employeeCookie : actor === 'driver' ? driverCookie : '';
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any, headers: response.headers };
  }
  const employee = await request('/auth/setup', 'POST', { login: 'operator', name: 'Portal test employee', password: EMPLOYEE_PASSWORD, setupToken: 'portal-fixture-setup-token' });
  assert.equal(employee.status, 201); employeeCookie = cookieValue(employee.headers.get('set-cookie')!);
  for (const [index, phone] of DRIVER_PHONES.entries()) {
    const configured = await request(`/admin/drivers/${index + 1}/phone`, 'PATCH', { phone }, 'employee');
    assert.equal(configured.status, 200);
  }
  return {
    ...service, request, base, employeeCookie,
    setNow(value: string) { currentTime = new Date(value); },
    async login(index = 1) {
      const result = await request('/driver/auth/login', 'POST', { phone: DRIVER_PHONES[index - 1] });
      assert.equal(result.status, 200);
      driverCookie = cookieValue(result.headers.get('set-cookie')!);
      return { ...result, cookie: driverCookie };
    },
    async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await service.close(); await stored.close(); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function isolated(operation: (f: Fixture) => Promise<void>, production = false) {
  const f = await fixture(production); try { await operation(f); } finally { await f.close(); }
}
async function successful(f: Fixture, path: string, method = 'GET', body?: unknown, actor: 'employee' | 'driver' = 'driver') {
  const result = await f.request(path, method, body, actor);
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: ${result.status} ${result.data.code ?? ''}`);
  return result.data;
}
async function assign(f: Fixture, id: number, date = TOMORROW, time = '08:30') {
  const plan = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${date}&time=${time}`, 'GET', undefined, 'employee');
  return successful(f, '/admin/trips/drivers', 'POST', { direction: 'gori-tbilisi', date, time, expectedRevision: plan.revision, action: 'add', driver: { kind: 'roster', id } }, 'employee');
}
function bookingInput(overrides: Record<string, unknown> = {}) {
  return { name: 'სატესტო მგზავრი', phone: '599111222', seats: 2, direction: 'gori-tbilisi', requestedDate: TOMORROW, requestedTime: '08:30', goriAddress: 'გორი, სახლი 15', ...overrides };
}
async function whole(f: Fixture, id: number, overrides: Record<string, unknown> = {}) {
  const options = await successful(f, `/admin/trips/whole-car-options?direction=gori-tbilisi&date=${TOMORROW}&time=08:30`, 'GET', undefined, 'employee');
  const driver = options.drivers.find((driver: any) => driver.driverId === id); assert.ok(driver);
  return successful(f, '/admin/bookings', 'POST', bookingInput({ bookingType: 'whole_car', assignedVehicleKey: driver.key, expectedVehicleRevision: driver.revision, ...overrides }), 'employee');
}

for (const dialect of ['sqlite', 'postgres'] as const) {
  test(`${dialect} driver-portal migration adds empty isolated credentials once and preserves all existing users, settings and driver state`, { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL }, async () => {
    const stored = await storage(dialect === 'postgres'); let db = await stored.open();
    try {
      await db.prepare('INSERT INTO users(login,name,password_hash,created_at) VALUES (?,?,?,?)').run('preserved', 'Existing employee', 'existing-private-hash', '2030-01-01T00:00:00Z');
      await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run('existing-private-session', 1, 1893456000000);
      await db.prepare("INSERT INTO driver_day_overrides(driver_id,date,declined,assignment_mode,manual_time,updated_at) VALUES (1,?,1,'manual',?,?)").run(TOMORROW, '09:30', '2030-01-01T00:00:00Z');
      await db.transaction(async () => { await db.exec('DROP TABLE call_device_heartbeats; DROP TABLE driver_trip_assignments; DROP TABLE driver_sessions; DROP TABLE driver_accounts;'); await db.prepare('DELETE FROM schema_versions WHERE version>=?').run(14); await db.exec('ALTER TABLE drivers DROP COLUMN deleted_at; ALTER TABLE drivers DROP COLUMN revision;'); });
      const snapshots = new Map<string, string>();
      for (const table of ['users', 'sessions', 'settings', 'stops', 'drivers', 'driver_day_overrides', 'base_schedule', 'date_schedule', 'bookings', 'audit_log', 'schema_versions']) snapshots.set(table, JSON.stringify(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
      await db.close();
      for (let reopen = 0; reopen < 2; reopen++) {
        db = await stored.open();
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 18);
        for (const [table, snapshot] of snapshots) assert.equal(JSON.stringify(await db.prepare(`SELECT ${table === 'drivers' ? 'id,name,capacity,sort_order' : '*'} FROM ${table}${table === 'schema_versions' ? ' WHERE version<14' : ''} ORDER BY 1`).all()), snapshot);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM driver_accounts').get())?.count, 0);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM driver_sessions').get())?.count, 0);
        if (!reopen) await db.close();
      }
      await assert.rejects(db.prepare('INSERT INTO driver_accounts(driver_id,login,password_hash,created_at,updated_at) VALUES (99999,?,?,?,?)').run('invalid', 'private-hash', '2030', '2030'));
    } finally { await db.close(); await stored.close(); }
  });
}

test('explicit driver account provisioning hashes four-digit passwords, preserves staff accounts and never overwrites an existing account', async () => {
  await isolated(async f => {
    const employees = JSON.stringify(await f.db.prepare('SELECT * FROM users ORDER BY id').all());
    const first = await f.db.prepare('SELECT * FROM driver_accounts WHERE driver_id=?').get(1); assert.ok(first);
    assert.match(first.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.notEqual(first.password_hash, DRIVER_PASSWORD);
    assert.equal(await driverPasswordMatches(DRIVER_PASSWORD, first.password_hash), true);
    assert.equal(await driverPasswordMatches('wrong', first.password_hash), false);
    assert.equal(await driverPasswordMatches(DRIVER_PASSWORD), false);
    assert.notEqual(await hashDriverPassword(DRIVER_PASSWORD), await hashDriverPassword(DRIVER_PASSWORD));
    for (const [input, code] of [
      [{ driverId: 1, login: 'new_login', password: '1357' }, 'ACCOUNT_EXISTS'],
      [{ driverId: 3, login: 'operator', password: '1357' }, 'LOGIN_TAKEN'],
      [{ driverId: 99999, login: 'missing', password: '1357' }, 'NOT_FOUND'],
      [{ driverId: 3, login: 'new_login', password: '1357', expectedName: 'Another driver' }, 'DRIVER_CHANGED'],
      [{ driverId: 3, login: 'bad login', password: '1357' }, 'VALIDATION'],
      [{ driverId: 3, login: 'new_login', password: '123' }, 'VALIDATION'],
    ] as const) await assert.rejects(createDriverAccount(f.db, input), error => error instanceof DriverAccountError && error.code === code);
    assert.deepEqual(await f.db.prepare('SELECT * FROM driver_accounts WHERE driver_id=?').get(1), first);
    const added = await createDriverAccount(f.db, { driverId: 3, login: 'New_Driver', password: '1357', expectedName: 'გოჩა' });
    assert.deepEqual(added, { id: 3, name: 'გოჩა', login: 'new_driver', capacity: 8, phone: null });
    assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM users ORDER BY id').all()), employees);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_accounts').get())?.count, 3);
    const audit = await f.db.prepare("SELECT user_id,details FROM audit_log WHERE action='driver.account.create' ORDER BY id DESC").get();
    assert.equal(audit?.user_id, null); assert.deepEqual(JSON.parse(audit!.details), { driverId: 3, login: 'new_driver' });
  });
});

test('driver authentication uses an opaque scoped cookie and a separate credential store', async () => {
  await isolated(async f => {
    const guest = await f.request('/driver/auth/session');
    assert.deepEqual(guest.data, { driver: null, today: TODAY, tomorrow: TOMORROW });
    assert.equal(guest.headers.get('cache-control'), 'no-store');
    const login = await f.login();
    assert.deepEqual(login.data, { driver: { id: 1, login: 'operator', name: 'რეზო', capacity: 7, phone: DRIVER_PHONES[0] }, today: TODAY, tomorrow: TOMORROW });
    const header = login.headers.get('set-cookie')!;
    assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/); assert.match(header, /Path=\/api\/driver/);
    const raw = login.cookie.split('=')[1]; assert.match(raw, /^[a-f0-9]{64}$/);
    const session = await f.db.prepare('SELECT token_hash,driver_id FROM driver_sessions').get();
    assert.equal(session?.token_hash, createHash('sha256').update(raw).digest('hex')); assert.notEqual(session?.token_hash, raw);
    assert.equal(session?.driver_id, 1);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM sessions').get())?.count, 1);
    for (const phone of ['599777771', '+995 599 77 77 72']) {
      const result = await f.request('/driver/auth/login', 'POST', { phone }); assert.equal(result.status, 401); assert.equal(result.data.code, 'INVALID_LOGIN');
    }
    for (const credentials of [{ login: 'operator', password: DRIVER_PASSWORD }, { phone: DRIVER_PHONES[0], password: DRIVER_PASSWORD }]) {
      assert.equal((await f.request('/driver/auth/login', 'POST', credentials)).status, 400, 'Legacy credentials must never authorize driver login');
    }
    assert.equal((await f.request('/auth/login', 'POST', { login: 'operator', password: DRIVER_PASSWORD })).status, 401);
    for (const value of ['malformed', '0'.repeat(64), f.employeeCookie.split('=')[1]]) {
      const headers = { Cookie: `greentaxi_driver_session=${value}` };
      assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', headers)).data.driver, null);
      assert.equal((await f.request('/driver/dashboard', 'GET', undefined, 'none', headers)).status, 401);
    }
  });
});

test('driver sessions cannot access or impersonate staff and staff sessions do not authorize driver-only endpoints', async () => {
  await isolated(async f => {
    const login = await f.login();
    for (const path of ['/admin/bookings', '/admin/staff', '/admin/settings', '/admin/drivers/schedule?direction=gori-tbilisi&date=2030-01-02']) assert.equal((await f.request(path, 'GET', undefined, 'driver')).status, 401);
    assert.equal((await f.request('/admin/bookings', 'POST', bookingInput(), 'driver')).status, 401);
    assert.equal((await f.request('/admin/bookings', 'GET', undefined, 'none', { Cookie: login.cookie.replace('greentaxi_driver_session=', 'greentaxi_session=') })).status, 401);
    assert.equal((await f.request('/driver/dashboard', 'GET', undefined, 'employee')).status, 401);
    assert.equal((await f.request('/driver/attendance', 'PATCH', { date: TODAY, working: false }, 'employee')).status, 401);
    assert.equal((await f.request('/auth/session', 'GET', undefined, 'driver')).data.user, null);
    assert.equal((await f.request('/driver/bookings/1/delete', 'POST', {}, 'driver')).status, 404);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM users').get())?.count, 1);
  });
});

test('driver attendance changes only the authenticated driver and selected day without assigning departure hours', async () => {
  await isolated(async f => {
    await f.login();
    const changed = await successful(f, '/driver/attendance', 'PATCH', { date: TODAY, working: false });
    assert.deepEqual(changed.days.map((day: any) => [day.date, day.working, day.assignedTime]), [[TODAY, false, null], [TOMORROW, true, null]]);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_day_overrides').get())?.count, 1);
    assert.equal((await f.db.prepare('SELECT manual_time FROM driver_day_overrides WHERE driver_id=? AND date=?').get(1, TODAY))?.manual_time, null);
    await successful(f, '/driver/attendance', 'PATCH', { date: TODAY, working: true });
    await assign(f, 1); await assign(f, 2, TOMORROW, '09:30');
    const other = JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides WHERE driver_id=?').all(2));
    const declined = await successful(f, '/driver/attendance', 'PATCH', { date: TOMORROW, working: false });
    assert.deepEqual(declined.days.find((day: any) => day.date === TOMORROW), { date: TOMORROW, working: false, assignedTime: null, assignmentActive: false, assignedTimes: [], activeAssignedTimes: [] });
    assert.equal((await f.db.prepare('SELECT manual_time FROM driver_day_overrides WHERE driver_id=? AND date=?').get(1, TOMORROW))?.manual_time, '08:30');
    const restored = await successful(f, '/driver/attendance', 'PATCH', { date: TOMORROW, working: true });
    assert.deepEqual(restored.days.find((day: any) => day.date === TOMORROW), { date: TOMORROW, working: true, assignedTime: '08:30', assignmentActive: true, assignedTimes: ['08:30'], activeAssignedTimes: ['08:30'] });
    assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides WHERE driver_id=?').all(2)), other);
    const audit = await f.db.prepare("SELECT user_id,details FROM audit_log WHERE action='driver.attendance' ORDER BY id DESC").get();
    assert.equal(audit?.user_id, null); assert.deepEqual(JSON.parse(audit!.details), { driverId: 1, date: TOMORROW, working: true, actorType: 'driver' });
    const employeePlan = await successful(f, `/admin/drivers/schedule?direction=gori-tbilisi&date=${TOMORROW}`, 'GET', undefined, 'employee');
    assert.equal(employeePlan.drivers.find((driver: any) => driver.id === 1).declined, false);
  });
});

test('driver APIs reject other dates, malformed statuses and driver or assignment overrides without partial writes', async () => {
  await isolated(async f => {
    await f.login();
    const before = JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides').all());
    for (const body of [{ date: '2029-12-31', working: false }, { date: '2030-01-03', working: true }, { date: TODAY, working: 'false' }, { date: TODAY }, { date: TODAY, working: false, driverId: 2 }, { date: TODAY, working: true, assignment: { mode: 'manual', time: '08:30' } }, { date: TODAY, working: true, direction: 'tbilisi-gori' }]) assert.equal((await f.request('/driver/attendance', 'PATCH', body, 'driver')).status, 400);
    for (const query of ['date=2029-12-31', 'date=2030-01-03', 'date=invalid', `date=${TODAY}&date=${TOMORROW}`]) assert.equal((await f.request(`/driver/dashboard?${query}`, 'GET', undefined, 'driver')).status, 400);
    assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides').all()), before);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='driver.attendance'").get())?.count, 0);
  });
});

test('declining a reserved whole-car day returns a clear conflict and leaves assignment, reservation and audit intact', async () => {
  await isolated(async f => {
    await f.login(); const reserved = await whole(f, 1);
    const before = JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides WHERE driver_id=?').all(1));
    const result = await f.request('/driver/attendance', 'PATCH', { date: TOMORROW, working: false }, 'driver');
    assert.equal(result.status, 409); assert.equal(result.data.code, 'VEHICLE_RESERVED');
    assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM driver_day_overrides WHERE driver_id=?').all(1)), before);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='driver.attendance'").get())?.count, 0);
    await successful(f, `/admin/bookings/${reserved.id}/delete`, 'POST', {}, 'employee');
    const changed = await successful(f, '/driver/attendance', 'PATCH', { date: TOMORROW, working: false });
    assert.equal(changed.days.find((day: any) => day.date === TOMORROW).working, false);
  });
});

test('whole-car performers see only their own active confirmed orders and a restricted contact DTO', async () => {
  await isolated(async f => {
    await f.login();
    const canceled = await whole(f, 1); await successful(f, `/admin/bookings/${canceled.id}/delete`, 'POST', {}, 'employee');
    const own = await whole(f, 1, { callerPhone: '+995 599 99 98 88', luggage: true, dog: true });
    const foreign = await whole(f, 2, { callerPhone: '599888777' });
    const passenger = await successful(f, '/admin/bookings', 'POST', bookingInput(), 'employee');
    const parcel = await successful(f, '/admin/bookings', 'POST', bookingInput({ bookingType: 'parcel' }), 'employee');
    const waiting = await f.request('/bookings', 'POST', bookingInput()); assert.equal(waiting.status, 201);
    await f.db.prepare('UPDATE bookings SET requested_date=? WHERE id=?').run(TODAY, own.id);
    const dashboard = await successful(f, `/driver/dashboard?date=${TOMORROW}`);
    assert.equal(dashboard.driver.id, 1); assert.equal(dashboard.bookingScope, 'assigned');
    assert.deepEqual(dashboard.trip, { direction: 'gori-tbilisi', time: '08:30', active: true });
    assert.deepEqual(dashboard.bookings.map((booking: any) => booking.id), [own.id]);
    assert.deepEqual(Object.keys(dashboard.bookings[0]).sort(), ['id', 'name', 'phone', 'callerPhone', 'direction', 'seats', 'bookingType', 'luggage', 'dog', 'seatPreference', 'goriAddress', 'pickupStopName', 'didubeName', 'didubeAddress', 'date', 'time'].sort());
    assert.equal(dashboard.bookings[0].phone, '599111222'); assert.equal(dashboard.bookings[0].luggage, true); assert.equal(dashboard.bookings[0].dog, true);
    assert.equal(dashboard.bookings[0].callerPhone, '599999888');
    assert.equal(JSON.stringify(dashboard.bookings).includes('599888777'), false);
    for (const parameters of ['path=driver%2Fdashboard', 'driverId=2', 'userId=2', 'path=driver%2Fdashboard&driverId=2&userId=2&accountId=2']) {
      const routed = await successful(f, `/driver/dashboard?date=${TOMORROW}&${parameters}`);
      assert.equal(routed.driver.id, 1);
      assert.equal(routed.date, TOMORROW);
      assert.deepEqual(routed.bookings, dashboard.bookings, 'Routing and identity query fields must never select another account');
      assert.deepEqual(routed.days, dashboard.days);
    }
    assert.deepEqual((await successful(f, `/driver/dashboard?date=${TODAY}`)).bookings, []);
    await f.login(2);
    const second = await successful(f, `/driver/dashboard?date=${TOMORROW}`);
    assert.deepEqual(second.bookings.map((booking: any) => booking.id), [foreign.id]);
    assert.ok(!second.bookings.some((booking: any) => [own.id, passenger.id, parcel.id, waiting.data.id, canceled.id].includes(booking.id)));
    await f.login();
    await successful(f, `/admin/bookings/${own.id}/delete`, 'POST', {}, 'employee');
    const shared = await successful(f, `/driver/dashboard?date=${TOMORROW}`);
    assert.equal(shared.bookingScope, 'trip');
    assert.deepEqual(shared.bookings.map((booking: any) => booking.id), [passenger.id, parcel.id], 'Canceling the exclusive order restores the assigned driver\'s shared trip list');
  });
});

test('working drivers assigned to the same trip share passenger and parcel orders without seeing any whole-car customers or other trips', async () => {
  await isolated(async f => {
    await f.login();
    assert.deepEqual((await successful(f, `/driver/dashboard?date=${TOMORROW}`)).bookings, []);
    await assign(f, 1); await assign(f, 2);
    const passenger = await successful(f, '/admin/bookings', 'POST', bookingInput({ phone: '599880001', callerPhone: '+995 599 88 09 99', luggage: true, seatPreference: 'front' }), 'employee');
    const parcel = await successful(f, '/admin/bookings', 'POST', bookingInput({ phone: '599880002', bookingType: 'parcel' }), 'employee');
    const exclusive = await whole(f, 3, { phone: '599880003' });
    const otherHour = await successful(f, '/admin/bookings', 'POST', bookingInput({ phone: '599880004', requestedTime: '09:30' }), 'employee');
    const otherDay = await successful(f, '/admin/bookings', 'POST', bookingInput({ phone: '599880005', requestedDate: TODAY }), 'employee');
    const config = await successful(f, '/public/config');
    const otherDirection = await successful(f, '/admin/bookings', 'POST', bookingInput({ phone: '599880006', direction: 'tbilisi-gori', pickupStopId: config.stops.find((stop: any) => stop.active).id }), 'employee');
    const deleted = await successful(f, '/admin/bookings', 'POST', bookingInput({ phone: '599880007' }), 'employee');
    await successful(f, `/admin/bookings/${deleted.id}/delete`, 'POST', {}, 'employee');
    const waiting = await f.request('/bookings', 'POST', bookingInput({ phone: '599880008' })); assert.equal(waiting.status, 201);
    // Assigned date/time, rather than a passenger's original request, owns the list.
    await f.db.prepare('UPDATE bookings SET requested_date=?,requested_time=? WHERE id=?').run(TODAY, '09:30', passenger.id);
    for (const driverId of [1, 2]) {
      await f.login(driverId);
      const dashboard = await successful(f, `/driver/dashboard?date=${TOMORROW}&driverId=3&time=09:30&direction=tbilisi-gori`);
      assert.equal(dashboard.driver.id, driverId);
      assert.equal(dashboard.bookingScope, 'trip');
      assert.deepEqual(dashboard.trip, { direction: 'gori-tbilisi', time: '08:30', active: true });
      assert.deepEqual(dashboard.bookings.map((booking: any) => booking.id), [passenger.id, parcel.id]);
      assert.deepEqual(dashboard.bookings.map((booking: any) => [booking.bookingType, booking.seats]), [['passenger', 2], ['parcel', 0]]);
      assert.equal(dashboard.bookings[0].luggage, true); assert.equal(dashboard.bookings[0].seatPreference, 'front');
      assert.equal(dashboard.bookings[0].callerPhone, '599880999');
      assert.equal(dashboard.bookings[1].callerPhone, null);
      for (const hidden of [exclusive.id, otherHour.id, otherDay.id, otherDirection.id, deleted.id, waiting.data.id]) assert.ok(!dashboard.bookings.some((booking: any) => booking.id === hidden));
      assert.deepEqual((await successful(f, `/driver/dashboard?date=${TODAY}`)).bookings, []);
    }
  });
});

test('shared trip orders remain readable when its hour is disabled but disappear after declining or removing that driver assignment', async () => {
  await isolated(async f => {
    await f.login(); await assign(f, 1);
    const passenger = await successful(f, '/admin/bookings', 'POST', bookingInput(), 'employee');
    const plan = await successful(f, `/admin/schedule?direction=gori-tbilisi&date=${TOMORROW}`, 'GET', undefined, 'employee');
    await successful(f, '/admin/schedule/date', 'PUT', { direction: 'gori-tbilisi', date: TOMORROW, times: plan.slots.filter((slot: any) => slot.active && slot.time !== '08:30').map((slot: any) => slot.time) }, 'employee');
    const disabled = await successful(f, `/driver/dashboard?date=${TOMORROW}`);
    assert.deepEqual(disabled.trip, { direction: 'gori-tbilisi', time: '08:30', active: false });
    assert.equal(disabled.bookingScope, 'trip');
    assert.deepEqual(disabled.bookings.map((booking: any) => booking.id), [passenger.id]);
    await successful(f, '/driver/attendance', 'PATCH', { date: TOMORROW, working: false });
    const declined = await successful(f, `/driver/dashboard?date=${TOMORROW}`);
    assert.equal(declined.trip, null); assert.deepEqual(declined.bookings, []);
    await successful(f, '/driver/attendance', 'PATCH', { date: TOMORROW, working: true });
    assert.deepEqual((await successful(f, `/driver/dashboard?date=${TOMORROW}`)).bookings.map((booking: any) => booking.id), [passenger.id]);
    await f.db.prepare('DELETE FROM driver_trip_assignments WHERE driver_id=? AND date=?').run(1, TOMORROW);
    await f.db.prepare('UPDATE driver_day_overrides SET manual_time=NULL WHERE driver_id=? AND date=?').run(1, TOMORROW);
    const unassigned = await successful(f, `/driver/dashboard?date=${TOMORROW}`);
    assert.equal(unassigned.trip, null); assert.deepEqual(unassigned.bookings, []);
  });
});

test('driver calendar follows Tbilisi midnight, including year boundaries, and rejects the previous day after rollover', async () => {
  await isolated(async f => {
    f.setNow('2030-12-31T19:59:00Z'); const login = await f.login();
    assert.equal(login.data.today, '2030-12-31'); assert.equal(login.data.tomorrow, '2031-01-01');
    await successful(f, '/driver/attendance', 'PATCH', { date: '2030-12-31', working: false });
    f.setNow('2030-12-31T20:00:00Z');
    const current = await successful(f, '/driver/auth/session');
    assert.equal(current.today, '2031-01-01'); assert.equal(current.tomorrow, '2031-01-02');
    assert.equal((await f.request('/driver/attendance', 'PATCH', { date: '2030-12-31', working: true }, 'driver')).data.code, 'DATE_OUT_OF_RANGE');
    const data = await successful(f, '/driver/dashboard'); assert.equal(data.date, '2031-01-01');
  });
});

test('driver logout, expiration and account deactivation revoke driver access while leaving staff sessions usable', async () => {
  await isolated(async f => {
    const first = await f.login(); const second = await f.login(2);
    const loggedOut = await f.request('/driver/auth/logout', 'POST', {}, 'none', { Cookie: first.cookie }); assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers.get('set-cookie')!, /Path=\/api\/driver/);
    assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', { Cookie: first.cookie })).data.driver, null);
    assert.equal((await successful(f, '/driver/auth/session')).driver.id, 2);
    await f.db.prepare('UPDATE driver_sessions SET expires_at=? WHERE driver_id=?').run(0, 2);
    assert.equal((await f.request('/driver/dashboard', 'GET', undefined, 'none', { Cookie: second.cookie })).status, 401);
    await f.login(); await f.db.prepare('UPDATE driver_accounts SET active=0 WHERE driver_id=?').run(1);
    assert.equal((await successful(f, '/driver/auth/session')).driver, null);
    assert.equal((await f.request('/driver/dashboard', 'GET', undefined, 'driver')).status, 401);
    assert.equal((await f.request('/driver/auth/login', 'POST', { phone: DRIVER_PHONES[0] })).status, 401);
    assert.equal((await f.request('/admin/settings', 'GET', undefined, 'employee')).status, 200);
  });
});

test('a browser with both sessions can log out of either portal without revoking the other role', async () => {
  await isolated(async f => {
    const first = await f.login();
    const combined = { Cookie: `${f.employeeCookie}; ${first.cookie}` };
    assert.equal((await f.request('/driver/auth/logout', 'POST', {}, 'none', combined)).status, 200);
    assert.equal((await f.request('/driver/dashboard', 'GET', undefined, 'none', combined)).status, 401);
    assert.equal((await f.request('/admin/settings', 'GET', undefined, 'none', combined)).status, 200);
    const second = await f.login();
    const next = { Cookie: `${f.employeeCookie}; ${second.cookie}` };
    assert.equal((await f.request('/auth/logout', 'POST', {}, 'none', next)).status, 200);
    assert.equal((await f.request('/admin/settings', 'GET', undefined, 'none', next)).status, 401);
    assert.equal((await f.request('/driver/dashboard', 'GET', undefined, 'none', next)).status, 200);
  });
});

test('production driver cookies are secure and cross-origin writes cannot authenticate or change attendance', async () => {
  await isolated(async f => {
    const login = await f.login(); assert.match(login.headers.get('set-cookie')!, /Secure/);
    const headers = { Origin: 'https://unrelated.example', 'X-Forwarded-Proto': 'https' };
    assert.equal((await f.request('/driver/auth/login', 'POST', { phone: DRIVER_PHONES[0] }, 'none', headers)).status, 403);
    assert.equal((await f.request('/driver/attendance', 'PATCH', { date: TODAY, working: false }, 'driver', headers)).status, 403);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_day_overrides').get())?.count, 0);
  }, true);
});

test('driver login attempts use their own persistent rate limit without blocking staff login', async () => {
  await isolated(async f => {
    for (let attempt = 0; attempt < 10; attempt++) assert.equal((await f.request('/driver/auth/login', 'POST', { phone: '599777771' })).status, 401);
    const limited = await f.request('/driver/auth/login', 'POST', { phone: DRIVER_PHONES[0] });
    assert.equal(limited.status, 429); assert.ok(limited.headers.has('retry-after'));
    assert.equal((await f.request('/auth/login', 'POST', { login: 'operator', password: EMPLOYEE_PASSWORD })).status, 200);
  });
});

for (const dialect of ['sqlite', 'postgres'] as const) {
  test(`${dialect} phone-login migration preserves legacy credentials, sessions and operational rows and runs once without configuring any phone`, { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL }, async () => {
    const stored = await storage(dialect === 'postgres'); let db = await stored.open();
    try {
      const previousName = `014_driver_portal.${dialect}.sql`;
      const previousSql = readFileSync(new URL(`../server/migrations/${previousName}`, import.meta.url), 'utf8');
      await db.transaction(async () => {
        await db.exec('DROP TABLE call_device_heartbeats; DROP TABLE driver_trip_assignments; DROP TABLE driver_sessions; DROP TABLE driver_accounts;');
        await db.prepare('DELETE FROM schema_versions WHERE version>=?').run(14);
        await db.exec(previousSql);
        await db.prepare('INSERT INTO schema_versions(version,name,checksum,applied_at) VALUES (?,?,?,?)')
          .run(14, previousName, createHash('sha256').update(previousSql).digest('hex'), '2030-01-01T00:00:00Z');
      });
      await db.exec('ALTER TABLE drivers DROP COLUMN deleted_at; ALTER TABLE drivers DROP COLUMN revision;');
      for (const id of [1, 2]) await db.prepare('INSERT INTO driver_accounts(driver_id,login,password_hash,active,created_at,updated_at) VALUES (?,?,?,1,?,?)')
        .run(id, `legacy_driver_${id}`, await hashDriverPassword(DRIVER_PASSWORD), '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
      await db.prepare('UPDATE driver_accounts SET active=0 WHERE driver_id=?').run(2);
      await db.prepare('INSERT INTO driver_sessions(token_hash,driver_id,expires_at) VALUES (?,?,?)').run('a'.repeat(64), 1, 1894060800000);
      await db.prepare('INSERT INTO users(login,name,password_hash,created_at) VALUES (?,?,?,?)').run('preserved', 'Existing employee', 'existing-private-hash', '2030-01-01T00:00:00Z');
      await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run('existing-staff-session', 1, 1894060800000);
      await db.prepare("INSERT INTO driver_day_overrides(driver_id,date,declined,assignment_mode,manual_time,updated_at) VALUES (1,?,1,'manual',?,?)").run(TOMORROW, '09:30', '2030-01-01T00:00:00Z');
      await db.prepare(`INSERT INTO bookings(name,phone,seats,direction,gori_address,didube_name,didube_address,requested_date,requested_time,assigned_date,assigned_time,status,source,created_at,updated_at)
        VALUES ('Preserved passenger','599888999',2,'gori-tbilisi','Existing house','Existing Didube','Existing destination',?,'08:30',?,'08:30','confirmed','employee',?,?)`)
        .run(TOMORROW, TOMORROW, '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
      const columns = (table: string) => table === 'driver_accounts' ? 'driver_id,login,password_hash,active,created_at,updated_at' : table === 'drivers' ? 'id,name,capacity,sort_order' : '*';
      const snapshots = new Map<string, string>();
      for (const table of ['driver_accounts', 'driver_sessions', 'users', 'sessions', 'settings', 'stops', 'drivers', 'driver_day_overrides', 'base_schedule', 'date_schedule', 'bookings', 'audit_log', 'schema_versions']) {
        snapshots.set(table, JSON.stringify(await db.prepare(`SELECT ${columns(table)} FROM ${table} ORDER BY 1`).all()));
      }
      await db.close();
      for (let reopen = 0; reopen < 2; reopen++) {
        db = await stored.open();
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 18);
        for (const [table, snapshot] of snapshots) assert.equal(JSON.stringify(await db.prepare(`SELECT ${columns(table)} FROM ${table}${table === 'schema_versions' ? ' WHERE version<15' : ''} ORDER BY 1`).all()), snapshot, table);
        assert.deepEqual((await db.prepare('SELECT phone FROM driver_accounts ORDER BY driver_id').all()).map(row => row.phone), [null, null]);
        if (!reopen) await db.close();
      }
      for (const phone of ['', '59912', '5999200010', '+995599920001', '322123456', '59992a001']) await assert.rejects(db.prepare('UPDATE driver_accounts SET phone=? WHERE driver_id=?').run(phone, 1), /check constraint|CHECK constraint/i);
      await db.prepare('UPDATE driver_accounts SET phone=? WHERE driver_id=?').run(DRIVER_PHONES[0], 1);
      await assert.rejects(db.prepare('UPDATE driver_accounts SET phone=? WHERE driver_id=?').run(DRIVER_PHONES[0], 2), /unique|duplicate/i);
    } finally { await db.close(); await stored.close(); }
  });
}

test('phone-only driver login accepts Georgian formatting aliases and rejects credentials, landlines and foreign numbers', async () => {
  await isolated(async f => {
    for (const phone of ['599920001', '599 92 00 01', '+995 599 92 00 01', '995599920001', '00995 (599) 92-00-01']) {
      const result = await f.request('/driver/auth/login', 'POST', { phone });
      assert.equal(result.status, 200); assert.equal(result.data.driver.id, 1); assert.equal(result.data.driver.phone, DRIVER_PHONES[0]);
    }
    assert.equal((await f.request('/driver/auth/login', 'POST', { phone: DRIVER_PHONES[0], login: 'driver_two' })).status, 400);
    assert.equal((await f.request('/driver/auth/login', 'POST', { login: 'operator', password: DRIVER_PASSWORD })).status, 400);
  });
  await isolated(async f => {
    for (const phone of ['', null, 599920001, {}, '59912', '+1 212 555 0101', '+995 322 12 34 56', '5'.repeat(41)]) {
      const result = await f.request('/driver/auth/login', 'POST', { phone });
      assert.equal(result.status, 400); assert.equal(result.data.code, 'VALIDATION');
    }
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_sessions').get())?.count, 0);
  });
  await isolated(async f => {
    for (const body of [null, [], true, 123, 'phone', undefined]) {
      assert.equal((await f.request('/driver/auth/login', 'POST', body)).status, 400);
      assert.equal((await f.request('/admin/drivers/3/phone', 'PATCH', body, 'employee')).status, 400);
    }
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_sessions').get())?.count, 0);
    assert.equal(await f.db.prepare('SELECT driver_id FROM driver_accounts WHERE driver_id=?').get(3), undefined);
  });
});

test('staff configures a phone for any existing roster driver without changing legacy accounts, staff access or daily plans', async () => {
  await isolated(async f => {
    const legacy = await f.db.prepare('SELECT login,password_hash,active,created_at FROM driver_accounts WHERE driver_id=?').get(1);
    const snapshot = new Map<string, string>();
    for (const table of ['drivers', 'driver_day_overrides', 'bookings', 'users', 'sessions']) snapshot.set(table, JSON.stringify(await f.db.prepare(`SELECT ${table === 'drivers' ? 'id,name,capacity,sort_order,deleted_at' : '*'} FROM ${table} ORDER BY 1`).all()));
    const roster = await successful(f, `/admin/drivers/schedule?direction=gori-tbilisi&date=${TODAY}`, 'GET', undefined, 'employee');
    assert.equal(roster.drivers.find((driver: any) => driver.id === 1).phone, DRIVER_PHONES[0]);
    assert.equal(roster.drivers.find((driver: any) => driver.id === 3).phone, null);
    const configured = await successful(f, '/admin/drivers/3/phone', 'PATCH', { phone: '+995 (555) 93-01-03' }, 'employee');
    assert.deepEqual(configured, { driverId: 3, phone: '555930103', revision: 2 });
    const newAccount = await f.db.prepare('SELECT login,password_hash,phone,active FROM driver_accounts WHERE driver_id=?').get(3);
    assert.equal(newAccount?.phone, '555930103'); assert.equal(newAccount?.active, 1);
    assert.match(newAccount!.login, /^phone_driver_3_[a-f0-9]{24}$/); assert.match(newAccount!.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    const login = await f.request('/driver/auth/login', 'POST', { phone: '555930103' }); assert.equal(login.status, 200); assert.equal(login.data.driver.id, 3);
    const savedRoster = await successful(f, `/admin/drivers/schedule?direction=gori-tbilisi&date=${TODAY}`, 'GET', undefined, 'employee');
    assert.equal(savedRoster.drivers.find((driver: any) => driver.id === 3).phone, '555930103');
    const empty = await successful(f, '/admin/drivers/4/phone', 'PATCH', { phone: null }, 'employee');
    assert.deepEqual(empty, { driverId: 4, phone: null, revision: 1 }); assert.equal(await f.db.prepare('SELECT driver_id FROM driver_accounts WHERE driver_id=?').get(4), undefined);
    assert.deepEqual(await f.db.prepare('SELECT login,password_hash,active,created_at FROM driver_accounts WHERE driver_id=?').get(1), legacy);
    for (const [table, value] of snapshot) assert.equal(JSON.stringify(await f.db.prepare(`SELECT ${table === 'drivers' ? 'id,name,capacity,sort_order,deleted_at' : '*'} FROM ${table} ORDER BY 1`).all()), value, table);
    const audit = await f.db.prepare("SELECT user_id,details FROM audit_log WHERE action='driver.phone' ORDER BY id DESC").get();
    assert.equal(audit?.user_id, 1); assert.deepEqual(JSON.parse(audit!.details), { driverId: 3, phoneConfigured: true });
    assert.equal(JSON.stringify((await f.request('/public/config')).data).includes('555930103'), false);
  });
});

test('phone updates require staff and reject invalid, duplicate or extra fields atomically including normalized aliases', async () => {
  await isolated(async f => {
    const driver = await f.login();
    const accountBefore = JSON.stringify(await f.db.prepare('SELECT * FROM driver_accounts ORDER BY driver_id').all());
    const sessionsBefore = JSON.stringify(await f.db.prepare('SELECT * FROM driver_sessions ORDER BY token_hash').all());
    const auditBefore = await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get();
    for (const actor of ['none', 'driver'] as const) assert.equal((await f.request('/admin/drivers/3/phone', 'PATCH', { phone: '555930103' }, actor)).status, 401);
    for (const body of [{}, { phone: 599920001 }, { phone: '+995 322 12 34 56' }, { phone: '+1 2125550101' }, { phone: 'bad' }, { phone: '555930103', active: 1 }, { phone: '555930103', driverId: 2 }]) {
      const result = await f.request('/admin/drivers/3/phone', 'PATCH', body, 'employee'); assert.equal(result.status, 400); assert.equal(result.data.code, 'VALIDATION');
    }
    for (const id of [2, 3]) {
      const result = await f.request(`/admin/drivers/${id}/phone`, 'PATCH', { phone: '+995 599 92 00 01' }, 'employee');
      assert.equal(result.status, 409); assert.equal(result.data.code, 'PHONE_TAKEN');
    }
    assert.equal((await f.request('/admin/drivers/99999/phone', 'PATCH', { phone: '555930103' }, 'employee')).status, 404);
    assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM driver_accounts ORDER BY driver_id').all()), accountBefore);
    assert.equal(JSON.stringify(await f.db.prepare('SELECT * FROM driver_sessions ORDER BY token_hash').all()), sessionsBefore);
    assert.deepEqual(await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), auditBefore);
    assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', { Cookie: driver.cookie })).data.driver.id, 1);
  });
});

test('changing or clearing a phone revokes only that driver sessions while an equivalent canonical save keeps them', async () => {
  await isolated(async f => {
    const first = await f.login(); const second = await f.login(); const other = await f.login(2);
    const legacy = await f.db.prepare('SELECT login,password_hash,active,created_at FROM driver_accounts WHERE driver_id=?').get(1);
    await successful(f, '/admin/drivers/1/phone', 'PATCH', { phone: '+995 599 92 00 01' }, 'employee');
    assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', { Cookie: first.cookie })).data.driver.id, 1);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_sessions WHERE driver_id=?').get(1))?.count, 2);
    await successful(f, '/admin/drivers/1/phone', 'PATCH', { phone: '555930111' }, 'employee');
    for (const cookie of [first.cookie, second.cookie]) assert.equal((await f.request('/driver/dashboard', 'GET', undefined, 'none', { Cookie: cookie })).status, 401);
    assert.equal((await f.request('/driver/auth/login', 'POST', { phone: DRIVER_PHONES[0] })).status, 401);
    const fresh = await f.request('/driver/auth/login', 'POST', { phone: '+995 555 93 01 11' }); assert.equal(fresh.status, 200);
    await successful(f, '/admin/drivers/1/phone', 'PATCH', { phone: '  ' }, 'employee');
    assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', { Cookie: cookieValue(fresh.headers.get('set-cookie')!) })).data.driver, null);
    assert.equal((await f.request('/driver/auth/login', 'POST', { phone: '555930111' })).status, 401);
    assert.deepEqual(await f.db.prepare('SELECT login,password_hash,active,created_at FROM driver_accounts WHERE driver_id=?').get(1), legacy);
    assert.equal((await f.db.prepare('SELECT phone FROM driver_accounts WHERE driver_id=?').get(1))?.phone, null);
    assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', { Cookie: other.cookie })).data.driver.id, 2);
    assert.equal((await f.request('/admin/settings', 'GET', undefined, 'employee')).status, 200);
  });
});

test('setting a phone does not reactivate an explicitly disabled existing driver account', async () => {
  await isolated(async f => {
    const loggedIn = await f.login(2);
    await f.db.prepare('UPDATE driver_accounts SET active=0 WHERE driver_id=?').run(2);
    await successful(f, '/admin/drivers/2/phone', 'PATCH', { phone: '555930112' }, 'employee');
    assert.equal((await f.db.prepare('SELECT active FROM driver_accounts WHERE driver_id=?').get(2))?.active, 0);
    assert.equal((await f.request('/driver/auth/login', 'POST', { phone: '555930112' })).status, 401);
    assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', { Cookie: loggedIn.cookie })).data.driver, null);
  });
});

test('legacy password-only session records cannot authorize phone login and are revoked when staff first configures the phone', async () => {
  await isolated(async f => {
    await createDriverAccount(f.db, { driverId: 3, login: 'legacy_three', password: DRIVER_PASSWORD });
    const raw = randomBytes(32).toString('hex');
    await f.db.prepare('INSERT INTO driver_sessions(token_hash,driver_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(raw).digest('hex'), 3, 1894060800000);
    const headers = { Cookie: `greentaxi_driver_session=${raw}` };
    assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', headers)).data.driver, null);
    assert.equal((await f.request('/driver/dashboard', 'GET', undefined, 'none', headers)).status, 401);
    assert.equal((await f.request('/driver/auth/login', 'POST', { login: 'legacy_three', password: DRIVER_PASSWORD })).status, 400);
    await successful(f, '/admin/drivers/3/phone', 'PATCH', { phone: '555930113' }, 'employee');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_sessions WHERE driver_id=?').get(3))?.count, 0);
    assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', headers)).data.driver, null);
    const login = await f.request('/driver/auth/login', 'POST', { phone: '555930113' }); assert.equal(login.status, 200); assert.equal(login.data.driver.id, 3);
  });
});

test('concurrent staff phone assignments keep a canonical number unique and leave the losing driver unchanged', async () => {
  await isolated(async f => {
    const results = await Promise.all([3, 4].map(id => f.request(`/admin/drivers/${id}/phone`, 'PATCH', { phone: id === 3 ? '555930114' : '+995 555 93 01 14' }, 'employee')));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(results.find(result => result.status === 409)?.data.code, 'PHONE_TAKEN');
    const accounts = await f.db.prepare('SELECT driver_id FROM driver_accounts WHERE phone=?').all('555930114');
    assert.equal(accounts.length, 1);
    const loser = results[0].status === 409 ? 3 : 4;
    assert.equal(await f.db.prepare('SELECT driver_id FROM driver_accounts WHERE driver_id=?').get(loser), undefined);
  });
});

async function driverVersion(f: Fixture, id: number) {
  return (await f.db.prepare('SELECT revision FROM drivers WHERE id=?').get(id))!.revision as number;
}
async function createDriver(f: Fixture, input: Record<string, unknown> = {}, key = `driver-create-${randomBytes(8).toString('hex')}`) {
  return f.request('/admin/drivers', 'POST', { name: 'ახალი მძღოლი', capacity: 6, ...input }, 'employee', { 'Idempotency-Key': key });
}

test('staff driver CRUD atomically normalizes contacts, preserves stable queue identities and revokes retired driver access', async () => {
  await isolated(async f => {
    const existing = JSON.stringify(await f.db.prepare('SELECT id,name,capacity,sort_order FROM drivers ORDER BY id').all());
    const created = await createDriver(f, { name: '  ახალი გიორგი  ', phone: '+995 (555) 94-00-44' });
    assert.equal(created.status, 201); assert.deepEqual(created.data.driver, { id: 44, name: 'ახალი გიორგი', capacity: 6, phone: '555940044', revision: 1 });
    const driver = created.data.driver;
    const loggedIn = await f.request('/driver/auth/login', 'POST', { phone: driver.phone }); assert.equal(loggedIn.status, 200);
    const oldCookie = cookieValue(loggedIn.headers.get('set-cookie')!);
    assert.equal((await f.request('/admin/drivers', 'POST', { name: 'Forbidden', capacity: 6 }, 'none', { Cookie: oldCookie, 'Idempotency-Key': 'forbidden-driver-create' })).status, 401);
    const updated = await successful(f, '/admin/drivers/44', 'PATCH', { name: 'ახალი გიორგი ორი', capacity: 8, phone: '555940045', expectedRevision: 1 }, 'employee');
    assert.deepEqual(updated.driver, { id: 44, name: 'ახალი გიორგი ორი', capacity: 8, phone: '555940045', revision: 2 });
    assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', { Cookie: oldCookie })).data.driver, null);
    assert.equal((await f.request('/driver/auth/login', 'POST', { phone: '555940044' })).status, 401);
    const fresh = await f.request('/driver/auth/login', 'POST', { phone: '555940045' }); assert.equal(fresh.status, 200);
    const freshCookie = cookieValue(fresh.headers.get('set-cookie')!);
    const account = await f.db.prepare('SELECT login,password_hash,created_at FROM driver_accounts WHERE driver_id=?').get(44);
    assert.equal((await f.request('/admin/drivers/44', 'DELETE', { expectedRevision: 2 }, 'employee')).status, 200);
    const archived = await f.db.prepare('SELECT * FROM drivers WHERE id=?').get(44);
    assert.ok(archived?.deleted_at); assert.equal(archived?.revision, 3); assert.equal(archived?.sort_order, 44);
    assert.equal((await f.request('/driver/auth/session', 'GET', undefined, 'none', { Cookie: freshCookie })).data.driver, null);
    assert.equal((await f.request('/driver/auth/login', 'POST', { phone: '555940045' })).status, 401);
    assert.deepEqual(await f.db.prepare('SELECT login,password_hash,created_at FROM driver_accounts WHERE driver_id=?').get(44), account);
    assert.deepEqual({ ...await f.db.prepare('SELECT phone,active FROM driver_accounts WHERE driver_id=?').get(44) }, { phone: null, active: 0 });
    for (const [path, body] of [['/admin/drivers/44/phone', { phone: '555940044' }], ['/admin/drivers/44/day', { direction: 'gori-tbilisi', date: TOMORROW, declined: false }]] as const) assert.equal((await f.request(path, 'PATCH', body, 'employee')).status, 404);
    assert.equal((await f.request('/admin/drivers/44', 'PATCH', { name: 'Ghost', capacity: 6, expectedRevision: 3 }, 'employee')).status, 404);
    const roster = await successful(f, `/admin/drivers/schedule?direction=gori-tbilisi&date=${TODAY}`, 'GET', undefined, 'employee');
    assert.equal(roster.drivers.some((row: any) => row.id === 44), false);
    assert.equal(JSON.stringify(await f.db.prepare('SELECT id,name,capacity,sort_order FROM drivers WHERE id<44 ORDER BY id').all()), existing);
    const replacement = await createDriver(f, { phone: '555940045' }); assert.equal(replacement.status, 201); assert.equal(replacement.data.driver.id, 45);
    assert.equal((await f.db.prepare('SELECT sort_order FROM drivers WHERE id=?').get(45))?.sort_order, 45);
    assert.equal((await f.request('/auth/session', 'GET', undefined, 'employee')).data.user.id, 1);
  });
});

test('driver CRUD keys replay committed changes once and stale or duplicate edits never partially mutate the roster', async () => {
  await isolated(async f => {
    const key = 'create-driver-stable-key'; const body = { phone: '555940046' };
    const created = await createDriver(f, body, key); assert.equal(created.status, 201);
    assert.deepEqual((await createDriver(f, body, key)).data, created.data);
    assert.equal((await createDriver(f, { phone: '555940047' }, key)).status, 409);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM drivers').get())?.count, 44);
    const snapshots = new Map<string, string>();
    for (const table of ['drivers', 'driver_accounts', 'driver_sessions', 'audit_log']) snapshots.set(table, JSON.stringify(await f.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
    const conflict = await f.request('/admin/drivers/44', 'PATCH', { name: 'Must rollback', capacity: 8, phone: `+995${DRIVER_PHONES[0]}`, expectedRevision: 1 }, 'employee');
    assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'PHONE_TAKEN');
    for (const [table, value] of snapshots) assert.equal(JSON.stringify(await f.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()), value, table);
    const editBody = { name: 'Saved once', capacity: 7, expectedRevision: 1 };
    const header = { 'Idempotency-Key': 'edit-driver-stable-key' };
    const edit = await f.request('/admin/drivers/44', 'PATCH', editBody, 'employee', header); assert.equal(edit.status, 200); assert.equal(edit.data.driver.revision, 2);
    assert.deepEqual((await f.request('/admin/drivers/44', 'PATCH', editBody, 'employee', header)).data, edit.data);
    assert.equal((await f.request('/admin/drivers/44', 'PATCH', { ...editBody, name: 'Stale browser' }, 'employee')).data.code, 'DRIVER_CHANGED');
    assert.equal((await f.request('/admin/drivers/44', 'DELETE', { expectedRevision: 1 }, 'employee')).data.code, 'DRIVER_CHANGED');
    const erase = () => f.request('/admin/drivers/44', 'DELETE', { expectedRevision: 2 }, 'employee', { 'Idempotency-Key': 'delete-driver-stable-key' });
    assert.equal((await erase()).status, 200); assert.equal((await erase()).status, 200);
    assert.equal((await f.request('/admin/drivers/44', 'DELETE', { expectedRevision: 2 }, 'employee')).status, 200);
    for (const action of ['driver.create', 'driver.edit', 'driver.delete']) assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE action=?').get(action))?.count, 1);
  });
});

test('driver creation and edits validate staff, fields and current revisions and serialize concurrent writers', async () => {
  await isolated(async f => {
    await f.login();
    for (const actor of ['none', 'driver'] as const) {
      assert.equal((await f.request('/admin/drivers', 'POST', { name: 'Test', capacity: 6 }, actor, { 'Idempotency-Key': 'forbidden-create-driver' })).status, 401);
      assert.equal((await f.request('/admin/drivers/3', 'PATCH', { name: 'Test', capacity: 6, expectedRevision: 1 }, actor)).status, 401);
      assert.equal((await f.request('/admin/drivers/3', 'DELETE', { expectedRevision: 1 }, actor)).status, 401);
    }
    assert.equal((await f.request('/admin/drivers', 'POST', { name: 'Test', capacity: 6 }, 'employee')).status, 400);
    for (const fields of [{ name: '' }, { name: 'A'.repeat(101) }, { capacity: 0 }, { capacity: 9 }, { capacity: 6.5 }, { capacity: '6' }, { phone: 'bad' }, { deleted_at: '2030' }, { name: 'bad\nname' }]) assert.equal((await createDriver(f, fields)).status, 400);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM drivers').get())?.count, 43);
    const responses = await Promise.all(['First', 'Second'].map(name => f.request('/admin/drivers/3', 'PATCH', { name, capacity: 7, expectedRevision: 1 }, 'employee')));
    assert.deepEqual(responses.map(row => row.status).sort(), [200, 409]);
    assert.equal((await driverVersion(f, 3)), 2);
    const phone = await successful(f, '/admin/drivers/3/phone', 'PATCH', { phone: '555940048' }, 'employee'); assert.equal(phone.revision, 3);
    assert.equal((await f.request('/admin/drivers/3', 'DELETE', { expectedRevision: 2 }, 'employee')).data.code, 'DRIVER_CHANGED');
  });
});

test('driver removal protects current and future trip assignments and whole-car reservations while allowing harmless renames', async () => {
  await isolated(async f => {
    await assign(f, 3);
    const assigned = await f.request('/admin/drivers/3', 'DELETE', { expectedRevision: 1 }, 'employee'); assert.equal(assigned.status, 409); assert.equal(assigned.data.code, 'DRIVER_ASSIGNED');
    const order = await whole(f, 1);
    const before = await f.db.prepare('SELECT * FROM bookings WHERE id=?').get(order.id);
    for (const capacity of [6, 8]) {
      const result = await f.request('/admin/drivers/1', 'PATCH', { name: 'Reserved car', capacity, expectedRevision: 2 }, 'employee'); assert.equal(result.status, 409); assert.equal(result.data.code, 'VEHICLE_RESERVED');
    }
    const deletion = await f.request('/admin/drivers/1', 'DELETE', { expectedRevision: 2 }, 'employee'); assert.equal(deletion.status, 409); assert.equal(deletion.data.code, 'VEHICLE_RESERVED');
    const rename = await f.request('/admin/drivers/1', 'PATCH', { name: 'Updated driver name', capacity: 7, expectedRevision: 2 }, 'employee'); assert.equal(rename.status, 200);
    assert.deepEqual(await f.db.prepare('SELECT * FROM bookings WHERE id=?').get(order.id), before);
    const options = await successful(f, `/admin/trips/whole-car-options?direction=gori-tbilisi&date=${TOMORROW}&time=08:30`, 'GET', undefined, 'employee');
    const oldChoice = options.drivers.find((row: any) => row.driverId === 4);
    assert.equal((await f.request('/admin/drivers/4', 'PATCH', { name: 'Changed picker label', capacity: 6, expectedRevision: 1 }, 'employee')).status, 200);
    const stale = await f.request('/admin/bookings', 'POST', bookingInput({ bookingType: 'whole_car', assignedVehicleKey: oldChoice.key, expectedVehicleRevision: oldChoice.revision }), 'employee');
    assert.equal(stale.status, 409); assert.equal(stale.data.code, 'TRIP_CHANGED');
  });
});

test('retiring a historical whole-car performer preserves bookings and does not block global schedule edits', async () => {
  await isolated(async f => {
    const order = await whole(f, 1); const snapshot = await f.db.prepare('SELECT * FROM bookings WHERE id=?').get(order.id);
    await f.login(); f.setNow('2030-01-03T00:00:00Z');
    const retired = await f.request('/admin/drivers/1', 'DELETE', { expectedRevision: 2 }, 'employee'); assert.equal(retired.status, 200);
    const settings = await f.request('/admin/schedule/base', 'PUT', { direction: 'gori-tbilisi', times: ['06:00', '08:30', '10:00'] }, 'employee'); assert.equal(settings.status, 200);
    assert.deepEqual(await f.db.prepare('SELECT * FROM bookings WHERE id=?').get(order.id), snapshot);
    assert.equal((await f.request('/driver/dashboard', 'GET', undefined, 'driver')).status, 401);
    assert.equal((await f.db.prepare('SELECT manual_time FROM driver_day_overrides WHERE driver_id=? AND date=?').get(1, TOMORROW))?.manual_time, '08:30');
  });
});

test('retiring the rotation anchor and every driver keeps queue projections usable and never reuses IDs', async () => {
  assert.equal(buildDriverSchedule('2026-10-19', [], INITIAL_DRIVER_ROSTER.filter(driver => driver.id !== 32)).firstDriverId, 31);
  assert.deepEqual(buildDriverSchedule('2026-10-19', ['08:30'], []).drivers, []);
  await isolated(async f => {
    const roster = await successful(f, `/admin/drivers/schedule?direction=gori-tbilisi&date=${TODAY}`, 'GET', undefined, 'employee');
    for (const driver of roster.drivers) assert.equal((await f.request(`/admin/drivers/${driver.id}`, 'DELETE', { expectedRevision: driver.revision }, 'employee')).status, 200);
    const empty = await successful(f, `/admin/drivers/schedule?direction=gori-tbilisi&date=${TODAY}`, 'GET', undefined, 'employee'); assert.equal(empty.firstDriverId, null); assert.deepEqual(empty.drivers, []);
    const capacity = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${TODAY}&time=08:30`, 'GET', undefined, 'employee'); assert.deepEqual(capacity.availableDrivers, []); assert.deepEqual(capacity.drivers, []);
    const options = await successful(f, `/admin/trips/whole-car-options?direction=gori-tbilisi&date=${TODAY}&time=08:30`, 'GET', undefined, 'employee'); assert.deepEqual(options.drivers, []);
    const created = await createDriver(f); assert.equal(created.status, 201); assert.equal(created.data.driver.id, 44);
  });
});

for (const dialect of ['sqlite', 'postgres'] as const) {
  test(`${dialect} driver management migration preserves every version-fifteen driver, account, session and order and runs once`, { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL }, async () => {
    const stored = await storage(dialect === 'postgres'); let db = await stored.open();
    try {
      await createDriverAccount(db, { driverId: 1, login: 'preserved_driver', password: DRIVER_PASSWORD });
      await db.prepare('UPDATE driver_accounts SET phone=? WHERE driver_id=?').run(DRIVER_PHONES[0], 1);
      await db.prepare('INSERT INTO driver_sessions(token_hash,driver_id,expires_at) VALUES (?,?,?)').run('c'.repeat(64), 1, 1894060800000);
      await db.prepare('INSERT INTO users(login,name,password_hash,created_at) VALUES (?,?,?,?)').run('preserved_staff', 'Employee', 'private-hash', '2030');
      await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run('private-staff-session', 1, 1894060800000);
      await db.prepare("INSERT INTO driver_day_overrides(driver_id,date,declined,assignment_mode,manual_time,updated_at) VALUES (1,?,0,'manual','08:30','2030')").run(TOMORROW);
      await db.exec('DROP TABLE call_device_heartbeats; DROP TABLE driver_trip_assignments; ALTER TABLE drivers DROP COLUMN deleted_at; ALTER TABLE drivers DROP COLUMN revision;');
      await db.prepare('DELETE FROM schema_versions WHERE version>=?').run(16);
      const snapshots = new Map<string, string>();
      const tables = ['drivers', 'driver_accounts', 'driver_sessions', 'users', 'sessions', 'settings', 'bookings', 'driver_day_overrides', 'audit_log', 'schema_versions'];
      for (const table of tables) snapshots.set(table, JSON.stringify(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
      await db.close();
      for (let pass = 0; pass < 2; pass++) {
        db = await stored.open();
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 18);
        for (const [table, snapshot] of snapshots) assert.equal(JSON.stringify(await db.prepare(`SELECT ${table === 'drivers' ? 'id,name,capacity,sort_order' : '*'} FROM ${table}${table === 'schema_versions' ? ' WHERE version<16' : ''} ORDER BY 1`).all()), snapshot, table);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM drivers WHERE deleted_at IS NULL AND revision=1').get())?.count, 43);
        if (!pass) await db.close();
      }
      await assert.rejects(db.prepare('UPDATE drivers SET revision=0 WHERE id=?').run(1), /check constraint|CHECK constraint/i);
    } finally { await db.close(); await stored.close(); }
  });
}
