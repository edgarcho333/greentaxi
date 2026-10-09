import type { Database, DatabaseRow } from './database.js';
import type { PassengerProfile, SavedPassengerAddress } from '../src/api.js';
import { normalizePhone, phoneAliases } from '../shared/phone.js';
import { passengerDepartureTimes } from '../shared/passenger-departure-times.js';

const PHONE_STORAGE_MARKER = 'georgianPhoneStorageV2';
const PICKUP_MEMORY_MARKER = 'goriPickupMemoryV1';
const ADDRESSES_MARKER = 'passengerAddressesV1';
const PHONE_QUERY_SIZE = 200;
type Candidate = { row: DatabaseRow; priority: number; canonical: string };

function canonicalPhone(value: unknown): string | null {
  return typeof value === 'string' ? normalizePhone(value) : null;
}
function stamp(row: DatabaseRow): string { return typeof row.updated_at === 'string' ? row.updated_at : ''; }
function cleanAddress(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
}
function addressKey(address: string): string { return address.toLocaleLowerCase('ka-GE'); }
function addressStamp(value: unknown): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
function compareCandidates(first: Candidate, second: Candidate): number {
  const firstStamp = stamp(first.row);
  const secondStamp = stamp(second.row);
  const firstTime = Date.parse(firstStamp);
  const secondTime = Date.parse(secondStamp);
  if (Number.isFinite(firstTime) !== Number.isFinite(secondTime)) return Number.isFinite(firstTime) ? -1 : 1;
  if (Number.isFinite(firstTime) && Number.isFinite(secondTime) && firstTime !== secondTime) return secondTime - firstTime;
  if (firstStamp !== secondStamp && (!Number.isFinite(firstTime) || !Number.isFinite(secondTime))) return secondStamp.localeCompare(firstStamp);
  if (first.priority !== second.priority) return second.priority - first.priority;
  const firstCanonical = first.row.phone === first.canonical;
  const secondCanonical = second.row.phone === second.canonical;
  if (firstCanonical !== secondCanonical) return firstCanonical ? -1 : 1;
  const firstId = Number(first.row.id ?? 0);
  const secondId = Number(second.row.id ?? 0);
  if (firstId !== secondId) return secondId - firstId;
  return String(first.row.phone).localeCompare(String(second.row.phone));
}
function pickupCandidate(candidates: Candidate[]): Candidate | undefined {
  return candidates.filter(candidate => typeof candidate.row.gori_pickup_address === 'string' && candidate.row.gori_pickup_address.trim())
    .sort((first, second) => compareCandidates(
      { ...first, row: { ...first.row, updated_at: first.row.gori_pickup_updated_at ?? first.row.updated_at } },
      { ...second, row: { ...second.row, updated_at: second.row.gori_pickup_updated_at ?? second.row.updated_at } },
    ))[0];
}
function withPickupMemory(row: DatabaseRow): DatabaseRow {
  return row.direction === 'gori-tbilisi'
    ? { ...row, gori_pickup_address: row.gori_address, gori_pickup_updated_at: row.updated_at }
    : row;
}
function mergeProfile(canonical: string, candidates: Candidate[]): PassengerProfile | null {
  const sorted = [...candidates].sort(compareCandidates);
  if (!sorted.length) return null;
  const newest = sorted[0].row;
  const named = sorted.find(candidate => typeof candidate.row.name === 'string' && candidate.row.name.trim())?.row ?? newest;
  const addressed = sorted.find(candidate => typeof candidate.row.gori_address === 'string' && candidate.row.gori_address.trim())?.row ?? newest;
  const stop = sorted.find(candidate => candidate.row.pickup_stop_id !== null && candidate.row.pickup_stop_id !== undefined && Number(candidate.row.stop_active) === 1)?.row;
  return {
    phone: canonical,
    name: typeof named.name === 'string' ? named.name : '',
    goriAddress: typeof addressed.gori_address === 'string' ? addressed.gori_address : '',
    goriPickupAddress: String(pickupCandidate(candidates)?.row.gori_pickup_address ?? ''),
    pickupStopId: stop ? Number(stop.pickup_stop_id) : null,
    pickupStopName: stop ? String(stop.current_stop_name ?? stop.pickup_stop_name) : null,
    updatedAt: stamp(newest),
  };
}
async function profileCandidates(db: Database, phones: string[]): Promise<Map<string, Candidate[]>> {
  const canonicalPhones = [...new Set(phones.map(canonicalPhone).filter((value): value is string => value !== null))];
  const aliases = [...new Set(canonicalPhones.flatMap(value => phoneAliases(value)))];
  const result = new Map<string, Candidate[]>();
  for (let offset = 0; offset < aliases.length; offset += PHONE_QUERY_SIZE) {
    const batch = aliases.slice(offset, offset + PHONE_QUERY_SIZE);
    const rows = await db.prepare(`SELECT passenger_profiles.*,stops.active AS stop_active,stops.name AS current_stop_name
      FROM passenger_profiles LEFT JOIN stops ON stops.id=passenger_profiles.pickup_stop_id
      WHERE phone IN (${batch.map(() => '?').join(',')})`).all(...batch);
    for (const row of rows) {
      const canonical = canonicalPhone(row.phone);
      if (!canonical) continue;
      const group = result.get(canonical) ?? [];
      group.push({ row, priority: 100, canonical });
      result.set(canonical, group);
    }
  }
  return result;
}

