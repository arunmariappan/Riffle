import { defineConfig } from '@playwright/test';

// End-to-end tests drive the real Chrome and Edge on this PC's GPU (plan 11). Runs stay short (plan open item P2).
const gpuArgs = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 720 },
    headless: true,
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'chrome', use: { channel: 'chrome', launchOptions: { args: gpuArgs } }, testIgnore: /bench\.spec\.ts/ },
    { name: 'edge', use: { channel: 'msedge', launchOptions: { args: gpuArgs } }, testIgnore: /bench\.spec\.ts/ },
    { name: 'bench', use: { channel: 'chrome', launchOptions: { args: gpuArgs } }, testMatch: /bench\.spec\.ts/ },
  ],
});
