import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server/index.js';

type Application = Awaited<ReturnType<typeof createApp>>;
let applicationPromise: Promise<Application> | undefined;

function application(): Promise<Application> {
  if (!applicationPromise) {
    // Reuse one pool and application per warm instance. Initialization failures
    // clear the cache so a later request can retry a transient connection error.
    applicationPromise = Promise.resolve()
      .then(() => createApp({ production: true }))
      .catch(error => {
        applicationPromise = undefined;
        throw error;
      });
  }
  return applicationPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { app } = await application();
    if (res.destroyed || res.writableEnded) return;

    // Vercel's rewrite selects this function while preserving the original URL,
    // including /api and the query string expected by the Express routes.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        res.off('finish', complete);
        res.off('close', complete);
      };
      const complete = () => {
        cleanup();
        resolve();
      };
      res.once('finish', complete);
      res.once('close', complete);
      try {
        app(req, res);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  } catch {
    // Never expose database URLs, credentials, or initialization diagnostics.
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.end(); return; }
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '5');
    res.end(JSON.stringify({
      error: 'სერვისი დროებით მიუწვდომელია. სცადეთ ხელახლა.',
      code: 'SERVICE_UNAVAILABLE',
    }));
  }
}
