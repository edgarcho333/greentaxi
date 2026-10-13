import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createApp } from '../server/index.js';
import { createDatabase, postgresPoolOptions, type Database } from '../server/database.js';

type Read = { sql: string; parameters: any[]; count: number };
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'greentaxi-queue-traffic-'));
  let administration: pg.Pool | undefined;
  let databaseUrl: string | undefined;
  let schema: string | undefined;
  if (process.env.TEST_DATABASE_URL) {
    schema = `greentaxi_traffic_${randomBytes(8).toString('hex')}`;
    administration = new pg.Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL));
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(process.env.TEST_DATABASE_URL);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connection.toString();
  }
  const db = await createDatabase({ dbPath: join(directory, 'test.sqlite'), databaseUrl, production: false });
  const reads: Read[] = [];
  const measured: Database = {
    exec: sql => db.exec(sql), close: () => db.close(), transaction: operation => db.transaction(operation),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...parameters) => statement.run(...parameters),
        async get(...parameters) {
          const row = await statement.get(...parameters);
          reads.push({ sql, parameters, count: row ? 1 : 0 });
          return row;
        },
        async all(...parameters) {
          const rows = await statement.all(...parameters);
          reads.push({ sql, parameters, count: rows.length });
          return rows;
        },
      };
    },
  };
  const service = await createApp({ database: measured, production: false, now: () => new Date('2030-01-01T00:00:00Z'), deferPhoneMigration: false });
  const server = await new Promise<Server>(resolve => {
    const listener = service.app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  let cookie = '';
  async function request(path: string, method = 'GET', body?: unknown, authenticated = true) {
    const response = await fetch(base + path, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(authenticated ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any, headers: response.headers };
  }
  const setup = await request('/auth/setup', 'POST', { name: 'ტრაფიკის ოპერატორი', login: 'traffic_operator', password: 'traffic-test-password' });
  assert.equal(setup.status, 201);
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
  const device = await request('/admin/devices', 'POST', { name: 'Traffic TEST phone' });
  assert.equal(device.status, 201);
  let sequence = 0;
  async function inquiry(phone: string | null, extra: { bookingId?: number; deletedAt?: string; occurredAt?: string } = {}) {
    const result = await db.prepare(`INSERT INTO call_inquiries(device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at,phase,booking_id,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(device.data.device.id, `traffic-${++sequence}`, 'frozen-private-hash', phone,
      extra.occurredAt ?? '2030-01-01T00:00:00.000Z', 12, '2030-01-01T00:00:00.000Z', 'completed', extra.bookingId ?? null, extra.deletedAt ?? null);
    return Number(result.lastInsertRowid);
  }
  async function order(phone: string, extra: { caller?: string; status?: 'waiting' | 'confirmed'; deletedAt?: string; createdAt?: string } = {}) {
    const status = extra.status ?? 'confirmed';
    const stamp = extra.createdAt ?? '2029-12-30T00:00:00.000Z';
    const result = await db.prepare(`INSERT INTO bookings(name,phone,seats,direction,gori_address,didube_name,didube_address,
      requested_date,requested_time,assigned_date,assigned_time,status,source,created_at,updated_at,caller_phone,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('', phone, 1, 'gori-tbilisi', 'სატესტო სახლი 12', 'დიდუბე', 'სატესტო ადგილი',
      '2029-12-30', '08:30', status === 'confirmed' ? '2029-12-30' : null, status === 'confirmed' ? '08:30' : null,
      status, 'manual', stamp, stamp, extra.caller ?? null, extra.deletedAt ?? null);
    return Number(result.lastInsertRowid);
  }
  async function profile(phone: string, name = 'Traffic passenger', stamp = '2029-12-30T00:00:00.000Z') {
    await db.prepare('INSERT INTO passenger_profiles(phone,name,gori_address,updated_at,gori_pickup_address) VALUES (?,?,?,?,?)')
      .run(phone, name, 'სატესტო მისამართი', stamp, 'სატესტო მისამართი');
  }
  return {
    db, reads, request, inquiry, order, profile,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await service.close();
      if (administration && schema) { await administration.query(`DROP SCHEMA "${schema}" CASCADE`); await administration.end(); }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function isolated(operation: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try { await operation(f); } finally { await f.close(); }
}

test('incoming counts exclude converted/deleted calls and deleted/confirmed orders without reading any passenger data', async () => {
  await isolated(async f => {
    const converted = await f.order('599000001');
    await f.order('599000002', { status: 'waiting' });
    await f.order('599000003', { status: 'waiting' });
    await f.order('599000004', { status: 'waiting', deletedAt: '2030-01-01T00:00:00Z' });
    await f.inquiry('599000001');
    await f.inquiry(null);
    await f.inquiry('599000001', { bookingId: converted });
    await f.inquiry('599000001', { deletedAt: '2030-01-01T00:00:00Z' });
    f.reads.length = 0;
    const result = await f.request('/admin/incoming-counts');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { calls: 2, bookings: 2, total: 4 });
    assert.equal(f.reads.length, 2); // One session lookup and one scalar aggregate.
    assert.equal(f.reads[1].count, 1);
    assert.ok(f.reads[1].sql.includes('COUNT(*)'));
    assert.ok(!f.reads.some(read => /passenger_|SELECT\s+\*/i.test(read.sql)));
    assert.equal((await f.request('/admin/incoming-counts', 'GET', undefined, false)).status, 401);
  });
});

test('paged calls fetch and enrich only visible contacts, with deterministic ordering, authoritative pages and legacy compatibility', async () => {
  await isolated(async f => {
    const ids: number[] = [];
    for (let index = 0; index < 71; index++) {
      const phone = `599${String(index).padStart(6, '0')}`;
      ids.push(await f.inquiry(phone));
      await f.profile(phone);
      await f.order(phone);
    }
    f.reads.length = 0;
    const first = await f.request('/admin/calls?page=1&pageSize=15');
    assert.equal(first.status, 200);
    assert.deepEqual({ total: first.data.total, page: first.data.page, pageSize: first.data.pageSize }, { total: 71, page: 1, pageSize: 15 });
    assert.deepEqual(first.data.calls.map((call: any) => call.id), ids.slice(-15).reverse());
    assert.ok(first.data.calls.every((call: any) => call.passengerProfile?.phone === call.phone));
    const rows = f.reads.find(read => read.sql.includes('ORDER BY occurred_at DESC,id DESC LIMIT'));
    assert.ok(rows);
    assert.equal(rows.count, 15);
    assert.ok(!rows.sql.includes('request_hash'));
    assert.ok(!f.reads.some(read => /SELECT id,phone,caller_phone,created_at FROM bookings/.test(read.sql)));
    const visible = new Set(first.data.calls.flatMap((call: any) => [call.phone, `+995${call.phone}`, `995${call.phone}`, `00995${call.phone}`]));
    for (const read of f.reads.filter(read => /WHERE phone IN/.test(read.sql))) {
      assert.ok(read.parameters.every(phone => visible.has(phone)), 'Profiles, saved addresses and history must use only the visible contacts');
      assert.ok(read.count <= 15);
    }
    const next = await f.request('/admin/calls?page=2&pageSize=15');
    assert.deepEqual(next.data.calls.map((call: any) => call.id), ids.slice(-30, -15).reverse());
    const last = await f.request('/admin/calls?page=999999999999999&pageSize=15');
    assert.equal(last.data.page, 5);
    assert.equal(last.data.calls.length, 11);
    for (const pageSize of [30, 50]) {
      const page = await f.request(`/admin/calls?pageSize=${pageSize}`);
      assert.equal(page.data.page, 1);
      assert.equal(page.data.calls.length, pageSize);
    }
    const legacy = await f.request('/admin/calls');
    assert.deepEqual(Object.keys(legacy.data), ['calls']);
    assert.equal(legacy.data.calls.length, 71);
    assert.equal((await f.request('/admin/calls?page=1', 'GET', undefined, false)).status, 401);
    for (const suffix of ['page=0', 'page=-1', 'page=1.5', 'page=no', 'page=9007199254740992', 'page=1&page=2', 'pageSize=0', 'pageSize=16', 'pageSize=51', 'pageSize=15&pageSize=30']) {
      const result = await f.request('/admin/calls?' + suffix);
      assert.equal(result.status, 400, suffix);
      assert.equal(result.data.code, 'VALIDATION');
    }
  });
});

test('paged search filters and counts by caller, latest preferred contact, device and profile name before slicing all queue scopes', async () => {
  await isolated(async f => {
    const caller = '568694879';
    const contact = '599123456';
    const unrelated = '599765432';
    await f.order('599111111', { caller, createdAt: '2029-12-28T00:00:00.000Z' });
    await f.order(contact, { caller: '+995' + caller, createdAt: '2029-12-28T00:00:00.000Z', deletedAt: '2029-12-29T00:00:00Z' });
    await f.order(unrelated, { caller, status: 'waiting', createdAt: '2029-12-30T00:00:00.000Z' });
    await f.order(unrelated, { caller: contact, createdAt: '2029-12-30T00:00:00.000Z' });
    await f.profile('+995' + contact, 'Edgar Akopov');
    const aliases = [caller, '+995' + caller, '995' + caller, '00995' + caller];
    for (let index = 0; index < 40; index++) await f.inquiry(aliases[index % aliases.length]);
    const needle = await f.inquiry('598888888');
    const convertedBooking = await f.order('598888888');
    const converted = await f.inquiry(caller, { bookingId: convertedBooking });
    const deleted = await f.inquiry(caller, { deletedAt: '2030-01-01T00:00:00Z' });
    for (const search of ['568 69 48 79', '+995599123456', 'EDGAR AKOPOV', 'traffic test PHONE']) {
      const result = await f.request('/admin/calls?page=2&pageSize=15&search=' + encodeURIComponent(search));
      assert.equal(result.status, 200, search);
      assert.equal(result.data.total, search === 'traffic test PHONE' ? 41 : 40, search);
      assert.equal(result.data.calls.length, 15, search);
      const legacy = await f.request('/admin/calls?search=' + encodeURIComponent(search));
      assert.deepEqual(result.data.calls, legacy.data.calls.slice(15, 30), search);
    }
    const selected = await f.request('/admin/calls?page=999&pageSize=15&search=598888888');
    assert.equal(selected.data.total, 1);
    assert.equal(selected.data.page, 1);
    assert.deepEqual(selected.data.calls.map((call: any) => call.id), [needle]);
    const notTransitive = await f.request('/admin/calls?page=1&search=' + unrelated);
    assert.deepEqual(notTransitive.data, { calls: [], total: 0, page: 1, pageSize: 15 });
    for (const [scope, id] of [['converted', converted], ['deleted', deleted]] as const) {
      const result = await f.request(`/admin/calls?page=1&scope=${scope}&search=Edgar`);
      assert.equal(result.status, 200);
      assert.equal(result.data.total, 1);
      assert.equal(result.data.calls[0].id, id);
    }
    const literal = await f.request('/admin/calls?page=1&search=' + encodeURIComponent('%_'));
    assert.equal(literal.data.total, 0, 'Wildcards must be literal, not broaden customer searches');
    await f.db.prepare('UPDATE call_devices SET name=?').run('Traffic TEST phone %_\\');
    for (const search of ['%_', '\\', '%_\\']) {
      const result = await f.request('/admin/calls?page=1&search=' + encodeURIComponent(search));
      assert.equal(result.status, 200);
      assert.equal(result.data.total, 41, 'A literal wildcard/backslash may match the actual device name');
    }
  });
});

test('paged preference preserves foreign identities and skips invalid historical contact numbers', async () => {
  await isolated(async f => {
    const caller = '+447700900123';
    const contact = '+447700900456';
    await f.order(contact.slice(1), { caller, createdAt: '2029-12-28T00:00:00.000Z' });
    await f.order('invalid-number', { caller, createdAt: '2029-12-29T00:00:00.000Z' });
    await f.profile(contact, 'Foreign passenger');
    await f.inquiry(caller);
    const paged = await f.request('/admin/calls?page=1&search=Foreign');
    assert.equal(paged.status, 200);
    assert.equal(paged.data.total, 1);
    assert.equal(paged.data.calls[0].bookingPhone, contact);
    const legacy = await f.request('/admin/calls?search=Foreign');
    assert.deepEqual(paged.data.calls, legacy.data.calls);
    await f.inquiry('unrepairable-legacy-number');
    const all = await f.request('/admin/calls?page=1');
    assert.equal(all.status, 200);
    assert.equal(all.data.calls.length, 2);
    assert.equal(all.data.calls[0].phone, 'unrepairable-legacy-number');
    assert.equal(all.data.calls[0].passengerProfile, null);
  });
});
