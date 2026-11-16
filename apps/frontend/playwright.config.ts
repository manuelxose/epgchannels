import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against a real production build served statically, so the tested
 * artifact is the same one that ships. The server also proxies `/api` to the real
 * backend, which is what makes `real-backend.spec.ts` meaningful: that suite
 * stubs nothing and talks to the database through the API.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:4400',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    /*
     * Full Chromium (not headless-shell) is required: the shell build lacks the
     * proprietary codecs the HLS test streams use (H.264/AAC).
     */
    channel: 'chromium',
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'node scripts/serve-dist.mjs',
    url: 'http://127.0.0.1:4400/television',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
