/**
 * Placement rules for the builder (plan 6.8): where each catalog item can go, and a clear reason when it can't
 * ("Lotus needs still water 0.3–1.8 m deep", "Hillstream loaches need fast water", "White cloud minnows need water
 * under 24 °C"). Pure TypeScript; the engine fills the probe from the terrain, the solved water and the stones.
 */
import type { CatalogItem } from '../content/catalog';

export interface PlacementProbe {
  ground: {
    height: number;
    /** 1 − normal.y. */
    slope: number;
    /** Meters from the stream's edge (negative in the channel). */
    riverDistance: number;
    wetness: number;
  };
  /** The water here, or null on dry ground. */
  water: {
    depth: number;
    speed: number;
    surface: number;
    bed: number;
    /** °C. */
    temperature: number;
    /** The still backwater pond (not the stream). */
    pond: boolean;
  } | null;
  /** A stone under the cursor, or null. */
  stone: { uid: string; top: number; radius: number } | null;
}

export type PlacementSurface = 'land' | 'water' | 'bed' | 'stone' | 'pond';

export interface PlacementResult {
  ok: boolean;
  /** Why it can't go here, or what will happen when it does. */
  reason: string;
  surface: PlacementSurface;
  /** Height the item sits at (ground, bed, stone top). */
  y: number;
  /** Water depth above the item (water plants). */
  depth?: number;
  /** The stone it grows on. */
  host?: string;
}

/** Water shallower than this counts as dry ground (a wet bank). */
const DRY = 0.05;

function deg(slope: number): number {
  return Math.round((Math.acos(Math.max(-1, Math.min(1, 1 - slope))) * 180) / Math.PI);
}

function range(r: readonly [number, number], unit: string, digits = 1): string {
  const f = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(digits));
  return `${f(r[0])}–${f(r[1])} ${unit}`;
}

export function checkPlacement(item: CatalogItem, probe: PlacementProbe): PlacementResult {
  const { ground, water, stone } = probe;
  const wet = water !== null && water.depth > DRY;
  switch (item.category) {
    case 'stones': {
      if (!wet && ground.slope > 0.6) return fail('Too steep here: the stone would roll away', 'land', ground.height);
      if (wet)
        return {
          ok: true,
          reason: `${item.name}: drops into the water and the stream flows around it`,
          surface: 'water',
          y: water.bed,
        };
      return { ok: true, reason: item.name, surface: 'land', y: ground.height };
    }
    case 'trees':
    case 'bushes': {
      if (wet) return fail(`${item.name} can't grow in the water`, 'water', water.bed);
      const max = item.placement.maxSlope;
      if (ground.slope > max)
        return fail(`${item.name} needs gentler ground (max ${deg(max)}°)`, 'land', ground.height);
      const w = item.placement.wetness;
      if (w && ground.wetness < w[0] - 0.12) return fail(`${item.name} needs damper ground`, 'land', ground.height);
      return { ok: true, reason: item.name, surface: 'land', y: ground.height };
    }
    case 'plants': {
      const p = item.placement;
      const depth = p.depth ?? [0, 99];
      const maxFlow = p.maxFlow ?? 99;
      if (p.surface === 'pond') {
        const need = `${item.name} needs still water ${range(depth, 'm')} deep`;
        if (!wet || water.speed > maxFlow || water.depth < depth[0] || water.depth > depth[1])
          return fail(need, wet ? 'water' : 'land', wet ? water.bed : ground.height);
        return { ok: true, reason: item.name, surface: 'pond', y: water.bed, depth: water.depth };
      }
      if (p.surface === 'stone') {
        if (!stone)
          return fail(`${item.name} grows on stones: drop it onto a stone in the water`, 'land', ground.height);
        const over = water ? water.surface - stone.top : 0;
        if (!water || over < depth[0] * 0.5)
          return fail(`${item.name} needs a stone under the water`, 'stone', stone.top);
        if (water.speed > maxFlow)
          return fail(`${item.name} needs slower water (max ${maxFlow} m/s)`, 'stone', stone.top);
        return {
          ok: true,
          reason: `${item.name} on the stone`,
          surface: 'stone',
          y: stone.top,
          depth: over,
          host: stone.uid,
        };
      }
      // On the stream bed.
      if (!wet) return fail(`${item.name} grows under water ${range(depth, 'm')} deep`, 'land', ground.height);
      if (water.depth < depth[0] || water.depth > depth[1])
        return fail(`${item.name} needs water ${range(depth, 'm')} deep`, 'bed', water.bed);
      if (water.speed > maxFlow) return fail(`${item.name} needs slower water (max ${maxFlow} m/s)`, 'bed', water.bed);
      return { ok: true, reason: item.name, surface: 'bed', y: water.bed, depth: water.depth };
    }
    case 'fish': {
      const h = item.habitat;
      if (!wet) return fail(`${item.plural} need water`, 'land', ground.height);
      if (h.pondOnly && !water.pond) return fail(`${item.plural} live in the backwater pond`, 'water', water.bed);
      if (water.depth < h.depth[0])
        return fail(`${item.plural} need water at least ${h.depth[0]} m deep`, 'water', water.bed);
      if (water.speed < h.flow[0])
        return fail(`${item.plural} need fast water (over ${h.flow[0]} m/s)`, 'water', water.bed);
      if (water.speed > h.flow[1])
        return fail(`${item.plural} need slower water (max ${h.flow[1]} m/s)`, 'water', water.bed);
      const t = Math.round(water.temperature);
      if (water.temperature > h.temperature[1])
        return fail(`${item.plural} need water under ${h.temperature[1]} °C (it's ${t} °C here)`, 'water', water.bed);
      if (water.temperature < h.temperature[0])
        return fail(`${item.plural} need water over ${h.temperature[0]} °C (it's ${t} °C here)`, 'water', water.bed);
      return { ok: true, reason: `${item.plural}: a school`, surface: 'water', y: water.bed, depth: water.depth };
    }
  }
}

function fail(reason: string, surface: PlacementSurface, y: number): PlacementResult {
  return { ok: false, reason, surface, y };
}
