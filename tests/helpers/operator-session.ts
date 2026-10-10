import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Session reuse is confined to one disposable Playwright run. Refuse any
// metadata that points at the development database or outside its temp folder.
export function operatorSessionPath(fixtureDatabasePath: unknown): string {
  if (typeof fixtureDatabasePath !== 'string') throw new Error('Missing isolated Playwright database path');
  const databasePath = resolve(fixtureDatabasePath);
  const directory = dirname(databasePath);
  if (basename(databasePath) !== 'greentaxi.sqlite' || dirname(directory) !== resolve(tmpdir()) || !/^greentaxi-e2e-[^/]+$/.test(basename(directory))) {
    throw new Error('Operator session state must stay inside the isolated Playwright temp directory');
  }
  return join(directory, 'operator-session.json');
}
