import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createDatabase, postgresPoolOptions, postgresSql, type Database } from '../server/database.js';
import { migratePassengerAddresses, migratePhoneStorage, migratePickupMemory, readPassengerProfile, readPassengerProfiles, savePassengerProfile } from '../server/passenger-profiles.js';

test('PostgreSQL translation preserves literals/comments and returns only numeric table IDs', () => {
  assert.equal(postgresSql(`SELECT '?' AS literal, "?identifier", ? AS orderCount, ? as latestDate -- ?\n/* ? */`),
    `SELECT '?' AS literal, "?identifier", $1 AS "orderCount", $2 AS "latestDate" -- ?\n/* ? */`);
  assert.equal(postgresSql('SELECT $$?$$, $body$?$body$, ? /* outer /* ? */ ? */'), 'SELECT $$?$$, $body$?$body$, $1 /* outer /* ? */ ? */');
  assert.equal(postgresSql("INSERT OR IGNORE INTO users(login,name,password_hash,created_at) VALUES (?,?,?,?); -- note"),
    "INSERT INTO users(login,name,password_hash,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id; -- note");
  assert.equal(postgresSql("INSERT INTO settings(key,value) VALUES (?,?)"), 'INSERT INTO settings(key,value) VALUES ($1,$2)');
  assert.equal(postgresSql('INSERT INTO stops(name,address) VALUES (?,?) RETURNING id'), 'INSERT INTO stops(name,address) VALUES ($1,$2) RETURNING id');
});

