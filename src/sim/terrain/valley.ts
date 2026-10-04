/**
 * The invented monsoon valley (plan 6.1, D10): a stream course with a waterfall, rapids, riffles, a deep pool,
 * a bend with gravel bars and a backwater pond, carved into a floodplain between steep forested ridges, then
 * shaped by water and slope erosion. Pure TypeScript and seeded: the same seed always gives the same valley.
 */
import { createRng } from '../rng';
import { createSimplex2, fbm, ridged, smoothstep, clamp, lerp } from '../noise';
import { buildRiverPath, type RiverPath, type Vec2 } from '../flow/path';
import { createHeightfield, type Heightfield } from './heightfield';
import { distanceTransform } from './edt';
import { hydraulicErosion, thermalErosion, flowAccumulation } from './erosion';

/** Bump when generation changes, so cached valleys are rebuilt. */
export const VALLEY_VERSION = 3;

export interface ValleyOptions {
  seed: number | string;
  /** Samples per side (default 1025 → 1 m cells over 1024 m). */
  size?: number;
  cell?: number;
  erosion?: boolean;
  droplets?: number;
  onProgress?: (stage: string, fraction: number) => void;
}

export interface Zone {
  name: 'headwaters' | 'rapids' | 'riffles' | 'pool' | 'bend' | 'pond' | 'outflow';
  start: number;
  end: number;
}

export interface StreamProfile {
  /** Lowest bed point per cross-section (meters). */
  thalweg: Float32Array;
  /** Floodplain level at the stream edge per cross-section. */
  bank: Float32Array;
  halfWidth: Float32Array;
  /** Valley floor half-width (from the stream center to the foot of the slopes). */
  floodplain: Float32Array;
  reachStarts: number[];
  waterfall: { section: number; drop: number };
  zones: Zone[];
}

export interface Pond {
  x: number;
  z: number;
  radius: number;
  depth: number;
  /** Cross-section the pond joins the stream at. */
  section: number;
  /** Bed level at the deepest point. */
  bottom: number;
}

export interface Spot {
  name: string;
  x: number;
  z: number;
  lookX: number;
  lookZ: number;
}

export interface ValleyMasks {
  /** Distance from the stream's water edge in meters (negative inside the channel). */
  riverDistance: Float32Array;
  /** Nearest stream cross-section per cell. */
  riverSection: Int32Array;
  /** Wetness 0..1 (near water, drainage lines, the pond). */
  wetness: Float32Array;
  /** Flow accumulation 0..1 (gullies). */
  flow: Float32Array;
  /** Sediment deposited (positive) or eroded (negative), meters. */
  sediment: Float32Array;
}

export interface Valley {
  version: number;
  seed: string;
  heightfield: Heightfield;
  /** River control points (for rebuilding the path cheaply elsewhere). */
  controls: Vec2[];
  path: RiverPath;
  profile: StreamProfile;
  pond: Pond;
  masks: ValleyMasks;
  spots: Spot[];
  /** Grass density per cell (filled by the terrain worker, see scatter/grassDensity.ts). */
  grassDensity?: Float32Array;
}

interface ZoneSpec {
  name: Zone['name'];
  from: number;
  to: number;
  slope: number;
  width: number;
  depth: number;
  flood: number;
  dip?: number;
}

const ZONES: ZoneSpec[] = [
  { name: 'headwaters', from: 0.0, to: 0.1, slope: 0.05, width: 6, depth: 0.8, flood: 9 },
  { name: 'rapids', from: 0.1, to: 0.27, slope: 0.028, width: 9, depth: 1.0, flood: 20 },
  { name: 'riffles', from: 0.27, to: 0.43, slope: 0.011, width: 11, depth: 1.0, flood: 38 },
  { name: 'pool', from: 0.43, to: 0.53, slope: 0.0015, width: 15, depth: 1.15, flood: 46, dip: 2.0 },
  { name: 'bend', from: 0.53, to: 0.71, slope: 0.006, width: 13, depth: 1.15, flood: 64 },
  { name: 'pond', from: 0.71, to: 0.8, slope: 0.003, width: 12, depth: 1.1, flood: 72 },
  { name: 'outflow', from: 0.8, to: 1.0, slope: 0.01, width: 10, depth: 1.0, flood: 44 },
];

const WATERFALL_AT = 0.1;
const WATERFALL_DROP = 7;
const SOURCE_ELEVATION = 118;

