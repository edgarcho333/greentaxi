import type { Database } from './database.js';
import { DriverAccountError, normalizeDriverPhone, setDriverPhone } from './driver-accounts.js';

type ManagedDriver = { id: number; name: string; capacity: number; phone: string | null; revision: number };
type MutationContext = { employeeId: number; now: () => Date; today: string };

function details(input: Record<string, unknown>, edit: boolean) {
  const allowed = edit ? ['name', 'capacity', 'phone', 'expectedRevision'] : ['name', 'capacity', 'phone'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new DriverAccountError(400, 'VALIDATION', 'მოთხოვნის მონაცემები არასწორია.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(input.name)) throw new DriverAccountError(400, 'VALIDATION', 'მიუთითეთ მძღოლის სახელი (მაქსიმუმ 100 სიმბოლო).');
  if (typeof input.capacity !== 'number' || !Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 8) throw new DriverAccountError(400, 'VALIDATION', 'ტევადობა უნდა იყოს 1-დან 8-მდე.');
  return { name: input.name.trim(), capacity: input.capacity, hasPhone: Object.hasOwn(input, 'phone'), phone: Object.hasOwn(input, 'phone') ? normalizeDriverPhone(input.phone, true) : null };
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new DriverAccountError(400, 'VALIDATION', 'განაახლეთ მძღოლის მონაცემები.');
  return value;
}
async function read(database: Database, id: number): Promise<ManagedDriver | null> {
  const row = await database.prepare(`SELECT driver.id,driver.name,driver.capacity,driver.revision,account.phone FROM drivers driver
    LEFT JOIN driver_accounts account ON account.driver_id=driver.id WHERE driver.id=? AND driver.deleted_at IS NULL`).get(id);
  return row ? { id: row.id, name: row.name, capacity: row.capacity, phone: row.phone ?? null, revision: row.revision } : null;
}
async function audit(database: Database, action: string, driver: ManagedDriver, context: MutationContext) {
  await database.prepare('INSERT INTO audit_log(user_id,booking_id,action,details,created_at) VALUES (?,NULL,?,?,?)')
    .run(context.employeeId, action, JSON.stringify({ driverId: driver.id, name: driver.name, capacity: driver.capacity, phoneConfigured: driver.phone !== null }), context.now().toISOString());
}
async function hasReservation(database: Database, id: number, today: string) {
  return database.prepare(`SELECT id FROM bookings WHERE booking_type='whole_car' AND assigned_vehicle_key=?
    AND status='confirmed' AND deleted_at IS NULL AND assigned_date>=?`).get(`roster:${id}`, today);
}

export async function createManagedDriver(database: Database, input: Record<string, unknown>, context: MutationContext): Promise<{ driver: ManagedDriver }> {
  const next = details(input, false);
  return database.transaction(async () => {
    const last = await database.prepare('SELECT COALESCE(MAX(id),0) AS last_id,COALESCE(MAX(sort_order),0) AS last_order FROM drivers').get();
    if (last!.last_id >= 2147483647 || last!.last_order >= 2147483647) throw new DriverAccountError(409, 'DRIVER_LIMIT', 'ახალი მძღოლის დამატება ვერ მოხერხდა.');
    const id = last!.last_id + 1;
    await database.prepare('INSERT INTO drivers(id,name,capacity,sort_order) VALUES (?,?,?,?)').run(id, next.name, next.capacity, last!.last_order + 1);
    if (next.hasPhone) await setDriverPhone(database, { driverId: id, phone: next.phone, employeeId: context.employeeId, now: context.now, touchRevision: false });
    const driver = (await read(database, id))!;
    await audit(database, 'driver.create', driver, context);
    return { driver };
  });
}

export async function updateManagedDriver(database: Database, id: number, input: Record<string, unknown>, context: MutationContext): Promise<{ driver: ManagedDriver }> {
  const next = details(input, true);
  const expected = revision(input.expectedRevision);
  return database.transaction(async () => {
    const current = await read(database, id);
    if (!current) throw new DriverAccountError(404, 'NOT_FOUND', 'მძღოლი ვერ მოიძებნა.');
    if (current.revision !== expected) throw new DriverAccountError(409, 'DRIVER_CHANGED', 'მძღოლის მონაცემები შეიცვალა. განაახლეთ სია და სცადეთ ხელახლა.');
    if (current.capacity !== next.capacity && await hasReservation(database, id, context.today)) throw new DriverAccountError(409, 'VEHICLE_RESERVED', 'მანქანა მთლიანად დაჯავშნილია. ტევადობის შეცვლამდე ჯერ შეცვალეთ ჯავშანი.');
    const phone = next.hasPhone ? next.phone : current.phone;
    const changed = next.name !== current.name || next.capacity !== current.capacity || phone !== current.phone;
    if (next.hasPhone && phone !== current.phone) await setDriverPhone(database, { driverId: id, phone, employeeId: context.employeeId, now: context.now, touchRevision: false });
    if (changed) {
      await database.prepare('UPDATE drivers SET name=?,capacity=?,revision=revision+1 WHERE id=?').run(next.name, next.capacity, id);
      await audit(database, 'driver.edit', (await read(database, id))!, context);
    }
    return { driver: (await read(database, id))! };
  });
}

export async function archiveManagedDriver(database: Database, id: number, input: Record<string, unknown>, context: MutationContext): Promise<{ ok: true }> {
  if (Object.keys(input).some(key => key !== 'expectedRevision')) throw new DriverAccountError(400, 'VALIDATION', 'მოთხოვნის მონაცემები არასწორია.');
  const expected = revision(input.expectedRevision);
  return database.transaction(async () => {
    const current = await read(database, id);
    if (!current) {
      if (await database.prepare('SELECT id FROM drivers WHERE id=? AND deleted_at IS NOT NULL').get(id)) return { ok: true };
      throw new DriverAccountError(404, 'NOT_FOUND', 'მძღოლი ვერ მოიძებნა.');
    }
    if (current.revision !== expected) throw new DriverAccountError(409, 'DRIVER_CHANGED', 'მძღოლის მონაცემები შეიცვალა. განაახლეთ სია და სცადეთ ხელახლა.');
    if (await hasReservation(database, id, context.today)) throw new DriverAccountError(409, 'VEHICLE_RESERVED', 'მანქანა მთლიანად დაჯავშნილია. წაშლამდე ჯერ შეცვალეთ ჯავშანი.');
    if (await database.prepare(`SELECT assignment.driver_id FROM driver_trip_assignments assignment
      LEFT JOIN driver_day_overrides preference ON preference.driver_id=assignment.driver_id AND preference.date=assignment.date
      WHERE assignment.driver_id=? AND assignment.date>=? AND COALESCE(preference.declined,0)=0`).get(id, context.today)) throw new DriverAccountError(409, 'DRIVER_ASSIGNED', 'მძღოლი რეისზეა დანიშნული. წაშლამდე ჯერ მოხსენით მომავალი რეისებიდან.');
    const timestamp = context.now().toISOString();
    await database.prepare('UPDATE drivers SET deleted_at=?,revision=revision+1 WHERE id=?').run(timestamp, id);
    await database.prepare('UPDATE driver_accounts SET phone=NULL,active=0,updated_at=? WHERE driver_id=?').run(timestamp, id);
    await database.prepare('DELETE FROM driver_sessions WHERE driver_id=?').run(id);
    await audit(database, 'driver.delete', current, context);
    return { ok: true };
  });
}
