import { expect, test } from '@playwright/test';
import { waitForReady } from './helpers';

test.describe('living water (Phase 2)', () => {
  test.setTimeout(300_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/?autostart&freeze&spot=riffles&hour=11');
    await waitForReady(page, 240_000);
  });

  test('a dropped stone brings foam and a calm wake within half a second', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const f = w.flow;
      // A point in the middle of the riffle zone, on the stream's center line.
      const zone = w.valley.profile.zones.find((z: any) => z.name === 'riffles');
      const i = Math.round((zone.start + zone.end) / 2);
      const x = f.path.points[i * 2];
      const z = f.path.points[i * 2 + 1];
      const tx = f.path.tangents[i * 2];
      const tz = f.path.tangents[i * 2 + 1];
      const before = f.sample(x + tx * 2.2, z + tz * 2.2);
      const t0 = performance.now();
      await w.placeStone('boulder-medium', x, z, 0.9, 0.9);
      const ms = performance.now() - t0;
      const after = f.sample(x + tx * 2.2, z + tz * 2.2);
      return { ms, before, after };
    });
    expect(result.ms).toBeLessThan(500);
    expect(result.after.shelter).toBeGreaterThan(0.2);
    expect(Math.hypot(result.after.velocityX, result.after.velocityZ)).toBeLessThan(
      Math.hypot(result.before.velocityX, result.before.velocityZ),
    );
    expect(result.after.foam).toBeGreaterThan(result.before.foam);
  });

  test('raising the discharge raises and speeds up the water', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const f = w.flow;
      const zone = w.valley.profile.zones.find((z: any) => z.name === 'pool');
      const i = Math.round((zone.start + zone.end) / 2);
      const x = f.path.points[i * 2];
      const z = f.path.points[i * 2 + 1];
      const before = f.sample(x, z);
      await f.setDischarge(f.discharge * 2.5);
      const after = f.sample(x, z);
      return { before, after };
    });
    expect(result.after.surface).toBeGreaterThan(result.before.surface + 0.1);
    expect(Math.hypot(result.after.velocityX, result.after.velocityZ)).toBeGreaterThan(
      Math.hypot(result.before.velocityX, result.before.velocityZ),
    );
  });

  test('you can wade, swim and dive', async ({ page }) => {
    const state = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const f = w.flow;
      const zone = w.valley.profile.zones.find((z: any) => z.name === 'pool');
      const i = Math.round((zone.start + zone.end) / 2);
      const x = f.path.points[i * 2];
      const z = f.path.points[i * 2 + 1];
      const s = f.sample(x, z);
      w.player.teleport(x, s.surface - 0.2, z);
      await new Promise((r) => setTimeout(r, 1200));
      return { swimming: w.player.swimming, depth: w.player.waterDepth, surface: s.surface, y: w.player.position.y };
    });
    expect(state.depth).toBeGreaterThan(1.2);
    expect(state.swimming).toBe(true);
    // Dive: hold C (sink) and check the camera goes under the surface.
    await page.keyboard.down('KeyC');
    await page.waitForTimeout(1800);
    await page.keyboard.up('KeyC');
    const under = await page.evaluate(() => (window as any).__riffle.world.player.underwater);
    expect(under).toBe(true);
  });
});

test.describe('the first fish (Phase 2)', () => {
  test.setTimeout(300_000);

  test('a school of barbs lives in the riffles, stays in the water and faces upstream', async ({ page }) => {
    await page.goto('/?autostart&freeze&spot=riffles&hour=11');
    await waitForReady(page, 240_000);
    await page.waitForTimeout(6000); // let the school settle into the current
    const stats = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      const fish = w.fish.positions();
      let inWater = 0;
      let upstream = 0;
      let moving = 0;
      for (const f of fish) {
        const s = w.flow.sample(f.x, f.z);
        if (s && s.depth > 0.05 && f.y >= s.bed - 0.01 && f.y <= s.surface + 0.01) inWater++;
        const speed = s ? Math.hypot(s.velocityX, s.velocityZ) : 0;
        if (s && speed > 0.3) {
          moving++;
          // Heading (yaw about +y from +z): facing upstream means heading · flow < 0.
          const hx = Math.sin(f.yaw);
          const hz = Math.cos(f.yaw);
          if ((hx * s.velocityX + hz * s.velocityZ) / speed < -0.3) upstream++;
        }
      }
      return { count: fish.length, inWater, upstream, moving };
    });
    expect(stats.count).toBeGreaterThanOrEqual(40);
    expect(stats.inWater).toBe(stats.count);
    if (stats.moving > 5) expect(stats.upstream / stats.moving).toBeGreaterThan(0.6);
  });
});
