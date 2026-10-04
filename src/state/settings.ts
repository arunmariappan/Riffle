/**
 * Everything the control panels set (plan 6.8): water, wind, trees, time and weather, and the ecosystem (6.6). One
 * plain object, so it is saved as-is, compared in tests and applied to the world in one place. Pure TypeScript.
 */
import { CALM_BREEZE, type WindState } from '../sim/wind/windField';
import { WEATHER_KINDS, type WeatherKind } from '../sim/weather/weather';
import { TIME_SPEEDS } from '../sim/time/clock';

export interface WaterSettings {
  /** m³/s. */
  discharge: number;
  /** Speed multiplier. */
  speed: number;
  /** Level offset, m. */
  level: number;
  /** 0 murky .. 1 crystal clear. */
  clarity: number;
}

export interface TreeSettings {
  flexibility: number;
  sway: number;
  flutter: number;
  /** Response delay (how heavy the branches feel). */
  delay: number;
  /** Per-species flexibility multipliers (overrides), by content id. */
  species: Record<string, number>;
}

export interface TimeSettings {
  /** Simulated seconds per real second. */
  timeScale: number;
  paused: boolean;
  /** Lock the season looks to this day of year (time of day still runs). */
  lockedDay: number | null;
}

export interface WeatherSettings {
  mode: 'auto' | WeatherKind;
}

/** The Ecosystem panel (plan 6.6). */
export interface EcosystemSettings {
  /** Traits respond to selection over the generations. */
  evolution: boolean;
  /** Mutation rate multiplier. */
  mutation: number;
  /** Predator pressure 0..1 (kingfisher and mahseer). Low lets the fish grow more vivid. */
  predators: number;
  /** Population caps: the carrying capacities' multiplier. */
  caps: number;
  /** The kingfisher hunts in the shallows. */
  kingfisher: boolean;
  /** Safety net: a species never quite dies out (a few fish come down from upstream). */
  restock: boolean;
  /** Rain fills the catchment and raises the stream after a delay (and the seasons change its base flow). */
  rainRaisesStream: boolean;
}

export interface ValleySettings {
  water: WaterSettings;
  wind: WindState;
  trees: TreeSettings;
  time: TimeSettings;
  weather: WeatherSettings;
  ecosystem: EcosystemSettings;
}

export function defaultEcosystem(): EcosystemSettings {
  return {
    evolution: true,
    mutation: 1,
    predators: 0.5,
    caps: 1,
    kingfisher: true,
    restock: true,
    rainRaisesStream: true,
  };
}

export function defaultSettings(): ValleySettings {
  return {
    water: { discharge: 4, speed: 1, level: 0, clarity: 0.9 },
    wind: { ...CALM_BREEZE },
    trees: { flexibility: 1, sway: 1, flutter: 1, delay: 1, species: {} },
    time: { timeScale: TIME_SPEEDS.minuteIsHour, paused: false, lockedDay: null },
    weather: { mode: 'auto' },
    ecosystem: defaultEcosystem(),
  };
}

/** Slider ranges, shared by the panels and the validation of loaded files. */
export const LIMITS = {
  discharge: [0.5, 16],
  speed: [0.2, 3],
  level: [-0.5, 1],
  clarity: [0, 1],
  windSpeed: [0, 25],
  gustiness: [0, 1.5],
  turbulence: [0, 1.5],
  flexibility: [0.2, 3],
  sway: [0, 3],
  flutter: [0, 3],
  delay: [0.3, 3],
  speciesFlex: [0.3, 3],
  mutation: [0, 3],
  predators: [0, 1],
  caps: [0.25, 3],
} as const satisfies Record<string, readonly [number, number]>;

