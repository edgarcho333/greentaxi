import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createDatabase, postgresPoolOptions, postgresSql, type Database } from '../server/database.js';

const OLD_CALL_COLUMNS = 'id,device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at,deleted_at,booking_id,phase,answered_hash,legacy_hash';
const PRE020_BOOKING_COLUMNS = 'id,name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,didube_name,didube_address,requested_date,requested_time,assigned_date,assigned_time,status,deleted_at,source,created_at,updated_at,booking_type,assigned_vehicle_key,assigned_vehicle_name,caller_phone,luggage,dog,seat_preference';

for (const dialect of ['sqlite', 'postgres'] as const) {
  test(`${dialect} all-incoming migration adds nullable status without changing any existing data, pairing or call links`,
    { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL }, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'greentaxi-call-status-upgrade-'));
      const dbPath = join(directory, 'version18.sqlite');
      const schema = `call_status_${randomUUID().replaceAll('-', '')}`;
      let administration: Pool | undefined;
      let stored: Pool | undefined;
      let sqlite: import('node:sqlite').DatabaseSync | undefined;
      let databaseUrl = '';
      let database: Database | undefined;
      try {
        if (dialect === 'postgres') {
          administration = new Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL!));
          await administration.query(`CREATE SCHEMA ${schema}`);
          const connection = new URL(process.env.TEST_DATABASE_URL!);
          connection.searchParams.set('options', `-csearch_path=${schema}`);
          databaseUrl = connection.toString();
          stored = new Pool(postgresPoolOptions(databaseUrl));
        } else {
          const { DatabaseSync } = await import('node:sqlite');
          sqlite = new DatabaseSync(dbPath);
          sqlite.exec('PRAGMA foreign_keys=ON');
        }
        const exec = async (sql: string) => { if (stored) await stored.query(sql); else sqlite!.exec(sql); };
        const run = async (sql: string, ...values: (string | number | null)[]) => {
          if (stored) await stored.query(postgresSql(sql, false), values); else sqlite!.prepare(sql).run(...values);
        };
        const rows = async (sql: string) => {
          if (!stored) return sqlite!.prepare(sql).all().map(row => ({ ...row }));
          const result = await stored.query(sql);
          const integers = result.fields.filter(field => [20, 21, 23].includes(field.dataTypeID));
          return result.rows.map(row => {
            for (const field of integers) if (typeof row[field.name] === 'string') row[field.name] = Number(row[field.name]);
            return row;
          });
        };
        await exec('CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
        const migrations = (await readdir(new URL('../server/migrations/', import.meta.url)))
          .filter(name => new RegExp(`^\\d+_.+\\.${dialect}\\.sql$`).test(name) && Number(name.split('_')[0]) <= 18)
          .sort();
        assert.equal(migrations.length, 18);
        for (const name of migrations) {
          const sql = await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8');
          await exec(sql);
          await run('INSERT INTO schema_versions(version,name,checksum,applied_at) VALUES (?,?,?,?)',
            Number(name.split('_')[0]), name, createHash('sha256').update(sql).digest('hex'), '2030-01-01T00:00:00.000Z');
        }
        const stamp = '2030-01-01T00:00:00.000Z';
        await run('INSERT INTO users(id,login,name,password_hash,created_at) VALUES (?,?,?,?,?)',
          901, 'preserved-operator', 'Stored operator', 'synthetic-password-hash', stamp);
        await run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)', 'synthetic-session-hash', 901, 1893456000000);
        await run('INSERT INTO call_devices(id,name,token_hash,active,created_at,last_seen_at) VALUES (?,?,?,?,?,?)',
          902, 'Stored Samsung', 'synthetic-pairing-hash', 1, stamp, stamp);
        await run(`INSERT INTO bookings(id,name,phone,seats,direction,gori_address,didube_name,didube_address,
          requested_date,requested_time,assigned_date,assigned_time,status,source,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        903, 'Stored passenger', '599123456', 2, 'gori-tbilisi', 'Stored house', 'Stored Didube', 'Stored terminal',
        '2030-01-02', '08:30', '2030-01-02', '08:30', 'confirmed', 'android', stamp, stamp);
        await run(`INSERT INTO call_inquiries(${OLD_CALL_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          904, 902, 'original-completed-event', 'immutable-completed-hash', '599123456', stamp, 42, stamp,
          '2030-01-01T01:00:00.000Z', 903, 'completed', 'immutable-answer-hash', 0);
        await run(`INSERT INTO call_inquiries(${OLD_CALL_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          905, 902, 'original-offline-event', 'immutable-answer-only-hash', null, stamp, 0, stamp,
          null, null, 'answered', 'immutable-answer-only-hash', 0);
        await run('INSERT INTO call_booking_links(call_id,booking_id) VALUES (?,?)', 904, 903);
        await run('INSERT INTO audit_log(id,user_id,booking_id,action,details,created_at) VALUES (?,?,?,?,?,?)',
          906, 901, 903, 'preserved-audit', '{"preserve":true}', stamp);
        await run('INSERT INTO call_device_heartbeats(device_id,received_at,app_version,android_version,monitoring,pending_count,oldest_pending_at,last_error) VALUES (?,?,?,?,?,?,?,?)',
          902, stamp, '0.3.1', '16', 1, 2, stamp, 'network');

        const tableRows = await rows(dialect === 'postgres'
          ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name"
          : "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
        const tables = tableRows.map(row => String(row.name));
        const query = (table: string) => `SELECT ${table === 'call_inquiries' ? OLD_CALL_COLUMNS : table === 'bookings' ? PRE020_BOOKING_COLUMNS : '*'} FROM ${table}${table === 'schema_versions' ? ' WHERE version<=18' : ''} ORDER BY 1,2`;
        const snapshots = new Map<string, string>();
        for (const table of tables) snapshots.set(table, JSON.stringify(await rows(query(table))));
        sqlite?.close(); sqlite = undefined;

        for (let attempt = 0; attempt < 2; attempt++) {
          database = await createDatabase({ dbPath, databaseUrl, production: false });
          assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 20);
          for (const table of tables) assert.equal(JSON.stringify(await database.prepare(query(table)).all()), snapshots.get(table), `${table} changed during additive status migration`);
          const calls = await database.prepare('SELECT id,call_status,ringing_hash FROM call_inquiries ORDER BY id').all();
          assert.deepEqual(calls.map(row => ({ ...row })), [
            { id: 904, call_status: null, ringing_hash: null },
            { id: 905, call_status: null, ringing_hash: null },
          ]);
          if (dialect === 'sqlite') assert.deepEqual(await database.prepare('PRAGMA foreign_key_check').all(), []);
          await database.close(); database = undefined;
        }
        database = await createDatabase({ dbPath, databaseUrl, production: false });
        for (const status of ['ringing', 'answered', 'completed', 'missed', 'rejected', null]) {
          await database.prepare('UPDATE call_inquiries SET call_status=? WHERE id=?').run(status, 905);
          assert.equal((await database.prepare('SELECT call_status FROM call_inquiries WHERE id=?').get(905))?.call_status, status);
        }
        await assert.rejects(database.prepare('UPDATE call_inquiries SET call_status=? WHERE id=?').run('outgoing', 905), /check constraint/i);
        assert.equal((await database.prepare('SELECT call_status FROM call_inquiries WHERE id=?').get(905))?.call_status, null);
        await assert.rejects(database.prepare('UPDATE call_booking_links SET call_id=? WHERE call_id=?').run(999999, 904), /foreign key/i);
      } finally {
        await database?.close(); sqlite?.close(); await stored?.end();
        if (administration) {
          await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          await administration.end();
        }
        await rm(directory, { recursive: true, force: true });
      }
    });
}
