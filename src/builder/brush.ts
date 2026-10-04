/**
 * Builder brushes (plan 6.8): the scatter brush (plants and pebbles with natural spacing, random scale and rotation),
 * the eraser and the grass brush. Pure TypeScript and seeded, so a brush stroke can be replayed from a save file.
 */
import { createRng } from '../sim/rng';
import type { GrassStroke } from './editLayer';

export interface BrushSettings {
  /** Meters. */
  radius: number;
  /** 0..1: how full the brush fills its circle. */
  density: number;
}

export interface ScatterDab {
  x: number;
  z: number;
  yaw: number;
  scale: number;
  variant: number;
}

/**
 * Points for one scatter-brush dab: dart throwing inside the circle with a minimum spacing, also keeping clear of
 * existing items. `spacing` comes from the item's placement rules.
 */
export function scatterDab(
  seed: string,
  cx: number,
  cz: number,
  brush: BrushSettings,
  spacing: number,
  variants: number,
  existing: readonly { x: number; z: number }[] = [],
  scaleRange: [number, number] = [0.8, 1.2],
): ScatterDab[] {
  const rng = createRng(seed);
  const area = Math.PI * brush.radius * brush.radius;
  // A full brush packs about one item per spacing² (hexagonal packing is denser; darts never reach it).
  const target = Math.max(1, Math.round((area / (spacing * spacing)) * 0.7 * brush.density));
  const out: ScatterDab[] = [];
  const min2 = spacing * spacing;
  const near = existing.filter((e) => (e.x - cx) ** 2 + (e.z - cz) ** 2 < (brush.radius + spacing) ** 2);
  for (let k = 0; k < target * 30 && out.length < target; k++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * brush.radius;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    if (out.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < min2)) continue;
    if (near.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < min2)) continue;
    out.push({
      x,
      z,
      yaw: rng.range(0, Math.PI * 2),
      scale: rng.range(scaleRange[0], scaleRange[1]),
      variant: rng.int(0, Math.max(1, variants)),
    });
  }
  return out;
}

/** The uids of items inside the eraser circle. */
export function itemsInCircle(
  items: Iterable<{ uid: string; x: number; z: number }>,
  cx: number,
  cz: number,
  r: number,
): string[] {
  const out: string[] = [];
  for (const i of items) if ((i.x - cx) ** 2 + (i.z - cz) ** 2 <= r * r) out.push(i.uid);
  return out;
}

export interface DensityGrid {
  data: Float32Array;
  size: number;
  cell: number;
  originX: number;
  originZ: number;
}

/**
 * Applies one grass-brush dab to a density grid (soft edge). Returns the cell bounds it touched, or null.
 * Painting never leaves the 0..1 range.
 */
export function applyGrassStroke(
  grid: DensityGrid,
  stroke: GrassStroke,
): { x0: number; z0: number; x1: number; z1: number } | null {
  const { size, cell } = grid;
  const x0 = Math.max(0, Math.floor((stroke.x - stroke.radius - grid.originX) / cell));
  const x1 = Math.min(size - 1, Math.ceil((stroke.x + stroke.radius - grid.originX) / cell));
  const z0 = Math.max(0, Math.floor((stroke.z - stroke.radius - grid.originZ) / cell));
  const z1 = Math.min(size - 1, Math.ceil((stroke.z + stroke.radius - grid.originZ) / cell));
  if (x0 > x1 || z0 > z1) return null;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const wx = grid.originX + x * cell;
      const wz = grid.originZ + z * cell;
      const d = Math.hypot(wx - stroke.x, wz - stroke.z) / stroke.radius;
      if (d >= 1) continue;
      const falloff = 1 - d * d;
      const i = z * size + x;
      const v = (grid.data[i] as number) + stroke.amount * falloff;
      grid.data[i] = Math.min(1, Math.max(0, v));
    }
  }
  return { x0, z0, x1, z1 };
}
