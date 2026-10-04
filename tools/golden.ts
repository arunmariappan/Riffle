/**
 * Golden shots (plan 10, 11): loads the valley once, then visits each viewpoint at each time of day and saves a
 * screenshot. Usage: tsx tools/golden.ts <outDir> [spots=all] [hours=6.2,12,17.9,23] [day=95] [width] [height]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [
  ,
  ,
  outDir = 'golden',
  spotsArg = 'all',
  hoursArg = '6.2,12,17.9,23',
  dayArg = '95',
  w = '1280',
  h = '720',
  extra = '',
] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const start = Date.now();
await page.goto(`http://localhost:5173/?autostart&freeze&day=${dayArg}&hour=12${extra}`);
await page.waitForFunction(() => (window as any).__riffle?.ready || (window as any).__riffle?.error, null, {
  timeout: 180_000,
});
console.log(`ready in ${((Date.now() - start) / 1000).toFixed(1)} s`);
const spots: string[] =
  spotsArg === 'all'
    ? await page.evaluate(() => (window as any).__riffle.world.valley.spots.map((s: { name: string }) => s.name))
    : spotsArg.split(',');
const hours = hoursArg.split(',').map(Number);
for (const spot of spots) {
  for (const hour of hours) {
    await page.evaluate(
      ([s, hr]) => {
        const world = (window as any).__riffle.world;
        world.goToSpot(s);
        world.clock.setHour(hr);
      },
      [spot, hour] as const,
    );
    await page.waitForTimeout(1800);
    const file = join(outDir, `${spot}-${String(hour).replace('.', 'h')}.png`);
    await page.screenshot({ path: file });
    const stats = await page.evaluate(() => (window as any).__riffle.engine.stats);
    console.log(
      `${file} fps ${stats.fps.toFixed(0)} gpu ${stats.gpuMs.toFixed(1)} ms cpu ${stats.cpuMs.toFixed(1)} ms`,
    );
  }
}
await browser.close();
