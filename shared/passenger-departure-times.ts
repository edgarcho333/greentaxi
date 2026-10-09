import type { Booking, Direction } from '../src/api.js';

type DepartureHistory = Pick<Booking, 'direction' | 'status' | 'deletedAt' | 'requestedDate' | 'requestedTime' | 'assignedDate' | 'assignedTime'>;
type TimeVotes = { count: number; latest: number };

/** Rank actual past departures, giving every active confirmed booking one vote. */
export function passengerDepartureTimes(history: readonly DepartureHistory[], now: Date = new Date()): Record<Direction, string[]> {
  const groups: Record<Direction, Map<string, TimeVotes>> = { 'gori-tbilisi': new Map(), 'tbilisi-gori': new Map() };
  const cutoff = now.getTime();
  for (const row of history) {
    if (row.status !== 'confirmed' || row.deletedAt !== null || (row.direction !== 'gori-tbilisi' && row.direction !== 'tbilisi-gori')) continue;
    const day = row.assignedDate ?? row.requestedDate;
    const time = row.assignedTime ?? row.requestedTime;
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)
      || typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) continue;
    // Date.parse rolls dates such as 30 February into March; reject those rows explicitly.
    const calendarDay = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== day) continue;
    const departure = Date.parse(`${day}T${time}:00+04:00`);
    if (!Number.isFinite(departure) || !(departure < cutoff)) continue;
    const votes = groups[row.direction].get(time) ?? { count: 0, latest: -Infinity };
    votes.count++;
    votes.latest = Math.max(votes.latest, departure);
    groups[row.direction].set(time, votes);
  }
  const ranked = (direction: Direction) => [...groups[direction]].sort(([firstTime, first], [secondTime, second]) =>
    second.count - first.count || second.latest - first.latest || firstTime.localeCompare(secondTime)).map(([time]) => time);
  return { 'gori-tbilisi': ranked('gori-tbilisi'), 'tbilisi-gori': ranked('tbilisi-gori') };
}
