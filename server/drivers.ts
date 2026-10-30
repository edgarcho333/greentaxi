import type { DriverSchedule } from '../src/api.js';
import { buildDriverSchedule, type DriverDayOverride, type DriverRosterEntry } from '../shared/driver-rotation.js';
import type { Database } from './database.js';

export async function readDriverSchedule(database: Database, date: string, times: readonly string[]): Promise<DriverSchedule> {
  const rows = await database.prepare('SELECT id,name,capacity,sort_order,revision FROM drivers WHERE deleted_at IS NULL ORDER BY sort_order,id').all();
  const drivers: DriverRosterEntry[] = rows.map(row => ({ id: row.id, name: row.name, capacity: row.capacity, order: row.sort_order }));
  const revisions = new Map(rows.map(row => [row.id, row.revision]));
  const stored = await database.prepare('SELECT driver_id,declined,assignment_mode,manual_time FROM driver_day_overrides WHERE date=?').all(date);
  const assignments = await database.prepare('SELECT driver_id,time FROM driver_trip_assignments WHERE date=? ORDER BY time,driver_id').all(date);
  const assignedTimes = new Map<number, string[]>();
  for (const assignment of assignments) assignedTimes.set(assignment.driver_id, [...(assignedTimes.get(assignment.driver_id) ?? []), assignment.time]);
  const overrides: DriverDayOverride[] = stored.map(row => ({
    driverId: row.driver_id,
    declined: row.declined === 1,
    assignmentMode: row.assignment_mode,
    manualTime: row.manual_time,
    manualTimes: assignedTimes.get(row.driver_id) ?? [],
  }));
  for (const [driverId, times] of assignedTimes) if (!overrides.some(row => row.driverId === driverId)) {
    overrides.push({ driverId, declined: false, assignmentMode: 'manual', manualTime: times[0] ?? null, manualTimes: times });
  }
  const contacts = await database.prepare('SELECT driver_id,phone FROM driver_accounts').all();
  const phones = new Map(contacts.map(contact => [contact.driver_id as number, contact.phone as string | null]));
  const schedule = buildDriverSchedule(date, times, drivers, overrides);
  return { ...schedule, drivers: schedule.drivers.map(driver => ({ ...driver, phone: phones.get(driver.id) ?? null, revision: revisions.get(driver.id)! })) };
}

/** Keep the old single-time column as a compatibility projection, never as the plan. */
async function mirrorLegacyAssignment(database: Database, driverId: number, date: string, timestamp: string, activate: boolean) {
  const first = await database.prepare('SELECT MIN(time) AS time FROM driver_trip_assignments WHERE driver_id=? AND date=?').get(driverId, date);
  await database.prepare(`INSERT INTO driver_day_overrides(driver_id,date,declined,assignment_mode,manual_time,updated_at) VALUES (?,?,0,'manual',?,?)
    ON CONFLICT(driver_id,date) DO UPDATE SET assignment_mode='manual',manual_time=excluded.manual_time,
      declined=CASE WHEN ?=1 THEN 0 ELSE driver_day_overrides.declined END,updated_at=excluded.updated_at`)
    .run(driverId, date, first?.time ?? null, timestamp, Number(activate));
}

export async function addDriverTripAssignment(database: Database, driverId: number, date: string, time: string, timestamp: string, activate = false) {
  await database.prepare('INSERT INTO driver_trip_assignments(driver_id,date,time,created_at) VALUES (?,?,?,?) ON CONFLICT(driver_id,date,time) DO NOTHING')
    .run(driverId, date, time, timestamp);
  await mirrorLegacyAssignment(database, driverId, date, timestamp, activate);
}

export async function removeDriverTripAssignment(database: Database, driverId: number, date: string, time: string, timestamp: string) {
  await database.prepare('DELETE FROM driver_trip_assignments WHERE driver_id=? AND date=? AND time=?').run(driverId, date, time);
  await mirrorLegacyAssignment(database, driverId, date, timestamp, false);
}
