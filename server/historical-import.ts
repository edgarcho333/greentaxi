import { createHash } from 'node:crypto';
import type { Database, DatabaseRow } from './database.js';
import { normalizePhone } from '../shared/phone.js';
import { savePassengerProfile } from './passenger-profiles.js';

export type HistoricalImportRecord = {
  sourceLine: number;
  phone: string;
  address: string;
  seats: number;
  time: string;
  deleted: boolean;
};
export type HistoricalImport = {
  batchKey: string;
  sourceHash: string;
  date: string;
  direction: 'gori-tbilisi';
  records: HistoricalImportRecord[];
};
type Disposition = 'create' | 'existing' | 'already-imported' | 'conflict';
export type HistoricalImportResult = {
  sourceLine: number;
  disposition: Disposition;
  bookingId: number | null;
  reason?: string;
  conflictingBookingIds?: number[];
};
export type HistoricalImportReport = {
  mode: 'dry-run' | 'applied' | 'blocked';
  committed: boolean;
  batchKey: string;
  sourceHash: string;
  date: string;
  direction: HistoricalImport['direction'];
  counts: {
    total: number; create: number; existing: number; alreadyImported: number; conflicts: number;
    active: number; deleted: number; activeSeats: number;
  };
  slots: { time: string; activeOrders: number; deletedOrders: number; activeSeats: number }[];
  records: HistoricalImportResult[];
};
type StoredBatch = {
  version: 1;
  sourceHash: string;
  date: string;
  direction: HistoricalImport['direction'];
  manifestHash: string;
  rows: { sourceLine: number; fingerprint: string; bookingId: number }[];
};
type PreparedRecord = HistoricalImportRecord & { fingerprint: string };

