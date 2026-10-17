import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DriverIdentity } from '../src/api.js';
import type { Database } from './database.js';

const scrypt = promisify(scryptCallback);
export class DriverAccountError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function normalizeDriverLogin(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9_.-]{3,64}$/i.test(value.trim())) throw new DriverAccountError(400, 'VALIDATION', 'მიუთითეთ სწორი მომხმარებლის სახელი.');
  return value.trim().toLowerCase();
}
export async function driverPasswordMatches(value: string, hash?: string): Promise<boolean> {
  // Missing accounts use the same expensive derivation as existing accounts.
  const validHash = typeof hash === 'string' && /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash);
  const [salt, expected] = (validHash ? hash! : `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const derived = await scrypt(value, salt, 64) as Buffer;
  return timingSafeEqual(derived, Buffer.from(expected, 'hex')) && validHash;
}
export async function hashDriverPassword(value: string): Promise<string> {
  if (typeof value !== 'string' || value.length < 4 || value.length > 512) throw new DriverAccountError(400, 'VALIDATION', 'პაროლი უნდა შეიცავდეს მინიმუმ 4 სიმბოლოს.');
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(value, salt, 64) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

/** Create one explicitly selected existing driver's account; never reset it. */
export async function createDriverAccount(database: Database, input: {
  driverId: number; login: string; password: string; expectedName?: string; now?: () => Date;
}): Promise<DriverIdentity> {
  if (!Number.isSafeInteger(input.driverId) || input.driverId < 1) throw new DriverAccountError(400, 'VALIDATION', 'აირჩიეთ მძღოლი.');
  const login = normalizeDriverLogin(input.login);
  const hash = await hashDriverPassword(input.password);
  return database.transaction(async () => {
    const driver = await database.prepare('SELECT id,name,capacity FROM drivers WHERE id=?').get(input.driverId);
    if (!driver) throw new DriverAccountError(404, 'NOT_FOUND', 'მძღოლი ვერ მოიძებნა.');
    if (input.expectedName !== undefined && driver.name !== input.expectedName) throw new DriverAccountError(409, 'DRIVER_CHANGED', 'მძღოლის მონაცემები შეიცვალა.');
    if (await database.prepare('SELECT driver_id FROM driver_accounts WHERE driver_id=?').get(driver.id)) throw new DriverAccountError(409, 'ACCOUNT_EXISTS', 'მძღოლის ანგარიში უკვე არსებობს.');
    if (await database.prepare('SELECT driver_id FROM driver_accounts WHERE login=?').get(login)) throw new DriverAccountError(409, 'LOGIN_TAKEN', 'მომხმარებლის სახელი უკვე გამოყენებულია.');
    const timestamp = (input.now?.() ?? new Date()).toISOString();
    await database.prepare('INSERT INTO driver_accounts(driver_id,login,password_hash,active,created_at,updated_at) VALUES (?,?,?,1,?,?)')
      .run(driver.id, login, hash, timestamp, timestamp);
    await database.prepare('INSERT INTO audit_log(user_id,booking_id,action,details,created_at) VALUES (NULL,NULL,?,?,?)')
      .run('driver.account.create', JSON.stringify({ driverId: driver.id, login }), timestamp);
    return { id: driver.id, name: driver.name, capacity: driver.capacity, login };
  });
}
