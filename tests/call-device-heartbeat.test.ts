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

const START = '2030-01-01T04:00:00.000Z';
const HEARTBEAT = '/integrations/android/heartbeat';
const health = (extra: Record<string, unknown> = {}) => ({
  appVersion: '0.2.2', androidVersion: '11', monitoring: true,
  pendingCount: 0, oldestPendingAt: null, lastError: null, ...extra,
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'greentaxi-device-heartbeat-'));
  let pool: pg.Pool | undefined, schema: string | undefined, databaseUrl = '';
  if (process.env.TEST_DATABASE_URL) {
    schema = `device_heartbeat_${randomBytes(8).toString('hex')}`;
    pool = new pg.Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL));
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(process.env.TEST_DATABASE_URL);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connection.toString();
  }
  const db = await createDatabase({ dbPath: join(directory, 'test.sqlite'), databaseUrl, production: false });
  let instant = new Date(START);
  const service = await createApp({ database: db, production: false, now: () => instant });
  const server = await new Promise<Server>(resolve => { const listener = service.app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  let cookie = '';
  async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, staff = true) {
    const response = await fetch(base + path, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(staff && cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any, headers: response.headers };
  }
  async function ok(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>, staff = true) {
    const response = await request(path, method, body, headers, staff);
    assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: HTTP ${response.status}, ${response.data.code ?? ''}`);
    return response.data;
  }
  const setup = await request('/auth/setup', 'POST', { login: 'phone_operator', name: 'Phone fixture', password: 'phone-heartbeat-test-password-123' });
  assert.equal(setup.status, 201); cookie = setup.headers.get('set-cookie')!.split(';')[0];
  async function device(name = 'Samsung A02 fixture') { return ok('/admin/devices', 'POST', { name }); }
  async function beat(token: string, body: unknown = health()) { return request(HEARTBEAT, 'POST', body, { Authorization: `Bearer ${token}` }, false); }
  async function listed(id: number, path = '/admin/devices/status') { return (await ok(path)).devices.find((item: any) => item.id === id); }
  return { db, request, ok, device, beat, listed, setNow(value: string) { instant = new Date(value); }, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await service.close();
    if (pool && schema) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    rmSync(directory, { recursive: true, force: true });
  } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function isolated(operation: (f: Fixture) => Promise<void>) { const f = await fixture(); try { await operation(f); } finally { await f.close(); } }

test('device heartbeat upserts only diagnostics using server time, without changing calls, bookings, pairing or last received call', async () => {
  await isolated(async f => {
    const paired = await f.device();
    const legacyStamp = '2029-12-31T18:00:00.000Z';
    await f.db.prepare('UPDATE call_devices SET last_seen_at=? WHERE id=?').run(legacyStamp, paired.device.id);
    const snapshot = await f.db.prepare('SELECT * FROM call_devices ORDER BY id').all();
    const auditBefore = await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get();
    const response = await f.beat(paired.token, health({ pendingCount: 3, oldestPendingAt: '2030-01-01T07:59:00+04:00', lastError: 'network', receivedAt: '2099-01-01T00:00:00Z', token: 'must-not-be-stored' }));
    assert.equal(response.status, 200); assert.deepEqual(response.data, { receivedAt: START });
    const first = await f.listed(paired.device.id);
    assert.equal(first.connectionState, 'online'); assert.equal(first.lastSeenAt, legacyStamp);
    assert.deepEqual(first.heartbeat, { receivedAt: START, appVersion: '0.2.2', androidVersion: '11', monitoring: true,
      pendingCount: 3, oldestPendingAt: '2030-01-01T03:59:00.000Z', lastError: 'network' });
    assert.deepEqual(await f.db.prepare('SELECT * FROM call_devices ORDER BY id').all(), snapshot);
    assert.deepEqual(await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), auditBefore);
    for (const table of ['call_inquiries', 'bookings', 'passenger_profiles']) assert.equal(Number((await f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())!.count), 0, table);
    f.setNow('2030-01-01T04:01:00.000Z');
    assert.equal((await f.beat(paired.token, health({ appVersion: '0.2.3', pendingCount: 0 }))).status, 200);
    const second = await f.listed(paired.device.id, '/admin/devices');
    assert.equal(second.heartbeat.receivedAt, '2030-01-01T04:01:00.000Z');
    assert.equal(second.heartbeat.appVersion, '0.2.3'); assert.equal(second.heartbeat.pendingCount, 0);
    assert.equal(second.heartbeat.oldestPendingAt, null); assert.equal(second.heartbeat.lastError, null);
    assert.equal(Number((await f.db.prepare('SELECT COUNT(*) AS count FROM call_device_heartbeats').get())!.count), 1);
    const stored = JSON.stringify(await f.db.prepare('SELECT * FROM call_device_heartbeats').all());
    assert.ok(!stored.includes(paired.token)); assert.ok(!stored.includes('must-not-be-stored'));
  });
});

test('staff connection states distinguish old apps, fresh monitoring, stale reports and revoked devices independently of the phone clock', async () => {
  await isolated(async f => {
    const paired = await f.device();
    const before = await f.listed(paired.device.id);
    assert.equal(before.connectionState, 'unknown'); assert.equal(before.heartbeat, null);
    assert.equal((await f.beat(paired.token, health({ pendingCount: 2, oldestPendingAt: '2099-01-01T00:00:00Z' }))).status, 200);
    assert.equal((await f.listed(paired.device.id)).connectionState, 'online', 'Phone clock does not decide whether a report is fresh');
    f.setNow('2030-01-01T04:02:30.000Z');
    assert.equal((await f.listed(paired.device.id)).connectionState, 'online');
    f.setNow('2030-01-01T04:02:30.001Z');
    const stale = await f.listed(paired.device.id); assert.equal(stale.connectionState, 'stale');
    assert.equal(stale.heartbeat.pendingCount, 2, 'A stale report retains the last reported count rather than fabricating a live count');
    assert.equal(stale.heartbeat.receivedAt, START);
    assert.equal((await f.beat(paired.token, health({ monitoring: false }))).status, 200);
    assert.equal((await f.listed(paired.device.id)).connectionState, 'stale');
    assert.equal((await f.beat(paired.token)).status, 200);
    assert.equal((await f.listed(paired.device.id)).connectionState, 'online');
    f.setNow('2029-12-31T23:59:00.000Z');
    assert.equal((await f.listed(paired.device.id)).connectionState, 'stale', 'Future server reports cannot count as live after the server clock moves backwards');
    await f.ok(`/admin/devices/${paired.device.id}`, 'PATCH', { active: false });
    assert.equal((await f.listed(paired.device.id)).connectionState, 'disabled');
  });
});

test('heartbeat and status endpoints enforce device and staff scopes, isolate reports by device and honor revocation', async () => {
  await isolated(async f => {
    const first = await f.device(), second = await f.device('Galaxy A14 fixture');
    for (const authorization of [undefined, 'Bearer invalid', `Bearer gtdevice_${'1'.repeat(64)}`]) {
      const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
      const response = await f.request(HEARTBEAT, 'POST', health(), headers, false);
      assert.equal(response.status, 401); assert.equal(response.data.code, 'DEVICE_UNAUTHORIZED');
    }
    assert.equal((await f.request(HEARTBEAT, 'POST', health())).status, 401, 'Staff session is not an Android device token');
    for (const path of ['/admin/devices', '/admin/devices/status']) {
      assert.equal((await f.request(path, 'GET', undefined, {}, false)).status, 401);
      assert.equal((await f.request(path, 'GET', undefined, { Authorization: `Bearer ${first.token}` }, false)).status, 401);
    }
    assert.equal((await f.beat(first.token, health({ pendingCount: 7, lastError: 'http_503' }))).status, 200);
    assert.equal((await f.listed(first.device.id)).heartbeat.pendingCount, 7);
    assert.equal((await f.listed(second.device.id)).heartbeat, null);
    assert.equal((await f.listed(second.device.id)).connectionState, 'unknown');
    const rows = (await f.ok('/admin/devices/status')).devices;
    const exposed = JSON.stringify(rows);
    assert.ok(!exposed.includes(first.token)); assert.ok(!exposed.includes(second.token));
    assert.ok(!exposed.includes('token_hash')); assert.ok(!exposed.includes('request_hash'));
    const report = await f.db.prepare('SELECT * FROM call_device_heartbeats WHERE device_id=?').get(first.device.id);
    await f.ok(`/admin/devices/${first.device.id}`, 'PATCH', { active: false });
    const revoked = await f.beat(first.token, health({ pendingCount: 0 }));
    assert.equal(revoked.status, 401); assert.equal(revoked.data.code, 'DEVICE_UNAUTHORIZED');
    assert.deepEqual(await f.db.prepare('SELECT * FROM call_device_heartbeats WHERE device_id=?').get(first.device.id), report);
    assert.equal((await f.listed(first.device.id)).connectionState, 'disabled');
  });
});

test('invalid heartbeat versions, counts, timestamps and diagnostic text never replace the last valid report', async () => {
  await isolated(async f => {
    const paired = await f.device();
    assert.equal((await f.beat(paired.token, health({ pendingCount: 1, oldestPendingAt: '2030-01-01T03:59:00Z' }))).status, 200);
    const before = await f.db.prepare('SELECT * FROM call_device_heartbeats WHERE device_id=?').get(paired.device.id);
    const invalid: Record<string, unknown>[] = [
      { appVersion: '' }, { appVersion: 'a'.repeat(33) }, { appVersion: '<script>' }, { appVersion: '0.2.2\nsecret' },
      { androidVersion: '' }, { androidVersion: 'x'.repeat(33) }, { androidVersion: '11\u0000' },
      { monitoring: 1 }, { monitoring: 'true' }, { pendingCount: -1 }, { pendingCount: 100001 }, { pendingCount: 1.5 }, { pendingCount: '2' },
      { oldestPendingAt: '' }, { oldestPendingAt: 'not-a-date' }, { oldestPendingAt: '2030-02-30T00:00:00Z' },
      { oldestPendingAt: '2030-01-01T00:00:00' }, { oldestPendingAt: 123 },
      { lastError: 'network token=secret' }, { lastError: 'http_999' }, { lastError: '' }, { lastError: 1 },
    ];
    for (const fields of invalid) {
      const response = await f.beat(paired.token, health(fields));
      assert.equal(response.status, 400, JSON.stringify(fields));
      assert.deepEqual(await f.db.prepare('SELECT * FROM call_device_heartbeats WHERE device_id=?').get(paired.device.id), before);
    }
    for (const missing of ['appVersion', 'androidVersion', 'monitoring', 'pendingCount', 'oldestPendingAt', 'lastError']) {
      const body: Record<string, unknown> = health(); delete body[missing];
      assert.equal((await f.beat(paired.token, body)).status, 400, missing);
    }
    for (const lastError of ['network', 'http_401', 'http_429', 'http_503', 'permission', 'storage', 'unknown', null]) {
      assert.equal((await f.beat(paired.token, health({ lastError }))).status, 200, String(lastError));
    }
  });
});

test('legacy connection checks and call delivery retain their original lastSeen behavior alongside independent heartbeats', async () => {
  await isolated(async f => {
    const paired = await f.device();
    const bearer = { Authorization: `Bearer ${paired.token}` };
    const auditBefore = await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get();
    const connected = await f.ok('/integrations/android/connection', 'GET', undefined, bearer, false);
    assert.deepEqual(connected, { connected: true, device: { id: paired.device.id, name: paired.device.name } });
    assert.equal((await f.listed(paired.device.id)).lastSeenAt, null);
    assert.equal((await f.listed(paired.device.id)).heartbeat, null);
    assert.deepEqual(await f.db.prepare('SELECT COUNT(*) AS count FROM audit_log').get(), auditBefore);
    const event = { eventId: 'heartbeat-independent-call', kind: 'incoming', phase: 'answered', phone: '555960001', occurredAt: START, durationSeconds: 0 };
    const delivered = await f.request('/integrations/android/calls', 'POST', event, bearer, false);
    assert.equal(delivered.status, 201);
    const inquiry = await f.db.prepare('SELECT * FROM call_inquiries WHERE id=?').get(delivered.data.id);
    assert.equal((await f.listed(paired.device.id)).lastSeenAt, START);
    assert.equal((await f.listed(paired.device.id)).connectionState, 'unknown', 'Calls do not pretend to be a regular health signal');
    f.setNow('2030-01-01T04:01:00.000Z');
    assert.equal((await f.beat(paired.token)).status, 200);
    assert.deepEqual(await f.db.prepare('SELECT * FROM call_inquiries WHERE id=?').get(delivered.data.id), inquiry);
    assert.equal((await f.listed(paired.device.id)).lastSeenAt, START);
    assert.equal((await f.listed(paired.device.id)).heartbeat.receivedAt, '2030-01-01T04:01:00.000Z');
    const repeated = await f.request('/integrations/android/calls', 'POST', event, bearer, false);
    assert.equal(repeated.status, 200); assert.equal(repeated.data.id, delivered.data.id);
    assert.equal(Number((await f.db.prepare('SELECT COUNT(*) AS count FROM call_inquiries').get())!.count), 1);
    assert.equal((await f.listed(paired.device.id)).lastSeenAt, '2030-01-01T04:01:00.000Z');
  });
});
