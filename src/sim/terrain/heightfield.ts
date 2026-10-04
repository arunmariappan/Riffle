/** A square height map in world space (plan 6.1). Sample (0, 0) sits at (originX, originZ). */
export interface Heightfield {
  /** Samples per side. */
  size: number;
  /** Meters between samples. */
  cell: number;
  originX: number;
  originZ: number;
  heights: Float32Array;
}

export function createHeightfield(size: number, cell: number): Heightfield {
  const extent = (size - 1) * cell;
  return { size, cell, originX: -extent / 2, originZ: -extent / 2, heights: new Float32Array(size * size) };
}

export function heightfieldExtent(hf: Heightfield): number {
  return (hf.size - 1) * hf.cell;
}

/** Bilinear height at a world position (clamped to the edges). */
export function sampleHeight(hf: Heightfield, x: number, z: number): number {
  const fx = Math.min(hf.size - 1.0001, Math.max(0, (x - hf.originX) / hf.cell));
  const fz = Math.min(hf.size - 1.0001, Math.max(0, (z - hf.originZ) / hf.cell));
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const i = iz * hf.size + ix;
  const h = hf.heights;
  const a = h[i] as number;
  const b = h[i + 1] as number;
  const c = h[i + hf.size] as number;
  const d = h[i + hf.size + 1] as number;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/** Unit surface normal from central differences. */
export function sampleNormal(
  hf: Heightfield,
  x: number,
  z: number,
  out: [number, number, number] = [0, 1, 0],
): [number, number, number] {
  const e = hf.cell;
  const dx = sampleHeight(hf, x + e, z) - sampleHeight(hf, x - e, z);
  const dz = sampleHeight(hf, x, z + e) - sampleHeight(hf, x, z - e);
  const nx = -dx / (2 * e);
  const nz = -dz / (2 * e);
  const len = Math.hypot(nx, 1, nz);
  out[0] = nx / len;
  out[1] = 1 / len;
  out[2] = nz / len;
  return out;
}

/** Slope as 1 - normal.y (0 flat, ~0.3 at 45°). */
export function slopeAt(hf: Heightfield, x: number, z: number): number {
  return 1 - sampleNormal(hf, x, z)[1];
}

/** Downsamples by an integer factor (e.g. the 1 m physics heightfield from a finer render map). */
export function downsample(hf: Heightfield, factor: number): Heightfield {
  const size = Math.floor((hf.size - 1) / factor) + 1;
  const out: Heightfield = {
    size,
    cell: hf.cell * factor,
    originX: hf.originX,
    originZ: hf.originZ,
    heights: new Float32Array(size * size),
  };
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      out.heights[z * size + x] = hf.heights[z * factor * hf.size + x * factor] as number;
    }
  }
  return out;
}
