import { expect, test, type Page } from '@playwright/test';
import { waitForReady } from './helpers';

/** Changes a panel setting the way the panels do (undoable, applied to the world). */
async function setSetting(page: Page, path: string, value: unknown): Promise<void> {
  await page.evaluate(([p, v]) => (window as any).__riffle.builder.setSetting(p, v), [path, value] as const);
}

test.describe('the ecosystem (Phase 6)', () => {
  test.setTimeout(360_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/?autostart&spot=riffles&hour=10&day=120');
    await waitForReady(page, 300_000);
  });

  test('the Ecosystem panel shows the populations and graphs', async ({ page }) => {
    await page.getByTestId('mode-builder').click();
    await page.getByTestId('tab-ecosystem').click();
    await expect(page.getByTestId('eco-readout')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('graph-populations').locator('canvas')).toBeVisible();
    for (const name of ['Denison barb', 'Golden mahseer', 'Koi'])
      await expect(page.getByText(name).first()).toBeVisible();
  });

  test('a season time-lapse moves the valley on: days pass, graphs grow, populations change', async ({ page }) => {
    const before = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      return {
        seconds: w.ecology.report.seconds,
        populations: w.ecology.report.snapshot.populations,
        history: w.ecology.history.length,
      };
    });
    await setSetting(page, 'time.timeScale', 86400 * 3);
    await page.waitForTimeout(25_000);
    const after = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      return {
        seconds: w.ecology.report.seconds,
        populations: w.ecology.report.snapshot.populations,
        history: w.ecology.history.length,
      };
    });
    // About 75 days in 25 s.
    expect((after.seconds - before.seconds) / 86400).toBeGreaterThan(40);
    expect(after.history).toBeGreaterThan(before.history + 4);
    expect(after.populations.some((n: number, i: number) => Math.abs(n - before.populations[i]) > 1)).toBe(true);
    for (const n of after.populations) expect(n).toBeGreaterThan(0);
  });

  test('rain falls, rings the water and wets the ground, then raises and clouds the stream after a delay', async ({
    page,
  }) => {
    const before = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      return { discharge: w.flow.discharge, turbidity: w.flow.look.turbidity.value };
    });
    await setSetting(page, 'weather.mode', 'downpour');
    // 1 min = 1 day: an hour of rain every 2.5 s.
    await setSetting(page, 'time.timeScale', 1440);
    await page.waitForTimeout(6_000);
    const raining = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      return { drops: w.rain.mesh.count, wetness: w.wetness, rain: w.weather.rain };
    });
    expect(raining.rain).toBeGreaterThan(20);
    expect(raining.drops).toBeGreaterThan(5000);
    expect(raining.wetness).toBeGreaterThan(0.3);
    await page.waitForTimeout(30_000);
    const after = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      return { discharge: w.flow.discharge, turbidity: w.flow.look.turbidity.value };
    });
    expect(after.discharge).toBeGreaterThan(before.discharge * 1.3);
    expect(after.turbidity).toBeGreaterThan(before.turbidity + 0.1);
  });

  test('fish hand off to the cohorts and back without popping in view', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const path = w.flow.path;
      const zone = w.valley.profile.zones.find((q: any) => q.name === 'riffles');
      const seen = new Map<number, { x: number; z: number }>();
      let near = 0;
      let appeared = 0;
      let vanished = 0;
      let vanishedNear = 0;
      // Walk down the stream from the riffles through the pool, a few meters at a time.
      for (let i = zone.start; i < zone.start + 900; i += 12) {
        const x = path.points[i * 2];
        const z = path.points[i * 2 + 1];
        const tx = path.tangents[i * 2];
        const tz = path.tangents[i * 2 + 1];
        w.player.teleport(
          x + path.normals[i * 2] * 8,
          w.heightAt(x, z) + 1,
          z + path.normals[i * 2 + 1] * 8,
          Math.atan2(-tx, -tz),
        );
        await sleep(400);
        const cam = w.engine.camera.position;
        const now = new Map<number, { x: number; z: number }>();
        for (const f of w.fish.positions()) now.set(f.id, { x: f.x, z: f.z });
        for (const [id, f] of now)
          if (!seen.has(id)) {
            appeared++;
            const d = Math.hypot(f.x - cam.x, f.z - cam.z);
            const dir = { x: -Math.sin(w.player.yaw), z: -Math.cos(w.player.yaw) };
            const ahead = ((f.x - cam.x) * dir.x + (f.z - cam.z) * dir.z) / Math.max(d, 1e-6);
            if (d < 20 && ahead > 0.3) near++;
          }
        for (const [id, f] of seen)
          if (!now.has(id)) {
            vanished++;
            if (Math.hypot(f.x - cam.x, f.z - cam.z) < 50) vanishedNear++;
          }
        seen.clear();
        for (const [id, f] of now) seen.set(id, f);
      }
      return { appeared, vanished, near, vanishedNear, count: w.fish.count };
    });
    expect(result.appeared).toBeGreaterThan(50);
    expect(result.vanished).toBeGreaterThan(20);
    // New fish come in out of sight, and fish fold back far away.
    expect(result.near).toBeLessThanOrEqual(Math.ceil(result.appeared * 0.02));
    expect(result.vanishedNear).toBeLessThanOrEqual(Math.ceil(result.vanished * 0.02));
    expect(result.count).toBeLessThan(900);
  });

  test('the kingfisher comes by in the daytime', async ({ page }) => {
    await page.waitForFunction(() => (window as any).__riffle.world.kingfisher.brain.state !== 'away', null, {
      timeout: 60_000,
    });
    await setSetting(page, 'ecosystem.kingfisher', false);
    await page.waitForFunction(() => (window as any).__riffle.world.kingfisher.brain.state === 'away', null, {
      timeout: 60_000,
    });
  });

  test('saving keeps the ecosystem: it continues from the same day with the same fish', async ({ page }) => {
    await setSetting(page, 'time.timeScale', 86400);
    await page.waitForTimeout(5_000);
    await setSetting(page, 'time.paused', true);
    await page.waitForTimeout(1_500);
    const saved = await page.evaluate(async () => {
      const r = (window as any).__riffle;
      await r.autosaver.save();
      return { seconds: r.world.ecology.report.seconds, populations: r.world.ecology.report.snapshot.populations };
    });
    await page.goto('/?autostart&continue');
    await waitForReady(page, 300_000);
    await page.waitForTimeout(2_000);
    const restored = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      return { seconds: w.ecology.report.seconds, populations: w.ecology.report.snapshot.populations };
    });
    expect(Math.abs(restored.seconds - saved.seconds)).toBeLessThan(3600);
    restored.populations.forEach((n: number, i: number) => expect(n).toBeCloseTo(saved.populations[i], 0));
  });
});
