import type { Database, DatabaseRow } from './database.js';
import { normalizePhone, phoneAliases } from '../shared/phone.js';
import { bookingMatchesCall } from '../shared/call-bookings.js';

const PHONE_QUERY_SIZE = 200;

/** An explicit caller/contact pair teaches a suggestion, never merges profiles. */
export async function readPreferredBookingPhones(database: Database, callers: string[]): Promise<Map<string, string>> {
  const canonical = [...new Set(callers.map(normalizePhone).filter((phone): phone is string => phone !== null))];
  const wanted = new Set(canonical);
  const result = new Map(canonical.map(phone => [phone, phone]));
  const latest = new Map<string, { createdAt: string; id: number }>();
  const aliases = [...new Set(canonical.flatMap(phoneAliases))];
  for (let offset = 0; offset < aliases.length; offset += PHONE_QUERY_SIZE) {
    const batch = aliases.slice(offset, offset + PHONE_QUERY_SIZE);
    const rows = await database.prepare(`SELECT id,phone,caller_phone,created_at FROM bookings
      WHERE status='confirmed' AND caller_phone IN (${batch.map(() => '?').join(',')})
      ORDER BY created_at DESC,id DESC`).all(...batch);
    for (const row of rows) {
      const caller = normalizePhone(row.caller_phone);
      const contact = normalizePhone(row.phone);
      if (!caller || !contact || !wanted.has(caller)) continue;
      const previous = latest.get(caller);
      const stamp = String(row.created_at);
      const id = Number(row.id);
      if (previous && (previous.createdAt > stamp || (previous.createdAt === stamp && previous.id >= id))) continue;
      latest.set(caller, { createdAt: stamp, id });
      result.set(caller, contact);
    }
  }
  return result;
}

export function callBookingRelated(row: DatabaseRow, caller: string | null, contact: string | null): boolean {
  return bookingMatchesCall({ phone: String(row.phone), callerPhone: row.caller_phone ?? null }, caller, contact);
}

/** Exact indexed identities; do not follow pairs into unrelated household members. */
export async function readActiveCallBookings(database: Database, caller: string | null, contact: string | null, today: string): Promise<DatabaseRow[]> {
  const callerAliases = caller === null ? [] : phoneAliases(caller);
  const contactAliases = [...new Set([...callerAliases, ...(contact === null ? [] : phoneAliases(contact))])];
  if (!contactAliases.length && !callerAliases.length) return [];
  const conditions: string[] = [];
  const values: string[] = [];
  if (contactAliases.length) {
    conditions.push(`phone IN (${contactAliases.map(() => '?').join(',')})`);
    values.push(...contactAliases);
  }
  if (callerAliases.length) {
    conditions.push(`caller_phone IN (${callerAliases.map(() => '?').join(',')})`);
    values.push(...callerAliases);
  }
  const rows = await database.prepare(`SELECT * FROM bookings WHERE deleted_at IS NULL
    AND COALESCE(assigned_date,requested_date)>=? AND (${conditions.join(' OR ')})
    ORDER BY COALESCE(assigned_date,requested_date),COALESCE(assigned_time,requested_time),id`)
    .all(today, ...values);
  return rows.filter(row => callBookingRelated(row, caller, contact));
}
