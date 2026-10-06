import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool, type PoolClient, type PoolConfig, type QueryResult } from 'pg';

export type DatabaseRow = Record<string, any>;
export type RunResult = { lastInsertRowid: number; changes: number };
export interface DatabaseStatement {
  get(...parameters: any[]): Promise<DatabaseRow | undefined>;
  all(...parameters: any[]): Promise<DatabaseRow[]>;
  run(...parameters: any[]): Promise<RunResult>;
}
export interface Database {
  prepare(sql: string): DatabaseStatement;
  exec(sql: string): Promise<void>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export type DatabaseOptions = { dbPath?: string; databaseUrl?: string; production?: boolean };

type SqlPart = { kind: 'code' | 'quoted' | 'comment'; text: string };
type Migration = { version: number; name: string; sql: string; checksum: string };
const ID_TABLES = new Set(['users', 'stops', 'bookings', 'audit_log', 'call_devices', 'call_inquiries']);
const MIGRATION_LOCK = [817305621, 1] as const;
const TRANSACTION_LOCK = [817305621, 2] as const;

// Keep placeholders and keywords inside quoted values, identifiers and comments untouched.
function sqlParts(sql: string): SqlPart[] {
  const parts: SqlPart[] = [];
  let codeStart = 0;
  let index = 0;
  while (index < sql.length) {
    const start = index;
    let kind: SqlPart['kind'] | undefined;
    const character = sql[index];
    if (sql.startsWith('--', index)) {
      kind = 'comment';
      index = sql.indexOf('\n', index + 2);
      if (index < 0) index = sql.length;
    } else if (sql.startsWith('/*', index)) {
      kind = 'comment';
      index += 2;
      let depth = 1;
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) { depth++; index += 2; }
        else if (sql.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
    } else if (character === "'" || character === '"' || character === '`' || character === '[') {
      kind = 'quoted';
      const delimiter = character === '[' ? ']' : character;
      const escapeString = character === "'" && /(?:^|[^\w])E$/i.test(sql.slice(0, index));
      index++;
      while (index < sql.length) {
        if (escapeString && sql[index] === '\\') { index += 2; continue; }
        if (sql[index] === delimiter) {
          index++;
          if (sql[index] === delimiter) { index++; continue; }
          break;
        }
        index++;
      }
    } else if (character === '$') {
      const delimiter = sql.slice(index).match(/^\$(?:[a-zA-Z_][\w]*)?\$/)?.[0];
      if (delimiter) {
        kind = 'quoted';
        const end = sql.indexOf(delimiter, index + delimiter.length);
        index = end < 0 ? sql.length : end + delimiter.length;
      }
    }
    if (kind) {
      if (codeStart < start) parts.push({ kind: 'code', text: sql.slice(codeStart, start) });
      parts.push({ kind, text: sql.slice(start, index) });
      codeStart = index;
    } else index++;
  }
  if (codeStart < sql.length) parts.push({ kind: 'code', text: sql.slice(codeStart) });
  return parts;
}
function codeMask(sql: string): string {
  return sqlParts(sql).map(part => part.kind === 'code' ? part.text : part.text.replace(/[^\s]/g, ' ')).join('');
}
function appendClause(sql: string, clause: string): string {
  const parts = sqlParts(sql);
  let offset = sql.length;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    offset -= part.text.length;
    if (part.kind === 'comment') continue;
    const trimmed = part.text.trimEnd();
    if (!trimmed) continue;
    const end = offset + trimmed.length;
    const insertion = part.kind === 'code' && trimmed.endsWith(';') ? end - 1 : end;
    return `${sql.slice(0, insertion)} ${clause}${sql.slice(insertion)}`;
  }
  throw new Error('Cannot prepare an empty SQL statement.');
}
export function postgresSql(sql: string, returnInsertedId = true): string {
  let parameter = 0;
  let ignoreConflict = false;
  let translated = sqlParts(sql).map(part => {
    if (part.kind !== 'code') return part.text;
    return part.text
      .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, () => { ignoreConflict = true; return 'INSERT INTO'; })
      .replace(/\bAS\s+([a-zA-Z_][\w$]*)\b/gi, (match, alias: string) => /[a-z]/.test(alias) && /[A-Z]/.test(alias) ? `AS "${alias}"` : match)
      .replace(/\?/g, () => `$${++parameter}`);
  }).join('');
  let mask = codeMask(translated);
  if (ignoreConflict && !/\bON\s+CONFLICT\b/i.test(mask)) {
    translated = appendClause(translated, 'ON CONFLICT DO NOTHING');
    mask = codeMask(translated);
  }
  const insertedTable = mask.match(/^\s*INSERT\s+INTO\s+(?:[a-z_][\w]*\.)?([a-z_][\w]*)\b/i)?.[1]?.toLowerCase();
  if (returnInsertedId && insertedTable && ID_TABLES.has(insertedTable) && !/\bRETURNING\b/i.test(mask)) {
    translated = appendClause(translated, 'RETURNING id');
  }
  return translated;
}

