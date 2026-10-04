/**
 * Rule-based placement (plan 6.4, replaces UE's PCG): jittered candidates per species, scored by its placement
 * rules (distance to water, height above the bank, slope, wetness) and patchy forest noise, with minimum spacing.
 * Pure TypeScript and seeded: the same seed always gives the same layout. User edits are a separate layer.
 */
import { createRng } from '../rng';
import { createSimplex2, fbm, smoothstep } from '../noise';
import { sampleHeight, sampleNormal } from '../terrain/heightfield';
import type { Valley } from '../terrain/valley';
import { inRange, type Placement } from '../../content/schema';

export interface ScatterInstance {
  /** Content id. */
  kind: string;
  /** Stable id in the item registry (`g:<category>:<n>` for generated items, `u<n>` for yours). */
  uid?: string;
  variant: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  phase: number;
}

export interface ScatterItem {
  id: string;
  placement: Placement;
  variants: number;
  /** Scale range applied per instance. */
  scale?: [number, number];
}

export interface CellInfo {
  height: number;
  slope: number;
  riverDistance: number;
  heightAboveBank: number;
  wetness: number;
  section: number;
  /** Distance from the pond shore, meters (negative inside the pond). */
  pondDistance: number;
}

/** Reads the valley's masks at a world position (nearest cell). */
export function cellInfo(valley: Valley, x: number, z: number): CellInfo {
  const hf = valley.heightfield;
  const cx = Math.min(hf.size - 1, Math.max(0, Math.round((x - hf.originX) / hf.cell)));
  const cz = Math.min(hf.size - 1, Math.max(0, Math.round((z - hf.originZ) / hf.cell)));
  const idx = cz * hf.size + cx;
  const height = sampleHeight(hf, x, z);
  const section = valley.masks.riverSection[idx] as number;
  return {
    height,
    slope: 1 - sampleNormal(hf, x, z)[1],
    riverDistance: valley.masks.riverDistance[idx] as number,
    heightAboveBank: height - (valley.profile.bank[section] as number),
    wetness: valley.masks.wetness[idx] as number,
    section,
    pondDistance: Math.hypot(x - valley.pond.x, z - valley.pond.z) - valley.pond.radius,
  };
}

/** 0..1 suitability of a spot for an item's placement rules (land items; aquatic items are placed by the builder). */
export function suitability(p: Placement, c: CellInfo): number {
  if (c.slope > p.maxSlope) return 0;
  // Land items stay out of the stream and the pond (hard edge, unlike the soft range edges).
  if (p.surface === 'land' && (c.riverDistance < 1 || c.pondDistance < 1.5)) return 0;
  let s =
    inRange(p.riverDistance, c.riverDistance) *
    inRange(p.heightAboveBank, c.heightAboveBank) *
    inRange(p.wetness, c.wetness);
  s *= 1 - smoothstep(p.maxSlope * 0.75, p.maxSlope, c.slope);
  return s;
}

/** Spatial hash of placed points for spacing checks. */
class Occupancy {
  private readonly cells = new Map<number, { x: number; z: number; r: number }[]>();
  constructor(private readonly cell: number) {}
  private key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }
  free(x: number, z: number, r: number): boolean {
    const reach = Math.ceil((r + 8) / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const list = this.cells.get(this.key(cx + dx, cz + dz));
        if (!list) continue;
        for (const p of list) {
          const min = Math.max(r, p.r);
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < min * min) return false;
        }
      }
    }
    return true;
  }
  add(x: number, z: number, r: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    const list = this.cells.get(k);
    if (list) list.push({ x, z, r });
    else this.cells.set(k, [{ x, z, r }]);
  }
}

export interface ScatterOptions {
  seed: string;
  /** Circles kept clear (viewpoints, the pond link, user exclusion areas). */
  exclusions?: readonly { x: number; z: number; radius: number }[];
  /** Multiplies every density (lower = sparser valley, cheaper to draw). */
  densityScale?: number;
}

/**
 * Scatters items over the valley. Items are processed in the given order; earlier items claim space first.
 */
export function scatterItems(
  valley: Valley,
  items: readonly ScatterItem[],
  options: ScatterOptions,
): ScatterInstance[] {
  const hf = valley.heightfield;
  const extent = (hf.size - 1) * hf.cell;
  const occupancy = new Occupancy(8);
  const patches = createSimplex2(`${options.seed}:patches`);
  const out: ScatterInstance[] = [];
  const densityScale = options.densityScale ?? 1;
  for (const item of items) {
    const p = item.placement;
    if (p.density <= 0) continue;
    const rng = createRng(`${options.seed}:scatter:${item.id}`);
    const step = Math.max(1, p.spacing);
    const n = Math.floor(extent / step);
    const patchOffset = rng.range(0, 1000);
    for (let gz = 0; gz < n; gz++) {
      for (let gx = 0; gx < n; gx++) {
        const x = hf.originX + (gx + rng.next()) * step;
        const z = hf.originZ + (gz + rng.next()) * step;
        const yaw = rng.range(0, Math.PI * 2);
        const roll = rng.next();
        const variant = rng.int(0, Math.max(1, item.variants));
        const scaleT = rng.next();
        const phase = rng.range(0, Math.PI * 2);
        if (Math.abs(x) > extent / 2 - 2 || Math.abs(z) > extent / 2 - 2) continue;
        if (options.exclusions?.some((e) => (e.x - x) ** 2 + (e.z - z) ** 2 < e.radius * e.radius)) continue;
        const info = cellInfo(valley, x, z);
        let s = suitability(p, info);
        if (s <= 0) continue;
        // Patchy groves rather than an even carpet.
        const patch = fbm(patches, x + patchOffset, z, { octaves: 3, frequency: 0.012 });
        s *= smoothstep(-0.6, 0.2, patch);
        if (roll > s * Math.min(1, p.density * densityScale)) continue;
        const radius = p.spacing * 0.5;
        if (!occupancy.free(x, z, radius)) continue;
        occupancy.add(x, z, radius);
        const [s0, s1] = item.scale ?? [0.8, 1.2];
        out.push({ kind: item.id, variant, x, y: info.height, z, yaw, scale: s0 + (s1 - s0) * scaleT, phase });
      }
    }
  }
  return out;
}
