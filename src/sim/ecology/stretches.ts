/**
 * The stream as stretches of about 50 m, plus the pond (plan 6.6, D19): the unit the ecology works in. Each stretch
 * summarizes its water from the solved flow (depth, current, turbulence, shelter), its shade, its spawning grounds,
 * and how well it suits each fish species. Pure TypeScript.
 */
import { FLOW, FLOW_STRIDE } from '../flow/layout';

export interface Stretch {
  id: number;
  /** First and last flow cross-section (pond: the section it joins at). */
  first: number;
  last: number;
  /** Habitat zone name (rapids, riffles, pool, bend, pond, …). */
  zone: string;
  pond: boolean;
  /** Wetted area, m². */
  area: number;
  /** Mean and maximum depth, m. */
  meanDepth: number;
  maxDepth: number;
  /** Area-weighted mean current, m/s, and the share of the area that is fast (> 0.6 m/s) or slow (< 0.2 m/s). */
  meanSpeed: number;
  fastShare: number;
  slowShare: number;
  /** Mean foam/turbulence 0..1 (riffles, wakes). */
  turbulence: number;
  /** Mean shelter 0..1 (calm water behind stones). */
  shelter: number;
  /** Canopy shade 0..1 over the water. */
  shade: number;
  /** Spawning grounds 0..1: clean gravel (riffles, pool tails) and plants (slow margins, the pond). */
  gravel: number;
  plants: number;
  /** Neighbors along the stream (−1 at the ends); the pond links to the stretch it joins. */
  upstream: number;
  downstream: number;
  /** Center, for distances to the camera. */
  x: number;
  z: number;
  /** How well it suits each species (by depth and current), 0..1, in species order. */
  suitability: number[];
}

export interface HabitatRange {
  depth: [number, number];
  flow: [number, number];
}

/** One wet cell's water, as the stretch builder sees it. */
export interface CellWater {
  depth: number;
  speed: number;
  foam: number;
  shelter: number;
}

export interface StretchSource {
  /** Cross-sections and cells across; cell size along and across, m. */
  ns: number;
  nn: number;
  ds: number;
  dn: number;
  cell(i: number, j: number): CellWater;
  /** Center of a section (x, z). */
  center(i: number): [number, number];
  zoneOf(i: number): string;
  /** Canopy shade over a section, 0..1. */
  shade(i: number): number;
  /** The pond, if any: its area, mean and max depth, the section it joins, its center. */
  pond: { area: number; meanDepth: number; maxDepth: number; section: number; x: number; z: number } | null;
  /** Stretches never span a reach break (the waterfall). */
  reachStarts: readonly number[];
}

function soft(v: number, lo: number, hi: number, margin: number): number {
  if (v < lo) return Math.max(0, 1 - (lo - v) / margin);
  if (v > hi) return Math.max(0, 1 - (v - hi) / margin);
  return 1;
}

