import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createDatabase, postgresPoolOptions, postgresSql, type Database } from '../server/database.js';
import { migratePhoneStorage, readPassengerProfile, readPassengerProfiles, savePassengerProfile } from '../server/passenger-profiles.js';

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
  assert.equal((await first.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 4);
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
        assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 4);
        assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM stops').get())?.count, 1);
        assert.equal((await database.prepare('SELECT value FROM settings WHERE key=?').get('didubeName'))?.value, 'Existing Didube');
      } finally { await database.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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
      phone: '568694879', name: 'Latest contact', goriAddress: 'გორი — Latest contact',
      pickupStopId: 1, pickupStopName: 'Current active stop name', updatedAt: '2030-01-03T00:00:00.000Z',
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
      for (const phone of phones) await insertProfile(database, phone, `Passenger ${phone}`, '2030-01-01T00:00:00.000Z');
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
    assert.equal((await readPassengerProfiles(observed, phones)).size, 205);
    assert.ok(queries <= 5, `Expected at most 5 batched queries, received ${queries}`);
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

async function insertHistoryBooking(database: Database, phone: string, name: string, updatedAt: string, status: 'waiting' | 'confirmed', deletedAt: string | null = null) {
  return database.prepare(`INSERT INTO bookings(name,phone,seats,direction,gori_address,didube_name,didube_address,requested_date,requested_time,
    assigned_date,assigned_time,status,deleted_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(name, phone, 1, 'gori-tbilisi', `გორი — ${name}`, 'დიდუბე', 'Didube test address', '2030-01-01', '08:30',
      status === 'confirmed' ? '2030-01-01' : null, status === 'confirmed' ? '08:30' : null, status, deletedAt, 'public', '2030-01-01T00:00:00.000Z', updatedAt);
}
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
