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
  const reservations = await database.prepare("SELECT id,assigned_vehicle_key,seats FROM bookings WHERE direction=? AND assigned_date=? AND assigned_time=? AND booking_type='whole_car' AND status='confirmed' AND deleted_at IS NULL").all(DRIVER_DIRECTION, date, time);
  const active = times.includes(time);
  const assigned = [
    ...schedule.drivers.filter(driver => !driver.declined && driver.assignedTime === time).map(driver => ({ key: `roster:${driver.id}`, driverId: driver.id, kind: 'roster' as const, name: driver.name, capacity: driver.capacity, active })),
    ...temporary.map(driver => ({ key: `temporary:${driver.id}`, driverId: null, kind: 'temporary' as const, name: driver.name as string, capacity: driver.capacity as number, active })),
  ];
  // Bookings can arrive while the editor is open. Only the driver/schedule plan
  // participates in the revision; editing an outdated plan must be explicit.
  const revision = createHash('sha256').update(JSON.stringify({ date, time, times: [...times], drivers: schedule.drivers, temporary })).digest('hex');
  const shared = calculateTripCapacity(assigned.filter(car => !reservations.some(row => row.assigned_vehicle_key === car.key)), Math.max(0, (count?.seats ?? 0) - reservations.reduce((sum, row) => sum + row.seats, 0)));
  const cars = assigned.map(car => {
    const reserved = reservations.find(row => row.assigned_vehicle_key === car.key);
    return reserved ? { ...car, filledSeats: active ? car.capacity : 0, freeSeats: 0, reservedBookingId: reserved.id } : shared.drivers.find(item => item.key === car.key)!;
  });
  return {
    direction: DRIVER_DIRECTION, date, time, active,
    bookingCount: count?.orders ?? 0,
    ...shared, drivers: cars, bookedSeats: count?.seats ?? 0,
    uncoveredSeats: shared.uncoveredSeats + reservations.filter(row => !assigned.some(car => car.active && car.key === row.assigned_vehicle_key)).reduce((sum, row) => sum + row.seats, 0),
    totalSeats: assigned.reduce((sum, car) => sum + (active ? car.capacity : 0), 0),
    revision,
    availableDrivers: schedule.drivers.filter(driver => !driver.declined),
  };
}