/** Messages and reports deliberately contain no customer values or database connection strings. */
export class HistoricalImportError extends Error {
  constructor(public readonly code: string, public readonly sourceLine?: number) {
    super(`Historical import failed: ${code}${sourceLine === undefined ? '' : ` (source line ${sourceLine})`}.`);
    this.name = 'HistoricalImportError';
  }
}
function fail(code: string, sourceLine?: number): never { throw new HistoricalImportError(code, sourceLine); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function address(value: string): string { return value.normalize('NFC').replace(/\s+/gu, ' ').trim(); }
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}
function tbilisiDay(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
function historicStamp(date: string, time: string): string { return new Date(`${date}T${time}:00+04:00`).toISOString(); }
function prepare(input: HistoricalImport, now: Date): { records: PreparedRecord[]; manifestHash: string } {
  if (!input || typeof input !== 'object') fail('INVALID_INPUT');
  if (typeof input.batchKey !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(input.batchKey)) fail('INVALID_BATCH_KEY');
  if (typeof input.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceHash)) fail('INVALID_SOURCE_HASH');
  if (input.direction !== 'gori-tbilisi') fail('UNSUPPORTED_DIRECTION');
  if (!validDate(input.date)) fail('INVALID_DATE');
  if (!Number.isFinite(now.getTime())) fail('INVALID_CLOCK');
  if (input.date >= tbilisiDay(now)) fail('HISTORICAL_DATE_REQUIRED');
  if (!Array.isArray(input.records) || !input.records.length || input.records.length > 10_000) fail('INVALID_RECORDS');
  const lines = new Set<number>();
  const semantics = new Set<string>();
  const requestedSlots = new Set<string>();
  const records = input.records.map(record => {
    if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.sourceLine) || record.sourceLine < 1) fail('INVALID_SOURCE_LINE');
    const line = record.sourceLine;
    if (lines.has(line)) fail('DUPLICATE_SOURCE_LINE', line);
    lines.add(line);
    if (typeof record.phone !== 'string' || !/^\d{9}$/.test(record.phone) || normalizePhone(record.phone) !== record.phone) fail('NONCANONICAL_PHONE', line);
    if (typeof record.address !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(record.address)) fail('INVALID_ADDRESS', line);
    const cleanAddress = address(record.address);
    if (cleanAddress.length < 3 || cleanAddress.length > 500) fail('INVALID_ADDRESS', line);
    if (!Number.isInteger(record.seats) || record.seats < 1 || record.seats > 8) fail('INVALID_SEATS', line);
    if (typeof record.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(record.time)) fail('INVALID_TIME', line);
    if (typeof record.deleted !== 'boolean') fail('INVALID_DELETED_FLAG', line);
    const fingerprint = hash([input.date, input.direction, record.phone, cleanAddress, record.seats, record.time, record.deleted]);
    if (semantics.has(fingerprint)) fail('DUPLICATE_RECORD', line);
    semantics.add(fingerprint);
    const requestedSlot = `${record.phone}:${record.time}`;
    if (requestedSlots.has(requestedSlot)) fail('CONFLICTING_INPUT_SLOT', line);
    requestedSlots.add(requestedSlot);
    return { sourceLine: line, phone: record.phone, address: cleanAddress, seats: record.seats, time: record.time, deleted: record.deleted, fingerprint };
  }).sort((first, second) => first.sourceLine - second.sourceLine);
  return { records, manifestHash: hash(records.map(row => [row.sourceLine, row.fingerprint])) };
}
function readMarker(value: unknown): StoredBatch {
  try {
    const stored = JSON.parse(String(value)) as StoredBatch;
    if (stored.version !== 1 || !Array.isArray(stored.rows) || typeof stored.manifestHash !== 'string' ||
      !stored.rows.every(row => Number.isSafeInteger(row.sourceLine) && row.sourceLine > 0 &&
        Number.isSafeInteger(row.bookingId) && row.bookingId > 0 && /^[a-f0-9]{64}$/.test(row.fingerprint))) fail('INVALID_IMPORT_MARKER');
    return stored;
  } catch { return fail('INVALID_IMPORT_MARKER'); }
}
function sameBooking(row: DatabaseRow, record: PreparedRecord): boolean {
  return row.status === 'confirmed' && row.assigned_date !== null && row.assigned_time === record.time &&
    address(String(row.gori_address ?? '')) === record.address && Number(row.seats) === record.seats &&
    Boolean(row.deleted_at) === record.deleted && row.pickup_stop_id === null;
}
function report(input: HistoricalImport, records: PreparedRecord[], results: HistoricalImportResult[], apply: boolean): HistoricalImportReport {
  const conflicts = results.filter(row => row.disposition === 'conflict').length;
  const slots = new Map<string, HistoricalImportReport['slots'][number]>();
  for (const row of records) {
    const slot = slots.get(row.time) ?? { time: row.time, activeOrders: 0, deletedOrders: 0, activeSeats: 0 };
    if (row.deleted) slot.deletedOrders++;
    else { slot.activeOrders++; slot.activeSeats += row.seats; }
    slots.set(row.time, slot);
  }
  return {
    mode: conflicts ? 'blocked' : apply ? 'applied' : 'dry-run', committed: apply && !conflicts,
    batchKey: input.batchKey, sourceHash: input.sourceHash, date: input.date, direction: input.direction,
    counts: {
      total: records.length, create: results.filter(row => row.disposition === 'create').length,
      existing: results.filter(row => row.disposition === 'existing').length,
      alreadyImported: results.filter(row => row.disposition === 'already-imported').length, conflicts,
      active: records.filter(row => !row.deleted).length, deleted: records.filter(row => row.deleted).length,
      activeSeats: records.reduce((total, row) => total + (row.deleted ? 0 : row.seats), 0),
    },
    slots: [...slots.values()].sort((first, second) => first.time.localeCompare(second.time)), records: results,
  };
}

