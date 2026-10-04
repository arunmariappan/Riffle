/** Dev helper: measures mean brightness of a region after toggling things (debugging). */
import { chromium } from '@playwright/test';
import sharp from 'sharp';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5173/?autostart&freeze&spot=pool&hour=11');
await page.waitForFunction(() => (window as any).__riffle?.ready, null, { timeout: 180000 });
const measure = async (label: string) => {
  await page.waitForTimeout(2500);
  const png = await page.screenshot();
  const s = await sharp(png).extract({ left: 0, top: 380, width: 400, height: 300 }).stats();
  console.log(
    label,
    s.channels
      .slice(0, 3)
      .map((c) => c.mean.toFixed(1))
      .join(','),
  );
};
await measure('as is');
await page.evaluate(() => {
  const w = (window as any).__riffle.world;
  w.terrain.material.emissiveNode = null;
  w.terrain.material.needsUpdate = true;
});
await measure('no terrain emissive');
await page.evaluate(() => {
  const w = (window as any).__riffle.world;
  w.flow.group.visible = false;
});
await measure('water hidden');
await browser.close();
