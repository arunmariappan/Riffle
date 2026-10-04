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

export const bushSchema = z.object({
  ...baseItem,
  category: z.literal('bushes'),
  generator: z.object({
    kind: z.enum(['fern', 'wildflowers', 'orchid']),
    height: range,
    variants: z.number().int().min(1).max(6).default(3),
    /** Flower colors (wildflowers pick one per flower; orchids use the first). */
    flowerColors: z.array(rgb).default([]),
  }),
  look: seasonalLookSchema,
  wind: windSchema.default({ stiffness: 1 }),
});

export const waterPlantSchema = z.object({
  ...baseItem,
  category: z.literal('plants'),
  generator: z.object({
    kind: z.enum(['lotus', 'lily', 'java-fern', 'cryptocoryne', 'rotala', 'moss']),
    height: range,
    variants: z.number().int().min(1).max(6).default(3),
    flowerColor: rgb.optional(),
    /** Tip color (red Rotala): leaves blend toward it at the top. */
    tipColor: rgb.optional(),
  }),
  look: seasonalLookSchema,
});

const seasonEnum = z.enum(['winter', 'spring', 'premonsoon', 'monsoon', 'autumn']);
/** A heritable trait's starting mean and spread across the population (plan D20). */
const geneSchema = z.object({ mean: z.number(), sd: z.number() });

/** Fish species (plan 6.5, 7): body, pattern and palette, behavior, habitat, diet, spawning and genes. */
export const fishSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  /** Plural for messages ("Hillstream loaches need fast water"). */
  plural: z.string(),
  description: z.string().default(''),
  category: z.literal('fish'),
  body: z.object({
    template: z.enum(['torpedo', 'deep', 'long', 'flat']),
    fins: z.enum(['forked', 'flowing', 'rounded', 'sucker']).default('forked'),
    /** Adult body length range, meters. */
    length: range,
    /** Koi and mahseer carry barbels at the mouth. */
    barbels: z.boolean().default(false),
  }),
  pattern: z.object({
    kind: z.enum(['stripes', 'pearls', 'leopard', 'koi', 'gold', 'plain']),
    back: rgb,
    flank: rgb,
    belly: rgb,
    /** Stripe, pearl spots, leopard spots or koi patches. */
    accent: rgb,
    /** Second stripe (the barb's red line) or second koi patch color. */
    accent2: rgb,
    fin: rgb,
    finTip: rgb,
    /** Metallic scales 0..1 (golden mahseer high). */
    metal: z.number().default(0.3),
    /** Thin-film iridescence 0..1. */
    iridescence: z.number().default(0.2),
  }),
  behavior: z.object({
    /** Cruise and burst speed relative to the water, m/s. */
    cruise: z.number(),
    burst: z.number(),
    /** Preferred current speed; above it they look for shelter. */
    comfortCurrent: z.number(),
    /** Preferred height in the water column, 0 bottom .. 1 surface. */
    depthPreference: z.number(),
    schooling: z.object({ separation: z.number(), alignment: z.number(), cohesion: z.number(), radius: z.number() }),
    /** 0 bold .. 1 shy. */
    shyness: z.number(),
    /** How strongly it faces upstream and holds station, 0..1. */
    rheotaxis: z.number().default(0.8),
    /** Clings to rocks on the bed (hillstream loach). */
    clings: z.boolean().default(false),
    /** Glides between tail strokes (koi). */
    glides: z.boolean().default(false),
    /** Comes closer when you stand still, 0..1. */
    curiosity: z.number().default(0.3),
  }),
  habitat: z.object({
    /** Water depth it can live in, meters. */
    depth: range,
    /** Current speed it can live in, m/s. */
    flow: range,
    /** Water temperature it can live in, °C. */
    temperature: range,
    /** Minimum dissolved oxygen, mg/L. */
    oxygenMin: z.number().default(5),
    /** Restrict releases to the pond (koi). */
    pondOnly: z.boolean().default(false),
  }),
  diet: z.array(z.enum(['insects', 'algae', 'plants', 'fish', 'detritus'])).default(['insects']),
  spawning: z.object({
    seasons: z.array(seasonEnum),
    ground: z.enum(['gravel', 'plants', 'pond']),
    /** Moves upstream to spawn when the monsoon raises the water (golden mahseer). */
    migrates: z.boolean().default(false),
  }),
  life: z.object({
    maturityYears: z.number(),
    lifespanYears: z.number(),
    /** Eggs per spawning female that hatch. */
    fecundity: z.number(),
  }),
  genes: z.object({
    bodySize: geneSchema,
    swimStrength: geneSchema,
    preferredFlow: geneSchema,
    brightness: geneSchema,
    shyness: geneSchema,
    /** Fraction of a trait's variation that is inherited (plan D20). */
    heritability: z.number().default(0.4),
    mutation: z.number().default(0.02),
  }),
  school: z.object({ size: z.number().int(), max: z.number().int() }),
});

export type FishDef = z.infer<typeof fishSchema>;
export type TreeDef = z.infer<typeof treeSchema>;
export type BushDef = z.infer<typeof bushSchema>;
export type WaterPlantDef = z.infer<typeof waterPlantSchema>;
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
