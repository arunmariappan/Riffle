/**
 * Seeded 2D simplex noise plus fractal helpers, used by the terrain generator, scatter rules and wind.
 * Pure TypeScript so it runs the same in Node (tests), workers and the main thread.
 */
import { createRng } from './rng';

const GRAD2: readonly (readonly [number, number])[] = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export type Noise2 = (x: number, y: number) => number;

/** Simplex noise in roughly [-1, 1]. */
export function createSimplex2(seed: number | string): Noise2 {
  const rng = createRng(seed);
  const perm = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = base[i] as number;
    base[i] = base[j] as number;
    base[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255] as number;

  const corner = (gi: number, x: number, y: number): number => {
    let t = 0.5 - x * x - y * y;
    if (t < 0) return 0;
    t *= t;
    const g = GRAD2[gi & 7] as readonly [number, number];
    return t * t * (g[0] * x + g[1] * y);
  };

  return (xin: number, yin: number): number => {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const n0 = corner(perm[ii + (perm[jj] as number)] as number, x0, y0);
    const n1 = corner(perm[ii + i1 + (perm[jj + j1] as number)] as number, x1, y1);
    const n2 = corner(perm[ii + 1 + (perm[jj + 1] as number)] as number, x2, y2);
    return 70 * (n0 + n1 + n2);
  };
}

export interface FbmOptions {
  octaves: number;
  frequency: number;
  lacunarity?: number;
  gain?: number;
}

/** Fractal sum of noise, normalized to roughly [-1, 1]. */
export function fbm(noise: Noise2, x: number, y: number, options: FbmOptions): number {
  const lacunarity = options.lacunarity ?? 2;
  const gain = options.gain ?? 0.5;
  let amplitude = 1;
  let frequency = options.frequency;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < options.octaves; o++) {
    sum += amplitude * noise(x * frequency + o * 17.13, y * frequency - o * 31.7);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

/** Ridged fractal noise in [0, 1]: sharp crests, good for mountain ridges. */
export function ridged(noise: Noise2, x: number, y: number, options: FbmOptions): number {
  const lacunarity = options.lacunarity ?? 2;
  const gain = options.gain ?? 0.5;
  let amplitude = 1;
  let frequency = options.frequency;
  let sum = 0;
  let norm = 0;
  let weight = 1;
  for (let o = 0; o < options.octaves; o++) {
    let n = 1 - Math.abs(noise(x * frequency + o * 11.7, y * frequency + o * 5.3));
    n *= n;
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 2));
    sum += amplitude * n;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}
