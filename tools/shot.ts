/**
 * Dev helper: open a Riffle URL in Chrome (real GPU), wait until the scene is ready, save a screenshot and print
 * console errors. Usage: tsx tools/shot.ts "<path-and-query>" <out.png> [waitMs] [width] [height]
 * Kept short on purpose (plan open item P2: no long GPU runs until the stability check passes).
 */
import { chromium } from '@playwright/test';

const [
  ,
  ,
  route = '/?scene=test&autostart=1',
  out = 'shot.png',
  waitArg = '3000',
  widthArg = '1280',
  heightArg = '720',
] = process.argv;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(widthArg), height: Number(heightArg) } });
const logs: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const started = Date.now();
await page.goto(`http://localhost:5173${route}`);
try {
  await page.waitForFunction(
    () => {
      const r = (window as any).__riffle;
      return r?.ready === true || typeof r?.error === 'string';
    },
    null,
    { timeout: 120_000 },
  );
} catch {
  logs.push('[timeout] scene never became ready');
}
const ready = Date.now() - started;
await page.waitForTimeout(Number(waitArg));
const info = await page.evaluate(() => {
  const r = (window as any).__riffle;
  return { error: r?.error, stats: r?.engine?.stats, extra: r?.debug };
});
await page.screenshot({ path: out });
console.log(JSON.stringify({ readyMs: ready, ...info }, null, 0));
for (const line of logs.slice(0, 40)) console.log(line);
await browser.close();
