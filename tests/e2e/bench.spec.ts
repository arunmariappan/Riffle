import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * Benchmark flythrough (plan 9): `pnpm bench`. Writes bench-results/<date>-<quality>.json and checks the budget.
 * Short by default (20 s) until the GPU stability check passes (plan open item P2).
 */
test('valley flythrough stays within the frame budget', async ({ page }) => {
  test.setTimeout(240_000);
  const quality = process.env.BENCH_QUALITY ?? 'high';
  const seconds = process.env.BENCH_SECONDS ?? '20';
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/?bench=valley&quality=${quality}&benchSeconds=${seconds}&hour=10`);
  await page.waitForFunction(() => (window as any).__riffle?.bench || (window as any).__riffle?.error, null, {
    timeout: 220_000,
  });
  const result = await page.evaluate(() => (window as any).__riffle.bench);
  mkdirSync('bench-results', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`bench-results/${stamp}-${quality}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  // Budget (plan 9): 45 fps floor at 1080p, GPU ≤ 22 ms.
  expect(result.fpsAvg).toBeGreaterThan(45);
  expect(result.gpuMsAvg).toBeLessThan(22);
});
