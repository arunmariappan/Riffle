import { expect, test, type Page } from '@playwright/test';
import { frameMeadow, frameNearestTree, imageDiff, waitForReady } from './helpers';

/** Center of the frame, where the framed tree or meadow is. */
const CENTER = { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.8 };
const STORM = { dirX: -0.6, dirZ: 0.8, speed: 16, gustiness: 1.2, turbulence: 1 };

/** How much the picture changes in 150 ms (wind motion); TRAA settles between the two shots. */
async function motion(page: Page): Promise<number> {
  const a = await page.getByTestId('viewport').screenshot();
  await page.waitForTimeout(150);
  const b = await page.getByTestId('viewport').screenshot();
  return imageDiff(a, b, CENTER);
}

test.describe('wind and tree dynamics (Phase 3)', () => {
  test.setTimeout(300_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/?autostart&freeze&spot=riffles&hour=11');
    await waitForReady(page, 240_000);
    // No falling petals across the frame: they would count as motion.
    await page.evaluate(() => ((window as any).__riffle.world.air.amount = 0));
  });

  test('a wind change reaches every consumer within 1 s', async ({ page }) => {
    await page.evaluate(() =>
      (window as any).__riffle.world.setWind({ dirX: 0.8, dirZ: 0.6, speed: 2, gustiness: 0.3, turbulence: 0.2 }),
    );
    await frameNearestTree(page);
    await page.waitForTimeout(1500);
    const treesCalm = await motion(page);
    await frameMeadow(page);
    await page.waitForTimeout(1500);
    const grassCalm = await motion(page);
    const before = await page.evaluate(() => (window as any).__riffle.world.windReport());

    await page.evaluate((storm) => (window as any).__riffle.world.setWind(storm), STORM);
    await page.waitForTimeout(1000);
    const after = await page.evaluate(() => (window as any).__riffle.world.windReport());
    // Shaders (trees, bamboo, ground plants, grass share these uniforms) follow the CPU state.
    expect(after.shader.speed).toBeCloseTo(STORM.speed, 5);
    expect(after.shader.dirX).toBeCloseTo(STORM.dirX, 3);
    expect(after.shader.dirZ).toBeCloseTo(STORM.dirZ, 3);
    expect(after.shader.gustiness).toBeCloseTo(STORM.gustiness, 5);
    // Water roughens (most on the pond) and the clouds speed up.
    expect(after.waterChop).toBeGreaterThan(before.waterChop);
    expect(after.pondChop).toBeGreaterThan(before.pondChop);
    expect(after.cloudSpeed).toBeGreaterThan(before.cloudSpeed);

    // Falling particles already drift the new way within the second.
    await page.evaluate(() => ((window as any).__riffle.world.air.amount = 1));
    await page.waitForTimeout(1000);
    const drift = (await page.evaluate(() => (window as any).__riffle.world.windReport())).particleDrift;
    const along = drift[0] * STORM.dirX + drift[1] * STORM.dirZ;
    expect(along).toBeGreaterThan(Math.hypot(drift[0], drift[1]) * 0.7);
    await page.evaluate(() => ((window as any).__riffle.world.air.amount = 0));

    // And the trees and the grass visibly move more.
    await frameNearestTree(page);
    await page.waitForTimeout(1500);
    const treesStorm = await motion(page);
    await frameMeadow(page);
    await page.waitForTimeout(1500);
    const grassStorm = await motion(page);
    expect(treesStorm).toBeGreaterThan(treesCalm * 1.5);
    expect(grassStorm).toBeGreaterThan(grassCalm * 1.3);
  });

  test('each tree dynamics slider makes a visible difference', async ({ page }) => {
    await page.evaluate((storm) => {
      const w = (window as any).__riffle.world;
      w.setWind(storm);
      // Freeze wind time so the only change between shots is the slider.
      w.frozenTime = 37.3;
    }, STORM);
    await frameNearestTree(page);
    await page.waitForTimeout(2500);
    const shot = () => page.getByTestId('viewport').screenshot();
    const base = await shot();
    await page.waitForTimeout(800);
    const noise = imageDiff(base, await shot(), CENTER);
    const sliders: [string, number][] = [
      ['flexibility', 2.6],
      ['swayStrength', 2.6],
      ['leafFlutter', 3],
      ['responseDelay', 2.4],
    ];
    for (const [key, value] of sliders) {
      const old = await page.evaluate(
        ([k, v]) => {
          const wind = (window as any).__riffle.world.wind;
          const prev = wind[k].value;
          wind[k].value = v;
          return prev;
        },
        [key, value] as const,
      );
      await page.waitForTimeout(1500);
      const changed = imageDiff(base, await shot(), CENTER);
      expect(changed, `${key} changes the picture`).toBeGreaterThan(Math.max(noise * 3, 0.4));
      await page.evaluate(([k, v]) => ((window as any).__riffle.world.wind[k].value = v), [key, old] as const);
      await page.waitForTimeout(1200);
    }
  });
});
