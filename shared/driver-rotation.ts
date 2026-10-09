import type { DriverDay, DriverSchedule } from '../src/api.js';

export const DRIVER_ROTATION_ANCHOR = '2026-10-09';
export const DRIVER_DIRECTION = 'gori-tbilisi' as const;

export type DriverRosterEntry = Readonly<{
  id: number;
  name: string;
  capacity: number;
  order: number;
}>;

export type DriverDayOverride = Readonly<{
  driverId: number;
  declined: boolean;
  assignmentMode: 'auto' | 'manual';
  manualTime: string | null;
}>;

// IDs and order describe the permanent queue, independently of daily attendance.
export const INITIAL_DRIVER_ROSTER: readonly DriverRosterEntry[] = Object.freeze([
  ['რეზო', 7],
  ['კუდუხა', 7],
  ['გოჩა', 8],
  ['ვიქტორი', 7],
  ['ბიძინა', 6],
  ['დიმა', 7],
  ['გუგა', 7],
  ['ამიკო', 6],
  ['ნიკა', 6],
  ['გიგა', 6],
  ['ვანო', 7],
  ['გიორგი', 7],
  ['შოშია', 7],
  ['ლევანი', 6],
  ['დოლიმე', 7],
  ['კობა', 6],
  ['ბოლოთა', 7],
  ['ბუზა', 7],
  ['ზურა', 7],
  ['ედიკა', 7],
  ['კახა ახალი', 7],
  ['ბორა', 7],
  ['თემო ახალი', 7],
  ['ფურცელა', 7],
  ['ბადრი', 6],
  ['რამაზი', 7],
  ['ვალერი', 7],
  ['დათო ტინის ხიდი', 7],
  ['დათო ტინის ხიდი ახალი', 7],
  ['ერასტი', 7],
  ['გურამი', 7],
  ['სუხიტა', 7],
  ['გელა', 6],
  ['სოსო', 8],
  ['აჩიკო', 7],
  ['ირაკლი', 7],
  ['კევა', 6],
  ['ზვიადი', 7],
  ['სვანი', 6],
  ['დევი', 6],
  ['ილარიონო', 7],
  ['გია', 8],
  ['ლაშა / ვიქტორი', 7],
].map(([name, capacity], index) => Object.freeze({
  id: index + 1,
  name: name as string,
  capacity: capacity as number,
  order: index + 1,
})));

/** A civil calendar day, without local timezone or daylight-saving offsets. */
export function calendarDateOrdinal(date: string): number {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('Invalid calendar date.');
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw new RangeError('Invalid calendar date.');
  return timestamp / 86_400_000;
}

/** Rotate by calendar days first; refusals must never change the base queue. */
export function rotateDriverQueue<T>(drivers: readonly T[], anchorDate: string, date: string): T[] {
  const elapsed = calendarDateOrdinal(date) - calendarDateOrdinal(anchorDate);
  if (drivers.length === 0) return [];
  const offset = ((elapsed % drivers.length) + drivers.length) % drivers.length;
  return [...drivers.slice(offset), ...drivers.slice(0, offset)];
}

/** A refusal belongs to this date only and does not consume a position. */
export function availableDriverQueue<T extends { id: number }>(
  drivers: readonly T[],
  anchorDate: string,
  date: string,
  declinedIds: ReadonlySet<number>,
): T[] {
  return rotateDriverQueue(drivers, anchorDate, date).filter(driver => !declinedIds.has(driver.id));
}

/** The daily plan is a projection; it never changes the permanent queue or bookings. */
export function buildDriverSchedule(
  date: string,
  times: readonly string[],
  drivers: readonly DriverRosterEntry[] = INITIAL_DRIVER_ROSTER,
  overrides: readonly DriverDayOverride[] = [],
): DriverSchedule {
  if (times.some(time => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new RangeError('Invalid departure time.');
  const effectiveTimes = [...new Set(times)].sort();
  const permanent = [...drivers].sort((first, second) => first.order - second.order || first.id - second.id);
  const queue = rotateDriverQueue(permanent, DRIVER_ROTATION_ANCHOR, date);
  if (queue.length === 0) throw new RangeError('Driver roster is empty.');
  const preferences = new Map(overrides.map(override => [override.driverId, override]));
  let availablePosition = 0;
  const plan: DriverDay[] = queue.map((driver, index) => {
    const preference = preferences.get(driver.id);
    const declined = preference?.declined ?? false;
    const assignmentMode = preference?.assignmentMode ?? 'auto';
    const automaticTime = declined ? null : effectiveTimes[availablePosition++] ?? null;
    const assignedTime = declined ? null : assignmentMode === 'manual' ? preference?.manualTime ?? null : automaticTime;
    return {
      ...driver,
      queuePosition: index + 1,
      declined,
      assignmentMode,
      automaticTime,
      assignedTime,
      assignmentActive: assignedTime !== null && effectiveTimes.includes(assignedTime),
    };
  });
  return { direction: DRIVER_DIRECTION, date, anchorDate: DRIVER_ROTATION_ANCHOR, firstDriverId: queue[0].id, times: effectiveTimes, drivers: plan };
}
