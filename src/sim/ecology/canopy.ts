/**
 * Canopy shade over the valley (plan 6.6: light = the sun's path for the season + canopy shade): each tree's crown
 * shades a disc of the ground around it. A coarse grid (4 m cells) that the ecology reads for the light on the water
 * and on the ground plants. Pure TypeScript.
 */

export interface CanopyGrid {
  data: Float32Array;
  size: number;
  cell: number;
  originX: number;
  originZ: number;
}

export interface Crown {
  x: number;
  z: number;
  /** Crown radius, m. */
  radius: number;
  /** 0..1 how dense the crown is (bare maples in winter shade less). */
  density?: number;
}

export function canopyGrid(crowns: Iterable<Crown>, extent: number, origin: number, cell = 4): CanopyGrid {
  const size = Math.ceil(extent / cell);
  const data = new Float32Array(size * size);
  for (const c of crowns) {
    const r = c.radius;
    const d = c.density ?? 0.8;
    const i0 = Math.max(0, Math.floor((c.x - r - origin) / cell));
    const i1 = Math.min(size - 1, Math.floor((c.x + r - origin) / cell));
    const j0 = Math.max(0, Math.floor((c.z - r - origin) / cell));
    const j1 = Math.min(size - 1, Math.floor((c.z + r - origin) / cell));
    for (let j = j0; j <= j1; j++) {
      const z = origin + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const x = origin + (i + 0.5) * cell;
        const q = 1 - Math.hypot(x - c.x, z - c.z) / r;
        if (q <= 0) continue;
        // Overlapping crowns add up, but never shade more than fully.
        const k = j * size + i;
        data[k] = 1 - (1 - (data[k] as number)) * (1 - d * Math.min(1, q * 1.6));
      }
    }
  }
  return { data, size, cell, originX: origin, originZ: origin };
}

/** Shade 0..1 at a point. */
export function shadeAt(grid: CanopyGrid, x: number, z: number): number {
  const i = Math.floor((x - grid.originX) / grid.cell);
  const j = Math.floor((z - grid.originZ) / grid.cell);
  if (i < 0 || j < 0 || i >= grid.size || j >= grid.size) return 0;
  return grid.data[j * grid.size + i] as number;
}
