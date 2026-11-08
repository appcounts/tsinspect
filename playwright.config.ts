import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'msedge',
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'cmd /c "corepack pnpm serve"',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
