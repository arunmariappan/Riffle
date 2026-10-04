/** Dev helper: runs a JS expression in the running app and prints the JSON result. Usage: tsx tools/probe.ts "<route>" "<expr>" [waitMs] */
import { chromium } from '@playwright/test';
const [, , route = '/?autostart&freeze', expr = 'null', wait = '4000'] = process.argv;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:5173${route}`);
await page.waitForFunction(() => (window as any).__riffle?.ready || (window as any).__riffle?.error, null, {
  timeout: 120000,
});
await page.waitForTimeout(Number(wait));
console.log(JSON.stringify(await page.evaluate(expr), null, 1));
await browser.close();