function num(v: unknown, fallback: number, [lo, hi]: readonly [number, number]): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/** Fills missing values with defaults and clamps everything into range (files from older versions, hand edits). */
export function normalizeSettings(raw: unknown): ValleySettings {
  const d = defaultSettings();
  const r = (raw ?? {}) as Partial<Record<keyof ValleySettings, Record<string, unknown>>>;
  const w = r.water ?? {};
  const wi = r.wind ?? {};
  const t = r.trees ?? {};
  const ti = r.time ?? {};
  const we = r.weather ?? {};
  const ec = r.ecosystem ?? {};
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  let dirX = num(wi.dirX, d.wind.dirX, [-1, 1]);
  let dirZ = num(wi.dirZ, d.wind.dirZ, [-1, 1]);
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6) {
    dirX = d.wind.dirX;
    dirZ = d.wind.dirZ;
  } else {
    dirX /= len;
    dirZ /= len;
  }
  const species: Record<string, number> = {};
  if (t.species && typeof t.species === 'object')
    for (const [k, v] of Object.entries(t.species as Record<string, unknown>))
      if (typeof v === 'number') species[k] = num(v, 1, LIMITS.speciesFlex);
  const mode = we.mode;
  return {
    water: {
      discharge: num(w.discharge, d.water.discharge, LIMITS.discharge),
      speed: num(w.speed, d.water.speed, LIMITS.speed),
      level: num(w.level, d.water.level, LIMITS.level),
      clarity: num(w.clarity, d.water.clarity, LIMITS.clarity),
    },
    wind: {
      dirX,
      dirZ,
      speed: num(wi.speed, d.wind.speed, LIMITS.windSpeed),
      gustiness: num(wi.gustiness, d.wind.gustiness, LIMITS.gustiness),
      turbulence: num(wi.turbulence, d.wind.turbulence, LIMITS.turbulence),
    },
    trees: {
      flexibility: num(t.flexibility, d.trees.flexibility, LIMITS.flexibility),
      sway: num(t.sway, d.trees.sway, LIMITS.sway),
      flutter: num(t.flutter, d.trees.flutter, LIMITS.flutter),
      delay: num(t.delay, d.trees.delay, LIMITS.delay),
      species,
    },
    time: {
      timeScale: num(ti.timeScale, d.time.timeScale, [0, TIME_SPEEDS.seasonLapse]),
      paused: typeof ti.paused === 'boolean' ? ti.paused : d.time.paused,
      lockedDay: typeof ti.lockedDay === 'number' ? num(ti.lockedDay, 0, [0, 364]) : null,
    },
    weather: {
      mode: mode === 'auto' || WEATHER_KINDS.includes(mode as WeatherKind) ? (mode as WeatherSettings['mode']) : 'auto',
    },
    ecosystem: {
      evolution: bool(ec.evolution, d.ecosystem.evolution),
      mutation: num(ec.mutation, d.ecosystem.mutation, LIMITS.mutation),
      predators: num(ec.predators, d.ecosystem.predators, LIMITS.predators),
      caps: num(ec.caps, d.ecosystem.caps, LIMITS.caps),
      kingfisher: bool(ec.kingfisher, d.ecosystem.kingfisher),
      restock: bool(ec.restock, d.ecosystem.restock),
      rainRaisesStream: bool(ec.rainRaisesStream, d.ecosystem.rainRaisesStream),
    },
  };
}

/** Reads a value at a dotted path ("water.discharge", "trees.species.bamboo"). */
export function getSetting(s: ValleySettings, path: string): unknown {
  let v: unknown = s;
  for (const k of path.split('.')) v = (v as Record<string, unknown> | undefined)?.[k];
  return v;
}

/** Returns a copy with one value changed at a dotted path. */
export function withSetting(s: ValleySettings, path: string, value: unknown): ValleySettings {
  const copy = JSON.parse(JSON.stringify(s)) as ValleySettings;
  const keys = path.split('.');
  let o = copy as unknown as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i] as string;
    if (typeof o[k] !== 'object' || o[k] === null) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1] as string] = value;
  return copy;
}
