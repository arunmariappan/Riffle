import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Benchmark flythroughs (plan 9): `pnpm bench`. Each writes bench-results/<date>-<name>-<quality>.json and checks the
 * budget. Short by default (20 s) until the GPU stability check passes (plan open item P2).
 */
async function fly(page: Page, name: string): Promise<any> {
  const quality = process.env.BENCH_QUALITY ?? 'high';
  const seconds = process.env.BENCH_SECONDS ?? '20';
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/?bench=${name}&quality=${quality}&benchSeconds=${seconds}&hour=10`);
  await page.waitForFunction(() => (window as any).__riffle?.bench || (window as any).__riffle?.error, null, {
    timeout: 220_000,
  });
  const error = await page.evaluate(() => (window as any).__riffle.error);
  expect(error).toBeUndefined();
  const result = await page.evaluate(() => (window as any).__riffle.bench);
  mkdirSync('bench-results', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`bench-results/${stamp}-${name}-${quality}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  return result;
}

test('valley flythrough stays within the frame budget', async ({ page }) => {
  test.setTimeout(240_000);
  const result = await fly(page, 'valley');
  // Budget (plan 9): 45 fps floor at 1080p, GPU ≤ 22 ms, ≤ 1,500 draw calls including shadows.
  expect(result.fpsAvg).toBeGreaterThan(45);
  expect(result.gpuMsAvg).toBeLessThan(22);
  expect(result.drawCallsMax).toBeLessThanOrEqual(1500);
});

test('storm-wind flythrough stays within the budget (Phase 3)', async ({ page }) => {
  test.setTimeout(240_000);
  const result = await fly(page, 'storm');
  expect(result.windSpeed).toBeGreaterThan(12);
  expect(result.fpsAvg).toBeGreaterThan(45);
  expect(result.gpuMsAvg).toBeLessThan(22);
  expect(result.drawCallsMax).toBeLessThanOrEqual(1500);
  expect(result.hitches).toBeLessThanOrEqual(2);
});

test('500 fish stay within the budget (Phase 5)', async ({ page }) => {
  test.setTimeout(240_000);
  const result = await fly(page, 'fish');
  expect(result.fish).toBeGreaterThanOrEqual(480);
  expect(result.fpsAvg).toBeGreaterThan(45);
  expect(result.gpuMsAvg).toBeLessThan(22);
  expect(result.drawCallsMax).toBeLessThanOrEqual(1500);
});
