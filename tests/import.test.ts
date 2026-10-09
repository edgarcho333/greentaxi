import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { createDatabase, postgresPoolOptions, type Database } from '../server/database.js';
import { HistoricalImportError, importHistoricalBookings, type HistoricalImport } from '../server/historical-import.js';
import { readPassengerProfile, savePassengerProfile } from '../server/passenger-profiles.js';
import { listPassengers, passengerBookings } from '../server/passengers.js';

const DATE = '2026-10-07';
const NOW = () => new Date('2026-10-09T10:00:00Z');
const SOURCE_HASH = createHash('sha256').update('Synthetic historical fixture.').digest('hex');
function input(): HistoricalImport {
  return {
    batchKey: 'synthetic-october-7', sourceHash: SOURCE_HASH, date: DATE, direction: 'gori-tbilisi',
    records: [
      { sourceLine: 2, phone: '599100001', address: 'გორი, ისტორიული ქუჩა 10', seats: 2, time: '07:30', deleted: false },
      { sourceLine: 7, phone: '599100001', address: 'გორი, სხვა ქუჩა 20', seats: 1, time: '13:00', deleted: false },
      { sourceLine: 11, phone: '599100002', address: 'გორი, წაშლილი ქუჩა 30', seats: 8, time: '08:30', deleted: true },
    ],
  };
}
async function fixture(dialect: 'sqlite' | 'postgres'): Promise<{ db: Database; close(): Promise<void> }> {
  let admin: Pool | undefined;
  let schema: string | undefined;
  let databaseUrl: string | undefined;
  if (dialect === 'postgres') {
    admin = new Pool(postgresPoolOptions(process.env.TEST_DATABASE_URL!));
    schema = `historical_import_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(process.env.TEST_DATABASE_URL!);
    connection.searchParams.set('options', `-csearch_path=${schema}`);
    databaseUrl = connection.toString();
  }
  const db = await createDatabase({ dbPath: ':memory:', databaseUrl: databaseUrl ?? '', production: false });
  return {
    db,
    async close() {
      await db.close();
      if (admin && schema) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
    },
  };
}
async function snapshot(db: Database) {
  return {
    bookings: await db.prepare('SELECT * FROM bookings ORDER BY id').all(),
    profiles: await db.prepare('SELECT * FROM passenger_profiles ORDER BY phone').all(),
    addresses: await db.prepare('SELECT * FROM passenger_addresses ORDER BY phone,city,address_key').all(),
    settings: await db.prepare('SELECT * FROM settings ORDER BY key').all(),
    audit: await db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    base: await db.prepare('SELECT * FROM base_schedule ORDER BY direction').all(),
    dated: await db.prepare('SELECT * FROM date_schedule ORDER BY direction,date').all(),
  };
}
async function existingBooking(db: Database, values: {
  phone?: string; address?: string; seats?: number; time?: string; date?: string; deleted?: boolean; status?: 'waiting' | 'confirmed';
} = {}) {
  const day = values.date ?? DATE;
  const time = values.time ?? '07:30';
  const stamp = new Date(`${day}T${time}:00+04:00`).toISOString();
  const status = values.status ?? 'confirmed';
  return db.prepare(`INSERT INTO bookings(name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,didube_name,didube_address,
    requested_date,requested_time,assigned_date,assigned_time,status,deleted_at,source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('Old compatibility name', values.phone ?? '599100001', values.seats ?? 2,
    'gori-tbilisi', values.address ?? 'გორი, ისტორიული ქუჩა 10', null, null, 'Historical Didube', 'Historical drop-off', day, time,
    status === 'confirmed' ? day : null, status === 'confirmed' ? time : null, status, values.deleted ? stamp : null, 'employee', stamp, stamp);
}

for (const dialect of ['sqlite', 'postgres'] as const) {
  const options = { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL };
  test(`${dialect} historical import dry-run is read-only and apply preserves slot snapshots, profiles, passenger history and schedule`, options, async () => {
    const f = await fixture(dialect);
    try {
      const recent = await existingBooking(f.db, { date: '2026-10-09', time: '09:00', address: 'გორი, ახალი მისამართი 99', seats: 4 });
      const recentRow = await f.db.prepare('SELECT * FROM bookings WHERE id=?').get(recent.lastInsertRowid);
      await f.db.transaction(() => savePassengerProfile(f.db, recentRow!));
      await f.db.prepare('UPDATE settings SET value=? WHERE key=?').run('Configured Didube', 'didubeName');
      await f.db.prepare('UPDATE settings SET value=? WHERE key=?').run('Configured drop-off', 'didubeAddress');
      await f.db.prepare('INSERT INTO date_schedule(direction,date,times) VALUES (?,?,?)').run('gori-tbilisi', DATE, '["10:00","18:00"]');
      const before = await snapshot(f.db);
      const dry = await importHistoricalBookings(f.db, input(), { now: NOW });
      assert.equal(dry.mode, 'dry-run');
      assert.equal(dry.committed, false);
      assert.deepEqual(dry.counts, { total: 3, create: 3, existing: 0, alreadyImported: 0, conflicts: 0, active: 2, deleted: 1, activeSeats: 3 });
      assert.deepEqual(await snapshot(f.db), before);
      const applied = await importHistoricalBookings(f.db, input(), { apply: true, now: NOW });
      assert.equal(applied.mode, 'applied');
      const imported = await f.db.prepare('SELECT * FROM bookings WHERE assigned_date=? ORDER BY assigned_time').all(DATE);
      assert.equal(imported.length, 3);
      const first = imported.find(row => row.assigned_time === '07:30')!;
      assert.equal(first.requested_time, '07:30');
      assert.equal(first.created_at, '2026-10-07T03:30:00.000Z');
      assert.equal(first.updated_at, first.created_at);
      assert.equal(first.status, 'confirmed');
      assert.equal(first.name, '');
      assert.equal(first.source, 'employee');
      assert.equal(first.phone, '599100001');
      assert.equal(first.didube_name, 'Configured Didube');
      assert.equal(first.didube_address, 'Configured drop-off');
      assert.equal(imported.find(row => row.phone === '599100002')!.deleted_at, '2026-10-07T04:30:00.000Z');
      const profile = await readPassengerProfile(f.db, '599100001');
      assert.equal(profile?.goriPickupAddress, 'გორი, ახალი მისამართი 99');
      assert.equal(profile?.updatedAt, '2026-10-09T05:00:00.000Z');
      assert.deepEqual(new Set(profile?.addresses?.map(row => row.address)), new Set([
        'გორი, ახალი მისამართი 99', 'გორი, ისტორიული ქუჩა 10', 'გორი, სხვა ქუჩა 20',
      ]));
      assert.equal((await readPassengerProfile(f.db, '599100002'))?.addresses?.[0].address, 'გორი, წაშლილი ქუჩა 30');
      const passengers = await listPassengers(f.db);
      const active = passengers.find(row => row.phone === '599100001')!;
      assert.equal(active.address, 'გორი, ახალი მისამართი 99');
      assert.equal(active.orderCount, 3);
      assert.equal(active.seats, 7);
      const removed = passengers.find(row => row.phone === '599100002')!;
      assert.equal(removed.orderCount, 0);
      assert.equal(removed.seats, 0);
      assert.equal(removed.latestDate, DATE);
      assert.equal((await passengerBookings(f.db, '599100001')).length, 3);
      assert.equal((await passengerBookings(f.db, '599100002'))[0].status, 'confirmed');
      const audits = await f.db.prepare("SELECT * FROM audit_log WHERE action='import.historical' ORDER BY id").all();
      assert.equal(audits.length, 3);
      assert.ok(audits.every(row => row.created_at === NOW().toISOString() && row.user_id === null));
      assert.ok(audits.every(row => !row.details.includes('599100') && !row.details.includes('ქუჩა')));
      const after = await snapshot(f.db);
      assert.deepEqual(after.base, before.base);
      assert.deepEqual(after.dated, before.dated);
      // The existing schedule's occupied-time union can expose 07:30 without enabling or altering schedules.
      const occupied = await f.db.prepare("SELECT assigned_time FROM bookings WHERE direction=? AND assigned_date=? AND deleted_at IS NULL").all('gori-tbilisi', DATE);
      assert.ok(occupied.some(row => row.assigned_time === '07:30'));
      assert.equal(applied.records.filter(row => row.bookingId !== null).length, 3);
      assert.ok(!JSON.stringify(applied).includes('599100001'));
    } finally { await f.close(); }
  });

  test(`${dialect} historical import retries preserve edited and deleted bookings and reject changed provenance`, options, async () => {
    const f = await fixture(dialect);
    try {
      const first = await importHistoricalBookings(f.db, input(), { apply: true, now: NOW });
      const firstId = first.records[0].bookingId!;
      await f.db.prepare('UPDATE bookings SET gori_address=?,seats=?,assigned_date=?,assigned_time=?,deleted_at=?,updated_at=? WHERE id=?')
        .run('Operator correction', 3, '2026-10-10', '10:00', NOW().toISOString(), NOW().toISOString(), firstId);
      const before = await snapshot(f.db);
      const retry = await importHistoricalBookings(f.db, input(), { apply: true, now: NOW });
      assert.equal(retry.counts.create, 0);
      assert.equal(retry.counts.alreadyImported, 3);
      assert.equal(retry.records[0].bookingId, firstId);
      assert.deepEqual(await snapshot(f.db), before);
      const changedSource = input();
      changedSource.sourceHash = 'f'.repeat(64);
      await assert.rejects(importHistoricalBookings(f.db, changedSource, { apply: true, now: NOW }),
        (error: unknown) => error instanceof HistoricalImportError && error.code === 'BATCH_CONFLICT');
      const changedLine = input();
      changedLine.records[0].address = 'Changed historical payload';
      await assert.rejects(importHistoricalBookings(f.db, changedLine, { apply: true, now: NOW }),
        (error: unknown) => error instanceof HistoricalImportError && error.code === 'BATCH_CONFLICT');
      assert.deepEqual(await snapshot(f.db), before);
    } finally { await f.close(); }
  });

  test(`${dialect} historical import adopts exact legacy-phone rows but blocks conflicting or ambiguous slots atomically`, options, async () => {
    const f = await fixture(dialect);
    try {
      const matched = await existingBooking(f.db, { phone: '+995599100001' });
      const original = await f.db.prepare('SELECT * FROM bookings WHERE id=?').get(matched.lastInsertRowid);
      const applied = await importHistoricalBookings(f.db, input(), { apply: true, now: NOW });
      assert.equal(applied.counts.existing, 1);
      assert.equal(applied.counts.create, 2);
      assert.equal(applied.records[0].bookingId, matched.lastInsertRowid);
      assert.deepEqual(await f.db.prepare('SELECT * FROM bookings WHERE id=?').get(matched.lastInsertRowid), original);
      assert.equal((await passengerBookings(f.db, '599100001')).length, 2);
      const later = input();
      later.batchKey = 'different-source-batch';
      later.records[0].seats = 3;
      later.records.push({ sourceLine: 100, phone: '599100003', address: 'New planned row', seats: 1, time: '09:00', deleted: false });
      const before = await snapshot(f.db);
      const blocked = await importHistoricalBookings(f.db, later, { apply: true, now: NOW });
      assert.equal(blocked.mode, 'blocked');
      assert.equal(blocked.committed, false);
      assert.equal(blocked.records[0].reason, 'EXISTING_SLOT_CONFLICT');
      assert.deepEqual(blocked.records[0].conflictingBookingIds, [matched.lastInsertRowid]);
      assert.deepEqual(await snapshot(f.db), before);
      await existingBooking(f.db, { phone: '599100001' });
      const ambiguous = await importHistoricalBookings(f.db, { ...input(), batchKey: 'ambiguous-batch' }, { apply: true, now: NOW });
      assert.equal(ambiguous.records[0].reason, 'AMBIGUOUS_EXISTING_SLOT');
    } finally { await f.close(); }
  });

  test(`${dialect} historical import never recreates a provenance-marked booking removed outside the normal history workflow`, options, async () => {
    const f = await fixture(dialect);
    try {
      const applied = await importHistoricalBookings(f.db, input(), { apply: true, now: NOW });
      const removedId = applied.records[0].bookingId!;
      await f.db.prepare('DELETE FROM audit_log WHERE booking_id=?').run(removedId);
      await f.db.prepare('DELETE FROM bookings WHERE id=?').run(removedId);
      const before = await snapshot(f.db);
      const blocked = await importHistoricalBookings(f.db, input(), { apply: true, now: NOW });
      assert.equal(blocked.mode, 'blocked');
      assert.equal(blocked.counts.create, 0);
      assert.equal(blocked.counts.conflicts, 1);
      assert.equal(blocked.records[0].reason, 'IMPORTED_BOOKING_MISSING');
      assert.equal(blocked.records[0].bookingId, removedId);
      assert.deepEqual(await snapshot(f.db), before);
    } finally { await f.close(); }
  });

  test(`${dialect} historical import validates strict past Tbilisi dates, canonical phones and duplicate records without writes`, options, async () => {
    const f = await fixture(dialect);
    try {
      const before = await snapshot(f.db);
      const invalid: [string, (value: HistoricalImport) => void][] = [
        ['INVALID_BATCH_KEY', value => { value.batchKey = '../bad'; }],
        ['INVALID_SOURCE_HASH', value => { value.sourceHash = 'short'; }],
        ['UNSUPPORTED_DIRECTION', value => { (value as any).direction = 'tbilisi-gori'; }],
        ['INVALID_DATE', value => { value.date = '2026-02-30'; }],
        ['HISTORICAL_DATE_REQUIRED', value => { value.date = '2026-10-09'; }],
        ['HISTORICAL_DATE_REQUIRED', value => { value.date = '2026-10-10'; }],
        ['NONCANONICAL_PHONE', value => { value.records[0].phone = '+995599100001'; }],
        ['INVALID_ADDRESS', value => { value.records[0].address = ' '; }],
        ['INVALID_ADDRESS', value => { value.records[0].address = 'a'.repeat(501); }],
        ['INVALID_ADDRESS', value => { value.records[0].address = 'Bad\u0000address'; }],
        ['INVALID_SEATS', value => { value.records[0].seats = 9; }],
        ['INVALID_SEATS', value => { value.records[0].seats = 1.5; }],
        ['INVALID_TIME', value => { value.records[0].time = '24:00'; }],
        ['INVALID_DELETED_FLAG', value => { (value.records[0] as any).deleted = 'false'; }],
        ['DUPLICATE_SOURCE_LINE', value => { value.records[1].sourceLine = value.records[0].sourceLine; }],
        ['DUPLICATE_RECORD', value => { value.records.push({ ...value.records[0], sourceLine: 99 }); }],
        ['CONFLICTING_INPUT_SLOT', value => { value.records.push({ ...value.records[0], sourceLine: 99, seats: 1 }); }],
      ];
      for (const [code, mutate] of invalid) {
        const data = input();
        mutate(data);
        await assert.rejects(importHistoricalBookings(f.db, data, { apply: true, now: NOW }),
          (error: unknown) => error instanceof HistoricalImportError && error.code === code, code);
      }
      const previousDate = input();
      previousDate.date = '2026-10-08';
      const midnight = await importHistoricalBookings(f.db, previousDate, { now: () => new Date('2026-10-08T20:01:00Z') });
      assert.equal(midnight.mode, 'dry-run');
      await assert.rejects(importHistoricalBookings(f.db, previousDate, { now: () => new Date('2026-10-08T19:59:00Z') }),
        (error: unknown) => error instanceof HistoricalImportError && error.code === 'HISTORICAL_DATE_REQUIRED');
      assert.deepEqual(await snapshot(f.db), before);
    } finally { await f.close(); }
  });

  test(`${dialect} historical import rolls back inserted bookings, addresses, profiles, audit and provenance on a downstream failure`, options, async () => {
    const f = await fixture(dialect);
    try {
      const before = await snapshot(f.db);
      const failedDb: Database = {
        ...f.db,
        prepare(sql) {
          if (/INSERT INTO audit_log/.test(sql)) return {
            get: async () => { throw new Error('Synthetic downstream failure'); },
            all: async () => { throw new Error('Synthetic downstream failure'); },
            run: async () => { throw new Error('Synthetic downstream failure'); },
          };
          return f.db.prepare(sql);
        },
      };
      await assert.rejects(importHistoricalBookings(failedDb, input(), { apply: true, now: NOW }), /Synthetic downstream failure/);
      assert.deepEqual(await snapshot(f.db), before);
    } finally { await f.close(); }
  });
}

test('historical import CLI defaults to dry-run, applies only explicitly and writes private reports without logging customer data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'greentaxi-import-cli-'));
  const inputPath = join(directory, 'input.json');
  const reportPath = join(directory, 'report.json');
  const dbPath = join(directory, 'database.sqlite');
  const exec = promisify(execFile);
  const cli = join(process.cwd(), 'scripts/import-historical-bookings.ts');
  const env = { ...process.env, DATABASE_URL: '', DB_PATH: dbPath, NODE_ENV: 'development' };
  try {
    await writeFile(inputPath, JSON.stringify(input()), { mode: 0o600 });
    const dry = await exec(process.execPath, ['--import', 'tsx', cli, '--input', inputPath], { env });
    assert.equal(JSON.parse(dry.stdout).mode, 'dry-run');
    assert.ok(!dry.stdout.includes('599100001') && !dry.stdout.includes('ისტორიული'));
    let db = await createDatabase({ dbPath, databaseUrl: '', production: false });
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM bookings').get())!.count, 0);
    await db.close();
    const applied = await exec(process.execPath, ['--import', 'tsx', cli, '--input', inputPath, '--apply', '--report', reportPath], { env });
    assert.equal(JSON.parse(applied.stdout).mode, 'applied');
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
    const stored = await readFile(reportPath, 'utf8');
    assert.equal(JSON.parse(stored).records.length, 3);
    assert.ok(!stored.includes('599100001') && !stored.includes('ისტორიული'));
    db = await createDatabase({ dbPath, databaseUrl: '', production: false });
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM bookings').get())!.count, 3);
    await db.close();
    const invalid = input();
    invalid.records[0].phone = 'SECRET-CUSTOMER-VALUE';
    await writeFile(inputPath, JSON.stringify(invalid));
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', cli, '--input', inputPath, '--apply'], { env }),
      (error: any) => error.code === 1 && error.stderr.includes('NONCANONICAL_PHONE') && !error.stderr.includes('SECRET-CUSTOMER-VALUE'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('historical import CLI accepts a private environment payload with strict names and never prints its customer values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'greentaxi-import-env-cli-'));
  const dbPath = join(directory, 'database.sqlite');
  const exec = promisify(execFile);
  const cli = join(process.cwd(), 'scripts/import-historical-bookings.ts');
  const env = {
    ...process.env, DATABASE_URL: '', DB_PATH: dbPath, NODE_ENV: 'development',
    HISTORICAL_IMPORT_PAYLOAD: JSON.stringify(input()),
  };
  try {
    const dry = await exec(process.execPath, ['--import', 'tsx', cli, '--input-env', 'HISTORICAL_IMPORT_PAYLOAD'], { env });
    assert.equal(JSON.parse(dry.stdout).mode, 'dry-run');
    assert.ok(!dry.stdout.includes('599100001') && !dry.stdout.includes('ისტორიული'));
    let db = await createDatabase({ dbPath, databaseUrl: '', production: false });
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM bookings').get())!.count, 0);
    await db.close();
    const applied = await exec(process.execPath, ['--import', 'tsx', cli, '--input-env', 'HISTORICAL_IMPORT_PAYLOAD', '--apply'], { env });
    assert.equal(JSON.parse(applied.stdout).mode, 'applied');
    assert.ok(!applied.stdout.includes('599100001') && !applied.stdout.includes('ისტორიული'));
    db = await createDatabase({ dbPath, databaseUrl: '', production: false });
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM bookings').get())!.count, 3);
    await db.close();
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', cli, '--input-env', 'not-a-valid-key'], { env }),
      (error: any) => error.code === 1 && error.stderr.includes('INVALID_INPUT_ENV_NAME'));
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', cli, '--input-env', 'MISSING_TEST_PAYLOAD'], { env }),
      (error: any) => error.code === 1 && error.stderr.includes('INVALID_INPUT_ENV'));
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', cli, '--input-env', 'HISTORICAL_IMPORT_PAYLOAD', '--input', 'unused.json'], { env }),
      (error: any) => error.code === 1 && error.stderr.includes('INVALID_ARGUMENTS'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
