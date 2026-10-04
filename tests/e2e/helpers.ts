import { expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

/** Waits until the app reports ready (or an error) through window.__riffle. */
export async function waitForReady(page: Page, timeout = 90_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const r = (window as any).__riffle;
      return r?.ready === true || typeof r?.error === 'string';
    },
    null,
    { timeout },
  );
  const error = await page.evaluate(() => (window as any).__riffle?.error);
  expect(error, 'the app reported an error').toBeUndefined();
}

/** Sum of the RGB standard deviations of a PNG: a blank or single-color frame is close to 0. */
export function imageSpread(png: Buffer): number {
  const image = PNG.sync.read(png);
  const n = image.width * image.height;
  let total = 0;
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = image.data[i * 4 + c] as number;
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    total += Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  }
  return total;
}

/** A box in fractions of the image (0..1). */
export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Mean absolute RGB difference (0..255) between two same-sized PNGs, optionally inside a region. */
export function imageDiff(a: Buffer, b: Buffer, region: Region = { x0: 0, y0: 0, x1: 1, y1: 1 }): number {
  const ia = PNG.sync.read(a);
  const ib = PNG.sync.read(b);
  expect(ib.width).toBe(ia.width);
  expect(ib.height).toBe(ia.height);
  const x0 = Math.floor(region.x0 * ia.width);
  const x1 = Math.ceil(region.x1 * ia.width);
  const y0 = Math.floor(region.y0 * ia.height);
  const y1 = Math.ceil(region.y1 * ia.height);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * ia.width + x) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs((ia.data[o + c] as number) - (ib.data[o + c] as number));
      n += 3;
    }
  }
  return sum / Math.max(1, n);
}

/** Points the camera at the tree nearest the player (fixed camera), so a test can watch it move. */
export async function frameNearestTree(page: Page): Promise<{ kind: string; height: number }> {
  return page.evaluate(() => {
    const w = (window as any).__riffle.world;
    const cam = (window as any).__riffle.engine.camera;
    const p = w.player.position;
    const t = w.trees.nearest(p.x, p.z);
    const dx = p.x - t.x;
    const dz = p.z - t.z;
    const len = Math.hypot(dx, dz) || 1;
    const dist = Math.max(7, t.height * 0.95);
    const cx = t.x + (dx / len) * dist;
    const cz = t.z + (dz / len) * dist;
    w.mode = 'fixed';
    cam.position.set(cx, Math.max(w.heightAt(cx, cz) + 1.6, t.y + t.height * 0.45), cz);
    cam.lookAt(t.x, t.y + t.height * 0.55, t.z);
    return { kind: t.kind, height: t.height };
  });
}

/** Points the camera down at the densest grass within 25 m of the player. */
export async function frameMeadow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = (window as any).__riffle.world;
    const cam = (window as any).__riffle.engine.camera;
    const p = w.player.position;
    let best = { x: p.x, z: p.z, d: -1 };
    for (let dz = -25; dz <= 25; dz += 1.5) {
      for (let dx = -25; dx <= 25; dx += 1.5) {
        const d = w.grass.densityAt(p.x + dx, p.z + dz);
        if (d > best.d) best = { x: p.x + dx, z: p.z + dz, d };
      }
    }
    w.mode = 'fixed';
    cam.position.set(best.x + 1.2, w.heightAt(best.x + 1.2, best.z) + 1.3, best.z);
    cam.lookAt(best.x - 0.6, w.heightAt(best.x, best.z) + 0.1, best.z);
    w.grass.update(cam.position, true);
    return best.d;
  });
}