/** Read aliases without repairing storage, so an operator lookup cannot change passenger data. */
export async function readPassengerProfiles(db: Database, phones: string[], now: Date = new Date()): Promise<Map<string, PassengerProfile>> {
  const groups = await profileCandidates(db, phones);
  const canonicalPhones = [...groups.keys()];
  const [addresses, departureTimes] = await Promise.all([
    readSavedAddresses(db, canonicalPhones), readDepartureTimes(db, canonicalPhones, now),
  ]);
  const result = new Map<string, PassengerProfile>();
  for (const [canonical, candidates] of groups) {
    const profile = mergeProfile(canonical, candidates);
    if (profile) result.set(canonical, { ...profile, addresses: addresses.get(canonical) ?? [],
      departureTimes: departureTimes.get(canonical) ?? { 'gori-tbilisi': [], 'tbilisi-gori': [] } });
  }
  return result;
}

/** The phone index and bounded alias batches avoid scanning unrelated customers or per-row requests. */
async function readDepartureTimes(db: Database, phones: string[], now: Date): Promise<Map<string, NonNullable<PassengerProfile['departureTimes']>>> {
  const aliases = [...new Set(phones.flatMap(phone => phoneAliases(phone)))];
  const wanted = new Set(phones);
  const groups = new Map<string, Parameters<typeof passengerDepartureTimes>[0][number][]>();
  for (let offset = 0; offset < aliases.length; offset += PHONE_QUERY_SIZE) {
    const batch = aliases.slice(offset, offset + PHONE_QUERY_SIZE);
    const rows = await db.prepare(`SELECT phone,direction,status,deleted_at,requested_date,requested_time,assigned_date,assigned_time
      FROM bookings WHERE status='confirmed' AND deleted_at IS NULL AND phone IN (${batch.map(() => '?').join(',')})`).all(...batch);
    for (const row of rows) {
      const canonical = canonicalPhone(row.phone);
      if (!canonical || !wanted.has(canonical)) continue;
      const group = groups.get(canonical) ?? [];
      group.push({ direction: row.direction, status: row.status, deletedAt: row.deleted_at,
        requestedDate: row.requested_date, requestedTime: row.requested_time, assignedDate: row.assigned_date, assignedTime: row.assigned_time });
      groups.set(canonical, group);
    }
  }
  return new Map([...groups].map(([phone, history]) => [phone, passengerDepartureTimes(history, now)]));
}

