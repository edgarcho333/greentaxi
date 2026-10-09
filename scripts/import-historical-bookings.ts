import { readFile, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, basename, resolve, join } from 'node:path';
import { createDatabase } from '../server/database.js';
import { HistoricalImportError, importHistoricalBookings, type HistoricalImport, type HistoricalImportReport } from '../server/historical-import.js';

async function writeReport(path: string, value: HistoricalImportReport): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let inputPath: string | undefined;
  let inputEnv: string | undefined;
  let reportPath: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply' && !apply) apply = true;
    else if ((arg === '--input' || arg === '--input-env' || arg === '--report') && args[index + 1] && !args[index + 1].startsWith('--')) {
      if (arg === '--input' && !inputPath && !inputEnv) inputPath = resolve(args[++index]);
      else if (arg === '--input-env' && !inputEnv && !inputPath) {
        inputEnv = args[++index];
        if (!/^[A-Z][A-Z0-9_]*$/.test(inputEnv)) throw new HistoricalImportError('INVALID_INPUT_ENV_NAME');
      }
      else if (arg === '--report' && !reportPath) reportPath = resolve(args[++index]);
      else throw new HistoricalImportError('INVALID_ARGUMENTS');
    } else throw new HistoricalImportError('INVALID_ARGUMENTS');
  }
  if ((!inputPath && !inputEnv) || (reportPath && inputPath === reportPath)) throw new HistoricalImportError('INVALID_ARGUMENTS');
  if (!process.env.DATABASE_URL?.trim() && !process.env.DB_PATH?.trim()) throw new HistoricalImportError('DATABASE_CONFIGURATION_REQUIRED');
  let input: HistoricalImport;
  try {
    const payload = inputEnv ? process.env[inputEnv] : await readFile(inputPath!, 'utf8');
    if (!payload?.trim()) throw new Error('Missing input');
    input = JSON.parse(payload) as HistoricalImport;
  } catch { throw new HistoricalImportError(inputEnv ? 'INVALID_INPUT_ENV' : 'INVALID_INPUT_FILE'); }
  const db = await createDatabase();
  try {
    const result = await importHistoricalBookings(db, input, { apply });
    if (reportPath) await writeReport(reportPath, result);
    // Only aggregate counts are printed. The optional private report contains IDs, never customer data.
    console.log(JSON.stringify({ mode: result.mode, committed: result.committed, counts: result.counts }));
    if (result.mode === 'blocked') process.exitCode = 2;
  } finally { await db.close(); }
}

main().catch(error => {
  const code = error instanceof HistoricalImportError ? error.code : 'IMPORT_FAILED';
  const sourceLine = error instanceof HistoricalImportError ? error.sourceLine : undefined;
  console.error(JSON.stringify({ error: code, ...(sourceLine === undefined ? {} : { sourceLine }) }));
  process.exitCode = 1;
});
