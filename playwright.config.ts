import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every run gets its own database; browser tests never use the development DB.
const testDirectory = mkdtempSync(join(tmpdir(), 'greentaxi-e2e-'));
const baseURL = 'http://127.0.0.1:3100';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: 'list',
  outputDir: join(testDirectory, 'artifacts'),
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    // A stable process avoids watch restarts while other development files change.
    command: 'npm exec -- tsx server/start.ts',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: '3100',
      DB_PATH: join(testDirectory, 'greentaxi.sqlite'),
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? '',
      NODE_ENV: 'development',
      ADMIN_SETUP_TOKEN: '',
      NPM_CONFIG_CACHE: '/workspace/.cache/npm',
    },
  },
});
