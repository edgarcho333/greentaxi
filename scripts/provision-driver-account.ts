import { pathToFileURL } from 'node:url';
import { createDatabase } from '../server/database.js';
import { createDriverAccount, DriverAccountError, hashDriverPassword, normalizeDriverLogin } from '../server/driver-accounts.js';

const EXISTING_NEON = {
  project: 'still-thunder-13359416', branch: 'br-summer-silence-b224ymgm', database: 'neondb',
  host: 'ep-lingering-glade-b21ogckx.c-6.eu-central-1.aws.neon.tech',
};
class ProvisionError extends Error {}
type Input = { driverId: number; login: string; expectedName?: string; create: boolean; neon: boolean; local: boolean };

function argumentsFor(args: string[]): Input | null {
  if (args.includes('--help')) return null;
  const input: Input = { driverId: 0, login: '', create: false, neon: false, local: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--create') input.create = true;
    else if (arg === '--neon-existing') input.neon = true;
    else if (arg === '--local') input.local = true;
    else if (arg === '--driver-id') {
      const id = args[++index];
      if (!id || !/^[1-9]\d*$/.test(id)) throw new ProvisionError('Provide --driver-id for one existing driver.');
      input.driverId = Number(id);
    } else if (arg === '--login') input.login = args[++index] ?? '';
    else if (arg === '--expected-name') input.expectedName = args[++index];
    else throw new ProvisionError('Unsupported argument. Use --help; never pass passwords as arguments.');
  }
  if (!Number.isSafeInteger(input.driverId) || input.driverId < 1) throw new ProvisionError('Provide --driver-id for one existing driver.');
  input.login = normalizeDriverLogin(input.login);
  if (input.local && input.neon) throw new ProvisionError('Choose either --local or --neon-existing.');
  if (input.neon && !input.expectedName?.trim()) throw new ProvisionError('--neon-existing requires --expected-name to verify the selected driver.');
  return input;
}

async function inputPassword(): Promise<string> {
  if (process.env.DRIVER_ACCOUNT_PASSWORD !== undefined) {
    const value = process.env.DRIVER_ACCOUNT_PASSWORD;
    delete process.env.DRIVER_ACCOUNT_PASSWORD;
    return value;
  }
  if (process.stdin.isTTY) throw new ProvisionError('Pass the password through stdin or DRIVER_ACCOUNT_PASSWORD; it will not be echoed.');
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 514) throw new ProvisionError('Password input is too long.');
  }
  return value.replace(/\r?\n$/, '');
}

async function createOnExistingNeon(input: Input, password: string) {
  const key = process.env.NEON_API_KEY;
  if (!key?.trim()) throw new ProvisionError('NEON_API_KEY is unavailable in this environment.');
  const api = async (path: string) => {
    const response = await fetch(`https://console.neon.tech/api/v2/projects/${EXISTING_NEON.project}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new ProvisionError(`Existing Neon project request failed (HTTP ${response.status}).`);
    return response.json();
  };
  const databases = await api(`/branches/${EXISTING_NEON.branch}/databases`);
  const database = databases.databases?.find((entry: { name: string }) => entry.name === EXISTING_NEON.database);
  if (!database?.owner_name) throw new ProvisionError('Existing Neon database metadata is unavailable.');
  const parameters = new URLSearchParams({ branch_id: EXISTING_NEON.branch, database_name: EXISTING_NEON.database, role_name: database.owner_name, pooled: 'false' });
  const connection = await api(`/connection_uri?${parameters}`);
  if (typeof connection.uri !== 'string' || new URL(connection.uri).hostname !== EXISTING_NEON.host) throw new ProvisionError('Existing Neon endpoint does not match.');
  const hash = await hashDriverPassword(password);
  const timestamp = new Date().toISOString();
  // One statement atomically creates just this account and its audit entry.
  // Neither an existing driver account nor a taken login can be overwritten.
  const query = `WITH created AS (
    INSERT INTO driver_accounts(driver_id,login,password_hash,active,created_at,updated_at)
    SELECT id,$2,$3,1,$5,$5 FROM drivers WHERE id=$1 AND name=$4
    ON CONFLICT DO NOTHING RETURNING driver_id,login
  ), logged AS (
    INSERT INTO audit_log(user_id,booking_id,action,details,created_at)
    SELECT NULL,NULL,'driver.account.create',$6,$5 FROM created RETURNING id
  ) SELECT created.driver_id AS id,created.login,drivers.name,drivers.capacity,
    (SELECT COUNT(*) FROM logged) AS audit_entries
    FROM created JOIN drivers ON drivers.id=created.driver_id`;
  const response = await fetch(`https://${EXISTING_NEON.host}/sql`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connection.uri },
    body: JSON.stringify({ queries: [{ query, params: [input.driverId, input.login, hash, input.expectedName, timestamp, JSON.stringify({ driverId: input.driverId, login: input.login, source: 'manual-provisioning' })] }] }),
  });
  if (!response.ok) throw new ProvisionError(`Account creation could not be confirmed (SQL HTTP ${response.status}); check existing account metadata before retrying.`);
  const data = await response.json();
  const result = (Array.isArray(data) ? data : data.results)?.[0];
  const row = result?.rows?.[0];
  if (!row) throw new ProvisionError('No account created: driver identity did not match, or the driver account/login already exists. Existing accounts were not overwritten.');
  if (Number(row.id) !== input.driverId || row.login !== input.login || row.name !== input.expectedName || Number(row.audit_entries) !== 1) throw new ProvisionError('Account creation response is unexpected; inspect account metadata before retrying.');
  return { id: Number(row.id), login: row.login as string, name: row.name as string, capacity: Number(row.capacity) };
}

export async function provisionDriverAccount(args = process.argv.slice(2)) {
  const input = argumentsFor(args);
  if (!input) {
    console.log('Usage: node --use-env-proxy --import tsx scripts/provision-driver-account.ts --driver-id <id> --login <login> [--expected-name <name>] [--neon-existing | --local] [--create]');
    console.log('Default: offline plan. --create creates exactly one account, never resets one. Password: stdin or DRIVER_ACCOUNT_PASSWORD only. Default database: existing DATABASE_URL; --local requires DB_PATH.');
    return;
  }
  if (!input.create) {
    console.log(JSON.stringify({ mode: 'plan', operation: 'create-one-driver-account', target: input.neon ? EXISTING_NEON : input.local ? 'explicit DB_PATH' : 'existing DATABASE_URL', driverId: input.driverId, login: input.login, expectedName: input.expectedName ?? null, overwritesExisting: false, appliesMigrations: !input.neon }));
    return;
  }
  if (!input.neon && (input.local ? !process.env.DB_PATH : !process.env.DATABASE_URL)) throw new ProvisionError(input.local ? '--local requires an explicit DB_PATH.' : 'DATABASE_URL is unavailable; select an explicit target.');
  const password = await inputPassword();
  let driver;
  if (input.neon) driver = await createOnExistingNeon(input, password);
  else {
    const database = await createDatabase({ databaseUrl: input.local ? '' : process.env.DATABASE_URL, dbPath: process.env.DB_PATH, production: !input.local });
    try { driver = await createDriverAccount(database, { ...input, password }); }
    finally { await database.close(); }
  }
  console.log(JSON.stringify({ created: true, driver }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  provisionDriverAccount().catch(error => {
    // Provider errors may echo parameters. Never log raw SQL responses, DSNs,
    // password hashes, error causes or untrusted exception text.
    console.error(error instanceof ProvisionError || error instanceof DriverAccountError ? error.message : 'Driver account operation failed; credentials were not logged.');
    process.exitCode = 1;
  });
}
