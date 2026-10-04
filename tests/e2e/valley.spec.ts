import { expect, test } from '@playwright/test';
import { imageSpread, waitForReady } from './helpers';

test.describe('the valley (Phase 1)', () => {
  test.setTimeout(240_000);

  test('loads, renders and lets you walk', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/?autostart&freeze&spot=riffles&hour=10');
    await waitForReady(page, 200_000);
    const png = await page.getByTestId('viewport').screenshot();
    expect(imageSpread(png)).toBeGreaterThan(30);

    const before = await page.evaluate(() => (window as any).__riffle.world.player.position.toArray());
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);
    await page.keyboard.up('KeyW');
    const after = await page.evaluate(() => (window as any).__riffle.world.player.position.toArray());
    const moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
    expect(moved).toBeGreaterThan(2);
    // Feet stay on the ground (not falling through the terrain).
    const ground = await page.evaluate(([x, z]) => (window as any).__riffle.world.heightAt(x, z), [after[0], after[2]]);
    expect(Math.abs(after[1] - ground)).toBeLessThan(1.5);
    expect(errors).toEqual([]);
  });

  test('the same seed builds the same valley', async ({ page }) => {
    await page.goto('/?autostart&freeze&seed=reproducible');
    await waitForReady(page, 200_000);
    const a = await page.evaluate(() => {
      const h = (window as any).__riffle.world.valley.heightfield.heights as Float32Array;
      let sum = 0;
      for (let i = 0; i < h.length; i += 97) sum += h[i]!;
      return sum;
    });
    await page.reload();
    await waitForReady(page, 200_000);
    const b = await page.evaluate(() => {
      const h = (window as any).__riffle.world.valley.heightfield.heights as Float32Array;
      let sum = 0;
      for (let i = 0; i < h.length; i += 97) sum += h[i]!;
      return sum;
    });
    expect(b).toBe(a);
  });
});
