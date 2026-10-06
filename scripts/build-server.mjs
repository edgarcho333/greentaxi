import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist-server');
await rm(output, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: [
    { in: 'server/start.ts', out: 'index' },
    { in: 'server/database.ts', out: 'database' },
  ],
  bundle: true,
  platform: 'node',
  packages: 'external',
  format: 'esm',
  target: 'node24',
  outdir: output,
});
await cp(resolve(root, 'server/migrations'), resolve(output, 'migrations'), { recursive: true });
