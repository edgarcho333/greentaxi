import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/html-preview-entry.tsx'],
  bundle: true,
  write: false,
  outdir: 'html-preview-build',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  charset: 'utf8',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.webp': 'dataurl', '.ttf': 'dataurl', '.otf': 'dataurl', '.woff2': 'dataurl' },
  legalComments: 'none',
});
const javascript = result.outputFiles.find(file => file.path.endsWith('.js'));
const stylesheet = result.outputFiles.find(file => file.path.endsWith('.css'));
if (!javascript || !stylesheet) throw new Error('Standalone preview assets were not generated.');
const html = `<!doctype html>
<html lang="ka"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#073f32"><title>GreenTaxi — დიზაინის ნახვა</title><style>${stylesheet.text.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${javascript.text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
const destination = resolve(root, 'GreenTaxi.html');
await writeFile(destination, html, 'utf8');
console.log(`Standalone HTML generated: GreenTaxi.html (${Math.round(Buffer.byteLength(html) / 1024)} KB).`);
