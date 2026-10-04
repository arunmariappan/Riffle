/**
 * Hydraulic (water-droplet) and thermal (slope settling) erosion on a height map (plan 6.1).
 * Droplets carve gullies and drop sediment in fans; thermal erosion turns steep faces into scree.
 * Pure TypeScript and seeded, so the same seed always gives the same valley.
 */
import type { Rng } from '../rng';

export interface ErosionOptions {
  droplets: number;
  maxSteps: number;
  inertia: number;
  capacity: number;
  minCapacity: number;
  erodeSpeed: number;
  depositSpeed: number;
  evaporate: number;
  gravity: number;
  radius: number;
}

export const DEFAULT_EROSION: ErosionOptions = {
  droplets: 120_000,
  maxSteps: 48,
  inertia: 0.06,
  capacity: 5,
  minCapacity: 0.01,
  erodeSpeed: 0.3,
  depositSpeed: 0.3,
  evaporate: 0.015,
  gravity: 9,
  radius: 3,
};

export interface ErosionResult {
  /** Net sediment deposited per cell (meters); negative where eroded. */
  sediment: Float32Array;
}

/**
 * Droplet erosion. `allow` (0..1 per cell) scales the effect, so the designed stream channel and floodplain stay
 * untouched. Cell size is assumed to be 1 unit in grid space; heights are in meters scaled by 1/cell.
 */
export function hydraulicErosion(
  heights: Float32Array,
  size: number,
  cell: number,
  allow: Float32Array,
  rng: Rng,
  options: Partial<ErosionOptions> = {},
): ErosionResult {
  const o = { ...DEFAULT_EROSION, ...options };
  const sediment = new Float32Array(size * size);
  // Brush offsets and weights for erosion.
  const brushDx: number[] = [];
  const brushDy: number[] = [];
  const brushW: number[] = [];
  let wSum = 0;
  for (let dy = -o.radius; dy <= o.radius; dy++) {
    for (let dx = -o.radius; dx <= o.radius; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > o.radius) continue;
      const w = 1 - d / o.radius;
      brushDx.push(dx);
      brushDy.push(dy);
      brushW.push(w);
      wSum += w;
    }
  }
  for (let i = 0; i < brushW.length; i++) brushW[i] = (brushW[i] as number) / wSum;

  const h = heights;
  const inv = 1 / cell; // work in grid units: heights / cell
  const heightAt = (x: number, y: number): number => {
    const ix = x | 0;
    const iy = y | 0;
    const tx = x - ix;
    const ty = y - iy;
    const i = iy * size + ix;
    return (
      (((h[i] as number) * (1 - tx) + (h[i + 1] as number) * tx) * (1 - ty) +
        ((h[i + size] as number) * (1 - tx) + (h[i + size + 1] as number) * tx) * ty) *
      inv
    );
  };

  for (let d = 0; d < o.droplets; d++) {
    let x = rng.range(1, size - 2);
    let y = rng.range(1, size - 2);
    const start = (y | 0) * size + (x | 0);
    if ((allow[start] as number) < 0.05) continue;
    let dirX = 0;
    let dirY = 0;
    let speed = 1;
    let water = 1;
    let carried = 0;
    for (let step = 0; step < o.maxSteps; step++) {
      const ix = x | 0;
      const iy = y | 0;
      const tx = x - ix;
      const ty = y - iy;
      const i = iy * size + ix;
      const h00 = (h[i] as number) * inv;
      const h10 = (h[i + 1] as number) * inv;
      const h01 = (h[i + size] as number) * inv;
      const h11 = (h[i + size + 1] as number) * inv;
      const gx = (h10 - h00) * (1 - ty) + (h11 - h01) * ty;
      const gy = (h01 - h00) * (1 - tx) + (h11 - h10) * tx;
      const height = (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
      dirX = dirX * o.inertia - gx * (1 - o.inertia);
      dirY = dirY * o.inertia - gy * (1 - o.inertia);
      const len = Math.hypot(dirX, dirY);
      if (len < 1e-9) break;
      dirX /= len;
      dirY /= len;
      x += dirX;
      y += dirY;
      if (x < 1 || y < 1 || x >= size - 2 || y >= size - 2) break;
      const allowHere = allow[(y | 0) * size + (x | 0)] as number;
      const newHeight = heightAt(x, y);
      const deltaH = newHeight - height;
      const capacity = Math.max(-deltaH * speed * water * o.capacity, o.minCapacity);
      if (carried > capacity || deltaH > 0) {
        const amount = deltaH > 0 ? Math.min(deltaH, carried) : (carried - capacity) * o.depositSpeed;
        carried -= amount;
        const a = amount * cell * allowHere;
        // Deposit bilinearly at the old position.
        h[i] = (h[i] as number) + a * (1 - tx) * (1 - ty);
        h[i + 1] = (h[i + 1] as number) + a * tx * (1 - ty);
        h[i + size] = (h[i + size] as number) + a * (1 - tx) * ty;
        h[i + size + 1] = (h[i + size + 1] as number) + a * tx * ty;
        sediment[i] = (sediment[i] as number) + a;
      } else {
        const amount = Math.min((capacity - carried) * o.erodeSpeed, -deltaH) * allowHere;
        for (let b = 0; b < brushW.length; b++) {
          const bx = ix + (brushDx[b] as number);
          const by = iy + (brushDy[b] as number);
          if (bx < 0 || by < 0 || bx >= size || by >= size) continue;
          const bi = by * size + bx;
          const take = amount * (brushW[b] as number) * cell;
          h[bi] = (h[bi] as number) - take;
          sediment[bi] = (sediment[bi] as number) - take;
        }
        carried += amount;
      }
      speed = Math.sqrt(Math.max(0, speed * speed + deltaH * o.gravity));
      water *= 1 - o.evaporate;
    }
  }
  return { sediment };
}

