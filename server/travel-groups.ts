import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';

export type TravelGroupMetadata = { travelGroupId: string | null; travelGroupOrder: number | null };

/** Called inside the same transaction that creates the individual passenger orders. */
export async function assignTravelGroup(database: Database, bookingIds: number[]): Promise<TravelGroupMetadata[]> {
  if (bookingIds.length < 2) return bookingIds.map(() => ({ travelGroupId: null, travelGroupOrder: null }));
  if (new Set(bookingIds).size !== bookingIds.length) throw new Error('Duplicate travel-group member');
  const id = randomUUID();
  const positions = bookingIds.map(() => 'WHEN ? THEN CAST(? AS INTEGER)').join(' ');
  const parameters: (string | number)[] = [id];
  bookingIds.forEach((bookingId, index) => parameters.push(bookingId, index));
  parameters.push(...bookingIds);
  const result = await database.prepare(`UPDATE bookings SET travel_group_id=?,
    travel_group_order=CASE id ${positions} END
    WHERE id IN (${bookingIds.map(() => '?').join(',')}) AND travel_group_id IS NULL`).run(...parameters);
  if (result.changes !== bookingIds.length) throw new Error('Travel-group membership changed');
  return bookingIds.map((_, index) => ({ travelGroupId: id, travelGroupOrder: index }));
}

/** Driver fields describe only the compatible orders already authorized for this response. */
export function visibleTravelGroups<T extends {
  id: number; direction: string; date: string; time: string; bookingType: string;
  travelGroupId?: string | null; travelGroupOrder?: number | null;
}>(bookings: T[]): (T & TravelGroupMetadata)[] {
  const result = bookings.map(booking => ({ ...booking, travelGroupId: null, travelGroupOrder: null } as T & TravelGroupMetadata));
  const cohorts = new Map<string, { booking: T; index: number }[]>();
  bookings.forEach((booking, index) => {
    // A whole-car reservation already identifies a particular vehicle. Never
    // reveal its ordinary or separately reserved siblings to another driver.
    if (!booking.travelGroupId || booking.bookingType === 'whole_car') return;
    const key = JSON.stringify([booking.travelGroupId, booking.direction, booking.date, booking.time]);
    const members = cohorts.get(key) ?? [];
    members.push({ booking, index });
    cohorts.set(key, members);
  });
  for (const members of cohorts.values()) {
    if (members.length < 2) continue;
    members.sort((first, second) => (first.booking.travelGroupOrder ?? Number.MAX_SAFE_INTEGER)
      - (second.booking.travelGroupOrder ?? Number.MAX_SAFE_INTEGER) || first.booking.id - second.booking.id);
    members.forEach(({ booking, index }, position) => {
      result[index].travelGroupId = booking.travelGroupId!;
      result[index].travelGroupOrder = position;
    });
  }
  return result;
}
