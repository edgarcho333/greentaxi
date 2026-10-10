import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingMatchesCall, isActiveCallBooking } from '../shared/call-bookings.js';
import { createDatabase, type Database } from '../server/database.js';
import { readPreferredBookingPhones } from '../server/call-bookings.js';

test('call booking identity matches only exact caller or explicitly selected contact, with no transitive household merge', () => {
  assert.equal(bookingMatchesCall({ phone: '568694879' }, '+995568694879', null), true);
  assert.equal(bookingMatchesCall({ phone: '599111222', callerPhone: '568 69 48 79' }, '568694879', null), true);
  assert.equal(bookingMatchesCall({ phone: '599111222', callerPhone: '599333444' }, '568694879', '599111222'), true);
  assert.equal(bookingMatchesCall({ phone: '599555666', callerPhone: '599111222' }, '568694879', '599111222'), false);
  assert.equal(bookingMatchesCall({ phone: '599111222', callerPhone: '599333444' }, '568694879', '599555666'), false);
  assert.equal(bookingMatchesCall({ phone: '568694870' }, '568694879', null), false);
  assert.equal(bookingMatchesCall({ phone: '568694879' }, null, null), false);
});

test('active call bookings use the civil day including earlier hours and exclude deleted or past orders', () => {
  const today = '2026-10-10';
  assert.equal(isActiveCallBooking({ assignedDate: today, requestedDate: '2026-10-09', deletedAt: null }, today), true);
  assert.equal(isActiveCallBooking({ assignedDate: null, requestedDate: '2026-10-11', deletedAt: null }, today), true);
  assert.equal(isActiveCallBooking({ assignedDate: '2026-10-09', requestedDate: today, deletedAt: null }, today), false);
  assert.equal(isActiveCallBooking({ assignedDate: today, requestedDate: today, deletedAt: '2026-10-10T01:00:00Z' }, today), false);
});

test('preferred booking contacts batch complete aliases across a long incoming queue without per-caller queries', async () => {
  const database = await createDatabase({ dbPath: ':memory:', databaseUrl: '', production: false });
  try {
    const callers = Array.from({ length: 60 }, (_, index) => String(599000000 + index));
    const insert = database.prepare(`INSERT INTO bookings(name,phone,caller_phone,seats,direction,gori_address,didube_name,didube_address,
      requested_date,requested_time,assigned_date,assigned_time,status,source,created_at,updated_at,deleted_at)
      VALUES ('',?,?,1,'gori-tbilisi','Synthetic street','Didube','Synthetic destination',
        '2030-01-02','08:30','2030-01-02','08:30','confirmed','employee',?,?,?)`);
    for (const [index, caller] of callers.entries()) await insert.run(String(568100000 + index), index % 2 ? caller : '+995' + caller,
      '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', null);
    await insert.run('568999999', '00995' + callers[0], '2030-01-02T00:00:00.000Z', '2030-01-02T00:00:00.000Z', '2030-01-02T01:00:00.000Z');
    const batchSizes: number[] = [];
    const observed: Database = {
      prepare(sql) {
        const statement = database.prepare(sql);
        if (!sql.includes("WHERE status='confirmed' AND caller_phone IN")) return statement;
        return { ...statement, all: async (...values) => { batchSizes.push(values.length); return statement.all(...values); } };
      },
      exec: sql => database.exec(sql), transaction: operation => database.transaction(operation), close: () => database.close(),
    };
    const preferred = await readPreferredBookingPhones(observed, [...callers, '+995' + callers[0]]);
    assert.deepEqual(batchSizes, [200, 40]);
    assert.equal(preferred.size, 60);
    assert.equal(preferred.get(callers[0]), '568999999');
    assert.equal(preferred.get(callers.at(-1)!), '568100059');
  } finally { await database.close(); }
});