/** Thermal erosion: material slides off faces steeper than the talus angle, forming scree. */
export function thermalErosion(
  heights: Float32Array,
  size: number,
  cell: number,
  allow: Float32Array,
  iterations = 8,
  talusSlope = 0.85,
): void {
  const talus = talusSlope * cell;
  const offsets = [1, -1, size, -size];
  for (let it = 0; it < iterations; it++) {
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        const a = allow[i] as number;
        if (a < 0.05) continue;
        const hi = heights[i] as number;
        let maxDiff = 0;
        let target = -1;
        for (const off of offsets) {
          const diff = hi - (heights[i + off] as number);
          if (diff > maxDiff) {
            maxDiff = diff;
            target = i + off;
          }
        }
        if (target >= 0 && maxDiff > talus) {
          const move = 0.25 * (maxDiff - talus) * a;
          heights[i] = hi - move;
          heights[target] = (heights[target] as number) + move;
        }
      }
    }
  }
}

/** D8 flow accumulation: how many cells drain through each cell (log-normalized to 0..1). */
export function flowAccumulation(heights: Float32Array, size: number): Float32Array {
  const n = size * size;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => (heights[b] as number) - (heights[a] as number));
  const acc = new Float32Array(n).fill(1);
  const offsets = [-size - 1, -size, -size + 1, -1, 1, size - 1, size, size + 1];
  const dist = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
  for (let k = 0; k < n; k++) {
    const i = order[k] as number;
    const x = i % size;
    const y = (i / size) | 0;
    if (x === 0 || y === 0 || x === size - 1 || y === size - 1) continue;
    let best = -1;
    let bestDrop = 0;
    const hi = heights[i] as number;
    for (let o = 0; o < 8; o++) {
      const j = i + (offsets[o] as number);
      const drop = (hi - (heights[j] as number)) / (dist[o] as number);
      if (drop > bestDrop) {
        bestDrop = drop;
        best = j;
      }
    }
    if (best >= 0) acc[best] = (acc[best] as number) + (acc[i] as number);
  }
  let max = 1;
  for (let i = 0; i < n; i++) max = Math.max(max, acc[i] as number);
  const logMax = Math.log(max);
  for (let i = 0; i < n; i++) acc[i] = Math.log(acc[i] as number) / logMax;
  return acc;
}
