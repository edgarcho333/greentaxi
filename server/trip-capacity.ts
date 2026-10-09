import { createHash } from 'node:crypto';
import type { TripCapacity } from '../src/api.js';
import { DRIVER_DIRECTION } from '../shared/driver-rotation.js';
import { calculateTripCapacity } from '../shared/trip-capacity.js';
import type { Database } from './database.js';
import { readDriverSchedule } from './drivers.js';

/** Call inside one database transaction so drivers and bookings form one snapshot. */
export async function readTripCapacity(database: Database, date: string, time: string, times: readonly string[]): Promise<TripCapacity> {
  const schedule = await readDriverSchedule(database, date, times);
  const temporary = await database.prepare('SELECT id,name,capacity,sort_order FROM temporary_trip_drivers WHERE direction=? AND date=? AND time=? AND removed_at IS NULL ORDER BY sort_order,id')
    .all(DRIVER_DIRECTION, date, time);
  const count = await database.prepare("SELECT COUNT(*) AS orders,COALESCE(SUM(seats),0) AS seats FROM bookings WHERE direction=? AND assigned_date=? AND assigned_time=? AND status='confirmed' AND deleted_at IS NULL")
    .get(DRIVER_DIRECTION, date, time);
  const active = times.includes(time);
  const assigned = [
    ...schedule.drivers.filter(driver => !driver.declined && driver.assignedTime === time).map(driver => ({ key: `roster:${driver.id}`, driverId: driver.id, kind: 'roster' as const, name: driver.name, capacity: driver.capacity, active })),
    ...temporary.map(driver => ({ key: `temporary:${driver.id}`, driverId: null, kind: 'temporary' as const, name: driver.name as string, capacity: driver.capacity as number, active })),
  ];
  // Bookings can arrive while the editor is open. Only the driver/schedule plan
  // participates in the revision; editing an outdated plan must be explicit.
  const revision = createHash('sha256').update(JSON.stringify({ date, time, times: [...times], drivers: schedule.drivers, temporary })).digest('hex');
  return {
    direction: DRIVER_DIRECTION, date, time, active,
    bookingCount: count?.orders ?? 0,
    ...calculateTripCapacity(assigned, count?.seats ?? 0),
    revision,
    availableDrivers: schedule.drivers,
  };
}
