import type { Passenger, PassengerProfile } from '../src/api.js';
import type { Database, DatabaseRow } from './database.js';
import { normalizePhone, phoneAliases } from '../shared/phone.js';
import { readPassengerProfiles } from './passenger-profiles.js';

function pickup(row: DatabaseRow): Pick<Passenger, 'address' | 'addressCity'> {
  if (row.direction === 'gori-tbilisi') return { address: String(row.gori_address ?? ''), addressCity: 'gori' };
  if (row.direction === 'tbilisi-gori') {
    const name = String(row.pickup_stop_name ?? row.current_stop_name ?? '').trim();
    const address = String(row.current_stop_address ?? '').trim();
    return { address: [...new Set([name, address].filter(Boolean))].join(' — '), addressCity: 'tbilisi' };
  }
  return { address: '', addressCity: null };
}

function latestDate(rows: DatabaseRow[]): string {
  return rows.reduce((latest, row) => {
    const day = String(row.assigned_date ?? row.requested_date ?? '');
    return day > latest ? day : latest;
  }, '');
}

/** New booking creation chooses the city; editing old contacts and deletion cannot change it. */
export function passengerSummary(rows: DatabaseRow[], profile: PassengerProfile | null = null, stops: DatabaseRow[] = []): Passenger {
  const newest = rows[0];
  const active = rows.filter(row => row.deleted_at === null);
  const trusted = rows.filter(row => row.status === 'confirmed');
  const candidates = [...(trusted.length ? trusted : rows)].sort((first, second) =>
    String(second.created_at).localeCompare(String(first.created_at)) || Number(second.id) - Number(first.id));
  const latest = candidates[0];
  let lastPickup = pickup(latest);
  if (trusted.length && profile) {
    if (latest.direction === 'gori-tbilisi' && profile.goriPickupAddress.trim()) {
      lastPickup = { address: profile.goriPickupAddress, addressCity: 'gori' };
    } else if (latest.direction === 'tbilisi-gori' && profile.pickupStopId !== null) {
      const currentStop = stops.find(stop => Number(stop.id) === profile.pickupStopId && Number(stop.active) === 1);
      if (currentStop) lastPickup = pickup({ direction: 'tbilisi-gori', pickup_stop_name: profile.pickupStopName ?? currentStop.name, current_stop_address: currentStop.address });
    }
  }
  return {
    name: String(newest.name ?? ''), phone: normalizePhone(newest.phone) ?? newest.phone,
    ...lastPickup,
    orderCount: active.length, seats: active.reduce((total, row) => total + Number(row.seats), 0),
    latestDate: latestDate(active.length ? active : rows),
  };
}

const passengerRowsSql = `SELECT bookings.*,stops.name AS current_stop_name,stops.address AS current_stop_address
  FROM bookings LEFT JOIN stops ON stops.id=bookings.pickup_stop_id`;

/** A single joined read covers both metrics and pickup addresses, including historical contacts. */
export async function listPassengers(db: Database): Promise<Passenger[]> {
  const rows = await db.prepare(`${passengerRowsSql} ORDER BY bookings.updated_at DESC,bookings.id DESC`).all();
  const groups = new Map<string, DatabaseRow[]>();
  for (const row of rows) {
    const canonical = normalizePhone(row.phone) ?? row.phone;
    const group = groups.get(canonical) ?? [];
    group.push(row);
    groups.set(canonical, group);
  }
  const [profiles, stops] = await Promise.all([
    readPassengerProfiles(db, [...groups.keys()]), db.prepare('SELECT id,name,address,active FROM stops').all(),
  ]);
  return [...groups.entries()].map(([canonical, group]) => passengerSummary(group, profiles.get(canonical) ?? null, stops))
    .sort((first, second) => second.latestDate.localeCompare(first.latestDate) || first.phone.localeCompare(second.phone));
}

/** Match complete phone identities only; never reuse the partial list-search predicate here. */
export async function passengerBookings(db: Database, canonical: string): Promise<DatabaseRow[]> {
  const aliases = phoneAliases(canonical);
  const rows = await db.prepare(`${passengerRowsSql} WHERE bookings.phone IN (${aliases.map(() => '?').join(',')})
    ORDER BY bookings.updated_at DESC,bookings.id DESC`).all(...aliases);
  return rows.filter(row => normalizePhone(row.phone) === canonical);
}

export function comparePassengerTrips(first: DatabaseRow, second: DatabaseRow): number {
  const firstSlot = `${first.assigned_date ?? first.requested_date} ${first.assigned_time ?? first.requested_time}`;
  const secondSlot = `${second.assigned_date ?? second.requested_date} ${second.assigned_time ?? second.requested_time}`;
  return secondSlot.localeCompare(firstSlot) || Number(second.id) - Number(first.id);
}
