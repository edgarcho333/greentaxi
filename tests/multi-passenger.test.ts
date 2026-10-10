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
  const service = await createApp({ database: db, production: false, now: () => new Date('2030-01-01T00:00:00Z'), deferPhoneMigration: false });
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
async function call(f: Fixture, phone: string | null = CALLER, eventId = randomBytes(8).toString('hex')) {
  const device = await successful(f, '/admin/devices', 'POST', { name: 'ჯგუფის სატესტო ტელეფონი' });
  const event = { eventId, phone, occurredAt: '2030-01-01T10:20:30+04:00', durationSeconds: 0, kind: 'incoming', phase: 'answered' };
  const headers = { Authorization: `Bearer ${device.token}` };
  const result = await f.request('/integrations/android/calls', 'POST', event, headers, false);
  assert.equal(result.status, 201);
  return { id: result.data.id as number, event, headers };
}
async function snapshot(f: Fixture) {
  const tables = ['bookings', 'call_inquiries', 'call_booking_links', 'passenger_profiles', 'passenger_addresses', 'audit_log', 'idempotency'];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).map(row => ({ ...row }));
  return result;
}
async function alternateOperator(f: Fixture) {
  await successful(f, '/admin/staff', 'POST', { name: 'მეორე ოპერატორი', login: 'second_operator', password: PASSWORD });
  const login = await f.request('/auth/login', 'POST', { login: 'second_operator', password: PASSWORD }, {}, false);
  assert.equal(login.status, 200);
  return { Cookie: login.headers.get('set-cookie')!.split(';')[0] };
}

test('one call creates independent contacts, addresses, options and departure slots without merging passenger identities', async () => {
  await isolated(async f => {
    const inquiry = await call(f);
    const stop = (await successful(f, '/public/config')).stops[0];
    const children = [
      input({ phone: '+995599111221', callerPhone: '599000000', seats: 2, luggage: true, seatPreference: 'front' }),
      input({ phone: '599 11 12 22', seats: 8, goriAddress: 'მეორე სახლი 34', dog: true, seatPreference: 'back' }),
      input({ phone: '599111223', direction: 'tbilisi-gori', pickupStopId: stop.id, requestedDate: '2030-01-09', requestedTime: '09:30', goriAddress: 'ჩამოსვლის სახლი 56', seats: 1, luggage: true, dog: true, seatPreference: 'middle' }),
    ];
    const result = await f.request(`/admin/calls/${inquiry.id}/convert-group`, 'POST', { bookings: children }, groupKey('independent'));
    assert.equal(result.status, 201);
    assert.equal(result.data.bookings.length, 3);
    const bookings = result.data.bookings;
    assert.deepEqual(bookings.map((row: any) => [row.phone, row.callerPhone, row.seats, row.direction, row.assignedDate, row.assignedTime]), [
      ['599111221', CALLER, 2, 'gori-tbilisi', DAY, '08:30'],
      ['599111222', CALLER, 8, 'gori-tbilisi', DAY, '08:30'],
      ['599111223', CALLER, 1, 'tbilisi-gori', '2030-01-09', '09:30'],
    ]);
    assert.deepEqual(bookings.map((row: any) => [row.luggage, row.dog, row.seatPreference]), [[true, false, 'front'], [false, true, 'back'], [true, true, 'middle']]);
    assert.ok(bookings.every((row: any) => row.status === 'confirmed' && row.deletedAt === null));
    assert.deepEqual((await f.db.prepare('SELECT call_id,booking_id FROM call_booking_links WHERE call_id=? ORDER BY booking_id').all(inquiry.id)).map(row => [row.call_id, row.booking_id]), bookings.map((row: any) => [inquiry.id, row.id]));
    assert.equal((await f.db.prepare('SELECT booking_id FROM call_inquiries WHERE id=?').get(inquiry.id))?.booking_id, bookings[0].id);
    assert.equal((await successful(f, '/admin/calls')).calls.length, 0);
    assert.equal((await successful(f, '/admin/calls?scope=converted')).calls[0].id, inquiry.id);
    const people = (await successful(f, '/admin/passengers')).passengers;
    assert.deepEqual(people.map((person: any) => person.phone).sort(), ['599111221', '599111222', '599111223']);
    for (let index = 0; index < bookings.length; index++) {
      const detail = await successful(f, '/admin/passengers/' + bookings[index].phone);
      assert.deepEqual(detail.bookings.map((row: any) => row.id), [bookings[index].id]);
      assert.equal(detail.passenger.orderCount, 1);
      assert.equal(detail.passenger.seats, bookings[index].seats);
      assert.equal(detail.profile.phone, bookings[index].phone);
    }
    assert.equal((await successful(f, '/admin/passengers/profile?phone=' + CALLER)).profile, null);
    assert.equal((await successful(f, '/admin/passengers/profile?phone=599111221')).profile.goriPickupAddress, children[0].goriAddress);
    assert.equal((await successful(f, '/admin/passengers/profile?phone=599111222')).profile.goriPickupAddress, children[1].goriAddress);
    assert.equal((await successful(f, '/admin/passengers/profile?phone=599111223')).profile.pickupStopId, stop.id);
    const capacity = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    assert.equal(capacity.bookingCount, 2);
    assert.equal(capacity.bookedSeats, 10);
    assert.equal((await f.request(`/admin/bookings/${bookings[1].id}`, 'PATCH', { callerPhone: '599000000' })).data.code, 'CALLER_IMMUTABLE');
  });
});