/** Read saved suggestions in bounded batches; inactive fixed stops stay in storage and history. */
async function readSavedAddresses(db: Database, phones: string[]): Promise<Map<string, SavedPassengerAddress[]>> {
  const aliases = [...new Set(phones.flatMap(phone => phoneAliases(phone)))];
  const groups = new Map<string, Map<string, SavedPassengerAddress>>();
  for (let offset = 0; offset < aliases.length; offset += PHONE_QUERY_SIZE) {
    const batch = aliases.slice(offset, offset + PHONE_QUERY_SIZE);
    const rows = await db.prepare(`SELECT passenger_addresses.*,stops.active AS stop_active,
      stops.name AS current_stop_name,stops.address AS current_stop_address
      FROM passenger_addresses LEFT JOIN stops ON stops.id=passenger_addresses.pickup_stop_id
      WHERE phone IN (${batch.map(() => '?').join(',')})`).all(...batch);
    for (const row of rows) {
      const canonical = canonicalPhone(row.phone);
      if (!canonical || (row.city !== 'gori' && row.city !== 'tbilisi')) continue;
      if (row.city === 'tbilisi' && Number(row.stop_active) !== 1) continue;
      const saved: SavedPassengerAddress = {
        city: row.city,
        address: cleanAddress(row.city === 'tbilisi' ? row.current_stop_address : row.address),
        pickupStopId: row.city === 'tbilisi' ? Number(row.pickup_stop_id) : null,
        pickupStopName: row.city === 'tbilisi' ? String(row.current_stop_name ?? row.pickup_stop_name ?? '') : null,
        updatedAt: addressStamp(row.updated_at),
      };
      const key = `${saved.city}:${saved.city === 'tbilisi' ? saved.pickupStopId : addressKey(saved.address)}`;
      const group = groups.get(canonical) ?? new Map<string, SavedPassengerAddress>();
      if (!group.has(key) || saved.updatedAt > group.get(key)!.updatedAt) group.set(key, saved);
      groups.set(canonical, group);
    }
  }
  return new Map([...groups].map(([phone, entries]) => [phone, [...entries.values()].sort((first, second) =>
    second.updatedAt.localeCompare(first.updatedAt) || first.city.localeCompare(second.city) || first.address.localeCompare(second.address))]));
}

async function saveAddress(db: Database, phone: string, city: SavedPassengerAddress['city'], value: unknown,
  updatedAt: unknown, stop?: DatabaseRow, snapshotName?: unknown): Promise<void> {
  const address = cleanAddress(value);
  if (city === 'gori' && !address) return;
  if (city === 'tbilisi' && !stop) return;
  const key = city === 'tbilisi' ? `stop:${Number(stop!.id)}` : addressKey(address);
  await db.prepare(`INSERT INTO passenger_addresses(phone,city,address_key,address,pickup_stop_id,pickup_stop_name,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(phone,city,address_key) DO UPDATE SET
      address=excluded.address,pickup_stop_id=excluded.pickup_stop_id,pickup_stop_name=excluded.pickup_stop_name,
      updated_at=excluded.updated_at WHERE excluded.updated_at>=passenger_addresses.updated_at`)
    .run(phone, city, key, address, city === 'tbilisi' ? Number(stop!.id) : null,
      city === 'tbilisi' ? String(snapshotName ?? stop!.name ?? '') : null, addressStamp(updatedAt));
}
export async function readPassengerProfile(db: Database, phone: string, now: Date = new Date()): Promise<PassengerProfile | null> {
  const canonical = canonicalPhone(phone);
  if (!canonical) return null;
  return (await readPassengerProfiles(db, [canonical], now)).get(canonical) ?? null;
}

