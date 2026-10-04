import { expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

/** Waits until the app reports ready (or an error) through window.__riffle. */
export async function waitForReady(page: Page, timeout = 90_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const r = (window as any).__riffle;
      return r?.ready === true || typeof r?.error === 'string';
    },
    null,
    { timeout },
  );
  const error = await page.evaluate(() => (window as any).__riffle?.error);
  expect(error, 'the app reported an error').toBeUndefined();
}

/** Sum of the RGB standard deviations of a PNG: a blank or single-color frame is close to 0. */
export function imageSpread(png: Buffer): number {
  const image = PNG.sync.read(png);
  const n = image.width * image.height;
  let total = 0;
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = image.data[i * 4 + c] as number;
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    total += Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  }
  return total;
}
