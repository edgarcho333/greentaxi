import express, { type NextFunction, type Request, type Response } from 'express';
import { createDatabase, type Database } from './database.js';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Analytics, Booking, CallDevice, CallInquiry, Direction, PassengerProfile, Schedule, Slot, User } from '../src/api.js';
import { normalizePhone, legacyPhoneKey } from '../shared/phone.js';
import { migratePhoneStorage, migratePickupMemory, readPassengerProfile, readPassengerProfiles, savePassengerProfile } from './passenger-profiles.js';
import { comparePassengerTrips, listPassengers, passengerBookings, passengerSummary } from './passengers.js';

const scrypt = promisify(scryptCallback);
const DIRECTIONS: Direction[] = ['gori-tbilisi', 'tbilisi-gori'];
const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'greentaxi_session';
type Row = Record<string, any>;
type ContextRequest = Request & { employee?: User };
type Options = { database?: Database; databaseUrl?: string; dbPath?: string; production?: boolean; setupToken?: string; now?: () => Date; deferPhoneMigration?: boolean };

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
function reject(status: number, message: string, code?: string): never { throw new HttpError(status, message, code); }
function text(value: unknown, field: string, min = 1, max = 200): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) reject(400, `${field}: შეავსეთ ველი სწორად.`, 'VALIDATION');
  return value.trim();
}
function direction(value: unknown): Direction {
  if (!DIRECTIONS.includes(value as Direction)) reject(400, 'აირჩიეთ მიმართულება.', 'VALIDATION');
  return value as Direction;
}
function date(value: unknown, code = 'VALIDATION'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) reject(400, 'მიუთითეთ სწორი თარიღი.', code);
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) reject(400, 'მიუთითეთ სწორი თარიღი.', code);
  return value;
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) reject(400, 'მიუთითეთ სწორი დრო.', 'VALIDATION');
  return value;
}
function times(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 96) reject(400, 'მიუთითეთ დროების სია.', 'VALIDATION');
  return [...new Set(value.map(time))].sort();
}
function numberId(value: unknown): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) reject(400, 'არასწორი იდენტიფიკატორი.', 'VALIDATION');
  return id;
}
function phone(value: unknown): string {
  const input = text(value, 'ტელეფონი', 9, 30);
  const normalized = normalizePhone(input);
  if (!normalized) reject(400, 'მიუთითეთ სწორი ტელეფონის ნომერი.', 'VALIDATION');
  return normalized;
}
// This parser is intentionally frozen to the original intake behavior, and is used only for old completed-call retries.
function originalPhoneForRetry(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const input = value.trim();
  if (input.length < 9 || input.length > 30 || !/^[+\d\s()-]+$/.test(input)) return undefined;
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('00') && digits.length >= 11) digits = digits.slice(2);
  if (digits.length < 9 || digits.length > 15) return undefined;
  return digits.length === 9 ? `+995${digits}` : `+${digits}`;
}
function seatCount(value: unknown, maximum = 4): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) reject(400, `ადგილების რაოდენობა უნდა იყოს 1-დან ${maximum}-მდე.`, 'VALIDATION');
  return value;
}
function login(value: unknown): string {
  const result = text(value, 'მომხმარებლის სახელი', 3, 64).toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(result)) reject(400, 'მომხმარებლის სახელში გამოიყენეთ ლათინური ასოები და ციფრები.', 'VALIDATION');
  return result;
}
function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 512) reject(400, 'პაროლი უნდა შეიცავდეს მინიმუმ 10 სიმბოლოს.', 'VALIDATION');
  return value;
}
async function passwordHash(value: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(value, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
async function passwordMatches(value: string, hash: string): Promise<boolean> {
  const [salt, keyHex] = hash.split(':');
  const key = await scrypt(value, salt, 64) as Buffer;
  const expected = Buffer.from(keyHex, 'hex');
  return expected.length === key.length && timingSafeEqual(expected, key);
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function sameSecret(a: string, b: string): boolean {
  const first = Buffer.from(digest(a), 'hex');
  const second = Buffer.from(digest(b), 'hex');
  return timingSafeEqual(first, second);
}
function user(row: Row): User { return { id: row.id, login: row.login, name: row.name }; }
function stop(row: Row) { return { id: row.id, name: row.name, address: row.address, active: Boolean(row.active) }; }
function callDevice(row: Row): CallDevice {
  return { id: row.id, name: row.name, active: Boolean(row.active), createdAt: row.created_at, lastSeenAt: row.last_seen_at };
}
function callInquiry(row: Row, passengerProfile: PassengerProfile | null = null): CallInquiry {
  return { id: row.id, phone: row.phone === null ? null : normalizePhone(row.phone) ?? row.phone, occurredAt: row.occurred_at, durationSeconds: row.duration_seconds, phase: row.phase ?? 'completed', passengerProfile, deviceName: row.device_name, createdAt: row.created_at, deletedAt: row.deleted_at, bookingId: row.booking_id };
}
function occurredAt(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) reject(400, 'მიუთითეთ ზარის სწორი დრო საათობრივი სარტყლით.', 'VALIDATION');
  date(value.slice(0, 10));
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) reject(400, 'მიუთითეთ ზარის სწორი დრო.', 'VALIDATION');
  return parsed.toISOString();
}
function booking(row: Row): Booking {
  return {
    id: row.id, name: row.name, phone: normalizePhone(row.phone) ?? row.phone, seats: row.seats, direction: row.direction,
    goriAddress: row.gori_address, pickupStopId: row.pickup_stop_id, pickupStopName: row.pickup_stop_name,
    didubeName: row.didube_name, didubeAddress: row.didube_address,
    requestedDate: row.requested_date, requestedTime: row.requested_time,
    assignedDate: row.assigned_date, assignedTime: row.assigned_time,
    status: row.status, deletedAt: row.deleted_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function createApp(options: Options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const db = options.database ?? await createDatabase({ dbPath: options.dbPath ?? process.env.DB_PATH, databaseUrl: options.databaseUrl ?? process.env.DATABASE_URL, production });
  const now = options.now ?? (() => new Date());
  const setupToken = options.setupToken ?? process.env.ADMIN_SETUP_TOKEN;
  const app = express();
  app.disable('x-powered-by');
  if (production) app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use('/api', async (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', async (req, _res, next) => {
    if (req.body === undefined) req.body = {};
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return next(new HttpError(400, 'მოთხოვნის მონაცემები არასწორია.', 'VALIDATION'));
    next();
  });
  app.use('/api', async (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.get('host') || origin.protocol !== `${req.protocol}:`) return next(new HttpError(403, 'მოთხოვნის წყარო დაუშვებელია.', 'ORIGIN'));
      } catch { return next(new HttpError(403, 'მოთხოვნის წყარო დაუშვებელია.', 'ORIGIN')); }
    }
    next();
  });
  let lastLimitCleanup = 0;
  function rateLimit(scope: string, max: number, interval: number) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const current = now().getTime();
      if (current - lastLimitCleanup >= 60_000) {
        lastLimitCleanup = current;
        await db.prepare('DELETE FROM rate_limits WHERE reset_at<=?').run(current);
      }
      const key = `${scope}:${req.ip}`;
      const entry = (await db.prepare(`INSERT INTO rate_limits(scope_key,count,reset_at) VALUES (?,1,?)
        ON CONFLICT(scope_key) DO UPDATE SET
          count=CASE WHEN rate_limits.reset_at<=? THEN 1 ELSE rate_limits.count+1 END,
          reset_at=CASE WHEN rate_limits.reset_at<=? THEN excluded.reset_at ELSE rate_limits.reset_at END
        RETURNING count,reset_at`).get(key, current + interval, current, current))!;
      if (entry.count > max) {
        res.setHeader('Retry-After', String(Math.ceil((entry.reset_at - current) / 1000)));
        return next(new HttpError(429, 'ძალიან ბევრი მოთხოვნაა. სცადეთ მოგვიანებით.', 'RATE_LIMIT'));
      }
      next();
    };
  }
  async function session(req: Request): Promise<User | null> {
    const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`));
    if (!cookie) return null;
    const token = cookie.slice(SESSION_COOKIE.length + 1);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const result = (await db.prepare('SELECT users.id, users.login, users.name FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?').get(digest(token), now().getTime())) as Row | undefined;
    return result ? user(result) : null;
  }
  async function setSession(res: Response, id: number) {
    const token = randomBytes(32).toString('hex');
    const current = now().getTime();
    (await db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(current));
    (await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(digest(token), id, current + SESSION_LIFETIME));
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: production, maxAge: SESSION_LIFETIME, path: '/' });
  }
  async function audit(action: string, employee?: User, bookingId?: number, details: unknown = {}) {
    (await db.prepare('INSERT INTO audit_log(user_id,booking_id,action,details,created_at) VALUES (?,?,?,?,?)').run(employee?.id ?? null, bookingId ?? null, action, JSON.stringify(details), now().toISOString()));
  }
  async function transaction<T>(operation: () => Promise<T>): Promise<T> { return db.transaction(operation); }
  async function settings() {
    const rows = (await db.prepare('SELECT key,value FROM settings').all()) as Row[];
    return { didubeName: rows.find(row => row.key === 'didubeName')!.value as string, didubeAddress: rows.find(row => row.key === 'didubeAddress')!.value as string };
  }
  async function configuredTimes(d: Direction, day: string) {
    const baseTimes = JSON.parse(((await db.prepare('SELECT times FROM base_schedule WHERE direction=?').get(d)) as Row).times) as string[];
    const override = (await db.prepare('SELECT times FROM date_schedule WHERE direction=? AND date=?').get(d, day)) as Row | undefined;
    const overrideTimes = override ? JSON.parse(override.times) as string[] : null;
    return { baseTimes, overrideTimes, effective: overrideTimes ?? baseTimes };
  }
  async function schedule(d: Direction, day: string): Promise<Schedule> {
    const { baseTimes, overrideTimes, effective } = (await configuredTimes(d, day));
    const counts = (await db.prepare("SELECT assigned_time AS time, COUNT(*) AS orders, SUM(seats) AS seats FROM bookings WHERE direction=? AND assigned_date=? AND status='confirmed' AND deleted_at IS NULL GROUP BY assigned_time").all(d, day)) as Row[];
    const allTimes = [...new Set([...effective, ...counts.map(row => row.time as string)])].sort();
    const slots: Slot[] = allTimes.map(slotTime => {
      const count = counts.find(row => row.time === slotTime);
      return { time: slotTime, active: effective.includes(slotTime), bookingCount: count?.orders ?? 0, seatCount: count?.seats ?? 0 };
    });
    return { direction: d, date: day, baseTimes, overrideTimes, slots };
  }
  function future(day: string, slotTime: string): boolean {
    return new Date(`${day}T${slotTime}:00+04:00`).getTime() > now().getTime();
  }
  const tbilisiCalendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' });
  function staffDateWindow(day: string, calendarException = false) {
    const parts = tbilisiCalendar.formatToParts(now());
    const today = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
    const lastDay = new Date(`${today}T12:00:00Z`);
    lastDay.setUTCDate(lastDay.getUTCDate() + 1);
    if (day < today || (!calendarException && day > lastDay.toISOString().slice(0, 10))) reject(400,
      calendarException ? 'აირჩიეთ დღევანდელი ან მომავალი თარიღი.' : 'აირჩიეთ დღეს ან ხვალ.', 'DATE_OUT_OF_RANGE');
  }
  async function activeSlot(d: Direction, day: string, slotTime: string, futureRequired = false) {
    if (!(await configuredTimes(d, day)).effective.includes(slotTime)) reject(409, 'არჩეული დრო გამორთულია. აირჩიეთ მოქმედი დრო.', 'SLOT_INACTIVE');
    if (futureRequired && !future(day, slotTime)) reject(400, 'აირჩიეთ მომავალი თარიღი და დრო.', 'SLOT_PAST');
  }
  async function getBooking(id: number) {
    const result = (await db.prepare('SELECT * FROM bookings WHERE id=?').get(id)) as Row | undefined;
    if (!result) reject(404, 'ჯავშანი ვერ მოიძებნა.', 'NOT_FOUND');
    return result;
  }
  async function activeBooking(id: number) {
    const result = (await getBooking(id));
    if (result.deleted_at) reject(409, 'ჯავშანი წაშლილია. ჯერ აღადგინეთ.', 'DELETED');
    return result;
  }
  async function inputBooking(body: Row, existing?: Row, employee = false) {
    const d = existing ? existing.direction as Direction : direction(body.direction);
    const name = text(body.name === undefined ? existing?.name ?? (employee ? '' : undefined) : body.name, 'სახელი', employee ? 0 : 2, 100);
    const number = phone(body.phone ?? existing?.phone);
    const seats = seatCount(body.seats ?? existing?.seats, employee ? 8 : 4);
    const address = text(body.goriAddress ?? existing?.gori_address, 'გორის მისამართი', 3, 500);
    let stopId: number | null = null;
    let stopName: string | null = null;
    if (d === 'tbilisi-gori') {
      stopId = numberId(body.pickupStopId ?? existing?.pickup_stop_id);
      const selected = (await db.prepare('SELECT * FROM stops WHERE id=?').get(stopId)) as Row | undefined;
      if (!selected || (!selected.active && stopId !== existing?.pickup_stop_id)) reject(400, 'აირჩიეთ მოქმედი გაჩერება თბილისში.', 'STOP_INACTIVE');
      stopName = existing && stopId === existing.pickup_stop_id ? existing.pickup_stop_name : selected.name;
    }
    return { direction: d, name, phone: number, seats, goriAddress: address, pickupStopId: stopId, pickupStopName: stopName };
  }
  async function saveProfile(row: Row) {
    await savePassengerProfile(db, row);
  }
  async function profile(number: string): Promise<PassengerProfile | null> {
    return readPassengerProfile(db, number);
  }
  async function createBooking(body: Row, employee?: User, source: 'public' | 'employee' | 'android' = employee ? 'employee' : 'public') {
    const input = (await inputBooking(body, undefined, Boolean(employee)));
    const day = date(body.requestedDate, employee ? 'DATE_INVALID' : 'VALIDATION');
    const slotTime = time(body.requestedTime);
    if (employee) staffDateWindow(day, source === 'android');
    (await activeSlot(input.direction, day, slotTime, true));
    const stamp = now().toISOString();
    const config = (await settings());
    const result = (await db.prepare(`INSERT INTO bookings(name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,didube_name,didube_address,requested_date,requested_time,assigned_date,assigned_time,status,source,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.name, input.phone, input.seats, input.direction, input.goriAddress, input.pickupStopId, input.pickupStopName, config.didubeName, config.didubeAddress, day, slotTime, employee ? day : null, employee ? slotTime : null, employee ? 'confirmed' : 'waiting', source, stamp, stamp));
    const id = Number(result.lastInsertRowid);
    (await audit('create', employee, id, { source }));
    const created = await getBooking(id);
    if (employee) await saveProfile(created);
    return booking(created);
  }
  async function idempotent(req: ContextRequest, res: Response, scope: string, operation: () => Promise<unknown>, status = 201) {
    const key = req.get('Idempotency-Key');
    if (!key) { const response = await transaction(operation); res.status(status).json(response); return; }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) reject(400, 'მოთხოვნის იდენტიფიკატორი არასწორია.', 'VALIDATION');
    const requestHash = digest(JSON.stringify(req.body));
    const output = await transaction(async () => {
      const existing = (await db.prepare('SELECT * FROM idempotency WHERE scope=? AND key=?').get(scope, key)) as Row | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) reject(409, 'ეს მოთხოვნის იდენტიფიკატორი უკვე გამოყენებულია.', 'IDEMPOTENCY_CONFLICT');
        return { status: existing.status as number, response: JSON.parse(existing.response) as unknown };
      }
      const response = await operation();
      (await db.prepare('INSERT INTO idempotency(scope,key,request_hash,status,response,created_at) VALUES (?,?,?,?,?,?)').run(scope, key, requestHash, status, JSON.stringify(response), now().getTime()));
      return { status, response };
    });
    const response = output.response;
    // Preserve the original raw-body idempotency hash while presenting legacy booking snapshots consistently.
    res.status(output.status).json(response && typeof response === 'object' && 'phone' in response && typeof response.phone === 'string'
      ? { ...response, phone: normalizePhone(response.phone) ?? response.phone } : response);
  }

  app.get('/api/auth/session', async (req, res) => {
    const count = ((await db.prepare('SELECT COUNT(*) AS count FROM users').get()) as Row).count;
    res.json({ user: (await session(req)), needsSetup: count === 0, requiresSetupToken: production });
  });
  app.post('/api/auth/setup', rateLimit('setup', 10, 15 * 60 * 1000), async (req, res, next) => {
    try {
      if (((await db.prepare('SELECT COUNT(*) AS count FROM users').get()) as Row).count) reject(409, 'საწყისი ანგარიში უკვე შექმნილია.', 'SETUP_COMPLETE');
      if (production && (!setupToken || typeof req.body.setupToken !== 'string' || !sameSecret(req.body.setupToken, setupToken))) reject(403, 'საწყისი ანგარიშის შექმნის კოდი არასწორია.', 'SETUP_TOKEN');
      const username = login(req.body.login);
      const name = text(req.body.name, 'სახელი', 2, 100);
      const hash = await passwordHash(password(req.body.password));
      const employee = await transaction(async () => {
        if (((await db.prepare('SELECT COUNT(*) AS count FROM users').get()) as Row).count) reject(409, 'საწყისი ანგარიში უკვე შექმნილია.', 'SETUP_COMPLETE');
        const created = (await db.prepare('INSERT INTO users(login,name,password_hash,created_at) VALUES (?,?,?,?)').run(username, name, hash, now().toISOString()));
        const result = user((await db.prepare('SELECT * FROM users WHERE id=?').get(Number(created.lastInsertRowid))) as Row);
        (await audit('staff.create', result, undefined, { userId: result.id }));
        return result;
      });
      (await setSession(res, employee.id));
      res.status(201).json({ user: employee });
    } catch (error) { next(error); }
  });
  app.post('/api/auth/login', rateLimit('login', 10, 15 * 60 * 1000), async (req, res, next) => {
    try {
      const username = login(req.body.login);
      if (typeof req.body.password !== 'string' || req.body.password.length < 1 || req.body.password.length > 512) reject(400, 'მიუთითეთ პაროლი.', 'VALIDATION');
      const pass = req.body.password;
      const row = (await db.prepare('SELECT * FROM users WHERE login=?').get(username)) as Row | undefined;
      // Perform the same password derivation for missing accounts to avoid a cheap account-enumeration timing signal.
      const valid = await passwordMatches(pass, row?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`);
      if (!row || !valid) reject(401, 'მომხმარებლის სახელი ან პაროლი არასწორია.', 'INVALID_LOGIN');
      (await setSession(res, row.id));
      res.json({ user: user(row) });
    } catch (error) { next(error); }
  });
  app.post('/api/auth/logout', async (req, res) => {
    const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`));
    if (cookie) (await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(cookie.slice(SESSION_COOKIE.length + 1))));
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: production, path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/public/config', async (_req, res) => {
    res.json({ stops: ((await db.prepare('SELECT * FROM stops WHERE active=1 ORDER BY id').all()) as Row[]).map(stop), ...(await settings()) });
  });
  app.get('/api/public/slots', async (req, res) => {
    const d = direction(req.query.direction);
    const day = date(req.query.date);
    res.json({ slots: (await schedule(d, day)).slots.filter(slot => slot.active && future(day, slot.time)) });
  });
  app.post('/api/bookings', rateLimit('public-booking', 40, 15 * 60 * 1000), async (req, res) => {
    (await idempotent(req, res, 'public-booking', async () => ({ id: (await createBooking(req.body)).id })));
  });

  async function authenticatedDevice(req: Request): Promise<Row> {
    const authorization = req.get('Authorization');
    if (!authorization || !/^Bearer gtdevice_[a-f0-9]{64}$/.test(authorization)) reject(401, 'მოწყობილობის ავტორიზაცია აუცილებელია.', 'DEVICE_UNAUTHORIZED');
    const token = authorization.slice('Bearer '.length);
    const device = (await db.prepare('SELECT * FROM call_devices WHERE token_hash=? AND active=1').get(digest(token))) as Row | undefined;
    if (!device) reject(401, 'მოწყობილობის წვდომა გაუქმებულია ან კოდი არასწორია.', 'DEVICE_UNAUTHORIZED');
    return device;
  }
  app.get('/api/integrations/android/connection', rateLimit('android-connection', 60, 60 * 1000), async (req, res) => {
    const device = await authenticatedDevice(req);
    res.json({ connected: true, device: { id: device.id, name: device.name } });
  });
  app.post('/api/integrations/android/calls', rateLimit('android-calls', 120, 60 * 1000), async (req, res) => {
    const device = await authenticatedDevice(req);
    const kind = req.body.kind;
    if (!['incoming', 'missed', 'rejected', 'outgoing'].includes(kind)) reject(400, 'ზარის ტიპი არასწორია.', 'VALIDATION');
    if (kind !== 'incoming') {
      (await db.prepare('UPDATE call_devices SET last_seen_at=? WHERE id=?').run(now().toISOString(), device.id));
      res.json({ ignored: true });
      return;
    }
    const eventId = text(req.body.eventId, 'ზარის იდენტიფიკატორი', 1, 128);
    const caller = req.body.phone === null ? null : phone(req.body.phone);
    const timestamp = occurredAt(req.body.occurredAt);
    const duration = req.body.durationSeconds;
    if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 0) reject(400, 'ზარის ხანგრძლივობა არასწორია.', 'VALIDATION');
    const explicitPhase = req.body.phase !== undefined;
    const phase = explicitPhase ? req.body.phase : 'completed';
    if (!['answered', 'completed'].includes(phase) || (phase === 'answered' && duration !== 0)) reject(400, 'ზარის ეტაპი არასწორია.', 'VALIDATION');
    // The legacy E164 identity keeps retries from existing Android installations valid after national-number migration.
    const hash = digest(JSON.stringify({ phone: caller === null ? null : legacyPhoneKey(caller), occurredAt: timestamp, durationSeconds: duration, kind }));
    const result = await transaction(async () => {
      (await db.prepare('UPDATE call_devices SET last_seen_at=? WHERE id=?').run(now().toISOString(), device.id));
      const existing = (await db.prepare('SELECT * FROM call_inquiries WHERE device_id=? AND event_id=?').get(device.id, eventId)) as Row | undefined;
      if (existing) {
        const conflict = () => reject(409, 'ზარის იდენტიფიკატორი უკვე გამოყენებულია სხვა მონაცემებით.', 'IDEMPOTENCY_CONFLICT');
        const previousPhone = existing.phone === null ? null : normalizePhone(existing.phone) ?? existing.phone;
        const sameIdentity = previousPhone === caller && existing.occurred_at === timestamp;
        if (!explicitPhase) {
          // Payloads from old applications retain strict idempotency, without permitting a phase transition.
          if (existing.request_hash !== hash) {
            const originalCaller = existing.phase === 'completed' && existing.legacy_hash === 1 ? originalPhoneForRetry(req.body.phone) : undefined;
            const originalHash = originalCaller === undefined ? undefined
              : digest(JSON.stringify({ phone: originalCaller, occurredAt: timestamp, durationSeconds: duration, kind }));
            if (existing.request_hash !== originalHash) conflict();
          }
        } else if (phase === 'answered') {
          if (existing.phase === 'answered') {
            if (existing.request_hash !== hash || !sameIdentity) conflict();
          } else if (existing.answered_hash ? existing.answered_hash !== hash : !sameIdentity) conflict();
          // A delayed answered event never downgrades a completed call or its duration/number.
        } else if (existing.phase === 'completed') {
          if (existing.request_hash !== hash) conflict();
        } else {
          if (existing.occurred_at !== timestamp || (previousPhone !== null && previousPhone !== caller)) conflict();
          await db.prepare("UPDATE call_inquiries SET phone=?,duration_seconds=?,phase='completed',request_hash=? WHERE id=?")
            .run(caller, duration, hash, existing.id);
          await audit('call.complete', undefined, undefined, { callId: existing.id, deviceId: device.id });
        }
        return { id: existing.id as number, duplicate: true };
      }
      const created = (await db.prepare('INSERT INTO call_inquiries(device_id,event_id,request_hash,phone,occurred_at,duration_seconds,created_at,phase,answered_hash,legacy_hash) VALUES (?,?,?,?,?,?,?,?,?,?)').run(device.id, eventId, hash, caller, timestamp, duration, now().toISOString(), phase, phase === 'answered' ? hash : null, 0));
      const id = Number(created.lastInsertRowid);
      (await audit('call.receive', undefined, undefined, { callId: id, deviceId: device.id }));
      return { id, duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  app.use('/api/admin', async (req: ContextRequest, _res, next) => {
    const employee = (await session(req));
    if (!employee) return next(new HttpError(401, 'პანელში შესასვლელად გაიარეთ ავტორიზაცია.', 'UNAUTHORIZED'));
    req.employee = employee;
    next();
  });
  async function getCall(id: number) {
    const row = (await db.prepare('SELECT call_inquiries.*,call_devices.name AS device_name FROM call_inquiries JOIN call_devices ON call_devices.id=call_inquiries.device_id WHERE call_inquiries.id=?').get(id)) as Row | undefined;
    if (!row) reject(404, 'ზარი ვერ მოიძებნა.', 'NOT_FOUND');
    return row;
  }
  async function enrichedCalls(rows: Row[]): Promise<CallInquiry[]> {
    const profiles = await readPassengerProfiles(db, rows.flatMap(row => row.phone === null ? [] : [row.phone]));
    return rows.map(row => callInquiry(row, row.phone === null ? null : profiles.get(normalizePhone(row.phone) ?? row.phone) ?? null));
  }
  app.get('/api/admin/devices', async (_req, res) => {
    res.json({ devices: ((await db.prepare('SELECT id,name,active,created_at,last_seen_at FROM call_devices ORDER BY id DESC').all()) as Row[]).map(callDevice) });
  });
  app.post('/api/admin/devices', async (req: ContextRequest, res) => {
    const name = text(req.body.name, 'მოწყობილობის სახელი', 2, 100);
    const token = `gtdevice_${randomBytes(32).toString('hex')}`;
    const device = await transaction(async () => {
      const created = (await db.prepare('INSERT INTO call_devices(name,token_hash,created_at) VALUES (?,?,?)').run(name, digest(token), now().toISOString()));
      const id = Number(created.lastInsertRowid);
      (await audit('device.create', req.employee, undefined, { deviceId: id }));
      return callDevice((await db.prepare('SELECT * FROM call_devices WHERE id=?').get(id)) as Row);
    });
    res.status(201).json({ device, token });
  });
  app.patch('/api/admin/devices/:id', async (req: ContextRequest, res) => {
    if (typeof req.body.active !== 'boolean') reject(400, 'მიუთითეთ მოწყობილობის აქტიურობა.', 'VALIDATION');
    const id = numberId(req.params.id);
    const device = await transaction(async () => {
      if (!(await db.prepare('SELECT id FROM call_devices WHERE id=?').get(id))) reject(404, 'მოწყობილობა ვერ მოიძებნა.', 'NOT_FOUND');
      (await db.prepare('UPDATE call_devices SET active=? WHERE id=?').run(Number(req.body.active), id));
      (await audit('device.edit', req.employee, undefined, { deviceId: id, active: req.body.active }));
      return callDevice((await db.prepare('SELECT * FROM call_devices WHERE id=?').get(id)) as Row);
    });
    res.json(device);
  });
  app.get('/api/admin/calls', async (req, res) => {
    const scope = req.query.scope ?? 'incoming';
    if (!['incoming', 'deleted', 'converted'].includes(String(scope))) reject(400, 'არასწორი ფილტრი.', 'VALIDATION');
    const conditions = [scope === 'deleted' ? 'call_inquiries.deleted_at IS NOT NULL' : 'call_inquiries.deleted_at IS NULL'];
    if (scope === 'incoming') conditions.push('booking_id IS NULL');
    if (scope === 'converted') conditions.push('booking_id IS NOT NULL');
    const rows = (await db.prepare(`SELECT call_inquiries.*,call_devices.name AS device_name FROM call_inquiries JOIN call_devices ON call_devices.id=call_inquiries.device_id WHERE ${conditions.join(' AND ')} ORDER BY occurred_at DESC,call_inquiries.id DESC`).all()) as Row[];
    let calls = await enrichedCalls(rows);
    if (req.query.search) {
      const search = text(req.query.search, 'ძიება', 1, 100).toLocaleLowerCase('ka-GE');
      const phoneSearch = normalizePhone(search) ?? search.replace(/\D/g, '');
      calls = calls.filter(call => Boolean(phoneSearch && call.phone?.includes(phoneSearch))
        || call.deviceName.toLocaleLowerCase('ka-GE').includes(search)
        || Boolean(call.passengerProfile?.name.toLocaleLowerCase('ka-GE').includes(search)));
    }
    res.json({ calls });
  });
  app.post('/api/admin/calls/:id/convert', async (req: ContextRequest, res) => {
    const result = await transaction(async () => {
      const inquiry = (await getCall(numberId(req.params.id)));
      if (inquiry.booking_id) return booking((await getBooking(inquiry.booking_id)));
      if (inquiry.deleted_at) reject(409, 'ზარი წაშლილია. ჯერ აღადგინეთ.', 'DELETED');
      const created = (await createBooking(req.body, req.employee, 'android'));
      (await db.prepare('UPDATE call_inquiries SET booking_id=? WHERE id=?').run(created.id, inquiry.id));
      (await audit('call.convert', req.employee, created.id, { callId: inquiry.id }));
      return created;
    });
    res.json(result);
  });
  app.post('/api/admin/calls/:id/delete', async (req: ContextRequest, res) => {
    const result = await transaction(async () => {
      const inquiry = (await getCall(numberId(req.params.id)));
      if (!inquiry.deleted_at) {
        (await db.prepare('UPDATE call_inquiries SET deleted_at=? WHERE id=?').run(now().toISOString(), inquiry.id));
        (await audit('call.delete', req.employee, inquiry.booking_id ?? undefined, { callId: inquiry.id }));
      }
      return (await enrichedCalls([await getCall(inquiry.id)]))[0];
    });
    res.json(result);
  });
  app.post('/api/admin/calls/:id/restore', async (req: ContextRequest, res) => {
    const result = await transaction(async () => {
      const inquiry = (await getCall(numberId(req.params.id)));
      if (inquiry.deleted_at) {
        (await db.prepare('UPDATE call_inquiries SET deleted_at=NULL WHERE id=?').run(inquiry.id));
        (await audit('call.restore', req.employee, inquiry.booking_id ?? undefined, { callId: inquiry.id }));
      }
      return (await enrichedCalls([await getCall(inquiry.id)]))[0];
    });
    res.json(result);
  });
  app.get('/api/admin/bookings', async (req, res) => {
    const scope = req.query.scope ?? 'all';
    if (!['all', 'incoming', 'scheduled', 'deleted'].includes(String(scope))) reject(400, 'არასწორი ფილტრი.', 'VALIDATION');
    const conditions: string[] = [scope === 'deleted' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
    const values: (string | number)[] = [];
    if (scope === 'incoming') conditions.push("status='waiting'");
    if (scope === 'scheduled') conditions.push("status='confirmed'");
    if (req.query.direction) { conditions.push('direction=?'); values.push(direction(req.query.direction)); }
    if (req.query.date) { conditions.push(`${scope === 'scheduled' ? 'assigned_date' : 'COALESCE(assigned_date,requested_date)'}=?`); values.push(date(req.query.date)); }
    if (req.query.time) { conditions.push(`${scope === 'scheduled' ? 'assigned_time' : 'COALESCE(assigned_time,requested_time)'}=?`); values.push(time(req.query.time)); }
    if (req.query.search) {
      const search = text(req.query.search, 'ძიება', 1, 100).replace(/[\\%_]/g, character => `\\${character}`);
      const digits = normalizePhone(search) ?? search.replace(/[^\d]/g, '');
      conditions.push("(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')"); values.push(`%${search}%`, `%${digits || search}%`);
    }
    const rows = (await db.prepare(`SELECT * FROM bookings WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(assigned_date,requested_date),COALESCE(assigned_time,requested_time),id DESC`).all(...values)) as Row[];
    res.json({ bookings: rows.map(booking) });
  });
  app.post('/api/admin/bookings', async (req: ContextRequest, res) => {
    (await idempotent(req, res, `employee-booking:${req.employee!.id}`, async () => (await createBooking(req.body, req.employee))));
  });
  app.patch('/api/admin/bookings/:id', async (req: ContextRequest, res) => {
    const result = await transaction(async () => {
      const row = (await activeBooking(numberId(req.params.id)));
      if (req.body.direction !== undefined && req.body.direction !== row.direction) reject(400, 'მიმართულების შეცვლა დაუშვებელია.', 'VALIDATION');
      const input = (await inputBooking(req.body, row, true));
      (await db.prepare('UPDATE bookings SET name=?,phone=?,seats=?,gori_address=?,pickup_stop_id=?,pickup_stop_name=?,updated_at=? WHERE id=?').run(input.name, input.phone, input.seats, input.goriAddress, input.pickupStopId, input.pickupStopName, now().toISOString(), row.id));
      (await audit('edit', req.employee, row.id, { fields: Object.keys(req.body) }));
      const edited = await getBooking(row.id);
      await saveProfile(edited);
      return booking(edited);
    });
    res.json(result);
  });
  app.post('/api/admin/bookings/:id/confirm', async (req: ContextRequest, res) => {
    (await idempotent(req, res, `confirm:${numberId(req.params.id)}`, async () => {
      const row = (await activeBooking(numberId(req.params.id)));
      const day = date(req.body.date, 'DATE_INVALID');
      const slotTime = time(req.body.time);
      if (row.status === 'confirmed') {
        if (row.assigned_date !== day || row.assigned_time !== slotTime) reject(409, 'ჯავშანი უკვე დადასტურებულია. გამოიყენეთ გადატანა.', 'ALREADY_CONFIRMED');
        return booking(row);
      }
      staffDateWindow(day);
      (await activeSlot(row.direction, day, slotTime, true));
      (await db.prepare("UPDATE bookings SET assigned_date=?,assigned_time=?,status='confirmed',updated_at=? WHERE id=?").run(day, slotTime, now().toISOString(), row.id));
      (await audit('confirm', req.employee, row.id, { date: day, time: slotTime }));
      const confirmed = await getBooking(row.id);
      await saveProfile(confirmed);
      return booking(confirmed);
    }, 200));
  });
  app.post('/api/admin/bookings/:id/move', async (req: ContextRequest, res) => {
    const result = await transaction(async () => {
      const row = (await activeBooking(numberId(req.params.id)));
      if (row.status !== 'confirmed') reject(409, 'ჯერ დაადასტურეთ ჯავშანი.', 'NOT_CONFIRMED');
      const day = date(req.body.date, 'DATE_INVALID');
      const slotTime = time(req.body.time);
      staffDateWindow(day);
      (await activeSlot(row.direction, day, slotTime, true));
      (await db.prepare('UPDATE bookings SET assigned_date=?,assigned_time=?,updated_at=? WHERE id=?').run(day, slotTime, now().toISOString(), row.id));
      (await audit('move', req.employee, row.id, { fromDate: row.assigned_date, fromTime: row.assigned_time, date: day, time: slotTime }));
      return booking((await getBooking(row.id)));
    });
    res.json(result);
  });
  app.post('/api/admin/bookings/:id/delete', async (req: ContextRequest, res) => {
    const result = await transaction(async () => {
      const row = (await getBooking(numberId(req.params.id)));
      if (!row.deleted_at) {
        const stamp = now().toISOString();
        (await db.prepare('UPDATE bookings SET deleted_at=?,updated_at=? WHERE id=?').run(stamp, stamp, row.id));
        (await audit('delete', req.employee, row.id));
      }
      return booking((await getBooking(row.id)));
    });
    res.json(result);
  });
  app.post('/api/admin/bookings/:id/restore', async (req: ContextRequest, res) => {
    const result = await transaction(async () => {
      const row = (await getBooking(numberId(req.params.id)));
      if (!row.deleted_at) return booking(row);
      let day: string | null = row.assigned_date;
      let slotTime: string | null = row.assigned_time;
      if (row.status === 'confirmed') {
        const rescheduling = req.body.date !== undefined || req.body.time !== undefined;
        day = date(req.body.date === undefined ? row.assigned_date : req.body.date, 'DATE_INVALID');
        slotTime = time(req.body.time === undefined ? row.assigned_time : req.body.time);
        if (rescheduling) staffDateWindow(day);
        (await activeSlot(row.direction, day, slotTime, rescheduling));
      }
      (await db.prepare('UPDATE bookings SET deleted_at=NULL,assigned_date=?,assigned_time=?,updated_at=? WHERE id=?').run(day, slotTime, now().toISOString(), row.id));
      (await audit('restore', req.employee, row.id, { date: day, time: slotTime }));
      return booking((await getBooking(row.id)));
    });
    res.json(result);
  });
  app.get('/api/admin/schedule', async (req, res) => {
    res.json((await schedule(direction(req.query.direction), date(req.query.date))));
  });
  app.put('/api/admin/schedule/base', async (req: ContextRequest, res) => {
    const d = direction(req.body.direction);
    const list = times(req.body.times);
    await transaction(async () => {
      (await db.prepare('UPDATE base_schedule SET times=? WHERE direction=?').run(JSON.stringify(list), d));
      (await audit('schedule.base', req.employee, undefined, { direction: d, times: list }));
    });
    res.json({ ok: true });
  });
  app.put('/api/admin/schedule/date', async (req: ContextRequest, res) => {
    const d = direction(req.body.direction);
    const day = date(req.body.date);
    const list = times(req.body.times);
    await transaction(async () => {
      (await db.prepare('INSERT INTO date_schedule(direction,date,times) VALUES (?,?,?) ON CONFLICT(direction,date) DO UPDATE SET times=excluded.times').run(d, day, JSON.stringify(list)));
      (await audit('schedule.date', req.employee, undefined, { direction: d, date: day, times: list }));
    });
    res.json({ ok: true });
  });
  app.delete('/api/admin/schedule/date', async (req: ContextRequest, res) => {
    const d = direction(req.query.direction);
    const day = date(req.query.date);
    await transaction(async () => {
      (await db.prepare('DELETE FROM date_schedule WHERE direction=? AND date=?').run(d, day));
      (await audit('schedule.reset', req.employee, undefined, { direction: d, date: day }));
    });
    res.json({ ok: true });
  });
  app.get('/api/admin/stops', async (_req, res) => { res.json({ stops: ((await db.prepare('SELECT * FROM stops ORDER BY id').all()) as Row[]).map(stop) }); });
  app.post('/api/admin/stops', async (req: ContextRequest, res) => {
    const name = text(req.body.name, 'გაჩერების სახელი', 2, 150);
    const address = text(req.body.address, 'მისამართი', 3, 500);
    const result = await transaction(async () => {
      const created = (await db.prepare('INSERT INTO stops(name,address) VALUES (?,?)').run(name, address));
      const id = Number(created.lastInsertRowid);
      (await audit('stop.create', req.employee, undefined, { stopId: id }));
      return stop((await db.prepare('SELECT * FROM stops WHERE id=?').get(id)) as Row);
    });
    res.status(201).json(result);
  });
  app.patch('/api/admin/stops/:id', async (req: ContextRequest, res) => {
    const id = numberId(req.params.id);
    const result = await transaction(async () => {
      const row = (await db.prepare('SELECT * FROM stops WHERE id=?').get(id)) as Row | undefined;
      if (!row) reject(404, 'გაჩერება ვერ მოიძებნა.', 'NOT_FOUND');
      const name = text(req.body.name ?? row.name, 'გაჩერების სახელი', 2, 150);
      const address = text(req.body.address ?? row.address, 'მისამართი', 3, 500);
      if (req.body.active !== undefined && typeof req.body.active !== 'boolean') reject(400, 'არასწორი აქტიურობის მნიშვნელობა.', 'VALIDATION');
      const active = req.body.active === undefined ? row.active : Number(req.body.active);
      (await db.prepare('UPDATE stops SET name=?,address=?,active=? WHERE id=?').run(name, address, active, id));
      (await audit('stop.edit', req.employee, undefined, { stopId: id, fields: Object.keys(req.body) }));
      return stop((await db.prepare('SELECT * FROM stops WHERE id=?').get(id)) as Row);
    });
    res.json(result);
  });
  app.get('/api/admin/settings', async (_req, res) => { res.json((await settings())); });
  app.put('/api/admin/settings', async (req: ContextRequest, res) => {
    const name = text(req.body.didubeName, 'დიდუბის ადგილის სახელი', 2, 150);
    const address = text(req.body.didubeAddress, 'დიდუბის მისამართი', 3, 500);
    await transaction(async () => {
      (await db.prepare('UPDATE settings SET value=? WHERE key=?').run(name, 'didubeName'));
      (await db.prepare('UPDATE settings SET value=? WHERE key=?').run(address, 'didubeAddress'));
      (await audit('settings.edit', req.employee));
    });
    res.json((await settings()));
  });
  app.get('/api/admin/passengers/profile', async (req, res) => {
    res.json({ profile: await profile(phone(req.query.phone)) });
  });
  app.get('/api/admin/passengers', async (req, res) => {
    let passengers = await listPassengers(db);
    if (req.query.search) {
      const search = text(req.query.search, 'ძიება', 1, 100).toLocaleLowerCase('ka-GE');
      const canonicalSearch = normalizePhone(search);
      const phoneSearch = canonicalSearch ?? search.replace(/\D/g, '');
      passengers = passengers.filter(passenger => passenger.name.toLocaleLowerCase('ka-GE').includes(search)
        || passenger.address.toLocaleLowerCase('ka-GE').includes(search)
        || Boolean(phoneSearch && (canonicalSearch ? passenger.phone === canonicalSearch : passenger.phone.includes(phoneSearch))));
    }
    res.json({ passengers });
  });
  app.get('/api/admin/passengers/:phone', async (req, res) => {
    const canonical = phone(req.params.phone);
    const rows = await passengerBookings(db, canonical);
    if (!rows.length) reject(404, 'მგზავრი ვერ მოიძებნა.', 'NOT_FOUND');
    const [passengerProfile, stops] = await Promise.all([profile(canonical), db.prepare('SELECT id,name,address,active FROM stops').all()]);
    res.json({ passenger: passengerSummary(rows, passengerProfile, stops), profile: passengerProfile, bookings: rows.sort(comparePassengerTrips).map(booking) });
  });
  app.get('/api/admin/analytics', async (req, res) => {
    const from = req.query.from ? date(req.query.from) : '0001-01-01';
    const to = req.query.to ? date(req.query.to) : '9999-12-31';
    if (from > to) reject(400, 'პერიოდის დასაწყისი უნდა იყოს დასასრულამდე.', 'VALIDATION');
    const rows = (await db.prepare('SELECT * FROM bookings WHERE COALESCE(assigned_date,requested_date) BETWEEN ? AND ?').all(from, to)) as Row[];
    const active = rows.filter(row => !row.deleted_at);
    const days = new Map<string, { date: string; orders: number; seats: number }>();
    for (const row of active) {
      const day = row.assigned_date ?? row.requested_date;
      const item = days.get(day) ?? { date: day, orders: 0, seats: 0 };
      item.orders++; item.seats += row.seats;
      days.set(day, item);
    }
    const output: Analytics = {
      totals: { incoming: active.filter(row => row.status === 'waiting').length, confirmed: active.filter(row => row.status === 'confirmed').length, deleted: rows.filter(row => row.deleted_at).length, seats: active.reduce((total, row) => total + row.seats, 0) },
      directions: DIRECTIONS.map(d => ({ direction: d, orders: active.filter(row => row.direction === d).length, seats: active.filter(row => row.direction === d).reduce((total, row) => total + row.seats, 0) })),
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
    res.json(output);
  });
  app.get('/api/admin/staff', async (_req, res) => { res.json({ users: ((await db.prepare('SELECT id,login,name FROM users ORDER BY id').all()) as Row[]).map(user) }); });
  app.post('/api/admin/staff', async (req: ContextRequest, res, next) => {
    try {
      const username = login(req.body.login);
      const name = text(req.body.name, 'სახელი', 2, 100);
      if ((await db.prepare('SELECT id FROM users WHERE login=?').get(username))) reject(409, 'მომხმარებლის სახელი უკვე გამოყენებულია.', 'LOGIN_TAKEN');
      const hash = await passwordHash(password(req.body.password));
      const result = await transaction(async () => {
        if ((await db.prepare('SELECT id FROM users WHERE login=?').get(username))) reject(409, 'მომხმარებლის სახელი უკვე გამოყენებულია.', 'LOGIN_TAKEN');
        const created = (await db.prepare('INSERT INTO users(login,name,password_hash,created_at) VALUES (?,?,?,?)').run(username, name, hash, now().toISOString()));
        (await audit('staff.create', req.employee, undefined, { userId: Number(created.lastInsertRowid) }));
        return user((await db.prepare('SELECT id,login,name FROM users WHERE id=?').get(Number(created.lastInsertRowid))) as Row);
      });
      res.status(201).json(result);
    } catch (error) { next(error); }
  });
  app.use('/api', async (_req, res) => { res.status(404).json({ error: 'მისამართი ვერ მოიძებნა.', code: 'NOT_FOUND' }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'მოთხოვნის მონაცემები არასწორია.', code: 'VALIDATION' }); return; }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') { res.status(413).json({ error: 'მოთხოვნა ზედმეტად დიდია.', code: 'VALIDATION' }); return; }
    console.error('API error:', error instanceof Error ? error.name : 'UnknownError');
    res.status(500).json({ error: 'სერვერის შეცდომა. სცადეთ ხელახლა.', code: 'INTERNAL' });
  });
  // Existing local installations receive one trusted-history backfill. Future writes update profiles
  // in the same transaction as the operator's confirmed booking; public waiting requests never do.
  try { await transaction(async () => {
    if (await db.prepare("SELECT value FROM settings WHERE key='passengerProfilesBackfilled'").get()) return;
    const existing = await db.prepare('SELECT * FROM bookings ORDER BY updated_at,id').all();
    for (const row of existing) {
      try {
        const canonical = phone(row.phone);
        await saveProfile({ ...row, phone: canonical });
      } catch (error) { if (!(error instanceof HttpError)) throw error; }
    }
    await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').run('passengerProfilesBackfilled', '1');
  });
    if (!(options.deferPhoneMigration ?? process.env.PHONE_MIGRATION_DEFERRED === '1')) await migratePhoneStorage(db);
    await migratePickupMemory(db);
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
  return { app, db, close: () => db.close() };
}