function migrations(dialect: 'sqlite' | 'postgres'): Migration[] {
  const candidates = [fileURLToPath(new URL('./migrations/', import.meta.url)), resolve('server/migrations'), resolve('dist-server/migrations')];
  let migrationDirectory: string | undefined;
  let files: string[] = [];
  for (const candidate of candidates) {
    try {
      files = readdirSync(candidate).filter(name => new RegExp(`^\\d+_.+\\.${dialect}\\.sql$`).test(name));
      if (files.length) { migrationDirectory = candidate; break; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!migrationDirectory) throw new Error(`Missing ${dialect} migrations. Include server/migrations in the deployment build.`);
  const result = files.map(name => {
    const sql = readFileSync(resolve(migrationDirectory!, name), 'utf8');
    return { version: Number(name.split('_')[0]), name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }).sort((first, second) => first.version - second.version);
  if (new Set(result.map(item => item.version)).size !== result.length) throw new Error('Duplicate database migration version.');
  return result;
}

class Mutex {
  private pending: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}
type SqliteTransaction = { active: boolean; savepoint: number };
async function sqliteDatabase(dbPath: string): Promise<Database> {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const connection = new DatabaseSync(dbPath);
  const context = new AsyncLocalStorage<SqliteTransaction>();
  const mutex = new Mutex();
  let closed = false;
  function checkOpen() { if (closed) throw new Error('Database is closed.'); }
  function locked<T>(operation: () => T): Promise<T> {
    const execute = async () => { checkOpen(); return operation(); };
    return context.getStore()?.active ? execute() : mutex.run(execute);
  }
  try {
    connection.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection.exec('CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const migration of migrations('sqlite')) {
        const existing = connection.prepare('SELECT checksum FROM schema_versions WHERE version=?').get(migration.version);
        if (existing) {
          if (existing.checksum !== migration.checksum) throw new Error(`Applied migration ${migration.version} has changed.`);
          continue;
        }
        connection.exec(migration.sql);
        connection.prepare('INSERT INTO schema_versions(version,name,checksum,applied_at) VALUES (?,?,?,?)').run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      }
      connection.exec('COMMIT');
    } catch (error) { connection.exec('ROLLBACK'); throw error; }
  } catch (error) { connection.close(); throw error; }
  return {
    prepare(sql) {
      return {
        get: (...parameters) => locked(() => connection.prepare(sql).get(...parameters) as DatabaseRow | undefined),
        all: (...parameters) => locked(() => connection.prepare(sql).all(...parameters) as DatabaseRow[]),
        run: (...parameters) => locked(() => {
          const result = connection.prepare(sql).run(...parameters);
          return { lastInsertRowid: Number(result.lastInsertRowid), changes: Number(result.changes) };
        }),
      };
    },
    exec: sql => locked(() => connection.exec(sql)),
    async transaction<T>(operation: () => Promise<T>): Promise<T> {
      const existing = context.getStore();
      if (existing?.active) {
        const savepoint = `greentaxi_${++existing.savepoint}`;
        connection.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = await operation();
          connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      }
      return mutex.run(async () => {
        checkOpen();
        const state: SqliteTransaction = { active: true, savepoint: 0 };
        connection.exec('BEGIN IMMEDIATE');
        try {
          const result = await context.run(state, operation);
          connection.exec('COMMIT');
          return result;
        } catch (error) { connection.exec('ROLLBACK'); throw error; }
        finally { state.active = false; }
      });
    },
    close: () => mutex.run(async () => {
      if (!closed) { connection.close(); closed = true; }
    }),
  };
}

export function postgresPoolOptions(databaseUrl: string): PoolConfig {
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must use postgres:// or postgresql://.');
  const hostname = parsed.hostname.toLowerCase();
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  const mode = parsed.searchParams.get('sslmode')?.toLowerCase();
  if (mode === 'no-verify' || (!local && mode === 'disable')) throw new Error('Remote PostgreSQL connections require verified TLS.');
  const rootCertificate = parsed.searchParams.get('sslrootcert') ?? process.env.PGSSLROOTCERT;
  const clientCertificate = parsed.searchParams.get('sslcert');
  const clientKey = parsed.searchParams.get('sslkey');
  for (const key of [...parsed.searchParams.keys()]) if (key.toLowerCase().startsWith('ssl')) parsed.searchParams.delete(key);
  const tls = !local || (mode !== undefined && mode !== 'disable');
  return {
    connectionString: parsed.toString(),
    max: 5,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    connectionTimeoutMillis: 15_000,
    ssl: tls ? {
      rejectUnauthorized: true,
      ...(rootCertificate ? { ca: readFileSync(rootCertificate, 'utf8') } : {}),
      ...(clientCertificate ? { cert: readFileSync(clientCertificate, 'utf8') } : {}),
      ...(clientKey ? { key: readFileSync(clientKey, 'utf8') } : {}),
    } : false,
  };
}
function normalizedRows(result: QueryResult): DatabaseRow[] {
  const numericFields = result.fields.filter(field => [20, 21, 23, 700, 701, 1700].includes(field.dataTypeID));
  return result.rows.map((row: DatabaseRow) => {
    for (const field of numericFields) {
      const value = row[field.name];
      if (typeof value !== 'string') continue;
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || ([20, 21, 23].includes(field.dataTypeID) && !Number.isSafeInteger(numeric))) throw new Error('Database number exceeds the supported JavaScript numeric range.');
      row[field.name] = numeric;
    }
    return row;
  });
}
type PostgresTransaction = { client: PoolClient; active: boolean; savepoint: number };
async function postgresDatabase(databaseUrl: string): Promise<Database> {
  const pool = new Pool(postgresPoolOptions(databaseUrl));
  const context = new AsyncLocalStorage<PostgresTransaction>();
  let closed = false;
  // A dropped idle connection should be replaced by the pool, without terminating the process.
  pool.on('error', () => {});
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1,$2)', [...MIGRATION_LOCK]);
        await client.query('CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
        for (const migration of migrations('postgres')) {
          const existing = await client.query('SELECT checksum FROM schema_versions WHERE version=$1', [migration.version]);
          if (existing.rows.length) {
            if (existing.rows[0].checksum !== migration.checksum) throw new Error(`Applied migration ${migration.version} has changed.`);
            continue;
          }
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_versions(version,name,checksum,applied_at) VALUES ($1,$2,$3,$4)', [migration.version, migration.name, migration.checksum, new Date().toISOString()]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    } finally { client.release(); }
  } catch (error) { await pool.end(); throw error; }
  function checkOpen() { if (closed) throw new Error('Database is closed.'); }
  async function query(sql: string, parameters: any[] = []): Promise<QueryResult> {
    checkOpen();
    const current = context.getStore();
    return current?.active ? current.client.query(sql, parameters) : pool.query(sql, parameters);
  }
  return {
    prepare(sql) {
      const translated = postgresSql(sql);
      return {
        async get(...parameters) { return normalizedRows(await query(translated, parameters))[0]; },
        async all(...parameters) { return normalizedRows(await query(translated, parameters)); },
        async run(...parameters) {
          const result = await query(translated, parameters);
          const row = normalizedRows(result)[0];
          return { lastInsertRowid: row?.id ?? 0, changes: result.rowCount ?? 0 };
        },
      };
    },
    async exec(sql) { await query(postgresSql(sql, false)); },
    async transaction<T>(operation: () => Promise<T>): Promise<T> {
      checkOpen();
      const existing = context.getStore();
      if (existing?.active) {
        const savepoint = `greentaxi_${++existing.savepoint}`;
        await existing.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await operation();
          await existing.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          await existing.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await existing.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      }
      const client = await pool.connect();
      const state: PostgresTransaction = { client, active: true, savepoint: 0 };
      try {
        await client.query('BEGIN');
        try {
          await client.query('SELECT pg_advisory_xact_lock($1,$2)', [...TRANSACTION_LOCK]);
          const result = await context.run(state, operation);
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      } finally { state.active = false; client.release(); }
    },
    async close() {
      if (!closed) { closed = true; await pool.end(); }
    },
  };
}

export async function createDatabase(options: DatabaseOptions = {}): Promise<Database> {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (production && !databaseUrl?.trim()) throw new Error('DATABASE_URL is required in production. SQLite is supported only for local development.');
  if (databaseUrl?.trim()) return postgresDatabase(databaseUrl.trim());
  return sqliteDatabase(options.dbPath ?? process.env.DB_PATH ?? resolve('.data/greentaxi.sqlite'));
}

// esbuild also inlines this module into index.js; only the dedicated migration entry runs the CLI.
if (process.argv[1] && /^database\.(?:ts|js)$/.test(basename(process.argv[1])) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createDatabase().then(async database => {
    await database.close();
    console.log('Database migrations completed.');
  }).catch(() => {
    console.error('Database migration failed. Check DATABASE_URL, database connectivity, TLS trust and migration files.');
    process.exitCode = 1;
  });
}