/** Splits the stream into stretches of about `length` meters and summarizes each one. */
export function buildStretches(src: StretchSource, species: readonly HabitatRange[], length = 50): Stretch[] {
  const per = Math.max(4, Math.round(length / src.ds));
  const bounds: [number, number][] = [];
  const breaks = [0, ...src.reachStarts, src.ns];
  for (let r = 0; r < breaks.length - 1; r++) {
    const a = breaks[r] as number;
    const b = breaks[r + 1] as number;
    const count = Math.max(1, Math.round((b - a) / per));
    for (let k = 0; k < count; k++)
      bounds.push([a + Math.floor(((b - a) * k) / count), a + Math.floor(((b - a) * (k + 1)) / count) - 1]);
  }
  const cellArea = src.ds * src.dn;
  const stretches: Stretch[] = bounds.map(([first, last], id) => {
    let area = 0;
    let depthSum = 0;
    let maxDepth = 0;
    let speedSum = 0;
    let fast = 0;
    let slow = 0;
    let foam = 0;
    let shelter = 0;
    let gravel = 0;
    let plants = 0;
    const suit = new Array<number>(species.length).fill(0);
    for (let i = first; i <= last; i++) {
      for (let j = 0; j < src.nn; j++) {
        const c = src.cell(i, j);
        if (c.depth < 0.03) continue;
        area += cellArea;
        depthSum += c.depth * cellArea;
        maxDepth = Math.max(maxDepth, c.depth);
        speedSum += c.speed * cellArea;
        if (c.speed > 0.6) fast += cellArea;
        if (c.speed < 0.2) slow += cellArea;
        foam += c.foam * cellArea;
        shelter += c.shelter * cellArea;
        // Clean gravel: shallow, moving water. Plants: slow, shallow margins.
        if (c.depth < 0.7 && c.speed > 0.25 && c.speed < 1.2) gravel += cellArea;
        if (c.depth < 0.8 && c.speed < 0.15) plants += cellArea;
        species.forEach((h, k) => {
          suit[k]! += soft(c.depth, h.depth[0], h.depth[1], 0.25) * soft(c.speed, h.flow[0], h.flow[1], 0.2) * cellArea;
        });
      }
    }
    const mid = Math.round((first + last) / 2);
    const [x, z] = src.center(mid);
    let shade = 0;
    for (let i = first; i <= last; i++) shade += src.shade(i);
    const a = Math.max(area, 1e-6);
    return {
      id,
      first,
      last,
      zone: src.zoneOf(mid),
      pond: false,
      area,
      meanDepth: depthSum / a,
      maxDepth,
      meanSpeed: speedSum / a,
      fastShare: fast / a,
      slowShare: slow / a,
      turbulence: foam / a,
      shelter: shelter / a,
      shade: shade / (last - first + 1),
      gravel: gravel / a,
      plants: plants / a,
      upstream: id - 1,
      downstream: id + 1 < bounds.length ? id + 1 : -1,
      x,
      z,
      suitability: suit.map((s) => s / a),
    };
  });
  // Reach breaks: water flows down the waterfall, but fish can't swim up it.
  for (const s of stretches) if (src.reachStarts.includes(s.first)) s.upstream = -1;
  if (src.pond) {
    const p = src.pond;
    const join = stretches.find((s) => p.section >= s.first && p.section <= s.last) ?? stretches[stretches.length - 1];
    stretches.push({
      id: stretches.length,
      first: p.section,
      last: p.section,
      zone: 'pond',
      pond: true,
      area: p.area,
      meanDepth: p.meanDepth,
      maxDepth: p.maxDepth,
      meanSpeed: 0,
      fastShare: 0,
      slowShare: 1,
      turbulence: 0,
      shelter: 0,
      shade: 0.1,
      gravel: 0,
      plants: 0.6,
      upstream: join?.id ?? -1,
      downstream: -1,
      x: p.x,
      z: p.z,
      // The pond is still and deep: suitability by its depth alone.
      suitability: species.map(
        (h) => soft(p.meanDepth, h.depth[0], h.depth[1], 0.4) * soft(0, h.flow[0], h.flow[1], 0.2),
      ),
    });
  }
  return stretches;
}

/** A stretch made by hand (tests and experiments). */
export function makeStretch(id: number, partial: Partial<Stretch> & { suitability: number[] }): Stretch {
  return {
    id,
    first: id * 100,
    last: id * 100 + 99,
    zone: 'riffles',
    pond: false,
    area: 600,
    meanDepth: 0.6,
    maxDepth: 1.2,
    meanSpeed: 0.5,
    fastShare: 0.3,
    slowShare: 0.3,
    turbulence: 0.2,
    shelter: 0.1,
    shade: 0.3,
    gravel: 0.4,
    plants: 0.2,
    upstream: id - 1,
    downstream: id + 1,
    x: 0,
    z: id * 50,
    ...partial,
  };
}

/** What `flowStretchSource` needs: the flow solver's cells and the valley's stream description. */
export interface FlowStretchInput {
  layout: { ns: number; nn: number; ds: number; dn: number };
  /** FLOW_STRIDE floats per cell (section-major), as the flow worker publishes them. */
  cells: Float32Array;
  /** Stream center points (x, z per section). */
  points: ArrayLike<number>;
  zones: readonly { name: string; start: number; end: number }[];
  reachStarts: readonly number[];
  shade: (section: number) => number;
  pond: StretchSource['pond'];
}

/** A stretch source over the solved flow (the engine's stream). */
export function flowStretchSource(input: FlowStretchInput): StretchSource {
  const { layout, cells, points, zones } = input;
  return {
    ns: layout.ns,
    nn: layout.nn,
    ds: layout.ds,
    dn: layout.dn,
    cell(i, j) {
      const o = (i * layout.nn + j) * FLOW_STRIDE;
      return {
        depth: cells[o + FLOW.depth] ?? 0,
        speed: Math.hypot(cells[o + FLOW.velX] ?? 0, cells[o + FLOW.velZ] ?? 0),
        foam: cells[o + FLOW.foam] ?? 0,
        shelter: cells[o + FLOW.shelter] ?? 0,
      };
    },
    center: (i) => [points[i * 2] ?? 0, points[i * 2 + 1] ?? 0],
    zoneOf: (i) => zones.find((z) => i >= z.start && i <= z.end)?.name ?? 'stream',
    shade: input.shade,
    pond: input.pond,
    reachStarts: input.reachStarts,
  };
}

/** Index of the stretch holding a cross-section (the pond excluded), or −1. */
export function stretchOfSection(stretches: readonly Stretch[], section: number): number {
  let lo = 0;
  let hi = stretches.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = stretches[mid] as Stretch;
    if (s.pond || section < s.first) hi = mid - 1;
    else if (section > s.last) lo = mid + 1;
    else return mid;
  }
  return -1;
}
