import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { imageSpread, waitForReady } from './helpers';

/** Sum of squared differences between neighboring pixels: jagged, noisy pictures score high. */
function roughness(png: Buffer): number {
  const img = PNG.sync.read(png);
  let sum = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 1; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) sum += ((img.data[i + c] as number) - (img.data[i - 4 + c] as number)) ** 2;
    }
  return sum / (img.width * img.height);
}

test.describe('photo mode and time-lapse (Phase 8)', () => {
  test.setTimeout(600_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/?autostart&spot=riffles&hour=9&day=290');
    await waitForReady(page, 300_000);
    await page.keyboard.press('KeyP');
    await expect(page.getByTestId('take-photo')).toBeVisible();
  });

  test('an accumulated still saves as a PNG and is smoother than a single frame', async ({ page }) => {
    const shoot = (samples: number) =>
      page.evaluate(async (n) => {
        const photo = (window as any).__riffle.world.photo;
        Object.assign(photo.settings, { samples: n, resolution: '1080p', aperture: 8, focus: 12 });
        const blob: Blob = await photo.takePhoto();
        return Array.from(new Uint8Array(await blob.arrayBuffer())) as number[];
      }, samples);
    const single = Buffer.from(await shoot(1));
    const still = Buffer.from(await shoot(64));
    const img = PNG.sync.read(still);
    expect([img.width, img.height]).toEqual([1920, 1080]);
    expect(imageSpread(still)).toBeGreaterThan(20);
    // Averaging 64 jittered frames smooths edges and noise.
    expect(roughness(still)).toBeLessThan(roughness(single) * 0.9);
  });

  test('a wide aperture blurs what is out of focus', async ({ page }) => {
    const shoot = (aperture: number) =>
      page.evaluate(async (f) => {
        const photo = (window as any).__riffle.world.photo;
        Object.assign(photo.settings, { samples: 32, resolution: '1080p', aperture: f, focus: 1.5, focalLength: 85 });
        const blob: Blob = await photo.takePhoto();
        return Array.from(new Uint8Array(await blob.arrayBuffer())) as number[];
      }, aperture);
    const sharp = Buffer.from(await shoot(22));
    const soft = Buffer.from(await shoot(1.4));
    expect(roughness(soft)).toBeLessThan(roughness(sharp) * 0.8);
  });

  test('a one-day time-lapse records a playable MP4 and leaves the valley a day later', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const start = w.clock.seconds;
      const p = w.photo;
      const key = { x: p.position.x, y: p.position.y, z: p.position.z, yaw: p.yaw, pitch: p.pitch, fov: p.fov };
      const blob: Blob = await p.recordTimeLapse(
        { span: 'day', interval: 1800, keyframes: [key], resolution: '1080p', samples: 1 },
        null,
        () => undefined,
      );
      const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      return {
        size: blob.size,
        box: String.fromCharCode(...head.slice(4, 8)),
        days: (w.clock.seconds - start) / 86400,
      };
    });
    expect(r.box).toBe('ftyp');
    expect(r.size).toBeGreaterThan(20_000);
    expect(r.days).toBeCloseTo(1, 3);
  });

  test("recording doesn't change the simulation", async ({ page, context }) => {
    // Record a season (a frame every 3 hours), then compare the ecosystem with one that simply ran the same time.
    // The stream is held at its level in both, so the only difference is the recording.
    const recorded = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      await (window as any).__riffle.builder.setSetting('ecosystem.rainRaisesStream', false);
      const p = w.photo;
      const key = { x: p.position.x, y: p.position.y, z: p.position.z, yaw: p.yaw, pitch: p.pitch, fov: p.fov };
      const target = w.clock.seconds + 91 * 86400;
      await p.recordTimeLapse(
        { span: 'season', interval: 3 * 3600, keyframes: [key], resolution: '1080p', samples: 1 },
        null,
        () => undefined,
      );
      return { hash: await w.ecology.hash(), target };
    });
    const other = await context.newPage();
    await other.goto('/?autostart&spot=riffles&hour=9&day=290');
    await waitForReady(other, 300_000);
    const straight = await other.evaluate(async (target) => {
      const w = (window as any).__riffle.world;
      await (window as any).__riffle.builder.setSetting('ecosystem.rainRaisesStream', false);
      w.clock.paused = true;
      w.clock.seconds = target;
      await w.ecology.syncNow();
      return w.ecology.hash();
    }, recorded.target);
    expect(straight).toBe(recorded.hash);
  });
});