test('group conversion requires an authenticated operator, valid replay key and a nonempty array of plain child objects', async () => {
  await isolated(async f => {
    const inquiry = await call(f);
    const endpoint = `/admin/calls/${inquiry.id}/convert-group`;
    const initial = await snapshot(f);
    const unauthorized = await f.request(endpoint, 'POST', { bookings: [input()] }, groupKey('unauthorized'), false);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.data.code, 'UNAUTHORIZED');
    const invalidHeaders: Record<string, string>[] = [{}, { 'Idempotency-Key': 'short' }, { 'Idempotency-Key': 'invalid key value' }];
    for (const headers of invalidHeaders) {
      const rejected = await f.request(endpoint, 'POST', { bookings: [input()] }, headers);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.data.code, 'VALIDATION');
    }
    for (const body of [null, [], 'invalid-body', 123, {}, { bookings: null }, { bookings: [] }, { bookings: {} }, { bookings: [null] }, { bookings: [[]] }, { bookings: ['passenger'] }]) {
      const rejected = await f.request(endpoint, 'POST', body, groupKey('bad-shape'));
      assert.equal(rejected.status, 400);
      assert.equal(rejected.data.code, 'VALIDATION');
    }
    assert.deepEqual(await snapshot(f), initial);
  });
});

test('a later invalid child rolls back every order, address, profile, audit and replay record, allowing a corrected retry', async () => {
  await isolated(async f => {
    await successful(f, '/admin/bookings', 'POST', input({ goriAddress: 'უკვე შენახული სახლი 1' }));
    const inquiry = await call(f);
    const endpoint = `/admin/calls/${inquiry.id}/convert-group`;
    const initial = await snapshot(f);
    for (const fields of [{ phone: 'not-a-number' }, { seats: 9 }, { goriAddress: '' }, { requestedTime: '22:30' }, { direction: 'tbilisi-gori', pickupStopId: 999999 }]) {
      const body = { bookings: [input({ goriAddress: 'სახლი შეცვლილი მხოლოდ წარმატებისას', luggage: true }), input({ phone: '599111222', ...fields })] };
      const rejected = await f.request(endpoint, 'POST', body, groupKey('rollback'));
      assert.equal(rejected.status, 'requestedTime' in fields ? 409 : 400);
      if ('requestedTime' in fields) assert.equal(rejected.data.code, 'SLOT_INACTIVE');
      assert.deepEqual(await snapshot(f), initial);
    }
    const corrected = await f.request(endpoint, 'POST', { bookings: [input({ goriAddress: 'წარმატებით შეცვლილი სახლი' }), input({ phone: '599111222' })] }, groupKey('rollback'));
    assert.equal(corrected.status, 201);
    assert.equal(corrected.data.bookings.length, 2);
    assert.equal((await successful(f, '/admin/passengers/profile?phone=599111221')).profile.goriPickupAddress, 'წარმატებით შეცვლილი სახლი');
  });
});

