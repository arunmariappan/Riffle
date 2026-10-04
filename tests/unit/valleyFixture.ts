/** A synthetic valley for the ecology tests: stretches like the real stream's zones, plus the pond. */
import { loadCatalog } from '../../src/content/catalog';
import { speciesLife, type SpeciesLife } from '../../src/sim/ecology/cohorts';
import { makeStretch, type Stretch } from '../../src/sim/ecology/stretches';
import type { FishDef } from '../../src/content/schema';

export const fishDefs: FishDef[] = loadCatalog().fish;
export const lives: SpeciesLife[] = fishDefs.map(speciesLife);

function soft(v: number, lo: number, hi: number, m: number): number {
  if (v < lo) return Math.max(0, 1 - (lo - v) / m);
  if (v > hi) return Math.max(0, 1 - (v - hi) / m);
  return 1;
}

interface ZoneSpec {
  zone: string;
  count: number;
  area: number;
  meanDepth: number;
  meanSpeed: number;
  fastShare: number;
  slowShare: number;
  turbulence: number;
  gravel: number;
  plants: number;
  shade: number;
}

/** Suitability from the share of fast, middling and slow water at a stretch's depth (an approximation). */
function suitability(z: ZoneSpec, defs: readonly FishDef[], pond: boolean): number[] {
  return defs.map((d) => {
    const h = d.habitat;
    if (pond) return soft(z.meanDepth, h.depth[0], h.depth[1], 0.4) * soft(0, h.flow[0], h.flow[1], 0.2);
    if (h.pondOnly) return 0;
    const mid = 1 - z.fastShare - z.slowShare;
    const depthFit = (k: number) => soft(z.meanDepth * k, h.depth[0], h.depth[1], 0.3);
    return (
      z.fastShare * soft(1.0, h.flow[0], h.flow[1], 0.25) * depthFit(0.8) +
      mid * soft(0.4, h.flow[0], h.flow[1], 0.25) * depthFit(1) +
      z.slowShare * soft(0.08, h.flow[0], h.flow[1], 0.25) * depthFit(0.7)
    );
  });
}

const DEFAULT_ZONES: ZoneSpec[] = [
  {
    zone: 'rapids',
    count: 2,
    area: 500,
    meanDepth: 0.5,
    meanSpeed: 1.1,
    fastShare: 0.6,
    slowShare: 0.1,
    turbulence: 0.5,
    gravel: 0.45,
    plants: 0.05,
    shade: 0.4,
  },
  {
    zone: 'riffles',
    count: 4,
    area: 700,
    meanDepth: 0.45,
    meanSpeed: 0.6,
    fastShare: 0.35,
    slowShare: 0.2,
    turbulence: 0.35,
    gravel: 0.6,
    plants: 0.15,
    shade: 0.3,
  },
  {
    zone: 'pool',
    count: 2,
    area: 900,
    meanDepth: 1.6,
    meanSpeed: 0.2,
    fastShare: 0.05,
    slowShare: 0.6,
    turbulence: 0.05,
    gravel: 0.1,
    plants: 0.2,
    shade: 0.25,
  },
  {
    zone: 'bend',
    count: 3,
    area: 800,
    meanDepth: 0.7,
    meanSpeed: 0.4,
    fastShare: 0.15,
    slowShare: 0.4,
    turbulence: 0.15,
    gravel: 0.35,
    plants: 0.35,
    shade: 0.35,
  },
];

/**
 * The stretches of a test valley. `kind`: the default (rapids → riffles → pool → bend, and a pond), a valley of fast
 * water only, or of slow water only (the adaptation experiments).
 */
export function testValley(
  kind: 'default' | 'fast' | 'slow' = 'default',
  defs: readonly FishDef[] = fishDefs,
): Stretch[] {
  const zones =
    kind === 'default'
      ? DEFAULT_ZONES
      : kind === 'fast'
        ? [
            {
              ...DEFAULT_ZONES[0]!,
              zone: 'rapids',
              count: 8,
              meanDepth: 0.6,
              meanSpeed: 1.1,
              fastShare: 0.7,
              slowShare: 0.05,
            },
          ]
        : [
            {
              ...DEFAULT_ZONES[2]!,
              zone: 'pool',
              count: 8,
              meanDepth: 0.8,
              meanSpeed: 0.12,
              fastShare: 0,
              slowShare: 0.8,
              gravel: 0.35,
            },
          ];
  const out: Stretch[] = [];
  for (const z of zones)
    for (let k = 0; k < z.count; k++) {
      const id = out.length;
      out.push(
        makeStretch(id, {
          zone: z.zone,
          area: z.area,
          meanDepth: z.meanDepth,
          maxDepth: z.meanDepth * 2,
          meanSpeed: z.meanSpeed,
          fastShare: z.fastShare,
          slowShare: z.slowShare,
          turbulence: z.turbulence,
          gravel: z.gravel,
          plants: z.plants,
          shade: z.shade,
          suitability: suitability(z, defs, false),
        }),
      );
    }
  out[out.length - 1]!.downstream = -1;
  if (kind === 'default') {
    const pondSpec: ZoneSpec = {
      zone: 'pond',
      count: 1,
      area: 600,
      meanDepth: 1.4,
      meanSpeed: 0,
      fastShare: 0,
      slowShare: 1,
      turbulence: 0,
      gravel: 0,
      plants: 0.6,
      shade: 0.1,
    };
    const id = out.length;
    out.push(
      makeStretch(id, {
        zone: 'pond',
        pond: true,
        area: pondSpec.area,
        meanDepth: pondSpec.meanDepth,
        maxDepth: 2.5,
        meanSpeed: 0,
        fastShare: 0,
        slowShare: 1,
        turbulence: 0,
        gravel: 0,
        plants: 0.6,
        shade: 0.1,
        upstream: id - 2,
        downstream: -1,
        suitability: suitability(pondSpec, defs, true),
      }),
    );
  }
  return out;
}

export function speciesIndex(id: string): number {
  return lives.findIndex((l) => l.id === id);
}
