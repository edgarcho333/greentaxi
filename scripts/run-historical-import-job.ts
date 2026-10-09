import { createDatabase } from '../server/database.js';
import { HistoricalImportError, importHistoricalBookings, type HistoricalImport } from '../server/historical-import.js';
import { readPassengerProfiles } from '../server/passenger-profiles.js';
import { listPassengers } from '../server/passengers.js';
import { normalizePhone } from '../shared/phone.js';

// Private build-time maintenance job: no HTTP route and no customer values in logs.
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) throw new Error('INVALID_ARGUMENTS');
  if (!process.env.DATABASE_URL?.trim() || !process.env.HISTORICAL_IMPORT_PAYLOAD?.trim()) throw new Error('IMPORT_CONFIGURATION_REQUIRED');
  const input = JSON.parse(process.env.HISTORICAL_IMPORT_PAYLOAD) as HistoricalImport;
  const db = await createDatabase({ databaseUrl: process.env.DATABASE_URL, production: true });
  try {
    const phones = [...new Set(input.records.map(row => row.phone))];
    const before = await readPassengerProfiles(db, phones);
    const result = await importHistoricalBookings(db, input, { apply: args[0] === '--apply' });
    console.log(`GREENTAXI_IMPORT_REPORT:${JSON.stringify(result)}`);
    if (result.mode === 'blocked') { process.exitCode = 2; return; }
    if (result.committed) {
      const after = await readPassengerProfiles(db, phones);
      const passengers = new Map((await listPassengers(db)).map(row => [row.phone, row]));
      const bookings = await db.prepare('SELECT * FROM bookings WHERE direction=? AND assigned_date=?').all(input.direction, input.date);
      const byId = new Map(bookings.map(row => [Number(row.id), row]));
      const clean = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
      for (const entry of result.records) {
        const record = input.records.find(row => row.sourceLine === entry.sourceLine)!;
        const booking = byId.get(entry.bookingId!);
        if (!booking || normalizePhone(booking.phone) !== record.phone || booking.assigned_time !== record.time ||
          Number(booking.seats) !== record.seats || clean(booking.gori_address) !== clean(record.address) ||
          booking.status !== 'confirmed' || Boolean(booking.deleted_at) !== record.deleted) throw new Error('IMPORTED_BOOKING_VERIFICATION_FAILED');
        if (!after.get(record.phone)?.addresses?.some(saved => saved.city === 'gori' && clean(saved.address).toLocaleLowerCase('ka-GE') === clean(record.address).toLocaleLowerCase('ka-GE')) ||
          !passengers.has(record.phone)) throw new Error('PASSENGER_SYNC_VERIFICATION_FAILED');
      }
      const endOfDay = new Date(`${input.date}T23:59:59.999+04:00`).getTime();
      for (const [phone, profile] of before) {
        const previousStamp = Date.parse(profile.updatedAt);
        if (!Number.isFinite(previousStamp) || previousStamp <= endOfDay) continue;
        const saved = after.get(phone);
        if (!saved || profile.goriAddress !== saved.goriAddress || (profile.goriPickupAddress.trim() && profile.goriPickupAddress !== saved.goriPickupAddress) ||
          profile.pickupStopId !== saved.pickupStopId || profile.pickupStopName !== saved.pickupStopName || profile.updatedAt !== saved.updatedAt)
          throw new Error('NEWER_PROFILE_DEFAULT_CHANGED');
      }
      console.log(`GREENTAXI_IMPORT_VERIFIED:${JSON.stringify({ bookings: result.records.length, passengers: phones.length, passengerSyncVerified: true, newerDefaultsPreserved: true })}`);
    }
  } finally { await db.close(); }
}

main().catch(error => {
  const code = error instanceof HistoricalImportError ? error.code : /^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'IMPORT_JOB_FAILED';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
});