test('same-key concurrent and cross-operator retries return the exact group, while changed bodies and new keys cannot duplicate it', async () => {
  await isolated(async f => {
    const other = await alternateOperator(f);
    const inquiry = await call(f);
    const endpoint = `/admin/calls/${inquiry.id}/convert-group`;
    const body = { bookings: [input(), input({ phone: '599111222', seats: 3, goriAddress: 'მეორე სახლი' })] };
    const headers = groupKey('same-submit');
    const results = await Promise.all([
      f.request(endpoint, 'POST', body, headers),
      f.request(endpoint, 'POST', body, { ...headers, ...other }),
      f.request(endpoint, 'POST', body, headers),
    ]);
    assert.ok(results.every(result => result.status === 201));
    for (const result of results) assert.deepEqual(result.data, results[0].data);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM bookings').get())?.count, 2);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM call_booking_links').get())?.count, 2);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='create'").get())?.count, 2);
    const before = await snapshot(f);
    const changed = await f.request(endpoint, 'POST', { bookings: [input({ seats: 1 }), body.bookings[1]] }, headers);
    assert.equal(changed.status, 409);
    assert.equal(changed.data.code, 'IDEMPOTENCY_CONFLICT');
    const differentKey = await f.request(endpoint, 'POST', body, groupKey('different-submit'));
    assert.equal(differentKey.status, 409);
    assert.equal(differentKey.data.code, 'CALL_CONVERTED');
    assert.deepEqual(await snapshot(f), before);
  });
});