test('PostgreSQL connection options keep certificate verification for sslmode=require', () => {
  const options = postgresPoolOptions('postgresql://test:placeholder@example.com/taxi?sslmode=require&options=-csearch_path%3Dtaxi');
  assert.equal(typeof options.ssl, 'object');
  assert.equal((options.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, true);
  assert.equal(new URL(options.connectionString!).searchParams.has('sslmode'), false);
  assert.equal(new URL(options.connectionString!).searchParams.get('options'), '-csearch_path=taxi');
  assert.throws(() => postgresPoolOptions('postgresql://test@example.com/taxi?sslmode=disable'), /verified TLS/);
  assert.throws(() => postgresPoolOptions('postgresql://test@example.com/taxi?sslmode=no-verify'), /verified TLS/);
  assert.equal(postgresPoolOptions('postgresql://test@127.0.0.1/taxi?sslmode=disable').ssl, false);
});

test('production refuses an absent DATABASE_URL', async () => {
  await assert.rejects(createDatabase({ production: true, databaseUrl: '', dbPath: ':memory:' }), /DATABASE_URL is required/);
});

async function verifySchemaAndTransactions(first: Database, second: Database = first) {
  assert.equal((await first.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 7);
  assert.equal((await first.prepare('SELECT COUNT(*) AS count FROM stops').get())?.count, 3);
  assert.equal((await first.prepare('SELECT COUNT(*) AS count FROM base_schedule').get())?.count, 2);
  const user = await first.prepare('INSERT INTO users(login,name,password_hash,created_at) VALUES (?,?,?,?)').run('adapter', 'Operator', 'test-hash', new Date().toISOString());
  assert.equal(typeof user.lastInsertRowid, 'number');
  assert.equal(user.changes, 1);
  assert.equal((await first.prepare('SELECT id FROM users WHERE id=?').get(user.lastInsertRowid))?.id, user.lastInsertRowid);
  await first.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('adapter-counter', '0');
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const increments = [first.transaction(async () => {
    const row = await first.prepare('SELECT value FROM settings WHERE key=?').get('adapter-counter');
    entered();
    await gate;
    await first.prepare('UPDATE settings SET value=? WHERE key=?').run(String(Number(row!.value) + 1), 'adapter-counter');
  })];
  await started;
  increments.push(second.transaction(async () => {
    const row = await second.prepare('SELECT value FROM settings WHERE key=?').get('adapter-counter');
    await second.prepare('UPDATE settings SET value=? WHERE key=?').run(String(Number(row!.value) + 1), 'adapter-counter');
  }));
  release();
  await Promise.all(increments);
  assert.equal((await first.prepare('SELECT value FROM settings WHERE key=?').get('adapter-counter'))?.value, '2');
  await assert.rejects(first.transaction(async () => {
    await first.prepare('UPDATE settings SET value=? WHERE key=?').run('invalid', 'adapter-counter');
    throw new Error('rollback marker');
  }), /rollback marker/);
  assert.equal((await first.prepare('SELECT value FROM settings WHERE key=?').get('adapter-counter'))?.value, '2');
  await first.transaction(async () => {
    await assert.rejects(first.transaction(async () => {
      await first.prepare('UPDATE settings SET value=? WHERE key=?').run('invalid-nested', 'adapter-counter');
      throw new Error('nested rollback marker');
    }), /nested rollback marker/);
    assert.equal((await first.prepare('SELECT value FROM settings WHERE key=?').get('adapter-counter'))?.value, '2');
  });
  const aliases = await first.prepare('SELECT COUNT(*) AS orderCount, MAX(created_at) AS latestDate FROM users').get();
  assert.equal(aliases?.orderCount, 1);
  assert.equal(typeof aliases?.latestDate, 'string');
  await first.prepare('INSERT INTO passenger_profiles(phone,name,gori_address,updated_at) VALUES (?,?,?,?)').run('+995555123456', 'Passenger', 'გორი', new Date().toISOString());
  assert.equal((await first.prepare('SELECT name FROM passenger_profiles WHERE phone=?').get('+995555123456'))?.name, 'Passenger');
  await assert.rejects(first.prepare('INSERT INTO passenger_profiles(phone,name,gori_address,pickup_stop_id,updated_at) VALUES (?,?,?,?,?)').run('+995555999999', 'Passenger', 'გორი', 999_999, new Date().toISOString()));
  const device = await first.prepare('INSERT INTO call_devices(name,token_hash,created_at) VALUES (?,?,?)').run('Phase test', 'phase-device-test', new Date().toISOString());
  const inquiry = await first.prepare('INSERT INTO call_inquiries(device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(device.lastInsertRowid, 'phase-event', 'original-hash', '568694879', new Date().toISOString(), 12, new Date().toISOString());
  assert.deepEqual({ ...(await first.prepare('SELECT phase,answered_hash,legacy_hash FROM call_inquiries WHERE id=?').get(inquiry.lastInsertRowid)) }, { phase: 'completed', answered_hash: null, legacy_hash: 1 });
  await first.prepare('UPDATE call_inquiries SET phase=? WHERE id=?').run('answered', inquiry.lastInsertRowid);
  await assert.rejects(first.prepare('UPDATE call_inquiries SET phase=? WHERE id=?').run('invalid', inquiry.lastInsertRowid));
  assert.equal((await first.prepare('SELECT phase FROM call_inquiries WHERE id=?').get(inquiry.lastInsertRowid))?.phase, 'answered');
  await first.prepare('UPDATE call_inquiries SET legacy_hash=? WHERE id=?').run(0, inquiry.lastInsertRowid);
  await assert.rejects(first.prepare('UPDATE call_inquiries SET legacy_hash=? WHERE id=?').run(2, inquiry.lastInsertRowid));
  await assert.rejects(first.prepare('UPDATE call_inquiries SET legacy_hash=NULL WHERE id=?').run(inquiry.lastInsertRowid));
  assert.equal((await first.prepare('SELECT legacy_hash FROM call_inquiries WHERE id=?').get(inquiry.lastInsertRowid))?.legacy_hash, 0);
  const staffBooking = await insertHistoryBooking(first, '568694880', 'Eight-seat staff booking', new Date().toISOString(), 'confirmed', null, 8);
  await assert.rejects(first.prepare('UPDATE bookings SET seats=? WHERE id=?').run(9, staffBooking.lastInsertRowid));
  assert.equal((await first.prepare('SELECT seats FROM bookings WHERE id=?').get(staffBooking.lastInsertRowid))?.seats, 8);
}

test('SQLite migrations and asynchronous transactions preserve isolation and rollback', async () => {
  const database = await createDatabase({ dbPath: ':memory:', databaseUrl: '', production: false });
  try { await verifySchemaAndTransactions(database); }
  finally { await database.close(); }
});

test('SQLite migration preserves existing data and runs once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'greentaxi-database-'));
  const dbPath = join(directory, 'existing.sqlite');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const oldDatabase = new DatabaseSync(dbPath);
    oldDatabase.exec('CREATE TABLE stops (id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    oldDatabase.prepare('INSERT INTO stops(name,address) VALUES (?,?)').run('Existing stop', 'Existing address');
    oldDatabase.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('didubeName', 'Existing Didube');
    oldDatabase.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const database = await createDatabase({ dbPath, databaseUrl: '', production: false });
      try {
        assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 7);
        assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM stops').get())?.count, 1);
        assert.equal((await database.prepare('SELECT value FROM settings WHERE key=?').get('didubeName'))?.value, 'Existing Didube');
      } finally { await database.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const dialect of ['sqlite', 'postgres'] as const) {
  test(`${dialect} pickup-memory migration upgrades persisted version five without changing history or prior checksums`,
    { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL }, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'greentaxi-pickup-memory-'));
      const dbPath = join(directory, 'pre-006.sqlite');
      const schema = `pickup_upgrade_${randomUUID().replaceAll('-', '')}`;
      let administration: Pool | undefined;
      let stored: Pool | undefined;
      let sqlite: import('node:sqlite').DatabaseSync | undefined;
      let databaseUrl: string | undefined;
      const databases: Database[] = [];
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
          if (stored) await stored.query(postgresSql(sql), values); else sqlite!.prepare(sql).run(...values);
        };
        const all = async (sql: string) => {
          if (!stored) return sqlite!.prepare(sql).all().map(row => ({ ...row }));
          const result = await stored.query(sql);
          const integerFields = result.fields.filter(field => [20, 21, 23].includes(field.dataTypeID));
          return result.rows.map(row => {
            for (const field of integerFields) if (typeof row[field.name] === 'string') row[field.name] = Number(row[field.name]);
            return row;
          });
        };
        await exec('CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
        for (const [index, migration] of ['001_initial', '002_rate_limits', '003_call_phase', '004_legacy_call_hash', '005_staff_seats'].entries()) {
          const name = `${migration}.${dialect}.sql`;
          const sql = await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8');
          await exec(sql);
          await run('INSERT INTO schema_versions(version,name,checksum,applied_at) VALUES (?,?,?,?)',
            index + 1, name, createHash('sha256').update(sql).digest('hex'), '2030-01-01T00:00:00.000Z');
        }
        await run('UPDATE stops SET name=?,address=?,active=? WHERE id=?', 'Stored Tbilisi stop', 'Stored stop address', 1, 1);
        await run('INSERT INTO passenger_profiles(phone,name,gori_address,pickup_stop_id,pickup_stop_name,updated_at) VALUES (?,?,?,?,?,?)',
          '568694879', 'Stored contact', 'More recent Gori dropoff', 1, 'Stored Tbilisi stop', '2030-01-04T00:00:00.000Z');
        const bookingSql = `INSERT INTO bookings(id,name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,didube_name,didube_address,
          requested_date,requested_time,assigned_date,assigned_time,status,deleted_at,source,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
        await run(bookingSql, 1, 'Stored contact', '568694879', 8, 'gori-tbilisi', 'Trusted Gori pickup', null, null,
          'Stored Didube', 'Stored destination', '2030-01-01', '08:30', '2030-01-01', '08:30', 'confirmed',
          '2030-01-02T00:00:00.000Z', 'employee', '2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z');
        await run(bookingSql, 2, 'Stored contact', '568694879', 3, 'tbilisi-gori', 'More recent Gori dropoff', 1, 'Stored Tbilisi stop',
          'Stored Didube', 'Stored destination', '2030-01-02', '09:30', '2030-01-02', '09:30', 'confirmed', null,
          'android', '2030-01-02T00:00:00.000Z', '2030-01-03T00:00:00.000Z');
        await run('INSERT INTO call_devices(id,name,token_hash,created_at) VALUES (?,?,?,?)', 1, 'Synthetic persisted device', 'preserved-device-hash', '2030-01-01T00:00:00.000Z');
        await run(`INSERT INTO call_inquiries(id,device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at,booking_id,phase,answered_hash,legacy_hash)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, 1, 1, 'stored-call', 'preserved-completed-hash', '568694879', '2030-01-01T00:00:00.000Z', 12,
          '2030-01-01T00:00:00.000Z', 2, 'completed', 'preserved-answered-hash', 0);
        await run('INSERT INTO audit_log(id,booking_id,action,details,created_at) VALUES (?,?,?,?,?)', 1, 2, 'preserved-audit', '{"preserve":true}', '2030-01-03T00:00:00.000Z');
        const versions = await all('SELECT * FROM schema_versions ORDER BY version');
        const unchangedTables = ['bookings', 'call_inquiries', 'call_devices', 'audit_log'];
        const snapshots = new Map<string, string>();
        for (const table of unchangedTables) snapshots.set(table, JSON.stringify(await all(`SELECT * FROM ${table} ORDER BY id`)));
        const legacySql = 'SELECT phone,name,gori_address,pickup_stop_id,pickup_stop_name,updated_at FROM passenger_profiles ORDER BY phone';
        const legacy = JSON.stringify(await all(legacySql));
        sqlite?.close(); sqlite = undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const database = await createDatabase({ dbPath, databaseUrl: databaseUrl ?? '', production: false });
          databases.push(database);
          assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 7);
          assert.deepEqual((await database.prepare('SELECT * FROM schema_versions WHERE version<6 ORDER BY version').all()).map(row => ({ ...row })), versions);
          if (attempt === 0) assert.equal((await readPassengerProfile(database, '568694879'))?.goriPickupAddress, '');
          await migratePickupMemory(database);
          assert.equal((await readPassengerProfile(database, '568694879'))?.goriPickupAddress, 'Trusted Gori pickup');
          assert.equal((await readPassengerProfile(database, '568694879'))?.pickupStopId, 1);
          assert.equal(JSON.stringify(await database.prepare(legacySql).all()), legacy);
          for (const table of unchangedTables) assert.equal(JSON.stringify(await database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()), snapshots.get(table));
          await database.close(); databases.pop();
        }
      } finally {
        await Promise.all(databases.map(database => database.close()));
        sqlite?.close();
        await stored?.end();
        if (administration) { await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await administration.end(); }
        await rm(directory, { recursive: true, force: true });
      }
    });
}

