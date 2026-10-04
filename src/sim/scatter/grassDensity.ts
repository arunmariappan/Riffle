/**
 * Grass density over the valley (0..1 per height-map cell): meadows dense, forest floor sparse, none in the water
 * or on steep faces. Computed once (in the terrain worker) so streaming grass around the camera only needs lookups.
 */
import { createSimplex2, fbm, smoothstep } from '../noise';
import type { Valley } from '../terrain/valley';

export function computeGrassDensity(valley: Valley, seed: string): Float32Array {
  const hf = valley.heightfield;
  const n = hf.size;
  const out = new Float32Array(n * n);
  const meadow = createSimplex2(`${seed}:meadow`);
  const h = hf.heights;
  const pondX = valley.pond.x;
  const pondZ = valley.pond.z;
  const pondR = valley.pond.radius;
  for (let z = 1; z < n - 1; z++) {
    for (let x = 1; x < n - 1; x++) {
      const i = z * n + x;
      const rd = valley.masks.riverDistance[i] as number;
      const wx = hf.originX + x * hf.cell;
      const wz = hf.originZ + z * hf.cell;
      const pd = Math.hypot(wx - pondX, wz - pondZ) - pondR;
      if (rd < 0.6 || pd < 0.8) continue;
      const dx = ((h[i + 1] as number) - (h[i - 1] as number)) / (2 * hf.cell);
      const dz = ((h[i + n] as number) - (h[i - n] as number)) / (2 * hf.cell);
      const slope = 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz);
      if (slope > 0.34) continue;
      const patch = fbm(meadow, wx, wz, { octaves: 2, frequency: 0.012 }) * 0.5 + 0.5;
      const forest = smoothstep(14, 40, rd) * smoothstep(0.35, 0.65, patch + slope * 1.4);
      const shore = smoothstep(0.6, 2.5, rd) * smoothstep(0.8, 2.5, pd);
      out[i] = Math.max(0, (1 - forest * 0.8) * shore * (1 - smoothstep(0.22, 0.34, slope)));
    }
  }
  return out;
}

/** Nearest-cell density lookup at a world position. */
export function grassDensityAt(valley: Valley, density: Float32Array, x: number, z: number): number {
  const hf = valley.heightfield;
  const cx = Math.round((x - hf.originX) / hf.cell);
  const cz = Math.round((z - hf.originZ) / hf.cell);
  if (cx < 0 || cz < 0 || cx >= hf.size || cz >= hf.size) return 0;
  return density[cz * hf.size + cx] as number;
}