test('competing operators with different replay keys can convert the call only once, including separate PostgreSQL workers', async () => {
  await isolated(async f => {
    const other = await alternateOperator(f);
    const inquiry = await call(f);
    const endpoint = `/admin/calls/${inquiry.id}/convert-group`;
    const body = { bookings: [input(), input({ phone: '599111222' })] };
    let second: Awaited<ReturnType<typeof createApp>> | undefined;
    let secondServer: Server | undefined;
    try {
      let otherBase = f.base;
      if (f.databaseUrl) {
        second = await createApp({ databaseUrl: f.databaseUrl, production: false, now: () => new Date('2030-01-01T00:00:00Z'), deferPhoneMigration: false });
        secondServer = await new Promise<Server>(resolve => {
          const listener = second!.app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        const address = secondServer.address();
        assert.ok(address && typeof address !== 'string');
        otherBase = `http://127.0.0.1:${address.port}`;
      }
      const results = await Promise.all([
        f.request(endpoint, 'POST', body, groupKey('operator-one')),
        (async () => {
          const response = await fetch(`${otherBase}/api${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...other, ...groupKey('operator-two') }, body: JSON.stringify(body) });
          return { status: response.status, data: await response.json() as any };
        })(),
      ]);
      assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
      assert.equal(results.find(result => result.status === 409)?.data.code, 'CALL_CONVERTED');
      assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM bookings').get())?.count, 2);
      assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM call_booking_links').get())?.count, 2);
      assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM idempotency WHERE scope=?").get(`call-convert-group:${inquiry.id}`))?.count, 1);
    } finally {
      if (secondServer) await new Promise<void>((resolve, reject) => secondServer!.close(error => error ? reject(error) : resolve()));
      await second?.close();
    }
  });
});

test('completion reveals an unknown caller on all linked orders while preserving every passenger field and saved profile', async () => {
  await isolated(async f => {
    const inquiry = await call(f, null);
    const group = await successful(f, `/admin/calls/${inquiry.id}/convert-group`, 'POST', { bookings: [
      input({ callerPhone: '599000000', luggage: true, seatPreference: 'front' }),
      input({ phone: '599111222', callerPhone: '599000001', seats: 8, goriAddress: 'მეორე სახლი', dog: true, seatPreference: 'middle', requestedDate: '2030-01-10', requestedTime: '09:30' }),
    ] }, groupKey('unknown-caller'));
    assert.ok(group.bookings.every((row: any) => row.callerPhone === null));
    await successful(f, `/admin/bookings/${group.bookings[1].id}/delete`, 'POST', {});
    const before = (await f.db.prepare('SELECT * FROM bookings ORDER BY id').all()).map(row => ({ ...row }));
    const profiles = (await f.db.prepare('SELECT * FROM passenger_profiles ORDER BY phone').all()).map(row => ({ ...row }));
    const addresses = (await f.db.prepare('SELECT * FROM passenger_addresses ORDER BY phone,address_key').all()).map(row => ({ ...row }));
    const event = { ...inquiry.event, phone: '+995' + CALLER, phase: 'completed', durationSeconds: 37 };
    const completed = await f.request('/integrations/android/calls', 'POST', event, inquiry.headers, false);
    assert.equal(completed.status, 200);
    const after = await f.db.prepare('SELECT * FROM bookings ORDER BY id').all();
    assert.ok(after.every(row => row.caller_phone === CALLER));
    assert.deepEqual(after.map(row => ({ ...row, caller_phone: null })), before);
    assert.deepEqual((await f.db.prepare('SELECT * FROM passenger_profiles ORDER BY phone').all()).map(row => ({ ...row })), profiles);
    assert.deepEqual((await f.db.prepare('SELECT * FROM passenger_addresses ORDER BY phone,address_key').all()).map(row => ({ ...row })), addresses);
    assert.equal((await successful(f, '/admin/passengers/profile?phone=' + CALLER)).profile, null);
    const retry = await f.request('/integrations/android/calls', 'POST', event, inquiry.headers, false);
    assert.equal(retry.status, 200);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='call.complete'").get())?.count, 1);
    const followup = await call(f, CALLER);
    const active = await successful(f, `/admin/calls/${followup.id}/bookings`);
    assert.deepEqual(active.bookings.map((row: any) => row.id), [group.bookings[0].id]);
  });
});

test('a later call exposes all sibling orders and cancellation affects only the selected passenger and their seats', async () => {
  await isolated(async f => {
    const inquiry = await call(f);
    const group = await successful(f, `/admin/calls/${inquiry.id}/convert-group`, 'POST', { bookings: [input({ seats: 2 }), input({ phone: '599111222', seats: 3 }), input({ phone: '599111223', requestedDate: '2030-01-06', seats: 1 })] }, groupKey('siblings'));
    const unrelated = await successful(f, '/admin/bookings', 'POST', input({ phone: '599999999' }));
    const followup = await call(f);
    const endpoint = `/admin/calls/${followup.id}/bookings`;
    const active = await successful(f, endpoint);
    assert.deepEqual(active.bookings.map((row: any) => row.id), group.bookings.map((row: any) => row.id));
    const passengerCall = await call(f, group.bookings[1].phone);
    assert.deepEqual((await successful(f, `/admin/calls/${passengerCall.id}/bookings`)).bookings.map((row: any) => row.id), [group.bookings[1].id]);
    assert.equal((await f.request(`${endpoint}/${unrelated.id}/delete`, 'POST', {})).status, 404);
    const cancellation = await successful(f, `${endpoint}/${group.bookings[1].id}/delete`, 'POST', {});
    assert.ok(cancellation.deletedAt);
    assert.deepEqual((await successful(f, endpoint)).bookings.map((row: any) => row.id), [group.bookings[0].id, group.bookings[2].id]);
    assert.equal((await f.db.prepare('SELECT deleted_at FROM bookings WHERE id=?').get(group.bookings[0].id))?.deleted_at, null);
    assert.equal((await f.db.prepare('SELECT deleted_at FROM bookings WHERE id=?').get(group.bookings[2].id))?.deleted_at, null);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM call_booking_links WHERE call_id=?').get(inquiry.id))?.count, 3);
    // The unrelated order occupies the same slot, so only the sibling's three seats disappear.
    const capacity = await successful(f, `/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    assert.equal(capacity.bookedSeats, 4);
    assert.deepEqual({ ...(await f.db.prepare('SELECT booking_id,deleted_at FROM call_inquiries WHERE id=?').get(followup.id)) }, { booking_id: null, deleted_at: null });
    const history = await successful(f, '/admin/passengers/599111222');
    assert.equal(history.bookings.length, 1);
    assert.equal(history.bookings[0].id, group.bookings[1].id);
    assert.ok(history.bookings[0].deletedAt);
    await successful(f, `/admin/bookings/${group.bookings[1].id}/restore`, 'POST', {});
    assert.deepEqual((await successful(f, endpoint)).bookings.map((row: any) => row.id), group.bookings.map((row: any) => row.id));
  });
});

test('staff group requests accommodate many Georgian addresses while public booking requests retain their smaller body limit', async () => {
  await isolated(async f => {
    const inquiry = await call(f);
    const children = Array.from({ length: 32 }, (_, index) => input({ phone: '599' + String(index).padStart(6, '0'), goriAddress: 'ს'.repeat(250), seats: 1 }));
    const body = { bookings: children };
    assert.ok(Buffer.byteLength(JSON.stringify(body)) > 16 * 1024);
    const created = await f.request(`/admin/calls/${inquiry.id}/convert-group`, 'POST', body, groupKey('large-group'));
    assert.equal(created.status, 201);
    assert.equal(created.data.bookings.length, children.length);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM call_booking_links WHERE call_id=?').get(inquiry.id))?.count, children.length);
    const oversizedPublic = await f.request('/bookings', 'POST', input({ name: 'სატესტო მგზავრი', unused: 'x'.repeat(17 * 1024) }), {}, false);
    assert.equal(oversizedPublic.status, 413);
    assert.equal(oversizedPublic.data.code, 'VALIDATION');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM bookings').get())?.count, children.length);
  });
});

test('legacy single conversion keeps its response and replay semantics and links the booking for group-aware history', async () => {
  await isolated(async f => {
    const inquiry = await call(f);
    const first = await f.request(`/admin/calls/${inquiry.id}/convert`, 'POST', input());
    assert.equal(first.status, 200);
    assert.equal(typeof first.data.id, 'number');
    assert.equal(first.data.bookings, undefined);
    const again = await f.request(`/admin/calls/${inquiry.id}/convert`, 'POST', input({ phone: '599111222', seats: 1 }));
    assert.equal(again.status, 200);
    assert.deepEqual(again.data, first.data);
    assert.deepEqual({ ...(await f.db.prepare('SELECT call_id,booking_id FROM call_booking_links WHERE call_id=?').get(inquiry.id)) }, { call_id: inquiry.id, booking_id: first.data.id });
    const groupAttempt = await f.request(`/admin/calls/${inquiry.id}/convert-group`, 'POST', { bookings: [input(), input({ phone: '599111222' })] }, groupKey('legacy-already-converted'));
    assert.equal(groupAttempt.status, 409);
    assert.equal(groupAttempt.data.code, 'CALL_CONVERTED');
    const groupedCall = await call(f);
    const grouped = await successful(f, `/admin/calls/${groupedCall.id}/convert-group`, 'POST', { bookings: [input(), input({ phone: '599111222' })] }, groupKey('group-first'));
    const legacyRetry = await f.request(`/admin/calls/${groupedCall.id}/convert`, 'POST', input({ phone: '599999999' }));
    assert.equal(legacyRetry.status, 200);
    assert.deepEqual(legacyRetry.data, grouped.bookings[0]);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM bookings').get())?.count, 3);
  });
});

test('separate bookings can reuse one contact while preserving multiple saved addresses, and deleted calls remain protected', async () => {
  await isolated(async f => {
    const inquiry = await call(f);
    const children = [input({ goriAddress: 'პირველი შენახული სახლი 1' }), input({ goriAddress: 'მეორე შენახული სახლი 2', seats: 1, requestedTime: '09:30' })];
    const grouped = await successful(f, `/admin/calls/${inquiry.id}/convert-group`, 'POST', { bookings: children }, groupKey('multiple-addresses'));
    const passenger = await successful(f, '/admin/passengers/599111221');
    assert.equal(passenger.passenger.orderCount, 2);
    assert.equal(passenger.passenger.seats, 3);
    assert.deepEqual(passenger.profile.addresses.map((address: any) => address.address).sort(), children.map(child => child.goriAddress).sort());
    assert.deepEqual(passenger.bookings.map((row: any) => row.id).sort((a: number, b: number) => a - b), grouped.bookings.map((row: any) => row.id));
    const deletedCall = await call(f);
    await successful(f, `/admin/calls/${deletedCall.id}/delete`, 'POST', {});
    const before = await snapshot(f);
    const rejected = await f.request(`/admin/calls/${deletedCall.id}/convert-group`, 'POST', { bookings: [input()] }, groupKey('deleted-call'));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.data.code, 'DELETED');
    assert.deepEqual(await snapshot(f), before);
    const absent = await f.request('/admin/calls/999999/convert-group', 'POST', { bookings: [input()] }, groupKey('absent-call'));
    assert.equal(absent.status, 404);
    assert.equal(absent.data.code, 'NOT_FOUND');
    assert.deepEqual(await snapshot(f), before);
  });
});
