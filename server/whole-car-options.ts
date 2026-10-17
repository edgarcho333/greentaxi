import { createHash } from 'node:crypto';
import type { WholeCarDriver, WholeCarOptions } from '../src/api.js';
import { DRIVER_DIRECTION } from '../shared/driver-rotation.js';
import type { Database } from './database.js';
import { readDriverSchedule } from './drivers.js';

/** Options are a read-only projection; choosing one in a form never assigns it. */
export async function readWholeCarOptions(database: Database, date: string, time: string, times: readonly string[]): Promise<WholeCarOptions> {
  const schedule = await readDriverSchedule(database, date, times);
  const temporary = await database.prepare('SELECT id,name,capacity,sort_order FROM temporary_trip_drivers WHERE direction=? AND date=? AND time=? AND removed_at IS NULL ORDER BY sort_order,id')
    .all(DRIVER_DIRECTION, date, time);
  const reservations = await database.prepare("SELECT id,assigned_vehicle_key FROM bookings WHERE direction=? AND assigned_date=? AND booking_type='whole_car' AND status='confirmed' AND deleted_at IS NULL ORDER BY id")
    .all(DRIVER_DIRECTION, date);
  const choices = [
    ...schedule.drivers.map(driver => ({
      key: `roster:${driver.id}`, driverId: driver.id, kind: 'roster' as const, name: driver.name,
      capacity: driver.capacity, queuePosition: driver.queuePosition, assignedTime: driver.assignedTime, declined: driver.declined,
    })),
    ...temporary.map(driver => ({
      key: `temporary:${driver.id}`, driverId: null, kind: 'temporary' as const, name: driver.name as string,
      capacity: driver.capacity as number, queuePosition: null, assignedTime: time, declined: false,
    })),
  ];
  const drivers: WholeCarDriver[] = choices.map(driver => {
    // Per-driver revisions allow several sibling bookings in one transaction.
    // Reservations are checked separately at commit, including other hours.
    const revision = createHash('sha256').update(JSON.stringify({ date, time, times: schedule.times, driver })).digest('hex');
    const reservation = reservations.find(row => row.assigned_vehicle_key === driver.key);
    return { ...driver, revision, ...(reservation ? { reservedBookingId: reservation.id as number } : {}) };
  });
  const revision = createHash('sha256').update(JSON.stringify({ date, time, revisions: drivers.map(driver => driver.revision) })).digest('hex');
  return { direction: DRIVER_DIRECTION, date, time, active: schedule.times.includes(time), revision, drivers };
}
