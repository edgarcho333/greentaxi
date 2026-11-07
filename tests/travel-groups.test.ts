import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createDatabase, postgresPoolOptions } from '../server/database.js';
import { createApp } from '../server/index.js';

const DAY = '2030-01-02';
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'greentaxi-travel-groups-'));
  const schema = `party_${randomUUID().replaceAll('-', '')}`;
  let administration: pg.Pool | undefined;
  let databaseUrl = '';
  if (process.env.TEST_DATABASE_URL) {
    administration = new pg.Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL));
    await administration.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(process.env.TEST_DATABASE_URL);
    connection.searchParams.set('options', `-csearch_path=${schema}`);
    databaseUrl = connection.toString();
  }
  const database = await createDatabase({ dbPath: join(directory, 'test.sqlite'), databaseUrl, production: false });
  const service = await createApp({ database, now: () => new Date('2030-01-01T00:00:00Z'), deferPhoneMigration: false });
  const server = await new Promise<Server>(resolve => { const listener = service.app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let staff = '', driver = '';
  async function request(path: string, method = 'GET', body?: unknown, actor: 'staff' | 'driver' | 'none' = 'staff', extra: Record<string, string> = {}) {
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(actor === 'staff' && staff ? { Cookie: staff } : actor === 'driver' && driver ? { Cookie: driver } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any, headers: response.headers };
  }
  async function ok(path: string, method = 'GET', body?: unknown, actor: 'staff' | 'driver' | 'none' = 'staff', headers?: Record<string, string>) {
    const response = await request(path, method, body, actor, headers);
    assert.ok(response.status >= 200 && response.status < 300, `${path}: ${response.status} ${response.data.code ?? ''}`);
    return response.data;
  }
  const employee = await request('/auth/setup', 'POST', { login: 'party_operator', name: 'Party operator', password: 'test-only-party-password' }, 'none');
  assert.equal(employee.status, 201); staff = employee.headers.get('set-cookie')!.split(';')[0];
  return {
    db: database, request, ok,
    async assign(id: number, time = '08:30') {
      const plan = await ok(`/admin/trips/capacity?direction=gori-tbilisi&date=${DAY}&time=${time}`);
      await ok('/admin/trips/drivers', 'POST', { direction: 'gori-tbilisi', date: DAY, time, expectedRevision: plan.revision, action: 'add', driver: { kind: 'roster', id } });
    },
    async login(id: number) {
      const phone = `59973000${id}`;
      await ok(`/admin/drivers/${id}/phone`, 'PATCH', { phone });
      const response = await request('/driver/auth/login', 'POST', { phone }, 'none');
      assert.equal(response.status, 200); driver = response.headers.get('set-cookie')!.split(';')[0];
    },
    dashboard: () => ok(`/driver/dashboard?date=${DAY}`, 'GET', undefined, 'driver'),
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await service.close();
      if (administration) { await administration.query(`DROP SCHEMA ${schema} CASCADE`); await administration.end(); }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const input = (overrides: Record<string, unknown> = {}) => ({ phone: '599731001', seats: 1, direction: 'gori-tbilisi', requestedDate: DAY, requestedTime: '08:30', goriAddress: 'პირველი მისამართი 1', ...overrides });
const key = () => ({ 'Idempotency-Key': randomUUID() });

test('a manual passenger party has durable identity while contacts, seats, replays and individual trip changes remain independent', async () => {
  const f = await fixture();
  try {
    await f.assign(1); await f.assign(1, '09:30'); await f.assign(2);
    const body = { bookings: [input({ callerPhone: '599739999', seats: 2 }), input({ phone: '599731002', goriAddress: 'მეორე მისამართი 2', dog: true })] };
    const headers = key();
    const grouped = await f.ok('/admin/bookings/group', 'POST', body, 'staff', headers);
    const [first, second] = grouped.bookings;
    assert.ok(first.travelGroupId && !first.travelGroupId.includes(':'));
    assert.equal(first.travelGroupId, second.travelGroupId);
    assert.deepEqual(grouped.bookings.map((booking: any) => booking.travelGroupOrder), [0, 1]);
    assert.deepEqual((await f.ok('/admin/bookings/group', 'POST', body, 'staff', headers)).bookings, grouped.bookings);
    const single = await f.ok('/admin/bookings', 'POST', input({ callerPhone: '599739999' }));
    assert.equal(single.travelGroupId, null, 'A matching caller and address never imply a party');
    const onlyOne = await f.ok('/admin/bookings/group', 'POST', { bookings: [input({ phone: '599731003' })] }, 'staff', key());
    assert.equal(onlyOne.bookings[0].travelGroupId, null);
    for (const id of [1, 2]) {
      await f.login(id);
      const visible = (await f.dashboard()).bookings;
      const members = visible.filter((booking: any) => booking.travelGroupId === first.travelGroupId);
      assert.deepEqual(members.map((booking: any) => [booking.id, booking.travelGroupOrder, booking.phone, booking.seats]),
        [[first.id, 0, '599731001', 2], [second.id, 1, '599731002', 1]]);
      assert.equal(visible.find((booking: any) => booking.id === single.id).travelGroupId, null);
    }
    await f.ok(`/admin/bookings/${second.id}/move`, 'POST', { date: DAY, time: '09:30' });
    await f.login(1);
    let visible = (await f.dashboard()).bookings;
    for (const id of [first.id, second.id]) assert.deepEqual([
      visible.find((booking: any) => booking.id === id).travelGroupId,
      visible.find((booking: any) => booking.id === id).travelGroupOrder,
    ], [null, null], 'Different departures must not imply the same vehicle');
    await f.ok(`/admin/bookings/${second.id}/move`, 'POST', { date: DAY, time: '08:30' });
    await f.ok(`/admin/bookings/${first.id}/delete`, 'POST', {});
    visible = (await f.dashboard()).bookings;
    assert.equal(visible.some((booking: any) => booking.id === first.id), false);
    assert.equal(visible.find((booking: any) => booking.id === second.id).travelGroupId, null);
    const stored = await f.db.prepare('SELECT travel_group_id,travel_group_order FROM bookings WHERE id=?').get(first.id);
    assert.equal(stored?.travel_group_id, first.travelGroupId);
    await f.ok(`/admin/bookings/${first.id}/restore`, 'POST', {});
    visible = (await f.dashboard()).bookings.filter((booking: any) => booking.travelGroupId === first.travelGroupId);
    assert.deepEqual(visible.map((booking: any) => booking.travelGroupOrder), [0, 1]);
    const profiles = await f.db.prepare('SELECT phone FROM passenger_profiles ORDER BY phone').all();
    assert.ok(profiles.some(row => row.phone === '599731001') && profiles.some(row => row.phone === '599731002'));
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM bookings').get())?.count, 4);
  } finally { await f.close(); }
});

test('call conversion links the party once and later call completion never changes membership or passenger identity', async () => {
  const f = await fixture();
  try {
    const device = await f.ok('/admin/devices', 'POST', { name: 'Party call fixture' });
    const call = { eventId: randomUUID(), phone: null, occurredAt: '2030-01-01T00:01:00Z', durationSeconds: 0, kind: 'incoming', phase: 'answered' };
    const bearer = { Authorization: `Bearer ${device.token}` };
    const inquiry = await f.ok('/integrations/android/calls', 'POST', call, 'none', bearer);
    const headers = key(); const body = { bookings: [input(), input({ phone: '599731002', goriAddress: 'მეორე სახლი 2' })] };
    const result = await f.ok(`/admin/calls/${inquiry.id}/convert-group`, 'POST', body, 'staff', headers);
    assert.equal(result.bookings[0].travelGroupId, result.bookings[1].travelGroupId);
    assert.ok(result.bookings[0].travelGroupId);
    assert.deepEqual((await f.ok(`/admin/calls/${inquiry.id}/convert-group`, 'POST', body, 'staff', headers)).bookings, result.bookings);
    await f.ok('/integrations/android/calls', 'POST', { ...call, phone: '599739999', durationSeconds: 31, phase: 'completed' }, 'none', bearer);
    const stored = await f.db.prepare('SELECT id,phone,caller_phone,travel_group_id,travel_group_order FROM bookings ORDER BY id').all();
    assert.deepEqual(stored.map(row => [row.id, row.phone, row.caller_phone, row.travel_group_id, row.travel_group_order]),
      result.bookings.map((booking: any, index: number) => [booking.id, booking.phone, '599739999', booking.travelGroupId, index]));
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM call_booking_links').get())?.count, 2);
  } finally { await f.close(); }
});

test('driver group metadata never exposes whole-car siblings or hidden original positions', async () => {
  const f = await fixture();
  try {
    await f.assign(3);
    const options = await f.ok(`/admin/trips/whole-car-options?direction=gori-tbilisi&date=${DAY}&time=08:30`);
    const firstCar = options.drivers.find((driver: any) => driver.driverId === 1);
    const secondCar = options.drivers.find((driver: any) => driver.driverId === 2);
    const group = await f.ok('/admin/bookings/group', 'POST', { bookings: [
      input({ phone: '599732001', bookingType: 'whole_car', assignedVehicleKey: firstCar.key, expectedVehicleRevision: firstCar.revision }),
      input({ phone: '599732002' }), input({ phone: '599732003', bookingType: 'parcel' }),
      input({ phone: '599732004', bookingType: 'whole_car', assignedVehicleKey: secondCar.key, expectedVehicleRevision: secondCar.revision }),
    ] }, 'staff', key());
    assert.equal(new Set(group.bookings.map((booking: any) => booking.travelGroupId)).size, 1);
    for (const id of [1, 2]) {
      await f.login(id);
      const visible = (await f.dashboard()).bookings;
      assert.equal(visible.length, 1);
      assert.equal(visible[0].travelGroupId, null);
      assert.equal(visible[0].travelGroupOrder, null);
    }
    await f.login(3);
    const visible = (await f.dashboard()).bookings;
    assert.deepEqual(visible.map((booking: any) => booking.id), [group.bookings[1].id, group.bookings[2].id]);
    assert.deepEqual(visible.map((booking: any) => booking.travelGroupOrder), [0, 1]);
    assert.ok(visible.every((booking: any) => booking.travelGroupId === group.bookings[0].travelGroupId));
    assert.equal(JSON.stringify(visible).includes('599732001'), false);
    assert.equal(JSON.stringify(visible).includes('599732004'), false);
  } finally { await f.close(); }
});
