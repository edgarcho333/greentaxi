import type { DriverSchedule } from '../src/api.js';
import { buildDriverSchedule, type DriverDayOverride, type DriverRosterEntry } from '../shared/driver-rotation.js';
import type { Database } from './database.js';

export async function readDriverSchedule(database: Database, date: string, times: readonly string[]): Promise<DriverSchedule> {
  const rows = await database.prepare('SELECT id,name,capacity,sort_order FROM drivers ORDER BY sort_order,id').all();
  const drivers: DriverRosterEntry[] = rows.map(row => ({ id: row.id, name: row.name, capacity: row.capacity, order: row.sort_order }));
  const stored = await database.prepare('SELECT driver_id,declined,assignment_mode,manual_time FROM driver_day_overrides WHERE date=?').all(date);
  const overrides: DriverDayOverride[] = stored.map(row => ({
    driverId: row.driver_id,
    declined: row.declined === 1,
    assignmentMode: row.assignment_mode,
    manualTime: row.manual_time,
  }));
  return buildDriverSchedule(date, times, drivers, overrides);
}
