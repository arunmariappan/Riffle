import { expect, test } from '@playwright/test';
import { waitForReady } from './helpers';

/**
 * The hour-long session (Phase 9 done-when): a scripted tour through every mode while the valley runs, sampling memory
 * once a minute. A long GPU run: set SOAK_MINUTES (60 for the real check) only after the hardware check (P1).
 */
const minutes = Number(process.env.SOAK_MINUTES ?? 0);

test('a long session runs without crashes or memory growth', async ({ page }) => {
  test.skip(!(minutes > 0), 'Set SOAK_MINUTES to run (a long GPU run: after P1)');
  test.setTimeout((minutes + 10) * 60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?autostart&spot=riffles&hour=8');
  await waitForReady(page, 300_000);
  const samples: { heap: number; geometries: number; textures: number; fish: number }[] = [];
  for (let m = 0; m < minutes; m++) {
    // One minute of the tour: walk the stream, build, a season lapse, weather, photo mode.
    await page.evaluate(async (minute) => {
      const r = (window as any).__riffle;
      const w = r.world;
      const b = r.builder;
      const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
      const step = minute % 6;
      if (step === 0) {
        const p = w.flow.path;
        for (let k = 0; k < 10; k++) {
          const i = Math.floor(Math.random() * p.count);
          w.player.teleport(
            p.points[i * 2] + 8,
            w.heightAt(p.points[i * 2] + 8, p.points[i * 2 + 1]) + 1,
            p.points[i * 2 + 1],
          );
          await sleep(5000);
        }
      } else if (step === 1) {
        b.setMode('builder');
        await sleep(55_000);
        b.setMode('explore');
      } else if (step === 2) {
        await b.setSetting('time.timeScale', 86400 * 3);
        await sleep(55_000);
        await b.setSetting('time.timeScale', 60);
      } else if (step === 3) {
        for (const k of ['downpour', 'storm', 'mist', 'auto']) {
          await b.setSetting('weather.mode', k);
          await sleep(13_000);
        }
      } else if (step === 4) {
        b.setMode('photo');
        await sleep(55_000);
        b.setMode('explore');
      } else {
        await b.setOverlay('oxygen');
        await sleep(30_000);
        await b.setOverlay('none');
        await sleep(25_000);
      }
    }, m);
    const s = await page.evaluate(() => {
      const r = (window as any).__riffle;
      const mem = (performance as any).memory;
      const info = r.engine.renderer.info.memory;
      return {
        heap: mem ? mem.usedJSHeapSize / 1e6 : 0,
        geometries: info.geometries,
        textures: info.textures,
        fish: r.world.fish.count,
        error: r.error ?? null,
      };
    });
    expect(s.error).toBeNull();
    samples.push(s);
    console.log(
      `minute ${m + 1}: heap ${s.heap.toFixed(0)} MB, ${s.geometries} geometries, ${s.textures} textures, ${s.fish} fish`,
    );
  }
  expect(errors).toEqual([]);
  // After warming up (the first 10 minutes), memory may wobble but not grow.
  const warm = samples.slice(Math.min(10, Math.floor(samples.length / 3)));
  const first = warm[0]!;
  const last = warm[warm.length - 1]!;
  if (first.heap > 0) expect(last.heap).toBeLessThan(first.heap * 1.25 + 50);
  expect(last.textures).toBeLessThan(first.textures + 20);
  expect(last.geometries).toBeLessThan(first.geometries * 1.2 + 50);
});