function zoneBlend(f: number, pick: (z: ZoneSpec) => number, smooth = 0.012): number {
  let sum = 0;
  let weight = 0;
  for (const z of ZONES) {
    const w = smoothstep(z.from - smooth, z.from + smooth, f) * (1 - smoothstep(z.to - smooth, z.to + smooth, f));
    sum += w * pick(z);
    weight += w;
  }
  return weight > 0 ? sum / weight : pick(ZONES[0] as ZoneSpec);
}

export function generateValley(options: ValleyOptions): Valley {
  const seed = String(options.seed);
  const size = options.size ?? 1025;
  const cell = options.cell ?? 1;
  const progress = options.onProgress ?? (() => undefined);
  const rng = createRng(`valley:${seed}`);
  const hf = createHeightfield(size, cell);
  const extent = (size - 1) * cell;
  const half = extent / 2;

  // 1. Stream course: north (−z, high) to south (+z, low), meandering.
  progress('course', 0);
  const meander = createSimplex2(`${seed}:meander`);
  const phase1 = rng.range(0, Math.PI * 2);
  const phase2 = rng.range(0, Math.PI * 2);
  const controls: Vec2[] = [];
  const zStart = -half * 0.93;
  const zEnd = half * 0.98;
  const steps = 15;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const z = lerp(zStart, zEnd, t);
    const amp = half * 0.15;
    const x =
      amp * Math.sin(z / (half * 0.32) + phase1) +
      amp * 0.45 * Math.sin(z / (half * 0.15) + phase2) +
      meander(t * 3.1, 0.5) * amp * 0.35;
    controls.push({ x, z });
  }
  const path = buildRiverPath(controls, 0.5);
  const count = path.count;

  // 2. Longitudinal profile: thalweg, bank level, widths, valley floor width.
  const thalweg = new Float32Array(count);
  const bank = new Float32Array(count);
  const halfWidth = new Float32Array(count);
  const floodplain = new Float32Array(count);
  const widthNoise = createSimplex2(`${seed}:width`);
  const waterfallSection = Math.round(WATERFALL_AT * (count - 1));
  let base = SOURCE_ELEVATION;
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    const slope = zoneBlend(f, (z) => z.slope);
    if (i > 0) base -= slope * path.spacing;
    if (i === waterfallSection) base -= WATERFALL_DROP;
    const width = zoneBlend(f, (z) => z.width) * (1 + 0.15 * widthNoise(i * 0.004, 0));
    const depth = zoneBlend(f, (z) => z.depth);
    const dip = zoneBlend(f, (z) => z.dip ?? 0, 0.03);
    const s = i * path.spacing;
    // Pool–riffle rhythm in the riffle and bend zones: about every six channel widths.
    const rhythm = zoneBlend(f, (z) => (z.name === 'riffles' || z.name === 'bend' ? 1 : 0));
    const undulation = rhythm * 0.35 * Math.sin((2 * Math.PI * s) / (6 * width));
    bank[i] = base + depth;
    thalweg[i] = base - dip * 0.9 + undulation;
    halfWidth[i] = width / 2;
    let flood = zoneBlend(f, (z) => z.flood) * (1 + 0.25 * widthNoise(i * 0.002, 3.7));
    // A narrow gorge around the waterfall.
    flood *= 1 - 0.6 * Math.exp(-((((i - waterfallSection) * path.spacing) / 40) ** 2));
    floodplain[i] = Math.max(halfWidth[i] as number, flood);
  }
  const zones: Zone[] = ZONES.map((z) => ({
    name: z.name,
    start: Math.round(z.from * (count - 1)),
    end: Math.round(z.to * (count - 1)),
  }));

  // 3. Distance from every cell to the stream center line (exact transform on rasterized samples).
  progress('distance', 0.1);
  const n = size * size;
  const seeds = new Uint8Array(n);
  const seedSection = new Int32Array(n).fill(-1);
  for (let i = 0; i < count; i++) {
    const cx = Math.round(((path.points[i * 2] as number) + half) / cell);
    const cz = Math.round(((path.points[i * 2 + 1] as number) + half) / cell);
    if (cx < 0 || cz < 0 || cx >= size || cz >= size) continue;
    const idx = cz * size + cx;
    seeds[idx] = 1;
    if (seedSection[idx] === -1) seedSection[idx] = i;
  }
  const edt = distanceTransform(seeds, size, size);

  // 4. Pond: a basin beside the stream in the pond zone, on the inside of the bend.
  const pondZone = zones.find((z) => z.name === 'pond') as Zone;
  const pondSection = Math.round((pondZone.start + pondZone.end) / 2);
  const curvature = (() => {
    const a = Math.max(0, pondSection - 40);
    const b = Math.min(count - 1, pondSection + 40);
    const ta = [path.tangents[a * 2] as number, path.tangents[a * 2 + 1] as number];
    const tb = [path.tangents[b * 2] as number, path.tangents[b * 2 + 1] as number];
    return (ta[0] as number) * (tb[1] as number) - (ta[1] as number) * (tb[0] as number);
  })();
  const pondSide = curvature >= 0 ? -1 : 1;
  const pondRadius = 19;
  const pondOffset = (halfWidth[pondSection] as number) + pondRadius + 5;
  const px =
    (path.points[pondSection * 2] as number) + (path.normals[pondSection * 2] as number) * pondSide * pondOffset;
  const pz =
    (path.points[pondSection * 2 + 1] as number) +
    (path.normals[pondSection * 2 + 1] as number) * pondSide * pondOffset;
  const pondLevelGuess = (bank[pondSection] as number) - 0.3;
  const pondDepth = 1.9;
  const pond: Pond = {
    x: px,
    z: pz,
    radius: pondRadius,
    depth: pondDepth,
    section: pondSection,
    bottom: pondLevelGuess - pondDepth,
  };
  const linkAx =
    (path.points[pondSection * 2] as number) +
    (path.normals[pondSection * 2] as number) * pondSide * (halfWidth[pondSection] as number) * 0.7;
  const linkAz =
    (path.points[pondSection * 2 + 1] as number) +
    (path.normals[pondSection * 2 + 1] as number) * pondSide * (halfWidth[pondSection] as number) * 0.7;

  // 5. Heights.
  progress('shape', 0.2);
  const mountain = createSimplex2(`${seed}:mountain`);
  const detail = createSimplex2(`${seed}:detail`);
  const floodN = createSimplex2(`${seed}:flood`);
  const riverDistance = new Float32Array(n);
  const riverSection = new Int32Array(n);
  const erosionAllow = new Float32Array(n);
  const h = hf.heights;
  for (let cz = 0; cz < size; cz++) {
    const z = hf.originZ + cz * cell;
    for (let cx = 0; cx < size; cx++) {
      const x = hf.originX + cx * cell;
      const idx = cz * size + cx;
      const seedIdx = edt.nearest[idx] as number;
      let i = seedIdx >= 0 ? (seedSection[seedIdx] as number) : 0;
      if (i < 0) i = 0;
      // Refine to the exact perpendicular distance from the local center-line segment.
      const pxi = path.points[i * 2] as number;
      const pzi = path.points[i * 2 + 1] as number;
      const along = (x - pxi) * (path.tangents[i * 2] as number) + (z - pzi) * (path.tangents[i * 2 + 1] as number);
      const across = (x - pxi) * (path.normals[i * 2] as number) + (z - pzi) * (path.normals[i * 2 + 1] as number);
      const d = Math.abs(along) < path.spacing * 3 ? Math.abs(across) : (edt.distance[idx] as number) * cell;
      riverSection[idx] = i;
      const hw = halfWidth[i] as number;
      const bk = bank[i] as number;
      const depth = bk - (thalweg[i] as number);
      riverDistance[idx] = d - hw;
      let height: number;
      if (d <= hw) {
        height = bk - depth * (1 - Math.pow(d / hw, 2.4));
      } else {
        const t = d - hw;
        const lip = 0.55 * smoothstep(0, 3, t);
        const undulate = fbm(floodN, x, z, { octaves: 3, frequency: 0.03 }) * 0.7 * smoothstep(3, 16, t);
        height = bk + lip + Math.max(0, t - 3) * 0.02 + undulate;
        const flood = (floodplain[i] as number) - hw;
        const u = t - flood;
        const wallBlend = smoothstep(-12, 18, u);
        if (wallBlend > 0) {
          const uu = Math.max(0, u + 12);
          const gorge = 1 + 0.6 * Math.exp(-((((i - waterfallSection) * path.spacing) / 60) ** 2));
          const wall = (150 * (1 - Math.exp(-uu / 170)) + uu * 0.16) * gorge;
          const ridge =
            ridged(mountain, x, z, { octaves: 6, frequency: 0.0042, gain: 0.5 }) * 190 * smoothstep(0, 260, uu);
          const bumps = fbm(detail, x, z, { octaves: 5, frequency: 0.018 }) * 9 * smoothstep(0, 50, uu);
          height += (wall + ridge + bumps) * wallBlend;
        }
        erosionAllow[idx] = smoothstep(8, 40, u);
      }
      // Beyond the source the ground keeps rising; beyond the outflow it keeps falling.
      if (i === 0 && along < 0) height += -along * 0.45 + smoothstep(0, 60, -along) * 8;
      if (i === count - 1 && along > 0) height -= along * 0.01;
      // Pond basin and the shallow link to the stream.
      const pr = Math.hypot(x - px, z - pz);
      if (pr < pondRadius + 7) {
        const basin = pondLevelGuess - pondDepth * (1 - clamp(pr / pondRadius, 0, 1) ** 2);
        const blend = smoothstep(pondRadius - 2, pondRadius + 7, pr);
        height = Math.min(height, lerp(basin, height, blend));
        erosionAllow[idx] = 0;
      }
      const lx = px - linkAx;
      const lz = pz - linkAz;
      const lt = clamp(((x - linkAx) * lx + (z - linkAz) * lz) / (lx * lx + lz * lz), 0, 1);
      const ld = Math.hypot(x - (linkAx + lx * lt), z - (linkAz + lz * lt));
      if (ld < 4.5) height = Math.min(height, lerp(pondLevelGuess - 0.45, height, smoothstep(1.8, 4.5, ld)));
      h[idx] = height;
    }
  }

  // 6. Erosion on the slopes only (the designed channel and floodplain stay exact).
  let sediment: Float32Array = new Float32Array(n);
  if (options.erosion !== false) {
    progress('erosion', 0.4);
    const droplets = options.droplets ?? Math.round(120_000 * (n / (1025 * 1025)));
    sediment = hydraulicErosion(h, size, cell, erosionAllow, rng.fork('erosion'), { droplets }).sediment;
    progress('scree', 0.75);
    thermalErosion(h, size, cell, erosionAllow, 6);
  }

  // 7. Masks.
  progress('masks', 0.85);
  const flow = flowAccumulation(h, size);
  const wetness = new Float32Array(n);
  for (let idx = 0; idx < n; idx++) {
    const rd = riverDistance[idx] as number;
    const near = Math.exp(-Math.max(0, rd) / 9);
    const drain = Math.pow(flow[idx] as number, 3) * 0.85;
    const cx = idx % size;
    const cz = (idx / size) | 0;
    const pr = Math.hypot(hf.originX + cx * cell - px, hf.originZ + cz * cell - pz);
    const pondWet = Math.exp(-Math.max(0, pr - pondRadius) / 7);
    wetness[idx] = clamp(Math.max(near, drain, pondWet), 0, 1);
  }

  // 8. Viewpoints for golden shots (plan 10, Phase 1 "Done when").
  const spot = (name: string, section: number, sideOffset: number, lookBack: number): Spot => {
    const i = clamp(Math.round(section), 0, count - 1);
    const off = (halfWidth[i] as number) + sideOffset;
    const x = (path.points[i * 2] as number) + (path.normals[i * 2] as number) * off;
    const z = (path.points[i * 2 + 1] as number) + (path.normals[i * 2 + 1] as number) * off;
    const j = clamp(i - lookBack, 0, count - 1);
    return { name, x, z, lookX: path.points[j * 2] as number, lookZ: path.points[j * 2 + 1] as number };
  };
  const mid = (name: Zone['name']): number => {
    const z = zones.find((zz) => zz.name === name) as Zone;
    return (z.start + z.end) / 2;
  };
  const spots: Spot[] = [
    spot('waterfall', waterfallSection + 70, 3, 75),
    spot('rapids', mid('rapids'), 3.5, 60),
    spot('riffles', mid('riffles'), 4, 70),
    spot('pool', mid('pool'), 5, 70),
    spot('bend', mid('bend'), 6, 90),
    {
      name: 'pond',
      x: px + (px - linkAx) * 0.0 + (path.tangents[pondSection * 2] as number) * (pondRadius + 8),
      z: pz + (path.tangents[pondSection * 2 + 1] as number) * (pondRadius + 8),
      lookX: px,
      lookZ: pz,
    },
  ];

  progress('done', 1);
  return {
    version: VALLEY_VERSION,
    seed,
    heightfield: hf,
    controls,
    path,
    profile: {
      thalweg,
      bank,
      halfWidth,
      floodplain,
      reachStarts: [waterfallSection],
      waterfall: { section: waterfallSection, drop: WATERFALL_DROP },
      zones,
    },
    pond,
    masks: { riverDistance, riverSection, wetness, flow, sediment },
    spots,
  };
}
