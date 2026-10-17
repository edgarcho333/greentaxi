import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createDatabase, postgresPoolOptions } from '../server/database.js';
import { createDriverAccount, DriverAccountError, driverPasswordMatches, hashDriverPassword } from '../server/driver-accounts.js';
import { createApp } from '../server/index.js';

const TODAY = '2030-01-01';
const TOMORROW = '2030-01-02';
const DRIVER_PASSWORD = '2468';
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
  return {
    ...service, request, base, employeeCookie,
    setNow(value: string) { currentTime = new Date(value); },
    async login(index = 1) {
      const result = await request('/driver/auth/login', 'POST', { login: index === 1 ? 'operator' : 'driver_two', password: DRIVER_PASSWORD });
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
      await db.transaction(async () => { await db.exec('DROP TABLE driver_sessions; DROP TABLE driver_accounts;'); await db.prepare('DELETE FROM schema_versions WHERE version=?').run(14); });
      const snapshots = new Map<string, string>();
      for (const table of ['users', 'sessions', 'settings', 'stops', 'drivers', 'driver_day_overrides', 'base_schedule', 'date_schedule', 'bookings', 'audit_log', 'schema_versions']) snapshots.set(table, JSON.stringify(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
      await db.close();
      for (let reopen = 0; reopen < 2; reopen++) {
        db = await stored.open();
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 14);
        for (const [table, snapshot] of snapshots) assert.equal(JSON.stringify(await db.prepare(`SELECT * FROM ${table}${table === 'schema_versions' ? ' WHERE version<14' : ''} ORDER BY 1`).all()), snapshot);
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
    assert.deepEqual(added, { id: 3, name: 'გოჩა', login: 'new_driver', capacity: 8 });
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
    assert.deepEqual(login.data, { driver: { id: 1, login: 'operator', name: 'რეზო', capacity: 7 }, today: TODAY, tomorrow: TOMORROW });
    const header = login.headers.get('set-cookie')!;
    assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/); assert.match(header, /Path=\/api\/driver/);
    const raw = login.cookie.split('=')[1]; assert.match(raw, /^[a-f0-9]{64}$/);
    const session = await f.db.prepare('SELECT token_hash,driver_id FROM driver_sessions').get();
    assert.equal(session?.token_hash, createHash('sha256').update(raw).digest('hex')); assert.notEqual(session?.token_hash, raw);
    assert.equal(session?.driver_id, 1);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM sessions').get())?.count, 1);
    for (const credentials of [{ login: 'operator', password: 'wrong' }, { login: 'unknown', password: DRIVER_PASSWORD }, { login: 'operator', password: EMPLOYEE_PASSWORD }]) {
      const result = await f.request('/driver/auth/login', 'POST', credentials); assert.equal(result.status, 401); assert.equal(result.data.code, 'INVALID_LOGIN');
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
    assert.deepEqual(declined.days.find((day: any) => day.date === TOMORROW), { date: TOMORROW, working: false, assignedTime: null, assignmentActive: false });
    assert.equal((await f.db.prepare('SELECT manual_time FROM driver_day_overrides WHERE driver_id=? AND date=?').get(1, TOMORROW))?.manual_time, '08:30');
    const restored = await successful(f, '/driver/attendance', 'PATCH', { date: TOMORROW, working: true });
    assert.deepEqual(restored.days.find((day: any) => day.date === TOMORROW), { date: TOMORROW, working: true, assignedTime: '08:30', assignmentActive: true });
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

test('the driver dashboard exposes only active confirmed orders explicitly assigned to that driver and a restricted contact DTO', async () => {
  await isolated(async f => {
    await f.login();
    const canceled = await whole(f, 1); await successful(f, `/admin/bookings/${canceled.id}/delete`, 'POST', {}, 'employee');
    const own = await whole(f, 1, { callerPhone: '599999888', luggage: true, dog: true });
    const foreign = await whole(f, 2);
    const passenger = await successful(f, '/admin/bookings', 'POST', bookingInput(), 'employee');
    const parcel = await successful(f, '/admin/bookings', 'POST', bookingInput({ bookingType: 'parcel' }), 'employee');
    const waiting = await f.request('/bookings', 'POST', bookingInput()); assert.equal(waiting.status, 201);
    await f.db.prepare('UPDATE bookings SET requested_date=? WHERE id=?').run(TODAY, own.id);
    const dashboard = await successful(f, `/driver/dashboard?date=${TOMORROW}`);
    assert.equal(dashboard.driver.id, 1); assert.equal(dashboard.bookingScope, 'assigned');
    assert.deepEqual(dashboard.trip, { direction: 'gori-tbilisi', time: '08:30', active: true });
    assert.deepEqual(dashboard.bookings.map((booking: any) => booking.id), [own.id]);
    assert.deepEqual(Object.keys(dashboard.bookings[0]).sort(), ['id', 'name', 'phone', 'direction', 'seats', 'bookingType', 'luggage', 'dog', 'seatPreference', 'goriAddress', 'pickupStopName', 'didubeName', 'didubeAddress', 'date', 'time'].sort());
    assert.equal(dashboard.bookings[0].phone, '599111222'); assert.equal(dashboard.bookings[0].luggage, true); assert.equal(dashboard.bookings[0].dog, true);
    assert.equal(JSON.stringify(dashboard.bookings).includes('599999888'), false);
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
    assert.equal((await f.request('/driver/auth/login', 'POST', { login: 'operator', password: DRIVER_PASSWORD })).status, 401);
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
    assert.equal((await f.request('/driver/auth/login', 'POST', { login: 'operator', password: DRIVER_PASSWORD }, 'none', headers)).status, 403);
    assert.equal((await f.request('/driver/attendance', 'PATCH', { date: TODAY, working: false }, 'driver', headers)).status, 403);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM driver_day_overrides').get())?.count, 0);
  }, true);
});

test('driver login attempts use their own persistent rate limit without blocking staff login', async () => {
  await isolated(async f => {
    for (let attempt = 0; attempt < 10; attempt++) assert.equal((await f.request('/driver/auth/login', 'POST', { login: 'operator', password: 'wrong' })).status, 401);
    const limited = await f.request('/driver/auth/login', 'POST', { login: 'operator', password: DRIVER_PASSWORD });
    assert.equal(limited.status, 429); assert.ok(limited.headers.has('retry-after'));
    assert.equal((await f.request('/auth/login', 'POST', { login: 'operator', password: EMPLOYEE_PASSWORD })).status, 200);
  });
});
