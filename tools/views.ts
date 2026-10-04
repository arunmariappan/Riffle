/** Dev helper: scripted camera views (underwater, waterfall) for visual checks. Usage: tsx tools/views.ts <outDir> */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'views';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/?autostart&freeze&spot=riffles&hour=11');
await page.waitForFunction(() => (window as any).__riffle?.ready, null, { timeout: 240000 });
const view = async (name: string, fn: string) => {
  await page.evaluate(fn);
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name);
};
// Underwater in the pool, looking along the stream.
await view(
  'underwater',
  `(() => { const w = window.__riffle.world; const f = w.flow; const z = w.valley.profile.zones.find(z => z.name === 'pool'); const i = Math.round((z.start + z.end) / 2) - 20; const x = f.path.points[i*2], zz = f.path.points[i*2+1]; const s = f.sample(x, zz); w.mode = 'fixed'; const c = window.__riffle.engine.camera; c.position.set(x, s.surface - 0.9, zz); c.lookAt(x + f.path.tangents[i*2]*10, s.surface - 1.4, zz + f.path.tangents[i*2+1]*10); w.player.underwater = true; })()`,
);
// Waterfall from downstream, on the bank.
await view(
  'waterfall',
  `(() => { const w = window.__riffle.world; const f = w.flow; const i = w.valley.profile.waterfall.section + 50; const x = f.path.points[i*2], z = f.path.points[i*2+1]; const c = window.__riffle.engine.camera; w.mode = 'fixed'; w.player.underwater = false; c.position.set(x, f.levels[i] + 1.6, z); const j = i - 52; c.lookAt(f.path.points[j*2], f.levels[j] + 2, f.path.points[j*2+1]); })()`,
);
// Riffles close-up looking down at the water.
await view(
  'riffle-close',
  `(() => { const w = window.__riffle.world; const f = w.flow; const z = w.valley.profile.zones.find(z => z.name === 'riffles'); const i = Math.round((z.start + z.end) / 2); const x = f.path.points[i*2] + f.path.normals[i*2] * 6, zz = f.path.points[i*2+1] + f.path.normals[i*2+1] * 6; const c = window.__riffle.engine.camera; c.position.set(x, w.heightAt(x, zz) + 1.7, zz); c.lookAt(f.path.points[i*2] - f.path.tangents[i*2] * 6, f.levels[i], f.path.points[i*2+1] - f.path.tangents[i*2+1] * 6); })()`,
);
// Fish: underwater beside the school, and from the bank looking into the water.
await view(
  'fish-under',
  `(() => { const w = window.__riffle.world; const fish = w.fish.positions(); const a = fish[Math.floor(fish.length / 2)]; let cx = 0, cz = 0; fish.forEach(f => { cx += f.x; cz += f.z; }); cx /= fish.length; cz /= fish.length; const c = window.__riffle.engine.camera; w.mode = 'fixed'; const dx = a.x - cx, dz = a.z - cz; const s = w.flow.sample(a.x + 1.4, a.z + 0.6); c.position.set(a.x + 1.4, Math.min(a.y + 0.05, (s ? s.surface : a.y + 0.5) - 0.12), a.z + 0.6); c.lookAt(a.x, a.y, a.z); void dx; void dz; })()`,
);
await view(
  'fish-above',
  `(() => { const w = window.__riffle.world; const fish = w.fish.positions(); const a = fish[5]; const c = window.__riffle.engine.camera; w.mode = 'fixed'; c.position.set(a.x + 2.2, a.y + 1.6, a.z + 1.2); c.lookAt(a.x, a.y, a.z); })()`,
);
await view(
  'fish-close',
  `(() => { const w = window.__riffle.world; const fish = w.fish.positions(); const a = fish[7]; const c = window.__riffle.engine.camera; w.mode = 'fixed'; const px = Math.cos(a.yaw), pz = -Math.sin(a.yaw); c.position.set(a.x + px * 0.45, a.y + 0.03, a.z + pz * 0.45); c.lookAt(a.x, a.y, a.z); })()`,
);
await browser.close();
