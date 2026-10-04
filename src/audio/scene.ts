/**
 * What the valley sounds like where you are (plan 6.9), as plain numbers: how the stream's water mixes rapids, riffle
 * and pool sounds, where the sliding river emitters sit, which birds, cicadas and frogs are about at this hour and
 * season, what your feet are on, and how much the water muffles the world when you dive. Pure TypeScript, unit-tested;
 * `NatureAudio` turns it into sound.
 */
import type { Noise } from './dsp/core';
import type { CallKind, Surface } from './dsp/calls';

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface RiverMix {
  rapids: number;
  riffle: number;
  pool: number;
  /** Loudness from how fast and broken the water is. */
  gain: number;
}

/** The stream's sound at a cross-section from its mean current (m/s), foam (0..1) and depth (m). */
export function riverMix(speed: number, foam: number, depth: number): RiverMix {
  if (depth < 0.02) return { rapids: 0, riffle: 0, pool: 0, gain: 0 };
  const rapids = Math.min(1, smoothstep(0.9, 1.9, speed) + foam * 0.5 * smoothstep(0.6, 1.4, speed));
  const pool = 1 - smoothstep(0.12, 0.5, speed);
  const riffle = Math.max(0, 1 - rapids - pool) + foam * 0.3 * (1 - rapids);
  const sum = rapids + riffle + pool || 1;
  return {
    rapids: rapids / sum,
    riffle: riffle / sum,
    pool: pool / sum,
    // Still water is nearly silent; broken, fast water is loud.
    gain: Math.min(1.6, 0.12 + speed * 0.55 + foam * 0.6),
  };
}

/**
 * Where the river emitters sit (plan 6.9: a pool of emitters that slide along the river to the points nearest you):
 * cross-section positions spread up- and downstream of the one nearest you, moving continuously as you walk.
 */
export function emitterSections(nearest: number, sections: number, count: number, spacing: number): number[] {
  const out: number[] = [];
  const span = (count - 1) * spacing;
  // Keep the spread inside the stream near its ends instead of piling up at the last section.
  const start = Math.min(Math.max(0, nearest - span / 2), Math.max(0, sections - 1 - span));
  for (let k = 0; k < count; k++) out.push(Math.min(sections - 1, start + k * spacing));
  return out;
}

export interface Ambience {
  /** Songbird calls per minute around you. */
  birds: number;
  /** Whistling thrush songs per minute (dawn and dusk, along the stream). */
  thrush: number;
  /** Cicada songs per minute (hot afternoons). */
  cicadas: number;
  /** Frog croaks per minute (monsoon nights, near water). */
  frogs: number;
}

export interface AmbienceInput {
  hour: number;
  /** Season weights. */
  season: { winter: number; spring: number; premonsoon: number; monsoon: number; autumn: number };
  /** Air temperature, °C. */
  airTemp: number;
  /** Rain now, mm/h. */
  rain: number;
  /** Wind speed, m/s. */
  wind: number;
  /** 0..1 how close the water is (frogs). */
  nearWater: number;
}

/** Who is singing at this hour and season, and how much. */
export function ambienceLevels(a: AmbienceInput): Ambience {
  const h = a.hour;
  const s = a.season;
  const bump = (center: number, width: number) => Math.exp(-(((h - center) / width) ** 2));
  const day = smoothstep(5.2, 6.5, h) * (1 - smoothstep(18.8, 19.8, h));
  const night = 1 - smoothstep(4.5, 6, h) + smoothstep(18.5, 20, h);
  // Rain and strong wind quiet the birds.
  const calm = (1 - smoothstep(2, 20, a.rain) * 0.85) * (1 - smoothstep(8, 20, a.wind) * 0.7);
  const breeding = 0.6 + s.spring * 0.6 + s.premonsoon * 0.4 + s.monsoon * 0.1 - s.winter * 0.3;
  const chorus = bump(6.3, 1.1) * 2.2 + bump(18, 0.9) * 1.1;
  const birds = Math.max(0, (day * 1.2 + chorus) * breeding * calm * 4);
  const thrush = Math.max(0, (bump(6, 0.9) * 1.6 + bump(18.4, 0.7)) * calm * (0.7 + s.spring * 0.5) * 1.5);
  const hot = smoothstep(21, 29, a.airTemp);
  const cicadas =
    hot *
    smoothstep(9.5, 11.5, h) *
    (1 - smoothstep(17.5, 19, h)) *
    (s.premonsoon + s.monsoon * 0.8 + s.spring * 0.3) *
    (1 - smoothstep(3, 15, a.rain)) *
    6;
  const frogs =
    night *
    (s.monsoon + s.premonsoon * 0.3) *
    (0.5 + smoothstep(0.5, 8, a.rain) * 0.8) *
    (0.3 + 0.7 * a.nearWater) *
    30;
  return { birds, thrush, cicadas, frogs };
}

