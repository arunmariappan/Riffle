/**
 * Content schemas (plan 7): every species and object is a JSON file in content/, checked with Zod at load.
 * Adding a new item needs no code: drop a JSON file (and a model only if it isn't generated).
 */
import { z } from 'zod';

const range = z.tuple([z.number(), z.number()]);
const rgb = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Smooth tolerance curve: full fitness inside [ideal], falling to 0 at [limits]. */
export const toleranceSchema = z.object({
  limits: range,
  ideal: range,
});

export const placementSchema = z.object({
  /** Where it can be placed. */
  surface: z.enum(['land', 'water', 'bed', 'stone', 'pond']),
  /** Distance from the stream's water edge, meters (negative = in the channel). */
  riverDistance: range.optional(),
  /** Height above the nearby stream bank, meters. */
  heightAboveBank: range.optional(),
  /** Water depth range for aquatic items, meters. */
  depth: range.optional(),
  /** Slope as 1 − normal.y. */
  maxSlope: z.number().default(0.4),
  /** Maximum current speed, m/s (aquatic items). */
  maxFlow: z.number().optional(),
  /** Wetness preference 0..1. */
  wetness: range.optional(),
  /** Minimum distance to other placed items, meters. */
  spacing: z.number().default(3),
  /** Relative density for the starting layout (0 = none at start). */
  density: z.number().default(1),
});

export const seasonalLookSchema = z.object({
  leafColor: rgb,
  /** Color the leaves blend toward per season (blossom, autumn red…), with blend amount. */
  spring: z.object({ color: rgb, mix: z.number() }).optional(),
  premonsoon: z.object({ color: rgb, mix: z.number() }).optional(),
  monsoon: z.object({ color: rgb, mix: z.number() }).optional(),
  autumn: z.object({ color: rgb, mix: z.number() }).optional(),
  winter: z.object({ color: rgb, mix: z.number() }).optional(),
  /** Foliage present per season (0 bare .. 1 full). */
  leafAmount: z
    .object({ winter: z.number(), spring: z.number(), premonsoon: z.number(), monsoon: z.number(), autumn: z.number() })
    .optional(),
});

export const windSchema = z.object({
  stiffness: z.number().default(1),
});

export const growthSchema = z.object({
  /** Years to reach full size. */
  yearsToMature: z.number().default(10),
  lifespanYears: z.number().default(80),
  spread: z.enum(['wind-seeds', 'runners', 'drift', 'plantlets', 'none']).default('wind-seeds'),
  /** Expected new plants per mature plant per year at full fitness. */
  spreadRate: z.number().default(0.2),
  spreadDistance: z.number().default(20),
});

export const toleranceSetSchema = z.object({
  light: toleranceSchema.optional(),
  moisture: toleranceSchema.optional(),
  temperature: toleranceSchema.optional(),
  flow: toleranceSchema.optional(),
  depth: toleranceSchema.optional(),
});

const baseItem = {
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  description: z.string().default(''),
  placement: placementSchema,
  tolerance: toleranceSetSchema.default({}),
  growth: growthSchema.default({
    yearsToMature: 10,
    lifespanYears: 80,
    spread: 'wind-seeds',
    spreadRate: 0.2,
    spreadDistance: 20,
  }),
};

export const treeSchema = z.object({
  ...baseItem,
  category: z.literal('trees'),
  generator: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('ez-tree'),
      preset: z.string(),
      height: range,
      variants: z.number().int().min(1).max(6).default(3),
      bark: z.string(),
      barkTint: rgb.default('#ffffff'),
      /** Lite (far) canopy shape. */
      shape: z.enum(['round', 'cone', 'spreading']).default('round'),
    }),
    z.object({ kind: z.literal('bamboo'), height: range, variants: z.number().int().default(3) }),
    z.object({ kind: z.literal('tree-fern'), height: range, variants: z.number().int().default(3) }),
  ]),
  look: seasonalLookSchema,
  wind: windSchema.default({ stiffness: 1 }),
});

export const stoneSchema = z.object({
  ...baseItem,
  category: z.literal('stones'),
  generator: z.object({
    kind: z.literal('rock'),
    radius: range,
    /** Height / radius. */
    flatness: range,
    roughness: z.number().default(0.35),
    variants: z.number().int().default(4),
    texture: z.string().default('mossy_rock'),
    /** Several small stones per placement (pebble cluster, cobbles). */
    cluster: z.number().int().default(1),
  }),
  /** Moss growth per year in damp shade (0..1). */
  mossRate: z.number().default(0.15),
  /** Density in t/m³ for physics. */
  density: z.number().default(2.6),
});

export type TreeDef = z.infer<typeof treeSchema>;
export type StoneDef = z.infer<typeof stoneSchema>;
export type Placement = z.infer<typeof placementSchema>;
export type Tolerance = z.infer<typeof toleranceSchema>;

/** 0..1 fitness of a value against a tolerance curve. */
export function fitness(t: Tolerance | undefined, value: number): number {
  if (!t) return 1;
  const [lo, hi] = t.limits;
  const [ilo, ihi] = t.ideal;
  if (value <= lo || value >= hi) return 0;
  if (value < ilo) return (value - lo) / Math.max(1e-6, ilo - lo);
  if (value > ihi) return (hi - value) / Math.max(1e-6, hi - ihi);
  return 1;
}

/** Smooth 0..1 membership of a value in a range with soft edges. */
export function inRange(r: readonly [number, number] | undefined, value: number, soft = 0.15): number {
  if (!r) return 1;
  const [lo, hi] = r;
  const width = Math.max(1e-6, (hi - lo) * soft);
  const a = Math.min(1, Math.max(0, (value - (lo - width)) / (2 * width)));
  const b = Math.min(1, Math.max(0, (hi + width - value) / (2 * width)));
  return Math.min(a, b);
}
