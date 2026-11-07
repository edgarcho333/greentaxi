import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createDatabase, postgresPoolOptions, type Database } from '../server/database.js';

for (const dialect of ['sqlite', 'postgres'] as const) {
  test(`${dialect} party upgrade recovers only proven historical groups and preserves every older field and receipt`,
    { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL }, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'greentaxi-party-upgrade-'));
      const schema = `party_upgrade_${randomUUID().replaceAll('-', '')}`;
      let administration: pg.Pool | undefined;
      let databaseUrl = '';
      let db: Database | undefined;
      if (dialect === 'postgres') {
        administration = new pg.Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL!));
        await administration.query(`CREATE SCHEMA ${schema}`);
        const connection = new URL(process.env.TEST_DATABASE_URL!);
        connection.searchParams.set('options', `-csearch_path=${schema}`);
        databaseUrl = connection.toString();
      }
      const open = () => createDatabase({ dbPath: join(directory, 'test.sqlite'), databaseUrl, production: false });
      try {
        db = await open();
        const stamp = '2030-01-01T00:00:00.000Z';
        for (let id = 1; id <= 15; id++) {
          await db.prepare(`INSERT INTO bookings(id,name,phone,seats,direction,gori_address,didube_name,didube_address,
            requested_date,requested_time,assigned_date,assigned_time,status,source,created_at,updated_at,deleted_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, `Passenger ${id}`, '599123456', 1, 'gori-tbilisi', `House ${id}`, 'Didube', 'Terminal',
          '2030-01-02', '08:30', id === 2 ? '2030-01-03' : '2030-01-02', '08:30', 'confirmed', id >= 11 ? 'android' : 'employee', stamp, stamp,
          id === 2 ? '2030-01-01T01:00:00.000Z' : null);
        }
        await db.prepare('INSERT INTO call_devices(id,name,token_hash,active,created_at) VALUES (1,?,?,1,?)')
          .run('Preserved receiver', 'synthetic-pairing-hash', stamp);
        for (const id of [1, 2, 3]) await db.prepare(`INSERT INTO call_inquiries(id,device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at)
          VALUES (?,1,?,?,?, ?,0,?)`).run(id, `event-${id}`, `request-hash-${id}`, '599123456', stamp, stamp);
        for (const [call, booking] of [[1, 11], [1, 12], [2, 13], [2, 14], [3, 14], [3, 15]]) {
          await db.prepare('INSERT INTO call_booking_links(call_id,booking_id) VALUES (?,?)').run(call, booking);
        }
        let receiptSequence = 0;
        const receipt = async (payload: unknown, scope = 'employee-booking-group:1', status = 201, raw = false) => {
          await db!.prepare('INSERT INTO idempotency(scope,key,request_hash,status,response,created_at) VALUES (?,?,?,?,?,?)')
            .run(scope, `stored-group-${++receiptSequence}`, `original-body-hash-${receiptSequence}`, status,
              raw ? String(payload) : JSON.stringify(payload), 1893456000000);
        };
        const members = (ids: number[]) => ({ bookings: ids.map(id => ({ id, createdAt: stamp })) });
        await receipt(members([1, 2])); // Proven manual group, including a later moved/deleted child.
        await receipt(members([3, 4])); await receipt(members([4, 5])); // Conflicting receipts cannot merge parties.
        await receipt('{invalid json', undefined, undefined, true);
        await receipt({ bookings: [{ id: 6, createdAt: stamp }, 'not an object'] });
        await receipt(`{"bookings":[{"id":1e100,"createdAt":"${stamp}"},{"id":7,"createdAt":"${stamp}"}]}`, undefined, undefined, true);
        await receipt(`{"bookings":[{"id":999999999999999999999999999999,"createdAt":"${stamp}"},{"id":7,"createdAt":"${stamp}"}]}`, undefined, undefined, true);
        await receipt(members([8, 8]));
        await receipt({ bookings: [{ id: 9, createdAt: stamp }, { id: 10, createdAt: 'different creation' }] });
        await receipt(members([9, 999999]));
        await receipt(members([9, 10]), 'employee-booking:1');
        await receipt(members([6, 7]), undefined, 409);
        await receipt({ bookings: [{ id: '9', createdAt: stamp }, { id: 10, createdAt: stamp }] });
        await receipt({ bookings: [null, [], 'invalid-json-item'] });
        await receipt(members([6, 11])); // A manual receipt cannot claim an Android child.
        await receipt(members([11, 12]), 'call-convert-group:1'); // Same call proof is not a competing party.

        const first = await db.prepare('SELECT * FROM bookings LIMIT 1').get();
        const bookingColumns = Object.keys(first!).filter(name => !['travel_group_id', 'travel_group_order'].includes(name)).join(',');
        await db.exec('ALTER TABLE bookings DROP COLUMN travel_group_order; ALTER TABLE bookings DROP COLUMN travel_group_id; DELETE FROM schema_versions WHERE version=20;');
        const tableRows = await db.prepare(dialect === 'postgres'
          ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name"
          : "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        const query = (table: string) => `SELECT ${table === 'bookings' ? bookingColumns : '*'} FROM ${table}${table === 'schema_versions' ? ' WHERE version<20' : ''} ORDER BY 1,2`;
        const snapshots = new Map<string, string>();
        for (const table of tableRows) snapshots.set(String(table.name), JSON.stringify(await db.prepare(query(String(table.name))).all()));
        await db.close(); db = undefined;

        let previousGroups: string | undefined;
        for (let pass = 0; pass < 2; pass++) {
          db = await open();
          assert.equal((await db.prepare('SELECT MAX(version) AS version FROM schema_versions').get())?.version, 20);
          for (const [table, snapshot] of snapshots) assert.equal(JSON.stringify(await db.prepare(query(table)).all()), snapshot, `${table}: existing business data changed`);
          const grouped = await db.prepare('SELECT id,travel_group_id,travel_group_order FROM bookings ORDER BY id').all();
          for (const pair of [[1, 2], [11, 12]]) {
            const [first, second] = pair.map(id => grouped.find(row => row.id === id)!);
            assert.match(first.travel_group_id, /^[a-f0-9]{32}$/);
            assert.equal(second.travel_group_id, first.travel_group_id);
            assert.deepEqual([first.travel_group_order, second.travel_group_order], [0, 1]);
          }
          assert.notEqual(grouped[0].travel_group_id, grouped[10].travel_group_id);
          for (const id of [3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15]) {
            assert.deepEqual([grouped[id - 1].travel_group_id, grouped[id - 1].travel_group_order], [null, null], `Unproven booking ${id} was grouped`);
          }
          if (previousGroups) assert.equal(JSON.stringify(grouped), previousGroups, 'Reopening must not recompute group identities');
          previousGroups = JSON.stringify(grouped);
          if (dialect === 'sqlite') assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all(), []);
          await db.close(); db = undefined;
        }
      } finally {
        await db?.close();
        if (administration) { await administration.query(`DROP SCHEMA ${schema} CASCADE`); await administration.end(); }
        rmSync(directory, { recursive: true, force: true });
      }
    });
}