async function writeProfile(db: Database, profile: PassengerProfile, candidates: Candidate[]): Promise<void> {
  const pickup = pickupCandidate(candidates);
  await db.prepare(`INSERT INTO passenger_profiles(phone,name,gori_address,pickup_stop_id,pickup_stop_name,updated_at,gori_pickup_address,gori_pickup_updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(phone) DO UPDATE SET name=excluded.name,gori_address=excluded.gori_address,
      pickup_stop_id=excluded.pickup_stop_id,pickup_stop_name=excluded.pickup_stop_name,updated_at=excluded.updated_at,
      gori_pickup_address=excluded.gori_pickup_address,gori_pickup_updated_at=excluded.gori_pickup_updated_at`)
    .run(profile.phone, profile.name, profile.goriAddress, profile.pickupStopId, profile.pickupStopName, profile.updatedAt,
      profile.goriPickupAddress, pickup ? pickup.row.gori_pickup_updated_at ?? stamp(pickup.row) : null);
  const aliases = [...new Set(candidates.map(candidate => String(candidate.row.phone)))].filter(value => value !== profile.phone && canonicalPhone(value) === profile.phone);
  for (let offset = 0; offset < aliases.length; offset += PHONE_QUERY_SIZE) {
    const batch = aliases.slice(offset, offset + PHONE_QUERY_SIZE);
    await db.prepare(`DELETE FROM passenger_profiles WHERE phone IN (${batch.map(() => '?').join(',')})`).run(...batch);
  }
}

/** The caller holds db.transaction together with the confirmed booking mutation. */
export async function savePassengerProfile(db: Database, row: DatabaseRow): Promise<void> {
  if (row.status !== 'confirmed') return;
  const canonical = canonicalPhone(row.phone);
  if (!canonical) return;
  const previous = (await profileCandidates(db, [canonical])).get(canonical) ?? [];
  const stop = row.pickup_stop_id === null || row.pickup_stop_id === undefined ? undefined
    : await db.prepare('SELECT id,name,address,active FROM stops WHERE id=?').get(row.pickup_stop_id);
  const incoming: Candidate = {
    canonical, priority: 1000,
    row: { ...withPickupMemory(row), phone: canonical, stop_active: stop?.active ?? 0, current_stop_name: stop?.name ?? null },
  };
  const candidates = [...previous, incoming];
  const merged = mergeProfile(canonical, candidates);
  if (merged) await writeProfile(db, merged, candidates);
  await saveAddress(db, canonical, 'gori', row.gori_address, row.updated_at);
  if (row.direction === 'tbilisi-gori') await saveAddress(db, canonical, 'tbilisi', stop?.address, row.updated_at, stop, row.pickup_stop_name);
}

/** One repeat-safe, additive backfill. GET requests never repair or add customer data. */
export async function migratePassengerAddresses(db: Database): Promise<void> {
  await db.transaction(async () => {
    if (await db.prepare('SELECT value FROM settings WHERE key=?').get(ADDRESSES_MARKER)) return;
    const stops = new Map((await db.prepare('SELECT id,name,address,active FROM stops').all()).map(row => [Number(row.id), row]));
    const bookings = await db.prepare("SELECT * FROM bookings WHERE status='confirmed' ORDER BY created_at,id").all();
    for (const row of bookings) {
      const canonical = canonicalPhone(row.phone);
      if (!canonical) continue;
      await saveAddress(db, canonical, 'gori', row.gori_address, row.created_at);
      if (row.direction === 'tbilisi-gori') {
        const stop = stops.get(Number(row.pickup_stop_id));
        await saveAddress(db, canonical, 'tbilisi', stop?.address, row.created_at, stop, row.pickup_stop_name);
      }
    }
    const profiles = await db.prepare('SELECT * FROM passenger_profiles').all();
    for (const row of profiles) {
      const canonical = canonicalPhone(row.phone);
      if (!canonical) continue;
      await saveAddress(db, canonical, 'gori', row.gori_address, row.updated_at);
      await saveAddress(db, canonical, 'gori', row.gori_pickup_address, row.gori_pickup_updated_at ?? row.updated_at);
      const stop = stops.get(Number(row.pickup_stop_id));
      if (stop) await saveAddress(db, canonical, 'tbilisi', stop.address, row.updated_at, stop, row.pickup_stop_name);
    }
    await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(ADDRESSES_MARKER, '1');
  });
}

