import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { DriverBooking, DriverDashboard, DriverDayStatus, DriverIdentity, DriverSession } from '../src/api.js';
import { DRIVER_DIRECTION } from '../shared/driver-rotation.js';
import { normalizePhone } from '../shared/phone.js';
import type { Database } from './database.js';
import { DriverAccountError, driverPasswordMatches, normalizeDriverLogin } from './driver-accounts.js';

const COOKIE = 'greentaxi_driver_session';
const COOKIE_PATH = '/api/driver';
const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000;
type DriverRequest = Request & { portalDriver?: DriverIdentity };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (row: Record<string, any>): DriverIdentity => ({ id: row.id, login: row.login, name: row.name, capacity: row.capacity });

export function mountDriverPortal(app: Express, dependencies: {
  database: Database; production: boolean; now: () => Date;
  reject: (status: number, message: string, code?: string) => never;
  rateLimit: (scope: string, max: number, interval: number) => RequestHandler;
  configuredTimes: (direction: typeof DRIVER_DIRECTION, date: string) => Promise<{ effective: string[] }>;
  protectWholeCars: (date: string) => Promise<void>;
  auditAttendance: (driverId: number, date: string, working: boolean) => Promise<void>;
}) {
  const { database, production, now } = dependencies;
  const reject: (status: number, message: string, code?: string) => never = dependencies.reject;
  const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' });
  function dateWindow() {
    const parts = calendar.formatToParts(now());
    const today = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
    const next = new Date(`${today}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    return { today, tomorrow: next.toISOString().slice(0, 10) };
  }
  function selectedDate(value: unknown, window: ReturnType<typeof dateWindow>) {
    if (typeof value !== 'string' || ![window.today, window.tomorrow].includes(value)) reject(400, 'აირჩიეთ დღეს ან ხვალ.', 'DATE_OUT_OF_RANGE');
    return value;
  }
  function onlyFields(value: Record<string, any>, allowed: string[]) {
    if (Object.keys(value).some(field => !allowed.includes(field))) reject(400, 'მოთხოვნის მონაცემები არასწორია.', 'VALIDATION');
  }
  function token(req: Request) {
    const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
    const value = cookie?.slice(COOKIE.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  }
  async function session(req: Request): Promise<DriverIdentity | null> {
    const value = token(req);
    if (!value) return null;
    const row = await database.prepare(`SELECT driver.id,driver.name,driver.capacity,account.login FROM driver_sessions session
      JOIN driver_accounts account ON account.driver_id=session.driver_id
      JOIN drivers driver ON driver.id=account.driver_id
      WHERE session.token_hash=? AND session.expires_at>? AND account.active=1`).get(digest(value), now().getTime());
    return row ? identity(row) : null;
  }
  async function days(driverId: number, window: ReturnType<typeof dateWindow>): Promise<DriverDayStatus[]> {
    const result: DriverDayStatus[] = [];
    for (const date of [window.today, window.tomorrow]) {
      const preference = await database.prepare('SELECT declined,assignment_mode,manual_time FROM driver_day_overrides WHERE driver_id=? AND date=?').get(driverId, date);
      const working = preference?.declined !== 1;
      const assignedTime: string | null = working && preference?.assignment_mode === 'manual' ? preference.manual_time : null;
      result.push({ date, working, assignedTime, assignmentActive: assignedTime !== null && (await dependencies.configuredTimes(DRIVER_DIRECTION, date)).effective.includes(assignedTime) });
    }
    return result;
  }
  const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: production, path: COOKIE_PATH };

  app.get('/api/driver/auth/session', async (req, res) => {
    const result: DriverSession = { driver: await session(req), ...dateWindow() };
    res.json(result);
  });
  app.post('/api/driver/auth/login', dependencies.rateLimit('driver-login', 10, 15 * 60 * 1000), async (req, res) => {
    onlyFields(req.body, ['login', 'password']);
    let login: string;
    try { login = normalizeDriverLogin(req.body.login); }
    catch (error) { if (error instanceof DriverAccountError) return reject(error.status, error.message, error.code); throw error; }
    if (typeof req.body.password !== 'string' || req.body.password.length < 1 || req.body.password.length > 512) reject(400, 'მიუთითეთ პაროლი.', 'VALIDATION');
    const row = await database.prepare('SELECT driver_id,password_hash,active FROM driver_accounts WHERE login=?').get(login);
    const valid = await driverPasswordMatches(req.body.password, row?.password_hash);
    if (!row || row.active !== 1 || !valid) reject(401, 'მომხმარებლის სახელი ან პაროლი არასწორია.', 'INVALID_LOGIN');
    const value = randomBytes(32).toString('hex');
    const driver = await database.transaction(async () => {
      const current = await database.prepare(`SELECT driver.id,driver.name,driver.capacity,account.login,account.password_hash FROM driver_accounts account
        JOIN drivers driver ON driver.id=account.driver_id WHERE account.driver_id=? AND account.active=1`).get(row.driver_id);
      if (!current || current.password_hash !== row.password_hash) reject(401, 'მომხმარებლის სახელი ან პაროლი არასწორია.', 'INVALID_LOGIN');
      await database.prepare('DELETE FROM driver_sessions WHERE expires_at<=?').run(now().getTime());
      await database.prepare('INSERT INTO driver_sessions(token_hash,driver_id,expires_at) VALUES (?,?,?)').run(digest(value), current.id, now().getTime() + SESSION_LIFETIME);
      return identity(current);
    });
    res.cookie(COOKIE, value, { ...cookieOptions, maxAge: SESSION_LIFETIME });
    const result: DriverSession = { driver, ...dateWindow() };
    res.json(result);
  });
  app.post('/api/driver/auth/logout', async (req, res) => {
    const value = token(req);
    if (value) await database.prepare('DELETE FROM driver_sessions WHERE token_hash=?').run(digest(value));
    res.clearCookie(COOKIE, cookieOptions);
    res.json({ ok: true });
  });
  app.use('/api/driver', async (req: DriverRequest, _res, next) => {
    const driver = await session(req);
    if (!driver) reject(401, 'შედით მძღოლის ანგარიშში.', 'UNAUTHORIZED');
    req.portalDriver = driver;
    next();
  });
  app.get('/api/driver/dashboard', async (req: DriverRequest, res) => {
    // Hosts may add rewrite parameters to the query. Only date is an input;
    // account identity always comes from the authenticated driver session.
    const driver = req.portalDriver!;
    const result = await database.transaction(async (): Promise<DriverDashboard> => {
      const window = dateWindow();
      const date = selectedDate(req.query.date ?? window.today, window);
      const status = await days(driver.id, window);
      const selected = status.find(day => day.date === date)!;
      const rows = await database.prepare(`SELECT id,name,phone,direction,seats,booking_type,luggage,dog,seat_preference,
        gori_address,pickup_stop_name,didube_name,didube_address,assigned_date,assigned_time FROM bookings
        WHERE direction=? AND assigned_date=? AND status='confirmed' AND deleted_at IS NULL
        AND booking_type='whole_car' AND assigned_vehicle_key=? ORDER BY assigned_time,id`).all(DRIVER_DIRECTION, date, `roster:${driver.id}`);
      const bookings: DriverBooking[] = rows.map(row => ({
        id: row.id, name: row.name, phone: normalizePhone(row.phone) ?? row.phone, direction: row.direction,
        seats: row.seats, bookingType: row.booking_type, luggage: row.luggage === 1, dog: row.dog === 1,
        seatPreference: row.seat_preference, goriAddress: row.gori_address, pickupStopName: row.pickup_stop_name,
        didubeName: row.didube_name, didubeAddress: row.didube_address, date: row.assigned_date, time: row.assigned_time,
      }));
      return { driver, ...window, days: status, date, bookings, bookingScope: 'assigned', trip: selected.assignedTime ? { direction: DRIVER_DIRECTION, time: selected.assignedTime, active: selected.assignmentActive } : null };
    });
    res.json(result);
  });
  app.patch('/api/driver/attendance', async (req: DriverRequest, res: Response) => {
    onlyFields(req.body, ['date', 'working']);
    if (typeof req.body.working !== 'boolean') reject(400, 'აირჩიეთ მუშაობთ თუ არა.', 'VALIDATION');
    const driver = req.portalDriver!;
    const result = await database.transaction(async () => {
      const window = dateWindow();
      const date = selectedDate(req.body.date, window);
      if (!req.body.working && await database.prepare(`SELECT id FROM bookings WHERE direction=? AND assigned_date=? AND assigned_vehicle_key=?
        AND booking_type='whole_car' AND status='confirmed' AND deleted_at IS NULL`).get(DRIVER_DIRECTION, date, `roster:${driver.id}`)) {
        reject(409, 'ამ დღეს მანქანა დაჯავშნილია. მუშაობის გასაუქმებლად დაუკავშირდით ადმინისტრატორს.', 'VEHICLE_RESERVED');
      }
      await database.prepare(`INSERT INTO driver_day_overrides(driver_id,date,declined,assignment_mode,manual_time,updated_at) VALUES (?,?,?,'manual',NULL,?)
        ON CONFLICT(driver_id,date) DO UPDATE SET declined=excluded.declined,updated_at=excluded.updated_at`)
        .run(driver.id, date, Number(!req.body.working), now().toISOString());
      await dependencies.protectWholeCars(date);
      await dependencies.auditAttendance(driver.id, date, req.body.working);
      return { ...window, days: await days(driver.id, window) };
    });
    res.json(result);
  });
}