/** Private maintenance helper. Ordinary booking endpoints keep their existing date and time restrictions. */
export async function importHistoricalBookings(db: Database, input: HistoricalImport,
  options: { apply?: boolean; now?: () => Date } = {}): Promise<HistoricalImportReport> {
  const now = (options.now ?? (() => new Date()))();
  const { records, manifestHash } = prepare(input, now);
  const apply = options.apply === true;
  return db.transaction(async () => {
    const markerKey = `historicalImport:${input.batchKey}`;
    const storedRow = await db.prepare('SELECT value FROM settings WHERE key=?').get(markerKey);
    const stored = storedRow ? readMarker(storedRow.value) : null;
    if (stored && (stored.sourceHash !== input.sourceHash || stored.date !== input.date ||
      stored.direction !== input.direction || stored.manifestHash !== manifestHash || stored.rows.length !== records.length)) fail('BATCH_CONFLICT');
    const existing = await db.prepare(`SELECT * FROM bookings WHERE direction=? AND COALESCE(assigned_date,requested_date)=?
      ORDER BY id`).all(input.direction, input.date);
    const configured = await db.prepare('SELECT key,value FROM settings WHERE key IN (?,?)').all('didubeName', 'didubeAddress');
    const didubeName = configured.find(row => row.key === 'didubeName')?.value;
    const didubeAddress = configured.find(row => row.key === 'didubeAddress')?.value;
    if (typeof didubeName !== 'string' || !didubeName.trim() || typeof didubeAddress !== 'string' || !didubeAddress.trim()) fail('MISSING_DIDUBE_CONFIGURATION');
    const results: HistoricalImportResult[] = [];
    for (const record of records) {
      const imported = stored?.rows.find(row => row.sourceLine === record.sourceLine);
      if (stored && (!imported || imported.fingerprint !== record.fingerprint)) fail('BATCH_CONFLICT', record.sourceLine);
      if (imported) {
        const exists = await db.prepare('SELECT id FROM bookings WHERE id=?').get(imported.bookingId);
        results.push({ sourceLine: record.sourceLine, bookingId: imported.bookingId,
          disposition: exists ? 'already-imported' : 'conflict', ...(!exists ? { reason: 'IMPORTED_BOOKING_MISSING' } : {}) });
        continue;
      }
      const slotMatches = existing.filter(row => normalizePhone(String(row.phone)) === record.phone &&
        String(row.assigned_time ?? row.requested_time) === record.time);
      const exact = slotMatches.filter(row => sameBooking(row, record));
      if (slotMatches.length > 1 || (slotMatches.length && exact.length !== 1)) {
        results.push({ sourceLine: record.sourceLine, disposition: 'conflict', bookingId: null,
          reason: slotMatches.length > 1 ? 'AMBIGUOUS_EXISTING_SLOT' : 'EXISTING_SLOT_CONFLICT',
          conflictingBookingIds: slotMatches.map(row => Number(row.id)) });
      } else if (exact.length === 1) {
        results.push({ sourceLine: record.sourceLine, disposition: 'existing', bookingId: Number(exact[0].id) });
      } else results.push({ sourceLine: record.sourceLine, disposition: 'create', bookingId: null });
    }
    const planned = report(input, records, results, apply);
    if (!apply || planned.counts.conflicts || stored) return planned;
    const marker: StoredBatch = { version: 1, sourceHash: input.sourceHash, date: input.date, direction: input.direction, manifestHash, rows: [] };
    for (const record of records) {
      const result = results.find(row => row.sourceLine === record.sourceLine)!;
      const stamp = historicStamp(input.date, record.time);
      if (result.disposition === 'create') {
        const created = await db.prepare(`INSERT INTO bookings(name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,
          didube_name,didube_address,requested_date,requested_time,assigned_date,assigned_time,status,deleted_at,source,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('', record.phone, record.seats, input.direction, record.address, null, null,
          didubeName, didubeAddress, input.date, record.time, input.date, record.time, 'confirmed', record.deleted ? stamp : null, 'employee', stamp, stamp);
        result.bookingId = created.lastInsertRowid;
      }
      const row = await db.prepare('SELECT * FROM bookings WHERE id=?').get(result.bookingId);
      // Historical addresses are additive; their old timestamp cannot replace newer profile defaults.
      await savePassengerProfile(db, { ...row!, updated_at: stamp });
      await db.prepare('INSERT INTO audit_log(user_id,booking_id,action,details,created_at) VALUES (?,?,?,?,?)').run(null, result.bookingId,
        'import.historical', JSON.stringify({ batchKey: input.batchKey, sourceHash: input.sourceHash, sourceLine: record.sourceLine, disposition: result.disposition }), now.toISOString());
      marker.rows.push({ sourceLine: record.sourceLine, fingerprint: record.fingerprint, bookingId: result.bookingId! });
    }
    await db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run(markerKey, JSON.stringify(marker));
    return report(input, records, results, true);
  });
}
