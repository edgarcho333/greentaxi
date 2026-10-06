import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createDatabase, postgresPoolOptions, postgresSql, type Database } from '../server/database.js';

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
  assert.equal((await first.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 2);
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
        assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM schema_versions').get())?.count, 2);
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