test('PostgreSQL concurrent migration and cross-instance transactions preserve isolation', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const baseUrl = process.env.TEST_DATABASE_URL!;
  const schema = `adapter_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool(postgresPoolOptions(baseUrl));
  const databaseUrl = new URL(baseUrl);
  databaseUrl.searchParams.set('options', `-csearch_path=${schema}`);
  const databases: Database[] = [];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    databases.push(...await Promise.all([
      createDatabase({ databaseUrl: databaseUrl.toString(), production: true }),
      createDatabase({ databaseUrl: databaseUrl.toString(), production: true }),
    ]));
    await verifySchemaAndTransactions(databases[0], databases[1]);
  } finally {
    await Promise.all(databases.map(database => database.close()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

for (const dialect of ['sqlite', 'postgres'] as const) {
  test(`${dialect} saved-address migration upgrades persisted version six once and keeps prior checksums and trusted history intact`,
    { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL }, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'greentaxi-address-upgrade-'));
      const dbPath = join(directory, 'pre-007.sqlite');
      const schema = `addresses_upgrade_${randomUUID().replaceAll('-', '')}`;
      let administration: Pool | undefined;
      let stored: Pool | undefined;
      let sqlite: import('node:sqlite').DatabaseSync | undefined;
      let databaseUrl: string | undefined;
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
          if (stored) await stored.query(postgresSql(sql), values); else sqlite!.prepare(sql).run(...values);
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
        for (const [index, migration] of ['001_initial', '002_rate_limits', '003_call_phase', '004_legacy_call_hash', '005_staff_seats', '006_gori_pickup_memory'].entries()) {
          const name = `${migration}.${dialect}.sql`;
          const sql = await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8');
          await exec(sql);
          await run('INSERT INTO schema_versions(version,name,checksum,applied_at) VALUES (?,?,?,?)', index + 1, name, createHash('sha256').update(sql).digest('hex'), '2026-10-09T00:00:00.000Z');
        }
        await run('INSERT INTO passenger_profiles(phone,name,gori_address,gori_pickup_address,gori_pickup_updated_at,pickup_stop_id,pickup_stop_name,updated_at) VALUES (?,?,?,?,?,?,?,?)',
          '+995568694879', 'Legacy private name', 'Gori arrival', 'Gori house', '2026-10-09T10:00:00.000Z', 1, 'Stored fixed stop', '2026-10-09T11:00:00.000Z');
        const snapshots = new Map<string, string>();
        for (const table of ['schema_versions', 'passenger_profiles', 'bookings', 'call_inquiries', 'audit_log']) snapshots.set(table, JSON.stringify(await rows(`SELECT * FROM ${table} ORDER BY 1`)));
        sqlite?.close(); sqlite = undefined;
        let addresses: string | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          database = await createDatabase({ dbPath, databaseUrl: databaseUrl ?? '', production: false });
          if (!attempt) assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM passenger_addresses').get())?.count, 0);
          await migratePassengerAddresses(database);
          assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 7);
          const current = JSON.stringify(await database.prepare('SELECT * FROM passenger_addresses ORDER BY phone,city,address_key').all());
          if (!attempt) addresses = current; else assert.equal(current, addresses);
          const profile = await readPassengerProfile(database, '568694879');
          assert.equal(profile?.addresses?.length, 3);
          assert.equal(profile?.goriPickupAddress, 'Gori house');
          for (const [table, snapshot] of snapshots) {
            const sql = `SELECT * FROM ${table}${table === 'schema_versions' ? ' WHERE version<7' : ''} ORDER BY 1`;
            assert.equal(JSON.stringify(await database.prepare(sql).all()), snapshot);
          }
          await database.close(); database = undefined;
        }
      } finally {
        await database?.close(); sqlite?.close(); await stored?.end();
        if (administration) { await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await administration.end(); }
        await rm(directory, { recursive: true, force: true });
      }
    });
}

test('PostgreSQL staff seat migration upgrades persisted version 4 without changing rows or references', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `staff_upgrade_${randomUUID().replaceAll('-', '')}`;
  const baseUrl = process.env.TEST_DATABASE_URL!;
  const connection = new URL(baseUrl);
  connection.searchParams.set('options', `-csearch_path=${schema}`);
  const admin = new Pool(postgresPoolOptions(baseUrl));
  const stored = new Pool(postgresPoolOptions(connection.toString()));
  const databases: Database[] = [];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const client = await stored.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
      const oldMigrations = ['001_initial', '002_rate_limits', '003_call_phase', '004_legacy_call_hash'];
      for (const [index, migration] of oldMigrations.entries()) {
        const name = `${migration}.postgres.sql`;
        const sql = await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_versions(version,name,checksum,applied_at) VALUES ($1,$2,$3,$4)',
          [index + 1, name, createHash('sha256').update(sql).digest('hex'), '2030-01-01T00:00:00.000Z']);
      }
      const bookingSql = `INSERT INTO bookings(name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,didube_name,didube_address,
        requested_date,requested_time,assigned_date,assigned_time,status,deleted_at,source,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`;
      const bookingValues = ['568694879', 4, 'tbilisi-gori', 'გორი, შენახული მისამართი', 1, 'Stored stop snapshot', 'დიდუბე', 'Stored Didube address',
        '2030-01-01', '08:30', '2030-01-01', '09:30', 'confirmed'];
      const active = (await client.query(bookingSql, ['Stored active passenger', ...bookingValues, null, 'employee', '2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z'])).rows[0].id;
      const deleted = (await client.query(bookingSql, ['Stored deleted passenger', ...bookingValues, '2030-01-03T00:00:00.000Z', 'employee', '2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z'])).rows[0].id;
      const device = (await client.query('INSERT INTO call_devices(name,token_hash,created_at) VALUES ($1,$2,$3) RETURNING id',
        ['Synthetic upgrade device', 'synthetic-upgrade-device-hash', '2030-01-01T00:00:00.000Z'])).rows[0].id;
      for (const bookingId of [active, deleted]) {
        await client.query('INSERT INTO audit_log(booking_id,action,details,created_at) VALUES ($1,$2,$3,$4)',
          [bookingId, 'preserved-history', '{"preserve":true}', '2030-01-03T00:00:00.000Z']);
        await client.query(`INSERT INTO call_inquiries(device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at,deleted_at,booking_id,phase,answered_hash,legacy_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [device, `converted-${bookingId}`, 'preserved-completed-hash', '568694879', '2030-01-01T00:00:00.000Z', 13, '2030-01-01T00:00:00.000Z',
            bookingId === deleted ? '2030-01-04T00:00:00.000Z' : null, bookingId, 'completed', 'preserved-answered-hash', 0]);
      }
      await client.query('INSERT INTO idempotency(scope,key,request_hash,status,response,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        ['employee-booking', 'synthetic-upgrade-key', 'preserved-request-hash', 201, JSON.stringify({ id: Number(active), phone: '568694879' }), 1893456000000]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }

    const tables = ['bookings', 'audit_log', 'call_inquiries', 'call_devices', 'idempotency', 'stops', 'settings', 'base_schedule', 'date_schedule', 'passenger_profiles', 'rate_limits'];
    const snapshots = new Map<string, string>();
    for (const table of tables) snapshots.set(table, JSON.stringify((await stored.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows));
    const versions = (await stored.query('SELECT * FROM schema_versions ORDER BY version')).rows;
    const indexesSql = 'SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname';
    const indexes = (await stored.query(indexesSql, [schema])).rows;
    const constraintsSql = `SELECT r.relname AS table_name,c.conname AS name,c.contype AS type,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname=$1 ORDER BY r.relname,c.conname`;
    const constraints = (await stored.query(constraintsSql, [schema])).rows;
    const sequence = (await stored.query('SELECT last_value,is_called FROM bookings_id_seq')).rows;
    await assert.rejects(stored.query('UPDATE bookings SET seats=8'), /bookings_seats_check/);

    const initialized = await Promise.allSettled([
      createDatabase({ databaseUrl: connection.toString(), production: true }),
      createDatabase({ databaseUrl: connection.toString(), production: true }),
    ]);
    for (const result of initialized) if (result.status === 'fulfilled') databases.push(result.value);
    for (const result of initialized) if (result.status === 'rejected') throw result.reason;
    assert.equal(databases.length, 2);
    for (const table of tables) assert.equal(JSON.stringify((await stored.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows), snapshots.get(table), `${table} rows changed`);
    assert.deepEqual((await stored.query('SELECT * FROM schema_versions WHERE version<5 ORDER BY version')).rows, versions);
    assert.equal((await stored.query('SELECT COUNT(*) AS count FROM schema_versions')).rows[0].count, '7');
    assert.deepEqual((await stored.query(indexesSql, [schema])).rows.filter(row => row.tablename !== 'passenger_addresses'), indexes);
    const migratedConstraints = (await stored.query(constraintsSql, [schema])).rows;
    assert.deepEqual(migratedConstraints.filter(row => row.name !== 'bookings_seats_check' && row.table_name !== 'passenger_addresses'), constraints.filter(row => row.name !== 'bookings_seats_check'));
    assert.match(migratedConstraints.find(row => row.name === 'bookings_seats_check')!.definition, /seats <= 8/);
    assert.deepEqual((await stored.query('SELECT last_value,is_called FROM bookings_id_seq')).rows, sequence);
    const eightSeat = await insertHistoryBooking(databases[0], '568694880', 'New eight-seat staff booking', '2030-01-05T00:00:00.000Z', 'confirmed', null, 8);
    assert.equal(eightSeat.lastInsertRowid, 3);
    await assert.rejects(databases[0].prepare('UPDATE bookings SET seats=9 WHERE id=?').run(eightSeat.lastInsertRowid), /bookings_seats_check/);
    await assert.rejects(databases[0].prepare('UPDATE bookings SET pickup_stop_id=? WHERE id=?').run(999_999, eightSeat.lastInsertRowid), /foreign key/);
    await assert.rejects(databases[0].prepare('UPDATE call_inquiries SET booking_id=? WHERE id=?').run(999_999, 1), /foreign key/);
    await assert.rejects(databases[0].prepare('UPDATE audit_log SET booking_id=? WHERE id=?').run(999_999, 1), /foreign key/);
    assert.equal((await databases[0].prepare('SELECT seats FROM bookings WHERE id=?').get(eightSeat.lastInsertRowid))?.seats, 8);
  } finally {
    await Promise.all(databases.map(database => database.close()));
    await stored.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

async function memoryDatabase(): Promise<Database> {
  return createDatabase({ dbPath: ':memory:', databaseUrl: '', production: false });
}
async function insertProfile(database: Database, phone: string, name: string, date: string, stopId: number | null = null) {
  await database.prepare('INSERT INTO passenger_profiles(phone,name,gori_address,pickup_stop_id,pickup_stop_name,updated_at) VALUES (?,?,?,?,?,?)')
    .run(phone, name, `გორი — ${name}`, stopId, stopId ? 'Historical stop name' : null, date);
}
test('alias profile reads merge newest contact details and active stop memory without changing storage', async () => {
  const database = await memoryDatabase();
  try {
    await database.prepare('UPDATE stops SET name=? WHERE id=?').run('Current active stop name', 1);
    await database.prepare('UPDATE stops SET active=0 WHERE id=?').run(2);
    await insertProfile(database, '+995568694879', 'Old contact', '2030-01-01T00:00:00.000Z', 1);
    await insertProfile(database, '995568694879', 'Middle contact', '2030-01-02T00:00:00.000Z', 2);
    await insertProfile(database, '568694879', 'Latest contact', '2030-01-03T00:00:00.000Z');
    await insertProfile(database, '+447700900123', 'International contact', '2030-01-01T00:00:00.000Z');
    const profiles = await readPassengerProfiles(database, ['568694879', '+995568694879', '00995568694879', '+447700900123', 'invalid']);
    assert.deepEqual([...profiles.keys()].sort(), ['+447700900123', '568694879']);
    assert.deepEqual(profiles.get('568694879'), {
      phone: '568694879', name: 'Latest contact', goriAddress: 'გორი — Latest contact', goriPickupAddress: '',
      pickupStopId: 1, pickupStopName: 'Current active stop name', updatedAt: '2030-01-03T00:00:00.000Z', addresses: [],
      departureTimes: { 'gori-tbilisi': [], 'tbilisi-gori': [] },
    });
    assert.equal((await readPassengerProfile(database, '995568694879'))?.name, 'Latest contact');
    assert.equal(await readPassengerProfile(database, 'invalid'), null);
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM passenger_profiles').get())?.count, 4);
    assert.equal((await database.prepare('SELECT name FROM passenger_profiles WHERE phone=?').get('+995568694879'))?.name, 'Old contact');
  } finally { await database.close(); }
});

test('batch profile lookup bounds alias parameters without per-passenger queries', async () => {
  const database = await memoryDatabase();
  try {
    const phones = Array.from({ length: 205 }, (_, index) => `568${String(index).padStart(6, '0')}`);
    await database.transaction(async () => {
      for (const phone of phones) {
        await insertProfile(database, phone, `Passenger ${phone}`, '2030-01-01T00:00:00.000Z');
        await insertHistoryBooking(database, phone, 'Past trip', '2030-01-01T00:00:00.000Z', 'confirmed');
      }
    });
    let queries = 0;
    const observed: Database = {
      ...database,
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          ...statement,
          async all(...parameters) {
            queries++;
            assert.ok(parameters.length <= 200);
            return statement.all(...parameters);
          },
        };
      },
    };
    const profiles = await readPassengerProfiles(observed, phones, new Date('2030-01-02T00:00:00Z'));
    assert.equal(profiles.size, 205);
    assert.equal([...profiles.values()].filter(profile => profile.departureTimes?.['gori-tbilisi']?.[0] === '08:30').length, 205);
    assert.ok(queries <= 15, `Expected at most 15 bounded profile/address/history batch queries, received ${queries}`);
    queries = 0;
    await insertHistoryBooking(database, '568999998', 'History without cached trusted profile', '2030-01-01T00:00:00.000Z', 'confirmed');
    assert.equal((await readPassengerProfiles(observed, ['568999998', '568999999'], new Date('2030-01-02T00:00:00Z'))).size, 0);
    assert.equal(queries, 1, 'Unknown profiles require no address/history lookup and do not create fallback profiles');
  } finally { await database.close(); }
});

test('confirmed profile writes merge only matching aliases and preserve newer trusted details', async () => {
  const database = await memoryDatabase();
  try {
    await insertProfile(database, '+995568694879', 'Older contact', '2030-01-01T00:00:00.000Z', 1);
    await insertProfile(database, '568694879', 'Newest contact', '2030-01-03T00:00:00.000Z');
    await insertProfile(database, '+447700900123', 'Unrelated contact', '2030-01-01T00:00:00.000Z');
    await database.transaction(async () => savePassengerProfile(database, {
      status: 'waiting', phone: '568694879', name: 'Untrusted', gori_address: 'Untrusted address', updated_at: '2030-01-04T00:00:00.000Z',
    }));
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM passenger_profiles').get())?.count, 3);
    await database.transaction(async () => savePassengerProfile(database, {
      status: 'confirmed', phone: '00995568694879', name: 'Older edit', gori_address: 'Older address', pickup_stop_id: 2, updated_at: '2030-01-02T00:00:00.000Z',
    }));
    const first = await readPassengerProfile(database, '568694879');
    assert.equal(first?.name, 'Newest contact');
    assert.equal(first?.updatedAt, '2030-01-03T00:00:00.000Z');
    assert.equal(first?.pickupStopId, 2);
    assert.equal(await database.prepare('SELECT phone FROM passenger_profiles WHERE phone=?').get('+995568694879'), undefined);
    await database.transaction(async () => savePassengerProfile(database, {
      status: 'confirmed', phone: '+995568694879', name: 'Equal-time current edit', gori_address: 'Current address', pickup_stop_id: null, updated_at: '2030-01-03T00:00:00.000Z',
    }));
    const changed = await readPassengerProfile(database, '568694879');
    assert.equal(changed?.name, 'Equal-time current edit');
    assert.equal(changed?.pickupStopId, 2);
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM passenger_profiles').get())?.count, 2);
    assert.equal((await readPassengerProfile(database, '+447700900123'))?.name, 'Unrelated contact');
  } finally { await database.close(); }
});

test('Gori pickup aliases use their own timestamps even after newer reverse-trip profile updates', async () => {
  const database = await memoryDatabase();
  try {
    await insertProfile(database, '+995568694879', 'Older Gori pickup, newer reverse trip', '2030-01-05T00:00:00.000Z', 1);
    await database.prepare('UPDATE passenger_profiles SET gori_pickup_address=?,gori_pickup_updated_at=? WHERE phone=?')
      .run('გორი, ძველი ასაღები სახლი', '2030-01-01T00:00:00.000Z', '+995568694879');
    await insertProfile(database, '568694879', 'More recent Gori pickup', '2030-01-03T00:00:00.000Z');
    await database.prepare('UPDATE passenger_profiles SET gori_pickup_address=?,gori_pickup_updated_at=? WHERE phone=?')
      .run('გორი, ახალი ასაღები სახლი', '2030-01-03T00:00:00.000Z', '568694879');
    const profile = await readPassengerProfile(database, '568694879');
    assert.equal(profile?.goriPickupAddress, 'გორი, ახალი ასაღები სახლი');
    assert.equal(profile?.name, 'Older Gori pickup, newer reverse trip');
    await database.transaction(async () => savePassengerProfile(database, {
      status: 'confirmed', direction: 'tbilisi-gori', phone: '568694879', name: '', gori_address: 'გორი, ჩამოსვლის მისამართი',
      pickup_stop_id: 2, updated_at: '2030-01-06T00:00:00.000Z',
    }));
    assert.equal((await readPassengerProfile(database, '568694879'))?.goriPickupAddress, 'გორი, ახალი ასაღები სახლი');
    assert.equal((await database.prepare('SELECT gori_pickup_updated_at FROM passenger_profiles WHERE phone=?').get('568694879'))?.gori_pickup_updated_at,
      '2030-01-03T00:00:00.000Z');
  } finally { await database.close(); }
});

test('pickup backfill trusts only Gori departures, preserves legacy fields and aliases, and runs once', async () => {
  const database = await memoryDatabase();
  try {
    const phone = '568694879';
    await insertProfile(database, '+995' + phone, 'Trusted legacy contact', '2030-01-05T00:00:00.000Z', 1);
    const pickup = await insertHistoryBooking(database, phone, 'Deleted confirmed Gori pickup', '2030-01-02T00:00:00.000Z', 'confirmed', '2030-01-03T00:00:00.000Z');
    const reverse = await insertHistoryBooking(database, phone, 'More recent Gori dropoff', '2030-01-04T00:00:00.000Z', 'confirmed');
    await database.prepare("UPDATE bookings SET direction='tbilisi-gori',pickup_stop_id=1 WHERE id=?").run(reverse.lastInsertRowid);
    await insertHistoryBooking(database, phone, 'Untrusted newest pickup', '2030-01-06T00:00:00.000Z', 'waiting');
    await insertHistoryBooking(database, '568694880', 'Untrusted only request', '2030-01-06T00:00:00.000Z', 'waiting');
    await insertHistoryBooking(database, '568694881', 'Reverse only history', '2030-01-06T00:00:00.000Z', 'confirmed');
    await database.prepare("UPDATE bookings SET direction='tbilisi-gori',pickup_stop_id=1 WHERE phone='568694881'").run();
    const legacy = await database.prepare('SELECT phone,name,gori_address,pickup_stop_id,pickup_stop_name,updated_at FROM passenger_profiles').all();
    const bookings = await database.prepare('SELECT * FROM bookings ORDER BY id').all();
    await migratePickupMemory(database);
    assert.deepEqual(await database.prepare('SELECT phone,name,gori_address,pickup_stop_id,pickup_stop_name,updated_at FROM passenger_profiles').all(), legacy);
    assert.deepEqual(await database.prepare('SELECT * FROM bookings ORDER BY id').all(), bookings);
    assert.equal((await readPassengerProfile(database, phone))?.goriPickupAddress, 'გორი — Deleted confirmed Gori pickup');
    assert.equal((await database.prepare('SELECT gori_pickup_updated_at FROM passenger_profiles WHERE phone=?').get('+995' + phone))?.gori_pickup_updated_at,
      '2030-01-02T00:00:00.000Z');
    assert.equal(await readPassengerProfile(database, '568694880'), null);
    assert.equal(await readPassengerProfile(database, '568694881'), null);
    await database.prepare('UPDATE bookings SET gori_address=? WHERE id=?').run('Changed historical address after backfill', pickup.lastInsertRowid);
    await migratePickupMemory(database);
    assert.equal((await readPassengerProfile(database, phone))?.goriPickupAddress, 'გორი — Deleted confirmed Gori pickup');
  } finally { await database.close(); }
});

async function insertHistoryBooking(database: Database, phone: string, name: string, updatedAt: string, status: 'waiting' | 'confirmed', deletedAt: string | null = null, seats = 1) {
  return database.prepare(`INSERT INTO bookings(name,phone,seats,direction,gori_address,didube_name,didube_address,requested_date,requested_time,
    assigned_date,assigned_time,status,deleted_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name, phone, seats, 'gori-tbilisi', `გორი — ${name}`, 'დიდუბე', 'Didube test address', '2030-01-01', '08:30',
      status === 'confirmed' ? '2030-01-01' : null, status === 'confirmed' ? '08:30' : null, status, deletedAt, 'public', '2030-01-01T00:00:00.000Z', updatedAt);
}
test('saved addresses are additive, canonical, deduplicated and historical imports preserve newer city defaults', async () => {
  const database = await memoryDatabase();
  try {
    const current = { status: 'confirmed', phone: '568694879', direction: 'gori-tbilisi', name: '',
      gori_address: '  Street   One 12 ', updated_at: '2026-10-09T10:00:00.000Z' };
    await database.transaction(async () => {
      await savePassengerProfile(database, current);
      await savePassengerProfile(database, { ...current, phone: '+995568694879', gori_address: 'Street Two 24', updated_at: '2026-10-09T11:00:00.000Z' });
      await savePassengerProfile(database, { ...current, phone: '995568694879', direction: 'tbilisi-gori', gori_address: 'New Gori destination', pickup_stop_id: 2, updated_at: '2026-10-09T12:00:00.000Z' });
      await savePassengerProfile(database, { ...current, phone: '00995568694879', gori_address: 'street one 12', updated_at: '2026-10-07T08:00:00.000Z' });
      await savePassengerProfile(database, { ...current, phone: '568694879', direction: 'tbilisi-gori', pickup_stop_id: 1, gori_address: 'Historical Gori destination', updated_at: '2026-10-07T09:00:00.000Z' });
      await savePassengerProfile(database, { ...current, status: 'waiting', gori_address: 'Unverified address', updated_at: '2026-10-10T08:00:00.000Z' });
      await savePassengerProfile(database, { ...current, phone: '+447911123456', gori_address: 'Foreign customer address' });
    });
    const profile = await readPassengerProfile(database, '+995568694879');
    assert.equal(profile?.goriPickupAddress, 'Street Two 24');
    assert.equal(profile?.goriAddress, 'New Gori destination');
    assert.equal(profile?.pickupStopId, 2);
    assert.equal(profile?.updatedAt, '2026-10-09T12:00:00.000Z');
    assert.deepEqual(profile?.addresses?.filter(address => address.city === 'gori').map(address => address.address),
      ['New Gori destination', 'Street Two 24', 'Street One 12', 'Historical Gori destination']);
    assert.deepEqual(profile?.addresses?.filter(address => address.city === 'tbilisi').map(address => address.pickupStopId), [2, 1]);
    assert.equal(profile?.addresses?.find(address => address.address === 'Street One 12')?.updatedAt, '2026-10-09T10:00:00.000Z');
    assert.equal(profile?.addresses?.some(address => /Foreign|Unverified/.test(address.address)), false);
    await database.prepare('UPDATE stops SET name=?,address=? WHERE id=?').run('Updated configured stop', 'Updated configured address', 2);
    assert.equal((await readPassengerProfile(database, '568694879'))?.addresses?.find(address => address.pickupStopId === 2)?.address, 'Updated configured address');
    await database.prepare('UPDATE stops SET active=0 WHERE id=2').run();
    assert.deepEqual((await readPassengerProfile(database, '568694879'))?.addresses?.filter(address => address.city === 'tbilisi').map(address => address.pickupStopId), [1]);
    assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM passenger_addresses WHERE phone=? AND city='tbilisi'").get('568694879'))?.count, 2);
    const before = await database.prepare('SELECT * FROM passenger_addresses ORDER BY phone,city,address_key').all();
    await readPassengerProfiles(database, ['568694879', '+995568694879', '+447911123456']);
    assert.deepEqual(await database.prepare('SELECT * FROM passenger_addresses ORDER BY phone,city,address_key').all(), before);
    await assert.rejects(database.transaction(async () => {
      await savePassengerProfile(database, { ...current, gori_address: 'Failed booking address', updated_at: '2026-10-10T10:00:00.000Z' });
      throw new Error('Synthetic failed booking mutation');
    }), /Synthetic failed booking mutation/);
    assert.deepEqual(await database.prepare('SELECT * FROM passenger_addresses ORDER BY phone,city,address_key').all(), before);
    assert.equal((await readPassengerProfile(database, '568694879'))?.goriPickupAddress, 'Street Two 24');
  } finally { await database.close(); }
});

test('saved-address backfill includes trusted deleted trips and aliases, preserves all existing tables and runs once', async () => {
  const database = await memoryDatabase();
  try {
    await insertProfile(database, '+995568694879', 'Cached trusted customer', '2026-10-09T12:00:00.000Z', 2);
    await database.prepare('UPDATE passenger_profiles SET gori_pickup_address=?,gori_pickup_updated_at=? WHERE phone=?')
      .run('Trusted cached pickup', '2026-10-09T11:00:00.000Z', '+995568694879');
    const removed = await insertHistoryBooking(database, '00995568694879', 'Deleted address', '2026-10-08T10:00:00.000Z', 'confirmed', '2026-10-08T10:00:00.000Z');
    const reverse = await insertHistoryBooking(database, '995568694879', 'Past Gori arrival', '2026-10-07T10:00:00.000Z', 'confirmed');
    await database.prepare("UPDATE bookings SET direction='tbilisi-gori',pickup_stop_id=1,pickup_stop_name=? WHERE id=?").run('Snapshot stop', reverse.lastInsertRowid);
    await insertHistoryBooking(database, '568694879', 'Untrusted address', '2026-10-10T10:00:00.000Z', 'waiting');
    await insertHistoryBooking(database, '568694880', 'Untrusted unknown contact', '2026-10-10T10:00:00.000Z', 'waiting');
    const before = new Map<string, string>();
    for (const table of ['passenger_profiles', 'bookings', 'audit_log', 'call_inquiries']) before.set(table, JSON.stringify(await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
    await migratePassengerAddresses(database);
    const profile = await readPassengerProfile(database, '568694879');
    assert.equal(profile?.addresses?.filter(address => address.city === 'gori').length, 4);
    assert.equal(profile?.addresses?.filter(address => address.city === 'tbilisi').length, 2);
    assert.equal(profile?.addresses?.some(address => address.address === 'გორი — Deleted address'), true);
    assert.equal(profile?.addresses?.some(address => /Untrusted/.test(address.address)), false);
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM passenger_addresses WHERE phone=?').get('568694880'))?.count, 0);
    for (const [table, snapshot] of before) assert.equal(JSON.stringify(await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()), snapshot);
    const stored = await database.prepare('SELECT * FROM passenger_addresses ORDER BY phone,city,address_key').all();
    await database.prepare('UPDATE bookings SET gori_address=? WHERE id=?').run('Changed after one-time backfill', removed.lastInsertRowid);
    await migratePassengerAddresses(database);
    assert.deepEqual(await database.prepare('SELECT * FROM passenger_addresses ORDER BY phone,city,address_key').all(), stored);
    assert.equal((await database.prepare('SELECT value FROM settings WHERE key=?').get('passengerAddressesV1'))?.value, '1');
  } finally { await database.close(); }
});

test('phone migration merges collisions atomically, trusts confirmed history and preserves hashes and invalid rows', async () => {
  const database = await memoryDatabase();
  try {
    await database.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('passengerProfilesBackfilled', '1');
    await insertProfile(database, '+995568694879', 'Older cached contact', '2030-01-01T00:00:00.000Z', 1);
    await insertProfile(database, '568694879', 'Newer cached contact', '2030-01-03T00:00:00.000Z');
    await insertProfile(database, 'invalid-legacy-phone', 'Legacy preserved', '2030-01-01T00:00:00.000Z');
    await insertProfile(database, '+447700900123', 'International preserved', '2030-01-01T00:00:00.000Z');
    const confirmed = await insertHistoryBooking(database, '00995568694879', 'Deleted confirmed contact', '2030-01-04T00:00:00.000Z', 'confirmed', '2030-01-05T00:00:00.000Z');
    await insertHistoryBooking(database, '+995568694879', 'Untrusted newer request', '2030-01-06T00:00:00.000Z', 'waiting');
    await insertHistoryBooking(database, '+995568694880', 'Unconfirmed separate request', '2030-01-06T00:00:00.000Z', 'waiting');
    const invalid = await insertHistoryBooking(database, 'invalid-legacy-phone', 'Invalid preserved history', '2030-01-06T00:00:00.000Z', 'confirmed');
    const device = await database.prepare('INSERT INTO call_devices(name,token_hash,created_at) VALUES (?,?,?)').run('Migration test device', 'migration-device-hash', '2030-01-01T00:00:00.000Z');
    const call = await database.prepare(`INSERT INTO call_inquiries(device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at,phase,answered_hash)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(device.lastInsertRowid, 'migration-event', 'immutable-completed-hash', '+995568694879', '2030-01-01T00:00:00.000Z', 15, '2030-01-01T00:00:00.000Z', 'completed', 'immutable-answered-hash');
    await migratePhoneStorage(database);
    const profile = await readPassengerProfile(database, '568694879');
    assert.equal(profile?.name, 'Deleted confirmed contact');
    assert.equal(profile?.pickupStopId, 1);
    assert.equal(profile?.updatedAt, '2030-01-04T00:00:00.000Z');
    assert.equal(await readPassengerProfile(database, '568694880'), null);
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM passenger_profiles').get())?.count, 3);
    assert.equal((await database.prepare('SELECT name FROM passenger_profiles WHERE phone=?').get('invalid-legacy-phone'))?.name, 'Legacy preserved');
    assert.deepEqual({ ...(await database.prepare('SELECT phone,deleted_at,updated_at FROM bookings WHERE id=?').get(confirmed.lastInsertRowid)) }, {
      phone: '568694879', deleted_at: '2030-01-05T00:00:00.000Z', updated_at: '2030-01-04T00:00:00.000Z',
    });
    assert.equal((await database.prepare('SELECT phone FROM bookings WHERE id=?').get(invalid.lastInsertRowid))?.phone, 'invalid-legacy-phone');
    assert.deepEqual({ ...(await database.prepare('SELECT phone,request_hash,answered_hash,phase,duration_seconds FROM call_inquiries WHERE id=?').get(call.lastInsertRowid)) }, {
      phone: '568694879', request_hash: 'immutable-completed-hash', answered_hash: 'immutable-answered-hash', phase: 'completed', duration_seconds: 15,
    });
    assert.equal((await database.prepare('SELECT value FROM settings WHERE key=?').get('georgianPhoneStorageV2'))?.value, '1');
    await database.prepare('UPDATE passenger_profiles SET name=? WHERE phone=?').run('After migration edit', '568694879');
    await migratePhoneStorage(database);
    assert.equal((await readPassengerProfile(database, '568694879'))?.name, 'After migration edit');
  } finally { await database.close(); }
});

for (const fixture of [
  { label: 'ordinary primary key', autoincrement: false, empty: false },
  { label: 'legacy high sequence', autoincrement: true, empty: false },
  { label: 'empty legacy table with a high sequence', autoincrement: true, empty: true },
]) {
  test(`staff seat migration preserves persisted rows, references, indexes and ${fixture.label}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'greentaxi-staff-seats-'));
    const dbPath = join(directory, 'pre-005.sqlite');
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const previous = new DatabaseSync(dbPath);
      previous.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
      const oldMigrations = ['001_initial', '002_rate_limits', '003_call_phase', '004_legacy_call_hash'];
      for (const [index, migration] of oldMigrations.entries()) {
        const name = `${migration}.sqlite.sql`;
        const sql = await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8');
        const appliedSql = fixture.autoincrement && index === 0
          ? sql.replace('CREATE TABLE IF NOT EXISTS bookings (\n  id INTEGER PRIMARY KEY,', 'CREATE TABLE IF NOT EXISTS bookings (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,')
          : sql;
        previous.exec(appliedSql);
        previous.prepare('INSERT INTO schema_versions(version,name,checksum,applied_at) VALUES (?,?,?,?)')
          .run(index + 1, name, createHash('sha256').update(sql).digest('hex'), '2030-01-01T00:00:00.000Z');
      }
      previous.exec('COMMIT');
      const historicalBooking = previous.prepare(`INSERT INTO bookings(id,name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,
        didube_name,didube_address,requested_date,requested_time,assigned_date,assigned_time,status,deleted_at,source,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const bookingValues = ['Stored passenger', '568694879', 4, 'tbilisi-gori', 'გორი, ძველი მისამართი', 1, 'Stored stop snapshot',
        'დიდუბე', 'Stored Didube address', '2030-01-01', '08:30', '2030-01-01', '09:30', 'confirmed', '2030-01-03T00:00:00.000Z',
        'employee', '2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z'];
      historicalBooking.run(44, ...bookingValues);
      if (fixture.autoincrement) {
        historicalBooking.run(9999, ...bookingValues);
        previous.prepare('DELETE FROM bookings WHERE id=?').run(9999);
      }
      if (fixture.empty) previous.prepare('DELETE FROM bookings WHERE id=?').run(44);
      const reference = fixture.empty ? null : 44;
      previous.prepare('INSERT INTO audit_log(id,booking_id,action,details,created_at) VALUES (?,?,?,?,?)')
        .run(61, reference, 'preserved-history', '{"preserve":true}', '2030-01-03T00:00:00.000Z');
      previous.prepare('INSERT INTO audit_log(id,booking_id,action,details,created_at) VALUES (?,?,?,?,?)')
        .run(62, null, 'unrelated-history', '{}', '2030-01-03T00:00:00.000Z');
      previous.prepare('INSERT INTO call_devices(id,name,token_hash,created_at) VALUES (?,?,?,?)')
        .run(7, 'Synthetic device', 'synthetic-pre-005-device', '2030-01-01T00:00:00.000Z');
      previous.prepare(`INSERT INTO call_inquiries(id,device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at,
        deleted_at,booking_id,phase,answered_hash,legacy_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(71, 7, 'converted-and-deleted', 'preserved-completed-hash', '568694879', '2030-01-01T00:00:00.000Z', 13,
          '2030-01-01T00:00:00.000Z', '2030-01-04T00:00:00.000Z', reference, 'completed', 'preserved-answered-hash', 0);
      previous.prepare(`INSERT INTO call_inquiries(id,device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at,booking_id)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(72, 7, 'unrelated-unconverted', 'unrelated-preserved-hash', null, '2030-01-01T00:00:00.000Z', 0, '2030-01-01T00:00:00.000Z', null);
      const tables = ['bookings', 'audit_log', 'call_inquiries'];
      const snapshots = new Map(tables.map(table => [table, previous.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => ({ ...row }))]));
      const foreignKeys = new Map(tables.map(table => [table, previous.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row => ({ ...row }))]));
      const indexes = previous.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='bookings' ORDER BY name").all().map(row => String(row.name));
      const indexColumns = new Map(indexes.map(name => [name, previous.prepare(`PRAGMA index_info(${name})`).all().map(row => ({ ...row }))]));
      const versions = previous.prepare('SELECT * FROM schema_versions ORDER BY version').all().map(row => ({ ...row }));
      previous.close();

      const database = await createDatabase({ dbPath, databaseUrl: '', production: false });
      try {
        assert.equal((await database.prepare('PRAGMA foreign_keys').get())?.foreign_keys, 1);
        assert.deepEqual(await database.prepare('PRAGMA foreign_key_check').all(), []);
        for (const table of tables) {
          assert.deepEqual((await database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).map(row => ({ ...row })), snapshots.get(table));
          assert.deepEqual((await database.prepare(`PRAGMA foreign_key_list(${table})`).all()).map(row => ({ ...row })), foreignKeys.get(table));
        }
        const migratedIndexes = (await database.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='bookings' ORDER BY name").all()).map(row => String(row.name));
        assert.deepEqual(migratedIndexes, indexes);
        for (const name of indexes) assert.deepEqual((await database.prepare(`PRAGMA index_info(${name})`).all()).map(row => ({ ...row })), indexColumns.get(name));
        assert.deepEqual((await database.prepare('SELECT * FROM schema_versions WHERE version<5 ORDER BY version').all()).map(row => ({ ...row })), versions);
        assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 7);
        assert.equal((await database.prepare("SELECT seq FROM sqlite_sequence WHERE name='bookings'").get())?.seq, fixture.autoincrement ? 9999 : 44);
        const eightSeat = await insertHistoryBooking(database, '568694880', 'New staff booking', '2030-01-05T00:00:00.000Z', 'confirmed', null, 8);
        assert.equal(eightSeat.lastInsertRowid, fixture.autoincrement ? 10000 : 45);
        await assert.rejects(database.prepare('UPDATE bookings SET seats=9 WHERE id=?').run(eightSeat.lastInsertRowid));
        await assert.rejects(database.prepare('UPDATE bookings SET pickup_stop_id=? WHERE id=?').run(999_999, eightSeat.lastInsertRowid));
        await assert.rejects(database.prepare('UPDATE audit_log SET booking_id=? WHERE id=?').run(999_999, 61));
        assert.deepEqual(await database.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { await database.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