/** One versioned repair; invalid legacy rows and immutable call hashes remain intact. */
export async function migratePhoneStorage(db: Database): Promise<void> {
  await db.transaction(async () => {
    if (await db.prepare('SELECT value FROM settings WHERE key=?').get(PHONE_STORAGE_MARKER)) return;
    const groups = new Map<string, Candidate[]>();
    const existingProfiles = await db.prepare(`SELECT passenger_profiles.*,stops.active AS stop_active,stops.name AS current_stop_name
      FROM passenger_profiles LEFT JOIN stops ON stops.id=passenger_profiles.pickup_stop_id`).all();
    for (const row of existingProfiles) {
      const canonical = canonicalPhone(row.phone);
      if (!canonical) continue;
      const group = groups.get(canonical) ?? [];
      group.push({ row, priority: 100, canonical });
      groups.set(canonical, group);
    }
    const stops = new Map((await db.prepare('SELECT id,name,active FROM stops').all()).map(row => [Number(row.id), row]));
    const bookings = await db.prepare('SELECT * FROM bookings ORDER BY updated_at,id').all();
    for (const row of bookings) {
      const canonical = canonicalPhone(row.phone);
      if (!canonical) continue;
      if (canonical !== row.phone) await db.prepare('UPDATE bookings SET phone=? WHERE id=?').run(canonical, row.id);
      // Deleted confirmed bookings remain trusted history; waiting public requests never populate profiles.
      if (row.status !== 'confirmed') continue;
      const stop = row.pickup_stop_id === null || row.pickup_stop_id === undefined ? undefined : stops.get(Number(row.pickup_stop_id));
      const group = groups.get(canonical) ?? [];
      group.push({
        canonical, priority: 10,
        row: { ...withPickupMemory(row), phone: canonical, stop_active: stop?.active ?? 0, current_stop_name: stop?.name ?? null },
      });
      groups.set(canonical, group);
    }
    const calls = await db.prepare('SELECT id,phone FROM call_inquiries WHERE phone IS NOT NULL').all();
    for (const row of calls) {
      const canonical = canonicalPhone(row.phone);
      if (canonical && canonical !== row.phone) await db.prepare('UPDATE call_inquiries SET phone=? WHERE id=?').run(canonical, row.id);
    }
    for (const [canonical, candidates] of groups) {
      const profile = mergeProfile(canonical, candidates);
      if (profile) await writeProfile(db, profile, candidates);
    }
    await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(PHONE_STORAGE_MARKER, '1');
  });
}

/** Backfill pickup-only memory without changing legacy contact fields, call identity or booking history. */
export async function migratePickupMemory(db: Database): Promise<void> {
  await db.transaction(async () => {
    if (await db.prepare('SELECT value FROM settings WHERE key=?').get(PICKUP_MEMORY_MARKER)) return;
    const groups = new Map<string, Candidate[]>();
    const profiles = await db.prepare('SELECT * FROM passenger_profiles').all();
    for (const row of profiles) {
      const canonical = canonicalPhone(row.phone);
      if (!canonical) continue;
      const group = groups.get(canonical) ?? [];
      group.push({ row, priority: 100, canonical });
      groups.set(canonical, group);
    }
    const bookings = await db.prepare("SELECT * FROM bookings WHERE status='confirmed' AND direction='gori-tbilisi' ORDER BY updated_at,id").all();
    for (const row of bookings) {
      const canonical = canonicalPhone(row.phone);
      if (!canonical) continue;
      const group = groups.get(canonical) ?? [];
      group.push({ row: withPickupMemory(row), priority: 10, canonical });
      groups.set(canonical, group);
    }
    for (const [canonical, candidates] of groups) {
      const pickup = pickupCandidate(candidates);
      if (!pickup) continue;
      const cached = candidates.filter(candidate => candidate.priority === 100);
      if (!cached.length) {
        const profile = mergeProfile(canonical, candidates);
        if (profile) await writeProfile(db, profile, candidates);
        continue;
      }
      // Keep aliases intact here: deferred phone migration must remain read-compatible.
      for (const candidate of cached) await db.prepare('UPDATE passenger_profiles SET gori_pickup_address=?,gori_pickup_updated_at=? WHERE phone=?')
        .run(pickup.row.gori_pickup_address, pickup.row.gori_pickup_updated_at ?? stamp(pickup.row), candidate.row.phone);
    }
    await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(PICKUP_MEMORY_MARKER, '1');
  });
}
