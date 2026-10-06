import express from 'express';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { createApp } from './index.js';

export async function startServer() {
  const service = await createApp();
  const server = createHttpServer(service.app);
  let closeVite: (() => Promise<void>) | undefined;
  if (process.env.NODE_ENV === 'production') {
    const dist = resolve('dist');
    service.app.use(express.static(dist));
    service.app.get('/{*path}', async (_req, res) => { res.sendFile(resolve(dist, 'index.html')); });
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
    service.app.use(vite.middlewares);
    closeVite = () => vite.close();
  }
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, '0.0.0.0', () => { console.log(`GreenTaxi is running on port ${port}`); });
  let stopping = false;
  const stopServer = async () => {
    if (stopping) return;
    stopping = true;
    await closeVite?.();
    server.close(() => { void service.close().then(() => process.exit(0)); });
  };
  process.once('SIGTERM', stopServer);
  process.once('SIGINT', stopServer);
  return { ...service, server };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().catch(error => { console.error('Startup failed:', error instanceof Error ? error.message : 'Unknown error'); process.exitCode = 1; });
}