export interface AmbienceEvent {
  kind: CallKind;
}

/** Turns the levels into calls at random moments (a Poisson process per kind), so nothing repeats on a timer. */
export class AmbienceScheduler {
  private readonly clocks: Record<'birds' | 'thrush' | 'cicadas' | 'frogs', number>;

  constructor(private readonly noise: Noise) {
    this.clocks = { birds: this.wait(), thrush: this.wait(), cicadas: this.wait(), frogs: this.wait() };
  }

  private wait(): number {
    return -Math.log(1 - this.noise.next() + 1e-12);
  }

  /** Advances by `dt` seconds; returns the calls that start now. */
  step(dt: number, levels: Ambience): AmbienceEvent[] {
    const out: AmbienceEvent[] = [];
    const kinds: [keyof typeof this.clocks, CallKind][] = [
      ['birds', 'songbird'],
      ['thrush', 'thrush'],
      ['cicadas', 'cicada'],
      ['frogs', 'frog'],
    ];
    for (const [key, kind] of kinds) {
      this.clocks[key] -= (levels[key] / 60) * dt;
      // At most a few per step (a frog chorus can be dense).
      for (let k = 0; k < 4 && this.clocks[key] < 0; k++) {
        this.clocks[key] += this.wait();
        out.push({ kind });
      }
      if (this.clocks[key] < 0) this.clocks[key] = this.wait();
    }
    return out;
  }
}

export interface GroundInput {
  /** Water over your feet, m. */
  waterDepth: number;
  /** Meters from the stream's edge. */
  riverDistance: number;
  /** 1 − normal.y. */
  slope: number;
  /** 0..1 dampness of the ground. */
  wetness: number;
  /** 0..1 forest cover (leaf litter). */
  forest: number;
  /** 0..1 how wet the rain has left the ground. */
  rainWet: number;
}

/** What your feet are on (plan 6.9: gravel, moss, mud, leaf litter, shallow water…), from the terrain's layers. */
export function footstepSurface(g: GroundInput): Surface {
  if (g.waterDepth > 0.03) return 'water';
  if (g.slope > 0.5) return 'rock';
  if (g.riverDistance < 3.5) return 'gravel';
  if (g.rainWet > 0.5 && g.forest < 0.5) return 'mud';
  if (g.forest > 0.5) return g.wetness > 0.55 ? 'moss' : 'leaves';
  if (g.wetness > 0.75) return 'moss';
  return 'grass';
}

/** How water muffles the world when your head is under it (plan 6.9): low-pass cutoff (Hz) and loudness. */
export function underwaterFilter(depth: number): { cutoff: number; gain: number } {
  if (depth <= 0) return { cutoff: 20000, gain: 1 };
  const k = Math.min(1, depth / 2);
  return { cutoff: 900 - 550 * k, gain: 0.75 - 0.25 * k };
}

/** What the rain lands on around you: leaves under trees, the water nearby, rock and open ground otherwise. */
export function rainShares(canopy: number, water: number): { leaves: number; water: number; rock: number } {
  const leaves = Math.min(1, canopy * 1.2);
  const w = Math.min(1, water) * (1 - leaves * 0.5);
  const rock = Math.max(0.1, 1 - leaves - w);
  const sum = leaves + w + rock;
  return { leaves: leaves / sum, water: w / sum, rock: rock / sum };
}
