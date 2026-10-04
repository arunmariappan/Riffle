import { expect, test, type Page } from '@playwright/test';
import { waitForReady } from './helpers';

/** Average loudness and brightness of the mix over a couple of seconds. */
async function listen(page: Page, ms = 2500): Promise<{ rms: number; centroid: number }> {
  return page.evaluate(async (duration) => {
    const engine = (window as any).__riffle.audio.engine;
    let rms = 0;
    let centroid = 0;
    let n = 0;
    const end = performance.now() + duration;
    while (performance.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      const m = engine.meter();
      rms += m.rms;
      centroid += m.centroid;
      n++;
    }
    return { rms: rms / n, centroid: centroid / n };
  }, ms);
}

/** Stands on the bank of a stream zone, looking at the water. */
async function standAt(page: Page, zone: string, offset = 1.2): Promise<void> {
  await page.evaluate(
    ([name, off]) => {
      const w = (window as any).__riffle.world;
      const z = w.valley.profile.zones.find((q: any) => q.name === name);
      const i = Math.round((z.start + z.end) / 2);
      const p = w.flow.path;
      const hw = w.valley.profile.halfWidth[i];
      const x = p.points[i * 2] + p.normals[i * 2] * hw * off;
      const zz = p.points[i * 2 + 1] + p.normals[i * 2 + 1] * hw * off;
      w.player.teleport(x, w.heightAt(x, zz) + 0.5, zz, Math.atan2(p.normals[i * 2], p.normals[i * 2 + 1]));
    },
    [zone, offset] as const,
  );
  await page.waitForTimeout(1500);
}

test.describe('nature audio (Phase 7)', () => {
  test.setTimeout(360_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/?autostart&spot=riffles&hour=11&day=290');
    await waitForReady(page, 300_000);
    // A click unlocks sound, as on the start screen.
    await page.getByTestId('viewport').click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as any).__riffle.audio?.engine?.ctx.state === 'running', null, {
      timeout: 20_000,
    });
    // Calm, dry weather so the stream is what we hear.
    await page.evaluate(async () => {
      const b = (window as any).__riffle.builder;
      await b.setSetting('weather.mode', 'clear');
      await b.setSetting('wind.speed', 1);
      await b.setSetting('time.paused', true);
    });
  });

  test('walking from the rapids to the pool changes the sound smoothly', async ({ page }) => {
    await standAt(page, 'rapids');
    const rapids = await listen(page);
    await standAt(page, 'pool');
    const pool = await listen(page);
    expect(rapids.rms).toBeGreaterThan(pool.rms * 1.5);
    // Walk back in small steps: the level never jumps.
    const steps: number[] = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const engine = (window as any).__riffle.audio.engine;
      const p = w.flow.path;
      const from = w.valley.profile.zones.find((q: any) => q.name === 'pool');
      const to = w.valley.profile.zones.find((q: any) => q.name === 'riffles');
      const out: number[] = [];
      for (let i = Math.round((from.start + from.end) / 2); i > (to.start + to.end) / 2; i -= 6) {
        const hw = w.valley.profile.halfWidth[i];
        const x = p.points[i * 2] + p.normals[i * 2] * hw * 1.2;
        const z = p.points[i * 2 + 1] + p.normals[i * 2 + 1] * hw * 1.2;
        w.player.teleport(x, w.heightAt(x, z) + 0.5, z);
        await new Promise((r) => setTimeout(r, 120));
        out.push(engine.meter().rms);
      }
      return out;
    });
    for (let k = 3; k < steps.length; k++) expect(steps[k]!, `step ${k}`).toBeLessThan(steps[k - 1]! * 2.5 + 0.01);
  });

  test('the water speed and wind sliders are audible', async ({ page }) => {
    await standAt(page, 'riffles');
    const before = await listen(page);
    await page.evaluate(() => (window as any).__riffle.builder.setSetting('water.speed', 2.5));
    await page.waitForTimeout(2000);
    const faster = await listen(page);
    expect(faster.rms).toBeGreaterThan(before.rms * 1.15);
    await page.evaluate(() => (window as any).__riffle.builder.setSetting('wind.speed', 20));
    await page.waitForTimeout(1500);
    const windy = await listen(page);
    expect(windy.rms).toBeGreaterThan(faster.rms * 1.15);
  });

  test('diving muffles the world', async ({ page }) => {
    await standAt(page, 'pool', 0);
    const above = await listen(page);
    await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      const p = w.player.position;
      const surface = w.flow.surfaceAt(p.x, p.z);
      w.player.teleport(p.x, surface - 1.6, p.z);
    });
    await page.waitForTimeout(800);
    const under = await listen(page);
    const cutoff = await page.evaluate(() => (window as any).__riffle.audio.debug.cutoff);
    expect(cutoff).toBeLessThan(1000);
    expect(under.centroid).toBeLessThan(above.centroid * 0.6);
  });

  test('the sound button mutes and the volume is remembered', async ({ page }) => {
    await page.getByTestId('sound-toggle').click();
    await page.waitForTimeout(500);
    const muted = await page.evaluate(() => (window as any).__riffle.audio.engine.audible);
    expect(muted).toBe(false);
    await page.reload();
    await waitForReady(page, 300_000);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('riffle:preferences') ?? '{}').muted)).toBe(true);
  });
});
