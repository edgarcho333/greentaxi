import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/index.js';
import { createDatabase, postgresPoolOptions } from '../server/database.js';
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';

const DAY = '2030-01-02';
const PASSWORD = 'test-password-long';
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(options: { production?: boolean; setupToken?: string; now?: () => Date; setup?: boolean; deferPhoneMigration?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'greentaxi-api-'));
  const path = join(directory, 'test.sqlite');
  let schema: string | undefined;
  let databaseUrl: string | undefined;
  let administration: pg.Pool | undefined;
  if (process.env.TEST_DATABASE_URL) {
    schema = `greentaxi_test_${randomBytes(8).toString('hex')}`;
    administration = new pg.Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL));
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(process.env.TEST_DATABASE_URL);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connection.toString();
  }
  // The injected SQLite database lets transport-security tests exercise production cookies
  // without permitting a production deployment to silently fall back to a local file.
  const database = await createDatabase({ dbPath: path, databaseUrl, production: false });
  const service = await createApp({ database, now: () => new Date('2030-01-01T00:00:00Z'), deferPhoneMigration: false, ...options });
  const server = await new Promise<Server>(resolve => {
    const listener = service.app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function request(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}, authenticated = true) {
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(authenticated && cookie ? { Cookie: cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json() as any;
    return { status: response.status, data, headers: response.headers };
  }
  async function setup(token?: string) {
    const response = await request('/auth/setup', 'POST', { name: 'ტესტ ოპერატორი', login: 'operator', password: PASSWORD, ...(token ? { setupToken: token } : {}) });
    assert.equal(response.status, 201);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
    return response;
  }
  if (options.setup !== false) await setup(options.setupToken);
  return {
    ...service, server, path, directory, databaseUrl, request, setup, base,
    async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await service.close(); if (administration && schema) { await administration.query(`DROP SCHEMA "${schema}" CASCADE`); await administration.end(); } rmSync(directory, { recursive: true, force: true }); },
  };
}
function input(overrides: Record<string, unknown> = {}) {
  return { name: 'ნინო ტესტი', phone: '599 12 34 56', seats: 2, direction: 'gori-tbilisi', requestedDate: DAY, requestedTime: '08:30', goriAddress: 'გორი, სატესტო ქუჩა 12', ...overrides };
}
async function successful(f: Fixture, path: string, method = 'GET', body?: unknown, extra?: Record<string, string>) {
  const response = await f.request(path, method, body, extra);
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${path} returned ${response.status}: ${response.data.error ?? ''}`);
  return response.data;
}

let f: Fixture;
before(async () => { f = await fixture(); });
after(async () => { await f.close(); });

test('a public request remains unassigned until confirmation and repeated confirmation does not duplicate it', async () => {
  const response = await f.request('/bookings', 'POST', input(), {}, false);
  assert.equal(response.status, 201);
  const id = response.data.id;
  const queue = await successful(f, '/admin/bookings?scope=incoming');
  const waiting = queue.bookings.find((row: any) => row.id === id);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.assignedDate, null);
  assert.equal(waiting.requestedTime, '08:30');
  assert.equal(waiting.phone, '599123456');
  const selected = { date: DAY, time: '09:30' };
  const confirmed = await successful(f, `/admin/bookings/${id}/confirm`, 'POST', selected);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.assignedTime, '09:30');
  assert.equal(confirmed.requestedTime, '08:30');
  const again = await successful(f, `/admin/bookings/${id}/confirm`, 'POST', selected);
  assert.equal(again.id, id);
  const list = await successful(f, `/admin/bookings?scope=scheduled&date=${DAY}&time=09:30`);
  assert.equal(list.bookings.filter((row: any) => row.id === id).length, 1);
  assert.equal((await successful(f, '/admin/bookings?scope=incoming')).bookings.some((row: any) => row.id === id), false);
  const conflict = await f.request(`/admin/bookings/${id}/confirm`, 'POST', { date: DAY, time: '10:00' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'ALREADY_CONFIRMED');
  const audit = (await f.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE booking_id=? AND action='confirm'").get(id)) as { count: number };
  assert.equal(audit.count, 1);
});

test('both directions have 18 daily times including the two half-hour departures', async () => {
  for (const d of ['gori-tbilisi', 'tbilisi-gori']) {
    const response = await f.request(`/public/slots?direction=${d}&date=2030-01-10`, 'GET', undefined, {}, false);
    assert.equal(response.status, 200);
    const slots = response.data.slots;
    assert.equal(slots.length, 18);
    assert.ok(slots.some((row: any) => row.time === '08:30'));
    assert.ok(slots.some((row: any) => row.time === '09:30'));
    assert.equal(slots[0].time, '06:00');
    assert.equal(slots.at(-1).time, '21:00');
  }
});

test('places are bounded per order while the number and seats of orders in a slot have no capacity limit', async () => {
  for (const seats of [0, 5, 1.5, '2']) {
    const invalid = await f.request('/bookings', 'POST', input({ seats }), {}, false);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.code, 'VALIDATION');
  }
  for (let i = 0; i < 8; i++) {
    const created = await successful(f, '/admin/bookings', 'POST', input({ seats: 4, requestedTime: '11:00', phone: `5990000${String(i).padStart(2, '0')}` }));
    assert.equal(created.status, 'confirmed');
    assert.equal(created.seats, 4);
  }
  const schedule = await successful(f, `/admin/schedule?direction=gori-tbilisi&date=${DAY}`);
  const slot = schedule.slots.find((row: any) => row.time === '11:00');
  assert.equal(slot.bookingCount, 8);
  assert.equal(slot.seatCount, 32);
});

test('idempotency protects public double-submit and rejects reusing a key with different fields', async () => {
  const headers = { 'Idempotency-Key': 'public-test-double-submit' };
  const [first, second] = await Promise.all([
    f.request('/bookings', 'POST', input({ name: 'იდემპოტენტური ტესტი' }), headers, false),
    f.request('/bookings', 'POST', input({ name: 'იდემპოტენტური ტესტი' }), headers, false),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.data.id, second.data.id);
  const rows = (await successful(f, '/admin/bookings?scope=incoming&search=' + encodeURIComponent('იდემპოტენტური ტესტი'))).bookings;
  assert.equal(rows.length, 1);
  const conflicting = await f.request('/bookings', 'POST', input({ seats: 3 }), headers, false);
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.data.code, 'IDEMPOTENCY_CONFLICT');
  const adminHeaders = { 'Idempotency-Key': 'admin-test-double-submit' };
  const adminFirst = await successful(f, '/admin/bookings', 'POST', input(), adminHeaders);
  const adminSecond = await successful(f, '/admin/bookings', 'POST', input(), adminHeaders);
  assert.equal(adminFirst.id, adminSecond.id);
});

test('a dated override preserves occupied disabled slots and restoring one requires an active replacement', async () => {
  const day = '2030-01-03';
  const created = await successful(f, '/admin/bookings', 'POST', input({ requestedDate: day, requestedTime: '08:30' }));
  await successful(f, '/admin/schedule/date', 'PUT', { direction: 'gori-tbilisi', date: day, times: ['09:00', '12:00'] });
  const schedule = await successful(f, `/admin/schedule?direction=gori-tbilisi&date=${day}`);
  assert.deepEqual(schedule.overrideTimes, ['09:00', '12:00']);
  assert.deepEqual(schedule.slots.find((row: any) => row.time === '08:30'), { time: '08:30', active: false, bookingCount: 1, seatCount: 2 });
  const publicSlots = (await f.request(`/public/slots?direction=gori-tbilisi&date=${day}`)).data.slots;
  assert.deepEqual(publicSlots.map((row: any) => row.time), ['09:00', '12:00']);
  assert.equal((await successful(f, `/admin/schedule?direction=gori-tbilisi&date=2030-01-12`)).slots.length, 18);
  assert.equal((await successful(f, `/admin/schedule?direction=tbilisi-gori&date=${day}`)).slots.length, 18);
  const deleted = await successful(f, `/admin/bookings/${created.id}/delete`, 'POST', {});
  assert.ok(deleted.deletedAt);
  assert.equal(deleted.assignedTime, '08:30');
  const rejected = await f.request(`/admin/bookings/${created.id}/restore`, 'POST', {});
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.code, 'SLOT_INACTIVE');
  const history = await successful(f, '/admin/bookings?scope=deleted');
  assert.ok(history.bookings.some((row: any) => row.id === created.id));
  const restored = await successful(f, `/admin/bookings/${created.id}/restore`, 'POST', { date: day, time: '12:00' });
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.assignedTime, '12:00');
  assert.equal(restored.status, 'confirmed');
  assert.equal(restored.name, created.name);
  await successful(f, `/admin/schedule/date?direction=gori-tbilisi&date=${day}`, 'DELETE');
  assert.equal((await successful(f, `/admin/schedule?direction=gori-tbilisi&date=${day}`)).overrideTimes, null);
});

test('base schedules can be changed independently and a dated override retains precedence', async () => {
  const fresh = await fixture();
  try {
    await successful(fresh, '/admin/schedule/date', 'PUT', { direction: 'tbilisi-gori', date: DAY, times: ['08:30'] });
    await successful(fresh, '/admin/schedule/base', 'PUT', { direction: 'tbilisi-gori', times: ['07:00', '09:30', '22:15'] });
    const override = await successful(fresh, `/admin/schedule?direction=tbilisi-gori&date=${DAY}`);
    assert.deepEqual(override.baseTimes, ['07:00', '09:30', '22:15']);
    assert.deepEqual(override.slots.map((row: any) => row.time), ['08:30']);
    const otherDate = await successful(fresh, '/admin/schedule?direction=tbilisi-gori&date=2030-01-03');
    assert.deepEqual(otherDate.slots.map((row: any) => row.time), ['07:00', '09:30', '22:15']);
    assert.equal((await successful(fresh, `/admin/schedule?direction=gori-tbilisi&date=${DAY}`)).slots.length, 18);
  } finally { await fresh.close(); }
});

test('editing and moving preserve confirmation; restoring a waiting request returns it to the queue', async () => {
  const created = await successful(f, '/admin/bookings', 'POST', input({ seats: 1 }));
  const edited = await successful(f, `/admin/bookings/${created.id}`, 'PATCH', { seats: 4, goriAddress: 'გორი, ახალი სატესტო მისამართი' });
  assert.equal(edited.seats, 4);
  const moved = await successful(f, `/admin/bookings/${created.id}/move`, 'POST', { date: DAY, time: '14:00' });
  assert.equal(moved.status, 'confirmed');
  assert.equal(moved.assignedTime, '14:00');
  assert.equal(moved.requestedTime, '08:30');
  const publicBooking = await f.request('/bookings', 'POST', input(), {}, false);
  const id = publicBooking.data.id;
  await successful(f, `/admin/bookings/${id}/delete`, 'POST', {});
  const restored = await successful(f, `/admin/bookings/${id}/restore`, 'POST', {});
  assert.equal(restored.status, 'waiting');
  assert.equal(restored.assignedDate, null);
  assert.equal(restored.assignedTime, null);
  assert.ok((await successful(f, '/admin/bookings?scope=incoming')).bookings.some((row: any) => row.id === id));
});

test('pickup stops and the Didube destination are configurable; inactive stops cannot receive new requests', async () => {
  const demo = await successful(f, '/public/config');
  assert.equal(demo.stops.length, 3);
  assert.ok(demo.stops.every((row: any) => row.name.includes('სატესტო')));
  assert.ok(demo.didubeName.includes('სატესტო'));
  const noStop = await f.request('/bookings', 'POST', input({ direction: 'tbilisi-gori' }), {}, false);
  assert.equal(noStop.status, 400);
  const added = await successful(f, '/admin/stops', 'POST', { name: 'ახალი სატესტო გაჩერება', address: 'თბილისი, სატესტო მისამართი 1' });
  const original = await successful(f, '/admin/bookings', 'POST', input({ direction: 'tbilisi-gori', pickupStopId: added.id }));
  const historicalDestination = await successful(f, '/admin/bookings', 'POST', input());
  await successful(f, `/admin/stops/${added.id}`, 'PATCH', { active: false, name: 'შეცვლილი სატესტო გაჩერება' });
  const config = await successful(f, '/public/config');
  assert.equal(config.stops.some((row: any) => row.id === added.id), false);
  assert.equal((await successful(f, '/admin/stops')).stops.find((row: any) => row.id === added.id).active, false);
  const invalid = await f.request('/bookings', 'POST', input({ direction: 'tbilisi-gori', pickupStopId: added.id }), {}, false);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'STOP_INACTIVE');
  const edited = await successful(f, `/admin/bookings/${original.id}`, 'PATCH', { seats: 3 });
  assert.equal(edited.pickupStopName, 'ახალი სატესტო გაჩერება');
  await successful(f, '/admin/settings', 'PUT', { didubeName: 'დიდუბე — ახალი სატესტო წერტილი', didubeAddress: 'დიდუბე, სატესტო მისამართი 7' });
  assert.equal((await successful(f, '/public/config')).didubeAddress, 'დიდუბე, სატესტო მისამართი 7');
  const history = await successful(f, `/admin/bookings/${historicalDestination.id}/delete`, 'POST', {});
  assert.equal(history.didubeName, demo.didubeName);
  assert.equal(history.didubeAddress, demo.didubeAddress);
});

test('public future-slot validation uses Tbilisi time and rejects malformed input', async () => {
  const fresh = await fixture({ now: () => new Date('2030-01-01T04:45:00Z') });
  try {
    const slots = await successful(fresh, '/public/slots?direction=gori-tbilisi&date=2030-01-01');
    assert.equal(slots.slots.some((row: any) => row.time === '08:30'), false);
    assert.equal(slots.slots[0].time, '09:00');
    for (const overrides of [{ requestedDate: '2030-01-01', requestedTime: '08:30' }, { requestedDate: '2029-12-31' }, { requestedDate: '2030-02-31' }, { requestedTime: '08:15' }, { phone: 'not-a-phone' }, { goriAddress: '' }]) {
      const rejected = await fresh.request('/bookings', 'POST', input(overrides), {}, false);
      assert.ok(rejected.status >= 400 && rejected.status < 500);
    }
  } finally { await fresh.close(); }
});

test('historical confirmation retries and untouched restorations preserve their original slots while new assignments must be future', async () => {
  let clock = new Date('2030-01-01T00:00:00Z');
  const fresh = await fixture({ now: () => clock });
  try {
    const past = await fresh.request('/admin/bookings', 'POST', input({ requestedDate: '2029-12-31' }));
    assert.equal(past.status, 400);
    assert.equal(past.data.code, 'DATE_OUT_OF_RANGE');
    const publicPast = await fresh.request('/bookings', 'POST', input({ requestedDate: '2029-12-31' }), {}, false);
    assert.equal(publicPast.status, 400);
    assert.equal(publicPast.data.code, 'SLOT_PAST');
    const created = await successful(fresh, '/admin/bookings', 'POST', input());
    const historicalEdit = await successful(fresh, '/admin/bookings', 'POST', input({ name: 'შესანარჩუნებელი სახელი' }));
    await successful(fresh, `/admin/bookings/${created.id}/delete`, 'POST', {});
    clock = new Date('2030-01-03T00:00:00Z');
    const repeat = await successful(fresh, `/admin/bookings/${historicalEdit.id}/confirm`, 'POST', { date: DAY, time: '08:30' });
    assert.equal(repeat.id, historicalEdit.id);
    const edited = await successful(fresh, `/admin/bookings/${historicalEdit.id}`, 'PATCH', { seats: 8 });
    assert.equal(edited.name, 'შესანარჩუნებელი სახელი');
    assert.equal(edited.seats, 8);
    const explicitPast = await fresh.request(`/admin/bookings/${created.id}/restore`, 'POST', { date: DAY, time: '08:30' });
    assert.equal(explicitPast.status, 400);
    assert.equal(explicitPast.data.code, 'DATE_OUT_OF_RANGE');
    assert.ok((await fresh.db.prepare('SELECT deleted_at FROM bookings WHERE id=?').get(created.id))!.deleted_at);
    const oldRestore = await fresh.request(`/admin/bookings/${created.id}/restore`, 'POST', {});
    assert.equal(oldRestore.status, 200);
    assert.equal(oldRestore.data.assignedDate, DAY);
    assert.equal(oldRestore.data.status, 'confirmed');
  } finally { await fresh.close(); }
});

test('operator orders accept eight seats and optional names while edits and trusted profiles preserve names when omitted', async () => {
  const fresh = await fixture();
  try {
    const existing = await successful(fresh, '/admin/bookings', 'POST', input({ name: 'არსებული სანდო სახელი', phone: '568694879' }));
    const unnamed = await successful(fresh, '/admin/bookings', 'POST', input({ name: undefined, phone: '568694879', seats: 8 }));
    assert.equal(unnamed.name, '');
    assert.equal(unnamed.seats, 8);
    assert.equal((await successful(fresh, '/admin/passengers/profile?phone=568694879')).profile.name, existing.name);
    const edited = await successful(fresh, `/admin/bookings/${existing.id}`, 'PATCH', { seats: 8, goriAddress: 'გორი, განახლებული მისამართი' });
    assert.equal(edited.name, existing.name);
    assert.equal(edited.seats, 8);
    const cleared = await successful(fresh, `/admin/bookings/${existing.id}`, 'PATCH', { name: '' });
    assert.equal(cleared.name, '');
    assert.equal((await successful(fresh, '/admin/passengers/profile?phone=568694879')).profile.name, existing.name);
    for (const seats of [0, 9, 1.5, '8']) {
      assert.equal((await fresh.request('/admin/bookings', 'POST', input({ name: undefined, seats }))).status, 400);
      assert.equal((await fresh.request(`/admin/bookings/${existing.id}`, 'PATCH', { seats })).status, 400);
    }
    for (const fields of [{ name: undefined }, { name: '' }, { seats: 5 }, { seats: 8 }]) {
      const response = await fresh.request('/bookings', 'POST', input(fields), {}, false);
      assert.equal(response.status, 400);
      assert.equal(response.data.code, 'VALIDATION');
    }
    const publicFour = await fresh.request('/bookings', 'POST', input({ seats: 4, requestedDate: '2030-01-20' }), {}, false);
    assert.equal(publicFour.status, 201);
    const slot = (await successful(fresh, `/admin/schedule?direction=gori-tbilisi&date=${DAY}`)).slots.find((item: any) => item.time === '08:30');
    assert.equal(slot.bookingCount, 2);
    assert.equal(slot.seatCount, 16);
  } finally { await fresh.close(); }
});

test('the operator calendar rolls at Tbilisi midnight and spans month boundaries using three local calendar days', async () => {
  let clock = new Date('2030-01-01T19:59:59Z'); // Tbilisi is still January 1.
  const fresh = await fixture({ now: () => clock });
  try {
    await successful(fresh, '/admin/bookings', 'POST', input({ name: undefined, requestedDate: '2030-01-03', requestedTime: '06:00' }));
    assert.equal((await fresh.request('/admin/bookings', 'POST', input({ requestedDate: '2030-01-04' }))).data.code, 'DATE_OUT_OF_RANGE');
    clock = new Date('2030-01-01T20:00:00Z'); // January 2 locally, although UTC is January 1.
    for (const day of ['2030-01-02', '2030-01-03', '2030-01-04']) {
      await successful(fresh, '/admin/bookings', 'POST', input({ name: undefined, requestedDate: day, requestedTime: '06:00' }));
    }
    for (const day of ['2030-01-01', '2030-01-05']) {
      const rejected = await fresh.request('/admin/bookings', 'POST', input({ requestedDate: day }));
      assert.equal(rejected.status, 400);
      assert.equal(rejected.data.code, 'DATE_OUT_OF_RANGE');
    }
  } finally { await fresh.close(); }
  const leap = await fixture({ now: () => new Date('2032-02-28T20:00:00Z') }); // February 29 locally, in a leap year.
  try {
    for (const day of ['2032-02-29', '2032-03-01', '2032-03-02']) {
      await successful(leap, '/admin/bookings', 'POST', input({ requestedDate: day, requestedTime: '06:00' }));
    }
    assert.equal((await leap.request('/admin/bookings', 'POST', input({ requestedDate: '2032-03-03' }))).data.code, 'DATE_OUT_OF_RANGE');
    for (const requestedDate of [undefined, null, '2032-02-30', '2032-2-29']) {
      const rejected = await leap.request('/admin/bookings', 'POST', input({ requestedDate }));
      assert.equal(rejected.status, 400);
      assert.equal(rejected.data.code, 'DATE_INVALID');
    }
  } finally { await leap.close(); }
});

test('every new operator assignment rejects elapsed times and distant dates without changing incoming or deleted orders', async () => {
  const fresh = await fixture({ now: () => new Date('2030-01-01T04:30:00Z') }); // Exactly 08:30 in Tbilisi.
  try {
    const today = '2030-01-01';
    for (const requestedTime of ['08:00', '08:30']) {
      const rejected = await fresh.request('/admin/bookings', 'POST', input({ name: undefined, requestedDate: today, requestedTime }));
      assert.equal(rejected.status, 400);
      assert.equal(rejected.data.code, 'SLOT_PAST');
    }
    const waiting = await successful(fresh, '/bookings', 'POST', input(), undefined);
    const original = await successful(fresh, '/admin/bookings', 'POST', input());
    await successful(fresh, `/admin/bookings/${original.id}/delete`, 'POST', {});
    for (const [date, time, code] of [[today, '08:30', 'SLOT_PAST'], ['2030-01-04', '09:00', 'DATE_OUT_OF_RANGE'], ['2030-02-31', '09:00', 'DATE_INVALID']]) {
      for (const [id, action] of [[waiting.id, 'confirm'], [original.id, 'restore']]) {
        const rejected = await fresh.request(`/admin/bookings/${id}/${action}`, 'POST', { date, time });
        assert.equal(rejected.status, 400);
        assert.equal(rejected.data.code, code);
      }
    }
    const waitingRow = (await fresh.db.prepare('SELECT status,assigned_date,assigned_time FROM bookings WHERE id=?').get(waiting.id))!;
    assert.equal(waitingRow.status, 'waiting');
    assert.equal(waitingRow.assigned_date, null);
    assert.equal(waitingRow.assigned_time, null);
    assert.ok((await fresh.db.prepare('SELECT deleted_at FROM bookings WHERE id=?').get(original.id))!.deleted_at);
    await successful(fresh, `/admin/bookings/${original.id}/restore`, 'POST', {});
    for (const [date, time, code] of [[today, '08:30', 'SLOT_PAST'], ['2030-01-04', '09:00', 'DATE_OUT_OF_RANGE']]) {
      const rejected = await fresh.request(`/admin/bookings/${original.id}/move`, 'POST', { date, time });
      assert.equal(rejected.data.code, code);
    }
    const unchanged = await successful(fresh, `/admin/bookings?scope=scheduled&date=${DAY}`);
    assert.equal(unchanged.bookings.find((row: any) => row.id === original.id).assignedTime, '08:30');
    const future = await successful(fresh, '/admin/bookings', 'POST', input({ requestedDate: today, requestedTime: '09:00' }));
    assert.equal(future.assignedTime, '09:00');
    const tomorrowSlots = (await successful(fresh, `/public/slots?direction=gori-tbilisi&date=${DAY}`)).slots;
    assert.equal(tomorrowSlots.length, 18);
    assert.equal(tomorrowSlots[0].time, '06:00');
    const inactive = await fresh.request('/admin/bookings', 'POST', input({ requestedTime: '08:15' }));
    assert.equal(inactive.status, 409);
    assert.equal(inactive.data.code, 'SLOT_INACTIVE');
  } finally { await fresh.close(); }
});

test('admin endpoints require opaque HttpOnly sessions, logout revokes them, and all employees share access', async () => {
  const fresh = await fixture({ setup: false });
  try {
    const session = await fresh.request('/auth/session');
    assert.deepEqual(session.data, { user: null, needsSetup: true, requiresSetupToken: false });
    assert.equal((await fresh.request('/admin/bookings')).status, 401);
    const setup = await fresh.setup();
    assert.match(setup.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(setup.headers.get('set-cookie')!, /SameSite=Lax/);
    assert.equal((await fresh.request('/auth/session')).data.user.login, 'operator');
    const storedUser = (await fresh.db.prepare('SELECT password_hash FROM users').get()) as { password_hash: string };
    assert.ok(storedUser.password_hash !== PASSWORD);
    const storedSession = (await fresh.db.prepare('SELECT token_hash FROM sessions').get()) as { token_hash: string };
    assert.ok(!setup.headers.get('set-cookie')!.includes(storedSession.token_hash));
    assert.equal((await fresh.request('/auth/setup', 'POST', { login: 'other', name: 'მეორე ოპერატორი', password: PASSWORD })).status, 409);
    const staff = await successful(fresh, '/admin/staff', 'POST', { login: 'second', name: 'მეორე ოპერატორი', password: PASSWORD });
    assert.equal(staff.login, 'second');
    assert.equal((await successful(fresh, '/admin/staff')).users.length, 2);
    await successful(fresh, '/auth/logout', 'POST');
    assert.equal((await fresh.request('/admin/settings')).status, 401);
    const denied = await fresh.request('/auth/login', 'POST', { login: 'operator', password: 'incorrect-password' });
    assert.equal(denied.status, 401);
    const loggedIn = await fresh.request('/auth/login', 'POST', { login: 'second', password: PASSWORD });
    assert.equal(loggedIn.status, 200);
    const secondCookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
    const canManage = await fresh.request('/admin/settings', 'PUT', { didubeName: 'დიდუბე — სატესტო ადგილი', didubeAddress: 'სატესტო მისამართი 12' }, { Cookie: secondCookie });
    assert.equal(canManage.status, 200);
  } finally { await fresh.close(); }
});

test('production first-user creation requires a setup token and mutation origins are checked', async () => {
  const fresh = await fixture({ setup: false, production: true, setupToken: 'test-only-setup-token' });
  try {
    assert.equal((await fresh.request('/auth/session')).data.requiresSetupToken, true);
    const missing = await fresh.request('/auth/setup', 'POST', { name: 'ტესტ ოპერატორი', login: 'operator', password: PASSWORD });
    assert.equal(missing.status, 403);
    assert.equal(missing.data.code, 'SETUP_TOKEN');
    const badOrigin = await fresh.request('/bookings', 'POST', input(), { Origin: 'https://unrelated.example' }, false);
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.data.code, 'ORIGIN');
    const setup = await fresh.setup('test-only-setup-token');
    assert.match(setup.headers.get('set-cookie')!, /Secure/);
    const matching = await fresh.request('/bookings', 'POST', input(), { Origin: fresh.base }, false);
    assert.equal(matching.status, 201);
  } finally { await fresh.close(); }
});

test('persistent database data survives reopening and analytics and passenger queries respect deletion', async () => {
  const fresh = await fixture();
  try {
    const original = await successful(fresh, '/admin/bookings', 'POST', input({ phone: '+995599888777', seats: 4 }));
    const waiting = await fresh.request('/bookings', 'POST', input({ phone: '599888777', seats: 2 }), {}, false);
    const deleted = await successful(fresh, '/admin/bookings', 'POST', input({ phone: '+995599888777', seats: 1 }));
    await successful(fresh, `/admin/bookings/${deleted.id}/delete`, 'POST', {});
    const reopened = await createApp({ dbPath: fresh.path, databaseUrl: fresh.databaseUrl });
    try {
      const rows = (await reopened.db.prepare('SELECT * FROM bookings').all());
      assert.equal(rows.length, 3);
      assert.equal(((await reopened.db.prepare('SELECT status FROM bookings WHERE id=?').get(original.id)) as { status: string }).status, 'confirmed');
      assert.equal(((await reopened.db.prepare('SELECT status FROM bookings WHERE id=?').get(waiting.data.id)) as { status: string }).status, 'waiting');
      assert.equal(((await reopened.db.prepare('SELECT COUNT(*) AS count FROM users').get()) as { count: number }).count, 1);
    } finally { await reopened.close(); }
    const passengers = await successful(fresh, '/admin/passengers?search=599888777');
    assert.equal(passengers.passengers.length, 1);
    assert.equal(passengers.passengers[0].orderCount, 2);
    assert.equal(passengers.passengers[0].seats, 6);
    const analytics = await successful(fresh, `/admin/analytics?from=${DAY}&to=${DAY}`);
    assert.deepEqual(analytics.totals, { incoming: 1, confirmed: 1, deleted: 1, seats: 6 });
  } finally { await fresh.close(); }
});

function callEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { eventId: 'android-call-1001', phone: '+995599123456', occurredAt: '2030-01-01T10:20:30+04:00', durationSeconds: 15, kind: 'incoming', ...overrides };
}

test('Android connection checks authenticate the own active device without creating inquiries or changing lastSeen or audit', async () => {
  const fresh = await fixture();
  try {
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'Redmi კავშირის ტესტი' });
    await successful(fresh, '/admin/devices', 'POST', { name: 'სხვა ტელეფონი' });
    const before = await fresh.db.prepare('SELECT * FROM call_devices ORDER BY id').all();
    const auditBefore = await fresh.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get();
    for (const authorization of [undefined, 'Bearer invalid', `Bearer gtdevice_${'1'.repeat(64)}`]) {
      const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
      const denied = await fresh.request('/integrations/android/connection', 'GET', undefined, headers, false);
      assert.equal(denied.status, 401);
      assert.equal(denied.data.code, 'DEVICE_UNAUTHORIZED');
    }
    const bearer = { Authorization: `Bearer ${paired.token}` };
    const connected = await fresh.request('/integrations/android/connection', 'GET', undefined, bearer, false);
    assert.equal(connected.status, 200);
    assert.deepEqual(connected.data, { connected: true, device: { id: paired.device.id, name: paired.device.name } });
    assert.deepEqual(await fresh.db.prepare('SELECT * FROM call_devices ORDER BY id').all(), before);
    assert.deepEqual(await fresh.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), auditBefore);
    assert.equal((await successful(fresh, '/admin/calls')).calls.length, 0);
    assert.equal(((await fresh.db.prepare('SELECT COUNT(*) AS count FROM bookings').get()) as { count: number }).count, 0);
    await successful(fresh, `/admin/devices/${paired.device.id}`, 'PATCH', { active: false });
    const revoked = await fresh.request('/integrations/android/connection', 'GET', undefined, bearer, false);
    assert.equal(revoked.status, 401);
    assert.equal(revoked.data.code, 'DEVICE_UNAUTHORIZED');
  } finally { await fresh.close(); }
});

test('Android device tokens are hashed, expose no staff access, update lastSeen, and stop working after revocation', async () => {
  const fresh = await fixture();
  try {
    const initial = await successful(fresh, '/admin/devices');
    assert.equal(initial.devices.length, 0);
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'Redmi სატესტო ტელეფონი' });
    assert.ok(/^gtdevice_[a-f0-9]{64}$/.test(paired.token));
    assert.equal(paired.device.active, true);
    assert.equal(paired.device.lastSeenAt, null);
    const stored = (await fresh.db.prepare('SELECT token_hash FROM call_devices WHERE id=?').get(paired.device.id)) as { token_hash: string };
    assert.ok(stored.token_hash !== paired.token);
    const listed = await successful(fresh, '/admin/devices');
    assert.equal('token' in listed.devices[0], false);
    assert.equal('token_hash' in listed.devices[0], false);
    const unauthorized = await fresh.request('/integrations/android/calls', 'POST', callEvent(), {}, false);
    assert.equal(unauthorized.status, 401);
    const bad = await fresh.request('/integrations/android/calls', 'POST', callEvent(), { Authorization: `Bearer gtdevice_${'1'.repeat(64)}` }, false);
    assert.equal(bad.status, 401);
    const bearer = { Authorization: `Bearer ${paired.token}` };
    assert.equal((await fresh.request('/admin/bookings', 'GET', undefined, bearer, false)).status, 401);
    const received = await fresh.request('/integrations/android/calls', 'POST', callEvent(), bearer, false);
    assert.equal(received.status, 201);
    assert.ok((await successful(fresh, '/admin/devices')).devices[0].lastSeenAt);
    const revoked = await successful(fresh, `/admin/devices/${paired.device.id}`, 'PATCH', { active: false });
    assert.equal(revoked.active, false);
    const denied = await fresh.request('/integrations/android/calls', 'POST', callEvent({ eventId: 'after-revocation' }), bearer, false);
    assert.equal(denied.status, 401);
  } finally { await fresh.close(); }
});

test('only answered incoming calls become inquiries, including subsecond calls; repeats deduplicate by device and event', async () => {
  const fresh = await fixture();
  try {
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'სატესტო ტელეფონი' });
    const bearer = { Authorization: `Bearer ${paired.token}` };
    for (const kind of ['missed', 'rejected', 'outgoing']) {
      const ignored = await fresh.request('/integrations/android/calls', 'POST', callEvent({ kind }), bearer, false);
      assert.equal(ignored.status, 200);
      assert.equal(ignored.data.ignored, true);
    }
    assert.equal((await successful(fresh, '/admin/calls')).calls.length, 0);
    const payload = callEvent({ durationSeconds: 0, phone: '599 12 34 56' });
    const created = await fresh.request('/integrations/android/calls', 'POST', payload, bearer, false);
    assert.equal(created.status, 201);
    assert.equal(created.data.duplicate, false);
    const repeated = await fresh.request('/integrations/android/calls', 'POST', payload, bearer, false);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.duplicate, true);
    assert.equal(repeated.data.id, created.data.id);
    const conflicting = await fresh.request('/integrations/android/calls', 'POST', { ...payload, durationSeconds: 1 }, bearer, false);
    assert.equal(conflicting.status, 409);
    assert.equal(conflicting.data.code, 'IDEMPOTENCY_CONFLICT');
    const nextCall = await fresh.request('/integrations/android/calls', 'POST', { ...payload, eventId: 'android-call-1002' }, bearer, false);
    assert.equal(nextCall.status, 201);
    assert.notEqual(nextCall.data.id, created.data.id);
    const anotherDevice = await successful(fresh, '/admin/devices', 'POST', { name: 'მეორე სატესტო ტელეფონი' });
    const other = await fresh.request('/integrations/android/calls', 'POST', payload, { Authorization: `Bearer ${anotherDevice.token}` }, false);
    assert.equal(other.status, 201);
    const calls = (await successful(fresh, '/admin/calls')).calls;
    assert.equal(calls.length, 3);
    assert.equal(calls.find((row: any) => row.id === created.data.id).phone, '599123456');
    assert.equal(calls.find((row: any) => row.id === created.data.id).durationSeconds, 0);
    assert.equal(calls.find((row: any) => row.id === created.data.id).occurredAt, '2030-01-01T06:20:30.000Z');
  } finally { await fresh.close(); }
});

test('a private-number call waits for enrichment and converts atomically to exactly one confirmed booking', async () => {
  const fresh = await fixture();
  try {
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'Redmi სატესტო ტელეფონი' });
    const received = await fresh.request('/integrations/android/calls', 'POST', callEvent({ phone: null }), { Authorization: `Bearer ${paired.token}` }, false);
    assert.equal(received.status, 201);
    const inquiryId = received.data.id;
    const inquiry = (await successful(fresh, '/admin/calls')).calls[0];
    assert.equal(inquiry.phone, null);
    assert.equal(inquiry.bookingId, null);
    const incomplete = await fresh.request(`/admin/calls/${inquiryId}/convert`, 'POST', { ...input(), phone: null });
    assert.equal(incomplete.status, 400);
    assert.equal(((await fresh.db.prepare('SELECT COUNT(*) AS count FROM bookings').get()) as { count: number }).count, 0);
    const converted = await successful(fresh, `/admin/calls/${inquiryId}/convert`, 'POST', input({ name: 'ზარიდან შექმნილი ჯავშანი', seats: 4 }));
    assert.equal(converted.status, 'confirmed');
    assert.equal(converted.assignedDate, DAY);
    assert.equal(converted.assignedTime, '08:30');
    assert.equal(converted.seats, 4);
    const duplicate = await successful(fresh, `/admin/calls/${inquiryId}/convert`, 'POST', input({ seats: 1 }));
    assert.equal(duplicate.id, converted.id);
    assert.equal(duplicate.seats, 4);
    assert.equal(((await fresh.db.prepare('SELECT COUNT(*) AS count FROM bookings').get()) as { count: number }).count, 1);
    assert.equal(((await fresh.db.prepare('SELECT source FROM bookings WHERE id=?').get(converted.id)) as { source: string }).source, 'android');
    assert.equal(((await fresh.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='call.convert'").get()) as { count: number }).count, 1);
    assert.equal((await successful(fresh, '/admin/calls?scope=incoming')).calls.length, 0);
    const history = await successful(fresh, '/admin/calls?scope=converted');
    assert.equal(history.calls[0].bookingId, converted.id);
  } finally { await fresh.close(); }
});

test('live calls in either direction convert without a name to eight-seat operator orders and retain trusted customer names', async () => {
  const fresh = await fixture({ now: () => new Date('2030-01-01T04:30:00Z') });
  try {
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'ოპერატორის რვა ადგილის ტესტი' });
    const bearer = { Authorization: `Bearer ${paired.token}` };
    const stop = (await successful(fresh, '/public/config')).stops[0];
    const known = await successful(fresh, '/admin/bookings', 'POST', input({ name: 'ზარის სანდო სახელი', phone: '568694879' }));
    for (const direction of ['gori-tbilisi', 'tbilisi-gori']) {
      const event = callEvent({ eventId: `operator-eight-${direction}`, phase: 'answered', durationSeconds: 0, phone: direction === 'gori-tbilisi' ? '568694879' : null });
      const received = await fresh.request('/integrations/android/calls', 'POST', event, bearer, false);
      assert.equal(received.status, 201);
      const body = input({ name: undefined, phone: '568694879', seats: 8, direction, ...(direction === 'tbilisi-gori' ? { pickupStopId: stop.id } : {}) });
      for (const fields of [{ seats: 9 }, { requestedDate: '2030-01-04' }, { requestedDate: '2030-01-01', requestedTime: '08:30' }]) {
        const rejected = await fresh.request(`/admin/calls/${received.data.id}/convert`, 'POST', { ...body, ...fields });
        assert.equal(rejected.status, 400);
        assert.equal((await fresh.db.prepare('SELECT booking_id FROM call_inquiries WHERE id=?').get(received.data.id))!.booking_id, null);
      }
      const converted = await successful(fresh, `/admin/calls/${received.data.id}/convert`, 'POST', body);
      assert.equal(converted.name, '');
      assert.equal(converted.seats, 8);
      assert.equal(converted.direction, direction);
      assert.equal(converted.status, 'confirmed');
      assert.equal(converted.pickupStopId, direction === 'tbilisi-gori' ? stop.id : null);
      assert.equal((await successful(fresh, '/admin/passengers/profile?phone=568694879')).profile.name, known.name);
      const retry = await successful(fresh, `/admin/calls/${received.data.id}/convert`, 'POST', body);
      assert.equal(retry.id, converted.id);
      assert.equal((await fresh.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='call.convert' AND booking_id=?").get(converted.id))!.count, 1);
    }
  } finally { await fresh.close(); }
});

test('call deletion retains metadata, blocks conversion until restoration, and never creates orders by itself', async () => {
  const fresh = await fixture();
  try {
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'სატესტო Redmi' });
    const received = await fresh.request('/integrations/android/calls', 'POST', callEvent(), { Authorization: `Bearer ${paired.token}` }, false);
    const id = received.data.id;
    const deleted = await successful(fresh, `/admin/calls/${id}/delete`, 'POST', {});
    assert.ok(deleted.deletedAt);
    assert.equal(deleted.phone, '599123456');
    assert.equal(deleted.durationSeconds, 15);
    assert.equal((await successful(fresh, '/admin/calls')).calls.length, 0);
    assert.equal((await successful(fresh, '/admin/calls?scope=deleted')).calls[0].id, id);
    assert.equal((await fresh.request(`/admin/calls/${id}/convert`, 'POST', input())).status, 409);
    const restored = await successful(fresh, `/admin/calls/${id}/restore`, 'POST', {});
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.bookingId, null);
    assert.equal((await successful(fresh, '/admin/calls?search=599123456')).calls.length, 1);
    assert.equal(((await fresh.db.prepare('SELECT COUNT(*) AS count FROM bookings').get()) as { count: number }).count, 0);
  } finally { await fresh.close(); }
});

test('Android ingestion validates metadata and accepts explicitly supplied offline events without importing other history', async () => {
  const fresh = await fixture();
  try {
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'სატესტო ტელეფონი' });
    const bearer = { Authorization: `Bearer ${paired.token}` };
    for (const overrides of [{ phone: 'hidden-number' }, { occurredAt: '2030-02-31T10:00:00Z' }, { occurredAt: '2030-01-01T10:00:00' }, { durationSeconds: -1 }, { durationSeconds: 1.2 }, { kind: 'unknown' }, { eventId: '' }]) {
      const rejected = await fresh.request('/integrations/android/calls', 'POST', callEvent(overrides), bearer, false);
      assert.equal(rejected.status, 400);
    }
    const offline = await fresh.request('/integrations/android/calls', 'POST', callEvent({ occurredAt: '2020-01-01T10:00:00Z', eventId: 'offline-event-1' }), bearer, false);
    assert.equal(offline.status, 201);
    const queue = await successful(fresh, '/admin/calls');
    assert.equal(queue.calls.length, 1);
    assert.equal(queue.calls[0].occurredAt, '2020-01-01T10:00:00.000Z');
  } finally { await fresh.close(); }
});

test('an answered call appears before completion, and late completion preserves its converted booking, profile, and deletion', async () => {
  const fresh = await fixture();
  try {
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'მიმდინარე ზარის ტესტი' });
    const bearer = { Authorization: `Bearer ${paired.token}` };
    const answered = callEvent({ phase: 'answered', durationSeconds: 0 });
    const received = await fresh.request('/integrations/android/calls', 'POST', answered, bearer, false);
    assert.equal(received.status, 201);
    const inquiryId = received.data.id;
    let inquiry = (await successful(fresh, '/admin/calls')).calls[0];
    assert.equal(inquiry.phase, 'answered');
    assert.equal(inquiry.durationSeconds, 0);
    assert.equal(inquiry.passengerProfile, null);
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', answered, bearer, false)).data.id, inquiryId);
    const converted = await successful(fresh, `/admin/calls/${inquiryId}/convert`, 'POST', input({ name: 'ოპერატორის მგზავრი', goriAddress: 'გორი, ოპერატორის მისამართი' }));
    const deleted = await successful(fresh, `/admin/calls/${inquiryId}/delete`, 'POST', {});
    const profileBefore = await successful(fresh, '/admin/passengers/profile?phone=599123456');
    const completion = callEvent({ phase: 'completed', durationSeconds: 35 });
    const results = await Promise.all(Array.from({ length: 4 }, () => fresh.request('/integrations/android/calls', 'POST', completion, bearer, false)));
    assert.ok(results.every(result => result.status === 200 && result.data.id === inquiryId && result.data.duplicate === true));
    inquiry = (await successful(fresh, '/admin/calls?scope=deleted')).calls[0];
    assert.equal(inquiry.phase, 'completed');
    assert.equal(inquiry.durationSeconds, 35);
    assert.equal(inquiry.deletedAt, deleted.deletedAt);
    assert.equal(inquiry.bookingId, converted.id);
    assert.deepEqual((await successful(fresh, '/admin/bookings?scope=scheduled')).bookings[0], converted);
    assert.deepEqual(await successful(fresh, '/admin/passengers/profile?phone=599123456'), profileBefore);
    assert.equal((await fresh.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='call.complete'").get())?.count, 1);
    const delayed = await fresh.request('/integrations/android/calls', 'POST', answered, bearer, false);
    assert.equal(delayed.status, 200);
    assert.equal((await successful(fresh, '/admin/calls?scope=deleted')).calls[0].durationSeconds, 35);
  } finally { await fresh.close(); }
});

test('call phases handle hidden-number enrichment and out-of-order retries while rejecting identity and duration conflicts', async () => {
  const fresh = await fixture();
  try {
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'ზარის ეტაპების ტესტი' });
    const bearer = { Authorization: `Bearer ${paired.token}` };
    for (const phase of [null, 'ringing', 1]) {
      assert.equal((await fresh.request('/integrations/android/calls', 'POST', callEvent({ phase }), bearer, false)).status, 400);
    }
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', callEvent({ phase: 'answered', durationSeconds: 1 }), bearer, false)).status, 400);
    const answered = callEvent({ phone: null, phase: 'answered', durationSeconds: 0 });
    const created = await fresh.request('/integrations/android/calls', 'POST', answered, bearer, false);
    const completed = callEvent({ phone: '599123456', phase: 'completed', durationSeconds: 10 });
    const ended = await fresh.request('/integrations/android/calls', 'POST', completed, bearer, false);
    assert.equal(ended.status, 200);
    assert.equal(ended.data.id, created.data.id);
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', answered, bearer, false)).status, 200);
    for (const overrides of [{ durationSeconds: 11 }, { phone: null }, { phone: '599123457' }, { occurredAt: '2030-01-01T10:20:31+04:00' }]) {
      const conflict = await fresh.request('/integrations/android/calls', 'POST', { ...completed, ...overrides }, bearer, false);
      assert.equal(conflict.status, 409);
      assert.equal(conflict.data.code, 'IDEMPOTENCY_CONFLICT');
    }
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', { ...answered, phone: '599123457' }, bearer, false)).status, 409);
    const { phase: _completedPhase, ...legacyCompletion } = completed;
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', legacyCompletion, bearer, false)).status, 200);
    const { phase: _answeredPhase, ...legacyAnswer } = answered;
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', legacyAnswer, bearer, false)).status, 409);
    const completedFirst = callEvent({ eventId: 'completed-first', phase: 'completed', durationSeconds: 20 });
    const first = await fresh.request('/integrations/android/calls', 'POST', completedFirst, bearer, false);
    const delayed = await fresh.request('/integrations/android/calls', 'POST', { ...completedFirst, phase: 'answered', durationSeconds: 0 }, bearer, false);
    assert.equal(delayed.status, 200);
    assert.equal(delayed.data.id, first.data.id);
    const zeroAnswer = callEvent({ eventId: 'zero-duration-completion', phase: 'answered', durationSeconds: 0 });
    const zero = await fresh.request('/integrations/android/calls', 'POST', zeroAnswer, bearer, false);
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', { ...zeroAnswer, phase: 'completed' }, bearer, false)).status, 200);
    const calls = (await successful(fresh, '/admin/calls')).calls;
    assert.equal(calls.find((call: any) => call.id === zero.data.id).phase, 'completed');
    assert.equal(calls.find((call: any) => call.id === first.data.id).durationSeconds, 20);
    const raceAnswer = callEvent({ eventId: 'competing-completions', phase: 'answered', durationSeconds: 0 });
    await fresh.request('/integrations/android/calls', 'POST', raceAnswer, bearer, false);
    const raced = await Promise.all([12, 13].map(durationSeconds => fresh.request('/integrations/android/calls', 'POST', { ...raceAnswer, phase: 'completed', durationSeconds }, bearer, false)));
    assert.deepEqual(raced.map(result => result.status).sort(), [200, 409]);
  } finally { await fresh.close(); }
});

test('incoming calls enrich only from trusted profiles, read legacy aliases, and search national or international phones and names', async () => {
  const fresh = await fixture({ deferPhoneMigration: true });
  try {
    const stop = (await successful(fresh, '/admin/stops')).stops[0];
    const booking = await successful(fresh, '/admin/bookings', 'POST', input({ phone: '568694879', name: 'ცნობილი მგზავრი', direction: 'tbilisi-gori', pickupStopId: stop.id }));
    await successful(fresh, `/admin/bookings/${booking.id}/delete`, 'POST', {});
    await fresh.db.prepare('UPDATE passenger_profiles SET phone=? WHERE phone=?').run('+995568694879', '568694879');
    await fresh.request('/bookings', 'POST', input({ phone: '568694879', name: 'შეუმოწმებელი სახელი' }), {}, false);
    await fresh.request('/bookings', 'POST', input({ phone: '568694880', name: 'მხოლოდ საჯარო მგზავრი' }), {}, false);
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'პროფილის ზარის ტესტი' });
    const bearer = { Authorization: `Bearer ${paired.token}` };
    for (const [index, number] of ['+995568694879', '568694880', null].entries()) {
      await fresh.request('/integrations/android/calls', 'POST', callEvent({ eventId: `profile-call-${index}`, phone: number, phase: 'answered', durationSeconds: 0 }), bearer, false);
    }
    const calls = (await successful(fresh, '/admin/calls')).calls;
    const known = calls.find((call: any) => call.phone === '568694879');
    assert.equal(known.passengerProfile.name, 'ცნობილი მგზავრი');
    assert.equal(known.passengerProfile.pickupStopId, stop.id);
    assert.equal(calls.find((call: any) => call.phone === '568694880').passengerProfile, null);
    assert.equal(calls.find((call: any) => call.phone === null).passengerProfile, null);
    assert.equal((await fresh.request('/admin/calls', 'GET', undefined, {}, false)).status, 401);
    for (const search of ['568694879', '+995568694879', '995568694879', '00995568694879', '568 69 48 79', 'ცნობილი მგზავრი']) {
      const found = await successful(fresh, '/admin/calls?search=' + encodeURIComponent(search));
      assert.equal(found.calls.length, 1);
      assert.equal(found.calls[0].id, known.id);
    }
    await successful(fresh, `/admin/stops/${stop.id}`, 'PATCH', { active: false });
    const inactive = (await successful(fresh, '/admin/calls?search=568694879')).calls[0].passengerProfile;
    assert.equal(inactive.pickupStopId, null);
    assert.equal(inactive.pickupStopName, null);
    assert.equal(inactive.name, 'ცნობილი მგზავრი');
  } finally { await fresh.close(); }
});

test('deferred bridge reads aliases and the later national migration preserves history, hashes, cached retries, and profile collisions', async () => {
  const fresh = await fixture({ deferPhoneMigration: true });
  const reopened: Awaited<ReturnType<typeof createApp>>[] = [];
  try {
    assert.ok(await fresh.db.prepare("SELECT value FROM settings WHERE key='passengerProfilesBackfilled'").get());
    assert.equal(await fresh.db.prepare("SELECT value FROM settings WHERE key='georgianPhoneStorageV2'").get(), undefined);
    const selected = (await successful(fresh, '/admin/stops')).stops[0];
    const originalInput = input({ phone: '+995568694879', direction: 'tbilisi-gori', pickupStopId: selected.id });
    const key = 'legacy-booking-retry';
    const original = await successful(fresh, '/admin/bookings', 'POST', originalInput, { 'Idempotency-Key': key });
    await successful(fresh, `/admin/bookings/${original.id}/delete`, 'POST', {});
    const waiting = await fresh.request('/bookings', 'POST', input({ phone: '568694879', name: 'შეუმოწმებელი საჯარო სახელი' }), {}, false);
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'მიგრაციის სატესტო ტელეფონი' });
    const bearer = { Authorization: `Bearer ${paired.token}` };
    const legacyEvent = callEvent({ phone: '+995568694879' });
    const received = await fresh.request('/integrations/android/calls', 'POST', legacyEvent, bearer, false);
    const hashBefore = (await fresh.db.prepare('SELECT request_hash FROM call_inquiries WHERE id=?').get(received.data.id))!.request_hash;
    const expectedLegacyHash = createHash('sha256').update(JSON.stringify({ phone: '+995568694879', occurredAt: '2030-01-01T06:20:30.000Z', durationSeconds: 15, kind: 'incoming' })).digest('hex');
    assert.equal(hashBefore, expectedLegacyHash);
    await fresh.db.prepare('UPDATE bookings SET phone=? WHERE id=?').run('+995568694879', original.id);
    await fresh.db.prepare('UPDATE bookings SET phone=? WHERE id=?').run('995568694879', waiting.data.id);
    await fresh.db.prepare('UPDATE call_inquiries SET phone=? WHERE id=?').run('+995568694879', received.data.id);
    await fresh.db.prepare('INSERT INTO passenger_profiles(phone,name,gori_address,pickup_stop_id,pickup_stop_name,updated_at) VALUES (?,?,?,?,?,?)')
      .run('+995568694879', 'უახლესი სანდო სახელი', 'გორი, უახლესი სანდო მისამართი', null, null, '2030-01-01T00:01:00Z');
    await fresh.db.prepare('UPDATE idempotency SET response=? WHERE key=?').run(JSON.stringify({ ...original, phone: '+995568694879' }), key);
    const recordBefore = await fresh.db.prepare('SELECT * FROM bookings WHERE id=?').get(original.id);
    const auditBefore = await fresh.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get();
    const bridge = await successful(fresh, '/admin/passengers/profile?phone=568694879');
    assert.equal(bridge.profile.phone, '568694879');
    assert.equal(bridge.profile.name, 'უახლესი სანდო სახელი');
    assert.equal(bridge.profile.pickupStopId, selected.id);
    assert.equal((await successful(fresh, '/admin/passengers?search=' + encodeURIComponent('+995568694879'))).passengers.length, 1);
    const start = () => createApp({ dbPath: fresh.path, databaseUrl: fresh.databaseUrl, deferPhoneMigration: false });
    if (fresh.databaseUrl) reopened.push(...await Promise.all([start(), start()]));
    else reopened.push(await start());
    assert.ok(await fresh.db.prepare("SELECT value FROM settings WHERE key='georgianPhoneStorageV2'").get());
    const recordAfter = await fresh.db.prepare('SELECT * FROM bookings WHERE id=?').get(original.id);
    assert.deepEqual({ ...recordAfter }, { ...recordBefore, phone: '568694879' });
    assert.equal((await fresh.db.prepare('SELECT request_hash,phone FROM call_inquiries WHERE id=?').get(received.data.id))?.request_hash, hashBefore);
    assert.equal((await fresh.db.prepare('SELECT request_hash,phone FROM call_inquiries WHERE id=?').get(received.data.id))?.phone, '568694879');
    const profiles = await fresh.db.prepare('SELECT * FROM passenger_profiles').all();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].phone, '568694879');
    assert.equal(profiles[0].name, 'უახლესი სანდო სახელი');
    assert.equal(profiles[0].pickup_stop_id, selected.id);
    assert.deepEqual(await fresh.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), auditBefore);
    for (const number of ['+995568694879', '568694879']) {
      const retry = await fresh.request('/integrations/android/calls', 'POST', { ...legacyEvent, phone: number }, bearer, false);
      assert.equal(retry.status, 200);
      assert.equal(retry.data.id, received.data.id);
    }
    const cached = await successful(fresh, '/admin/bookings', 'POST', originalInput, { 'Idempotency-Key': key });
    assert.equal(cached.id, original.id);
    assert.equal(cached.phone, '568694879');
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', { ...legacyEvent, durationSeconds: 16 }, bearer, false)).status, 409);
    const second = await start();
    reopened.push(second);
    assert.deepEqual(await fresh.db.prepare('SELECT * FROM passenger_profiles').all(), profiles);
    const foreign = await successful(fresh, '/admin/bookings', 'POST', input({ phone: '+447911123456' }));
    assert.equal(foreign.phone, '+447911123456');
  } finally {
    await Promise.all(reopened.map(service => service.close()));
    await fresh.close();
  }
});

test('only legacy completed calls accept the original parser hash before and after migration; new calls retain strict identity', async () => {
  const fresh = await fixture({ deferPhoneMigration: true });
  let migrated: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'ძველი ნომრის გამეორების ტესტი' });
    const bearer = { Authorization: `Bearer ${paired.token}` };
    const payload = callEvent({ eventId: 'old-foreign-nine-digits', phone: '+298555123' });
    const originalHash = createHash('sha256').update(JSON.stringify({ phone: '+995298555123', occurredAt: '2030-01-01T06:20:30.000Z', durationSeconds: 15, kind: 'incoming' })).digest('hex');
    // Old warm instances omit the new column, so its migration default must mark their inserts as legacy.
    const inserted = await fresh.db.prepare('INSERT INTO call_inquiries(device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(paired.device.id, payload.eventId, originalHash, '+995298555123', '2030-01-01T06:20:30.000Z', 15, '2030-01-01T00:00:00.000Z');
    const id = Number(inserted.lastInsertRowid);
    const before = await fresh.db.prepare('SELECT * FROM call_inquiries WHERE id=?').get(id);
    assert.equal(before?.legacy_hash, 1);
    assert.equal(before?.phase, 'completed');
    const first = await fresh.request('/integrations/android/calls', 'POST', payload, bearer, false);
    assert.equal(first.status, 200);
    assert.deepEqual(first.data, { id, duplicate: true });
    assert.deepEqual(await fresh.db.prepare('SELECT * FROM call_inquiries WHERE id=?').get(id), before);
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', { ...payload, phase: 'completed' }, bearer, false)).status, 409);
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', { ...payload, phase: 'answered', durationSeconds: 0 }, bearer, false)).status, 409);
    migrated = await createApp({ dbPath: fresh.path, databaseUrl: fresh.databaseUrl, deferPhoneMigration: false });
    const afterMigration = await fresh.db.prepare('SELECT * FROM call_inquiries WHERE id=?').get(id);
    assert.equal(afterMigration?.phone, '298555123');
    assert.equal(afterMigration?.request_hash, originalHash);
    const repeated = await fresh.request('/integrations/android/calls', 'POST', payload, bearer, false);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.id, id);
    assert.deepEqual(await fresh.db.prepare('SELECT * FROM call_inquiries WHERE id=?').get(id), afterMigration);
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', { ...payload, durationSeconds: 16 }, bearer, false)).status, 409);
    const national = callEvent({ eventId: 'new-national-nine-digits', phone: '298555123' });
    const created = await fresh.request('/integrations/android/calls', 'POST', national, bearer, false);
    assert.equal(created.status, 201);
    const newBefore = await fresh.db.prepare('SELECT * FROM call_inquiries WHERE id=?').get(created.data.id);
    assert.equal(newBefore?.legacy_hash, 0);
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', { ...national, phone: '+298555123' }, bearer, false)).status, 409);
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', { ...national, phone: '+298555123', phase: 'completed' }, bearer, false)).status, 409);
    assert.deepEqual(await fresh.db.prepare('SELECT * FROM call_inquiries WHERE id=?').get(created.data.id), newBefore);
    const answered = callEvent({ eventId: 'new-answered-nine-digits', phone: '298555123', phase: 'answered', durationSeconds: 0 });
    const active = await fresh.request('/integrations/android/calls', 'POST', answered, bearer, false);
    const { phase: _phase, ...withoutPhase } = answered;
    assert.equal((await fresh.request('/integrations/android/calls', 'POST', { ...withoutPhase, phone: '+298555123' }, bearer, false)).status, 409);
    assert.equal((await fresh.db.prepare('SELECT phase FROM call_inquiries WHERE id=?').get(active.data.id))?.phase, 'answered');
  } finally {
    if (migrated) await migrated.close();
    await fresh.close();
  }
});

test('trusted passenger profiles use one Georgian canonical phone and persist through deletion and database restart', async () => {
  const fresh = await fixture();
  try {
    assert.deepEqual(await successful(fresh, '/admin/passengers/profile?phone=599112233'), { profile: null });
    const created = await successful(fresh, '/admin/bookings', 'POST', input({ phone: '995599112233', name: 'განმეორებითი მგზავრი', goriAddress: 'გორი, შენახული მისამართი 4' }));
    assert.equal(created.phone, '599112233');
    for (const value of ['599112233', '995599112233', '+995599112233', '599 11 22 33', '00995599112233']) {
      const result = await successful(fresh, '/admin/passengers/profile?phone=' + encodeURIComponent(value));
      assert.equal(result.profile.phone, '599112233');
      assert.equal(result.profile.name, 'განმეორებითი მგზავრი');
      assert.equal(result.profile.goriAddress, 'გორი, შენახული მისამართი 4');
      assert.equal(result.profile.pickupStopId, null);
      assert.equal('requestedDate' in result.profile, false);
      assert.equal('seats' in result.profile, false);
    }
    assert.equal((await fresh.request('/admin/passengers/profile?phone=599112233', 'GET', undefined, {}, false)).status, 401);
    await successful(fresh, `/admin/bookings/${created.id}/delete`, 'POST', {});
    assert.equal((await successful(fresh, '/admin/passengers/profile?phone=599112233')).profile.name, 'განმეორებითი მგზავრი');
    const reopened = await createApp({ dbPath: fresh.path, databaseUrl: fresh.databaseUrl });
    try {
      const persisted = await reopened.db.prepare('SELECT * FROM passenger_profiles WHERE phone=?').get('599112233');
      assert.equal(persisted?.gori_address, 'გორი, შენახული მისამართი 4');
      assert.equal(persisted?.name, 'განმეორებითი მგზავრი');
    } finally { await reopened.close(); }
  } finally { await fresh.close(); }
});

test('public unverified orders and waiting edits cannot overwrite a trusted passenger profile; operator confirmation can', async () => {
  const fresh = await fixture();
  try {
    await successful(fresh, '/admin/bookings', 'POST', input({ phone: '599222333', name: 'დადასტურებული სახელი', goriAddress: 'გორი, სანდო მისამართი' }));
    const waiting = await fresh.request('/bookings', 'POST', input({ phone: '+995599222333', name: 'საჯარო მონაცემები', goriAddress: 'გორი, შეუმოწმებელი მისამართი' }), {}, false);
    assert.equal(waiting.status, 201);
    let result = await successful(fresh, '/admin/passengers/profile?phone=995599222333');
    assert.equal(result.profile.name, 'დადასტურებული სახელი');
    assert.equal(result.profile.goriAddress, 'გორი, სანდო მისამართი');
    await successful(fresh, `/admin/bookings/${waiting.data.id}`, 'PATCH', { name: 'ოპერატორის ახალი სახელი', goriAddress: 'გორი, ოპერატორის ახალი მისამართი' });
    result = await successful(fresh, '/admin/passengers/profile?phone=599222333');
    assert.equal(result.profile.name, 'დადასტურებული სახელი');
    await successful(fresh, `/admin/bookings/${waiting.data.id}/confirm`, 'POST', { date: DAY, time: '08:30' });
    result = await successful(fresh, '/admin/passengers/profile?phone=599222333');
    assert.equal(result.profile.name, 'ოპერატორის ახალი სახელი');
    assert.equal(result.profile.goriAddress, 'გორი, ოპერატორის ახალი მისამართი');
    await successful(fresh, `/admin/bookings/${waiting.data.id}`, 'PATCH', { name: 'შესწორებული სახელი' });
    assert.equal((await successful(fresh, '/admin/passengers/profile?phone=599222333')).profile.name, 'შესწორებული სახელი');
    const newCaller = await fresh.request('/bookings', 'POST', input({ phone: '599222334' }), {}, false);
    assert.equal(newCaller.status, 201);
    assert.equal((await successful(fresh, '/admin/passengers/profile?phone=599222334')).profile, null);
  } finally { await fresh.close(); }
});

test('passenger profiles remember the last active Tbilisi stop and exclude a disabled stop from autofill', async () => {
  const fresh = await fixture();
  try {
    const selected = await successful(fresh, '/admin/stops', 'POST', { name: 'მგზავრის სატესტო გაჩერება', address: 'თბილისი, სატესტო მისამართი' });
    await successful(fresh, '/admin/bookings', 'POST', input({ phone: '599333444', direction: 'tbilisi-gori', pickupStopId: selected.id }));
    let result = await successful(fresh, '/admin/passengers/profile?phone=599333444');
    assert.equal(result.profile.pickupStopId, selected.id);
    assert.equal(result.profile.pickupStopName, selected.name);
    await successful(fresh, '/admin/bookings', 'POST', input({ phone: '995599333444', direction: 'gori-tbilisi' }));
    assert.equal((await successful(fresh, '/admin/passengers/profile?phone=599333444')).profile.pickupStopId, selected.id);
    await successful(fresh, `/admin/stops/${selected.id}`, 'PATCH', { name: 'განახლებული გაჩერება' });
    assert.equal((await successful(fresh, '/admin/passengers/profile?phone=599333444')).profile.pickupStopName, 'განახლებული გაჩერება');
    await successful(fresh, `/admin/stops/${selected.id}`, 'PATCH', { active: false });
    result = await successful(fresh, '/admin/passengers/profile?phone=599333444');
    assert.equal(result.profile.pickupStopId, null);
    assert.equal(result.profile.pickupStopName, null);
    assert.equal(result.profile.name, 'ნინო ტესტი');
  } finally { await fresh.close(); }
});

test('legacy confirmed history backfills canonical profiles once; unconfirmed history never becomes a profile', async () => {
  const fresh = await fixture();
  try {
    await successful(fresh, '/admin/bookings', 'POST', input({ phone: '599444555', name: 'ისტორიული მგზავრი' }));
    await fresh.request('/bookings', 'POST', input({ phone: '599444556', name: 'დაუდასტურებელი მგზავრი' }), {}, false);
    await fresh.db.prepare('DELETE FROM passenger_profiles').run();
    await fresh.db.prepare("DELETE FROM settings WHERE key='passengerProfilesBackfilled'").run();
    await fresh.db.prepare("DELETE FROM settings WHERE key='georgianPhoneStorageV2'").run();
    await fresh.db.prepare('UPDATE bookings SET phone=? WHERE phone=?').run('995599444555', '599444555');
    const reopened = await createApp({ dbPath: fresh.path, databaseUrl: fresh.databaseUrl });
    try {
      const trusted = await reopened.db.prepare('SELECT * FROM passenger_profiles WHERE phone=?').get('599444555');
      assert.equal(trusted?.name, 'ისტორიული მგზავრი');
      assert.equal(await reopened.db.prepare('SELECT * FROM passenger_profiles WHERE phone=?').get('599444556'), undefined);
      assert.equal((await reopened.db.prepare('SELECT phone FROM bookings WHERE name=?').get('ისტორიული მგზავრი'))?.phone, '599444555');
    } finally { await reopened.close(); }
  } finally { await fresh.close(); }
});

test('concurrent confirmations and Android conversions update one profile and create no duplicate orders across application instances', async () => {
  const fresh = await fixture();
  let second: Awaited<ReturnType<typeof createApp>> | undefined;
  let secondServer: Server | undefined;
  try {
    const waiting = await fresh.request('/bookings', 'POST', input({ phone: '599555666' }), {}, false);
    const confirmed = await Promise.all(Array.from({ length: 5 }, () => fresh.request(`/admin/bookings/${waiting.data.id}/confirm`, 'POST', { date: DAY, time: '08:30' })));
    assert.ok(confirmed.every(response => response.status === 200 && response.data.id === waiting.data.id));
    assert.equal((await fresh.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE booking_id=? AND action='confirm'").get(waiting.data.id))?.count, 1);
    const paired = await successful(fresh, '/admin/devices', 'POST', { name: 'სატესტო ტელეფონი' });
    const received = await fresh.request('/integrations/android/calls', 'POST', callEvent({ phone: '599555667' }), { Authorization: `Bearer ${paired.token}` }, false);
    const session = await fresh.request('/auth/login', 'POST', { login: 'operator', password: PASSWORD });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let secondBase = fresh.base;
    // PostgreSQL uses another pool/application here, matching concurrent serverless instances.
    // SQLite remains a single-process development database.
    if (fresh.databaseUrl) {
      second = await createApp({ databaseUrl: fresh.databaseUrl, now: () => new Date('2030-01-01T00:00:00Z') });
      secondServer = await new Promise<Server>(resolve => {
        const listener = second!.app.listen(0, '127.0.0.1', () => resolve(listener));
      });
      const address = secondServer.address();
      assert.ok(address && typeof address !== 'string');
      secondBase = `http://127.0.0.1:${address.port}`;
    }
    const converted = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const base = index % 2 ? secondBase : fresh.base;
      const response = await fetch(`${base}/api/admin/calls/${received.data.id}/convert`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input({ phone: '995599555667' })),
      });
      return { status: response.status, data: await response.json() as any };
    }));
    assert.ok(converted.every(response => response.status === 200));
    assert.equal(new Set(converted.map(response => response.data.id)).size, 1);
    assert.equal((await fresh.db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE phone=?').get('599555667'))?.count, 1);
    assert.equal((await successful(fresh, '/admin/passengers/profile?phone=599555667')).profile.phone, '599555667');
    assert.equal((await fresh.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='call.convert'").get())?.count, 1);
  } finally {
    if (secondServer) await new Promise<void>((resolve, reject) => secondServer!.close(error => error ? reject(error) : resolve()));
    if (second) await second.close();
    await fresh.close();
  }
});

test('production initialization rejects a missing DATABASE_URL instead of creating a SQLite fallback', async () => {
  await assert.rejects(createApp({ production: true, databaseUrl: '', dbPath: ':memory:' }), /DATABASE_URL/);
});

test('login throttling shares an atomic window across application instances, survives restart, and expires without deleting users', async () => {
  let clock = new Date('2030-01-01T00:00:00Z');
  const fresh = await fixture({ now: () => clock });
  let other: Awaited<ReturnType<typeof createApp>> | undefined;
  let otherServer: Server | undefined;
  async function openOther() {
    other = await createApp({ dbPath: fresh.path, databaseUrl: fresh.databaseUrl, now: () => clock });
    otherServer = await new Promise<Server>(resolve => {
      const listener = other!.app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = otherServer.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  }
  async function closeOther() {
    if (otherServer) await new Promise<void>((resolve, reject) => otherServer!.close(error => error ? reject(error) : resolve()));
    if (other) await other.close();
    otherServer = undefined;
    other = undefined;
  }
  async function failedLogin(base: string) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'operator', password: 'incorrect-password' }),
    });
    return { status: response.status, data: await response.json() as any, retryAfter: response.headers.get('Retry-After') };
  }
  try {
    let otherBase = await openOther();
    const attempts = await Promise.all(Array.from({ length: 10 }, (_, index) => failedLogin(index % 2 ? otherBase : fresh.base)));
    assert.ok(attempts.every(response => response.status === 401));
    const limited = await failedLogin(otherBase);
    assert.equal(limited.status, 429);
    assert.equal(limited.data.code, 'RATE_LIMIT');
    assert.equal(limited.retryAfter, '900');
    await closeOther();
    otherBase = await openOther();
    assert.equal((await failedLogin(otherBase)).status, 429);
    clock = new Date(clock.getTime() + 15 * 60 * 1000 + 1);
    const expired = await failedLogin(otherBase);
    assert.equal(expired.status, 401);
    assert.equal((await fresh.db.prepare('SELECT COUNT(*) AS count FROM users').get())?.count, 1);
    assert.equal((await fresh.db.prepare('SELECT count FROM rate_limits WHERE scope_key=?').get('login:127.0.0.1'))?.count, 1);
  } finally { await closeOther(); await fresh.close(); }
});
