/**
 * The valley's ecosystem (plan 6.6): the whole stream as stretches with their environment and fish cohorts, the
 * weather and the catchment, stepped in fixed simulated hours (weather, water) and days (environment, fish).
 * Reproducible: the same seed and the same inputs give the same state, which `hash()` checks. Pure TypeScript; it runs
 * in the ecology worker and in Node tests.
 */
import { createRng, restoreRng, type Rng } from '../rng';
import { seasonOf, seasonWeights } from '../time/clock';
import { WeatherSystem, Catchment } from '../weather/weatherSystem';
import { WEATHER_LOOKS, type WeatherKind } from '../weather/weather';
import { initialEnv, stepEnvironment, type StretchEnv } from './environment';
import type { Stretch } from './stretches';
import {
  ADULT,
  JUVENILE,
  FRY,
  addAdults,
  moveFish,
  newCohort,
  stepCohort,
  swimming,
  type Cohort,
  type SpeciesLife,
} from './cohorts';
import { mixKoiPatterns, selectionGradients, traitStats, type TraitStats } from './genetics';

export interface EcologySettings {
  /** Traits respond to selection. */
  evolution: boolean;
  /** Mutation rate multiplier. */
  mutation: number;
  /** Predator pressure 0..1 (kingfisher and mahseer); low lets the fish grow more vivid (plan D20). */
  predators: number;
  /** Carrying capacity multiplier (population caps). */
  caps: number;
  /** The kingfisher hunts in the shallows. */
  kingfisher: boolean;
  /** Safety net: a species never dies out completely (a few fish come down from upstream). */
  restock: boolean;
}

export const DEFAULT_ECOLOGY: EcologySettings = {
  evolution: true,
  mutation: 1,
  predators: 0.5,
  caps: 1,
  kingfisher: true,
  restock: true,
};

export interface EcologyOptions {
  seed: string;
  stretches: Stretch[];
  species: SpeciesLife[];
  /** Simulated seconds since 1 January, year 0 (SimClock.seconds). */
  startSeconds: number;
  settings?: Partial<EcologySettings>;
  /** How full each stretch starts, as a share of its carrying capacity. */
  fill?: number;
  /** Follow the weather on its own (true), or have it set from outside (the Time & weather panel). */
  autoWeather?: boolean;
}

/** One point of the graphs (plan 6.6: populations, biodiversity, water quality, brightness over time). */
export interface EcologyPoint {
  /** Days since year 0. */
  day: number;
  populations: number[];
  biodiversity: number;
  oxygen: number;
  oxygenMin: number;
  waterTemp: number;
  turbidity: number;
  discharge: number;
  brightness: number[];
  swimStrength: number[];
}

export interface EcologySnapshot extends EcologyPoint {
  year: number;
  dayOfYear: number;
  weather: WeatherKind;
  /** Fry per species. */
  fry: number[];
  /** Adult trait means per species (5 traits). */
  traits: number[][];
}

/** One stretch's fish, for the view (individual fish near the camera). */
export interface StretchCohorts {
  id: number;
  x: number;
  z: number;
  counts: number[];
  cohorts: {
    juveniles: number;
    adults: number;
    juvenileTraits: TraitStats;
    adultTraits: TraitStats;
    /** Koi pattern seeds (inherited). */
    patterns: number[];
  }[];
}

const DAY = 86400;
const MAX_HISTORY = 2600;

/** Body mass (kg) of a fish of a given length (m). */
function mass(length: number): number {
  return 12 * length ** 3;
}

function soft(v: number, lo: number, hi: number, margin: number): number {
  if (v < lo) return Math.max(0, 1 - (lo - v) / margin);
  if (v > hi) return Math.max(0, 1 - (v - hi) / margin);
  return 1;
}

export class Ecology {
  stretches: Stretch[];
  readonly species: SpeciesLife[];
  readonly cohorts: Cohort[][];
  env: StretchEnv[];
  readonly weather: WeatherSystem;
  readonly catchment = new Catchment();
  settings: EcologySettings;
  /** Simulated seconds since year 0. */
  seconds: number;
  /** When false, the weather is set from outside (`setWeather`) instead of following the seasons. */
  autoWeather: boolean;
  history: EcologyPoint[] = [];
  private rng: Rng;
  private dayIndex: number;
  private hourCarry = 0;
  private dayRain = 0;
  private dayCloud = 0;
  private dayHours = 0;
  private readonly seasonDays: number[];
  private readonly initialTotals: number[];

  constructor(options: EcologyOptions) {
    this.stretches = options.stretches;
    this.species = options.species;
    this.settings = { ...DEFAULT_ECOLOGY, ...options.settings };
    this.seconds = options.startSeconds;
    this.dayIndex = Math.floor(this.seconds / DAY);
    this.autoWeather = options.autoWeather ?? true;
    this.rng = createRng(`ecology:${options.seed}`);
    this.weather = new WeatherSystem(this.rng.fork('weather'));
    this.env = this.stretches.map(() => initialEnv());
    this.seasonDays = this.species.map((sp) => {
      let n = 0;
      for (let d = 0; d < 365; d++) if (sp.seasons.includes(seasonOf(d))) n++;
      return n;
    });
    // Settle the water before stocking the fish, so capacities use a realistic environment.
    for (let k = 0; k < 20; k++)
      this.env = this.stretches.map((s, i) =>
        stepEnvironment(s, this.env[i] as StretchEnv, this.climate(0, 0.3), 0, 0, 0),
      );
    const fill = options.fill ?? 0.7;
    const koiPatterns = Array.from({ length: 12 }, () => this.rng.next());
    this.cohorts = this.stretches.map((s, i) =>
      this.species.map((sp, p) =>
        newCohort(
          sp,
          this.capacity(i, p) * fill * 0.65,
          this.capacity(i, p) * fill * 0.35,
          sp.pondOnly ? koiPatterns : [],
        ),
      ),
    );
    this.initialTotals = this.species.map((_, p) => this.total(p));
  }

  get days(): number {
    return this.seconds / DAY;
  }

  get dayOfYear(): number {
    const d = this.days % 365;
    return d < 0 ? d + 365 : d;
  }

  get year(): number {
    return Math.floor(this.days / 365);
  }

  private climate(
    rain: number,
    cloud: number,
  ): {
    dayOfYear: number;
    cloudCover: number;
    rain: number;
    turbidity: number;
    flowRatio: number;
  } {
    const day = this.dayOfYear;
    return {
      dayOfYear: day,
      cloudCover: cloud,
      rain,
      turbidity: this.catchment.turbidity,
      flowRatio: this.catchment.ratio(day),
    };
  }

  /** Sets the weather from outside (the panel's manual choice). */
  setWeather(kind: WeatherKind, hours = 6): void {
    this.weather.state = kind;
    this.weather.hoursLeft = hours;
  }

  /** Replaces the stretches' water (a new flow solve), keeping the fish. Ids must match. */
  setStretches(stretches: Stretch[]): void {
    if (stretches.length === this.stretches.length) this.stretches = stretches;
  }

  /** Carrying capacity of a stretch for a species (juveniles + adults) under today's conditions. */
  capacity(s: number, p: number): number {
    const st = this.stretches[s] as Stretch;
    const sp = this.species[p] as SpeciesLife;
    const env = this.env[s] as StretchEnv;
    if (sp.pondOnly && !st.pond) return 0;
    const suit = (st.suitability[p] ?? 0) * (st.pond && !sp.pondOnly ? 0.6 : 1);
    // Cold and heat thin a stretch's capacity only a little (fish slow down rather than move out).
    const tFit = soft(env.waterTemp, sp.temperature[0], sp.temperature[1], 10);
    const productivity = this.supply(sp, env, st);
    return (
      st.area * suit * sp.density * (0.4 + 0.6 * Math.min(1.2, productivity)) * (0.6 + 0.4 * tFit) * this.settings.caps
    );
  }

  /** Food on offer for a species in a stretch (0..~1.5), from its diet. */
  private supply(sp: SpeciesLife, env: StretchEnv, st: Stretch, preyDensity = 0): number {
    let sum = 0;
    for (const d of sp.diet) {
      if (d === 'insects') sum += env.insects;
      else if (d === 'algae') sum += env.algae * 1.2;
      else if (d === 'plants') sum += 0.3 + st.plants * 0.8;
      else if (d === 'detritus') sum += env.nutrients * 0.8 + 0.2;
      else if (d === 'fish') sum += Math.min(1, preyDensity * 2);
    }
    return sum / Math.max(1, sp.diet.length) + 0.25;
  }

  /** Juveniles and adults of a species in the whole valley. */
  total(p: number): number {
    return this.cohorts.reduce((sum, row) => sum + swimming(row[p] as Cohort), 0);
  }

  /** Advances the ecosystem by simulated seconds (fixed hourly and daily steps inside). */
  advance(seconds: number): number {
    let days = 0;
    let left = seconds;
    while (left > 0) {
      const step = Math.min(left, 3600 - this.hourCarry);
      this.hourCarry += step;
      this.seconds += step;
      left -= step;
      if (this.hourCarry >= 3600 - 1e-6) {
        this.hourCarry = 0;
        this.hour();
      }
      const d = Math.floor(this.seconds / DAY);
      while (this.dayIndex < d) {
        this.dayIndex++;
        this.daily();
        days++;
      }
    }
    return days;
  }

  private hour(): void {
    const day = this.dayOfYear;
    if (this.autoWeather) this.weather.step(1, day);
    else this.weather.hoursLeft = Math.max(1, this.weather.hoursLeft);
    const look = WEATHER_LOOKS[this.weather.state];
    this.catchment.step(1, look.rain, day);
    this.dayRain += look.rain;
    this.dayCloud += look.cloudCover;
    this.dayHours++;
  }

  private daily(): void {
    const hours = Math.max(1, this.dayHours);
    const climate = this.climate(this.dayRain, this.dayCloud / hours);
    this.dayRain = 0;
    this.dayCloud = 0;
    this.dayHours = 0;
    const dt = 1 / 365;
    const w = seasonWeights(climate.dayOfYear);
    const mahseer = this.species.findIndex((sp) => sp.predator);
    // Environment first (it depends on yesterday's fish).
    this.env = this.stretches.map((st, s) => {
      let biomass = 0;
      let grazers = 0;
      this.species.forEach((sp, p) => {
        const c = this.cohorts[s]?.[p] as Cohort;
        const kg = swimming(c) * mass((sp.length[0] + sp.length[1]) / 2);
        biomass += kg;
        if (sp.diet.includes('algae')) grazers += kg;
      });
      const a = Math.max(1, st.area);
      const litter = st.shade * (w.autumn * 0.6 + w.winter * 0.15) + 0.02;
      return stepEnvironment(st, this.env[s] as StretchEnv, climate, biomass / a, grazers / a, litter);
    });
    // Fish. Recruitment crowding is valley-wide per species (fish spawn on their grounds, then spread).
    const predators = this.settings.predators;
    const crowding = this.species.map((_, p) => {
      let n = 0;
      let k = 0;
      this.stretches.forEach((__, s) => {
        n += swimming(this.cohorts[s]?.[p] as Cohort);
        k += this.capacity(s, p);
      });
      return k > 0 ? n / k : 2;
    });
    this.stretches.forEach((st, s) => {
      const env = this.env[s] as StretchEnv;
      const mahseerDensity = mahseer >= 0 ? swimming(this.cohorts[s]?.[mahseer] as Cohort) / Math.max(1, st.area) : 0;
      let preyDensity = 0;
      this.species.forEach((sp, p) => {
        if (sp.prey) preyDensity += swimming(this.cohorts[s]?.[p] as Cohort) / Math.max(1, st.area);
      });
      this.species.forEach((sp, p) => {
        const c = this.cohorts[s]?.[p] as Cohort;
        const K = this.capacity(s, p);
        const N = swimming(c);
        // Food per fish: the valley-wide crowding, or this stretch's when it is fuller (migrants spawning away from
        // their home water count the valley's).
        const local = K > 1e-6 ? Math.min(3, N / K) : 3;
        const ratio = sp.migrates ? (crowding[p] as number) : Math.max(crowding[p] as number, local);
        const food = Math.min(1.5, (this.supply(sp, env, st, preyDensity) * 1.4) / (0.4 + ratio));
        const tLo = sp.temperature[0];
        const tHi = sp.temperature[1];
        // Stress: too little oxygen at dawn, water far colder or warmer than the species likes, hunger.
        const stress =
          Math.max(0, sp.oxygenMin - env.oxygenMin) * 1.5 +
          Math.max(0, env.waterTemp - (tHi + 2)) * 0.6 +
          Math.max(0, tLo - 7 - env.waterTemp) * 0.3 +
          Math.max(0, 0.5 - food) * 2;
        const bright = c.traits[ADULT]?.mean[3] ?? 0.5;
        let predation = 0;
        if (sp.prey) {
          const visible = 0.6 + bright * 0.8;
          if (this.settings.kingfisher) predation += predators * 0.8 * (st.meanDepth < 1.2 ? 1 : 0.3) * visible;
          predation += predators * Math.min(0.8, mahseerDensity * 60) * visible;
        }
        const inSeason = sp.seasons.includes(seasonOf(climate.dayOfYear));
        let ground =
          sp.ground === 'gravel'
            ? Math.min(1, st.gravel * 3)
            : sp.ground === 'plants'
              ? Math.min(1, st.plants * 2 + (st.pond ? 0.4 : 0))
              : st.pond
                ? 1
                : 0;
        if (sp.migrates && st.gravel < 0.15) ground = 0;
        const condition = (0.4 + 0.6 * Math.min(1, food)) * soft(env.waterTemp, tLo, tHi, 3);
        stepCohort(
          c,
          sp,
          {
            capacity: K,
            crowding: crowding[p] as number,
            stress,
            predation,
            spawning: inSeason ? ground * condition : 0,
            gradients: this.settings.evolution
              ? selectionGradients({
                  meanSpeed: st.meanSpeed,
                  comfortSpeed: sp.comfortSpeed,
                  fastShare: st.fastShare,
                  predation: sp.prey ? Math.min(1, predation / 1.2) : 0,
                  food,
                })
              : null,
            mutation: this.settings.mutation,
            mateChoice: 1,
            seasonDays: this.seasonDays[p] as number,
          },
          dt,
          (pool) => mixKoiPatterns(pool, this.rng, 0.03 * this.settings.mutation),
        );
      });
    });
    this.disperse(climate.flowRatio, w.monsoon, w.autumn);
    if (this.settings.restock) this.restock();
    if (this.dayIndex % 7 === 0) this.record();
  }

  /** Fish spread to better neighboring water; mahseer run upstream in monsoon floods and back down in autumn. */
  private disperse(flowRatio: number, monsoon: number, autumn: number): void {
    this.species.forEach((sp, p) => {
      this.stretches.forEach((st, s) => {
        const c = this.cohorts[s]?.[p] as Cohort;
        if (swimming(c) < 1e-3) return;
        const own = st.suitability[p] ?? 0;
        for (const n of [st.upstream, st.downstream]) {
          if (n < 0) continue;
          const nb = this.stretches[n] as Stretch;
          if (sp.pondOnly !== nb.pond && (sp.pondOnly || nb.pond)) {
            // Only pond fish live in the pond; small fish may wander into it a little.
            if (sp.pondOnly || sp.length[1] > 0.2) continue;
          }
          const theirs = nb.suitability[p] ?? 0;
          if (theirs <= 0) continue;
          const share = 0.004 * (theirs / Math.max(0.05, own + theirs));
          moveFish(c, this.cohorts[n]?.[p] as Cohort, share);
        }
        if (sp.migrates) {
          // Upstream to the gravel when the monsoon raises the water; back down to deep pools in autumn.
          if (monsoon > 0.5 && flowRatio > 1.25 && st.upstream >= 0 && st.gravel < 0.3)
            moveFish(c, this.cohorts[st.upstream]?.[p] as Cohort, 0.04, [ADULT]);
          if (autumn > 0.5 && st.downstream >= 0 && st.meanDepth < 0.9)
            moveFish(c, this.cohorts[st.downstream]?.[p] as Cohort, 0.03, [ADULT, JUVENILE]);
          // The young hatch on the gravel and drift down to the deep water they will live in.
          if (st.downstream >= 0 && own < 0.2)
            moveFish(c, this.cohorts[st.downstream]?.[p] as Cohort, 0.05, [JUVENILE]);
        }
      });
    });
  }

  /** A species that has nearly vanished gets a few fish back in its best stretch (the plan's seed-stock floor). */
  private restock(): void {
    this.species.forEach((sp, p) => {
      const floor = Math.max(2, (this.initialTotals[p] as number) * 0.02);
      if (this.total(p) >= floor) return;
      let best = -1;
      let bestK = 0;
      this.stretches.forEach((_, s) => {
        const k = this.capacity(s, p);
        if (k > bestK) {
          bestK = k;
          best = s;
        }
      });
      if (best < 0) return;
      const c = this.cohorts[best]?.[p] as Cohort;
      const sd = sp.baseVariance.map(Math.sqrt);
      addAdults(c, floor, traitStats(c.traits[ADULT]?.mean ?? sp.baseMean, sd));
    });
  }

  /** Adds fish you released (as adults) to the nearest stretch's cohort. */
  addFish(x: number, z: number, p: number, count: number, traits?: TraitStats): void {
    const s = this.stretchAt(x, z);
    const sp = this.species[p];
    if (s < 0 || !sp) return;
    const c = this.cohorts[s]?.[p] as Cohort;
    addAdults(c, count, traits ?? traitStats(sp.baseMean, sp.baseVariance.map(Math.sqrt)));
  }

  /** Takes fish out of the nearest stretch's cohort (a released school taken back with undo). */
  removeFish(x: number, z: number, p: number, count: number): void {
    const s = this.stretchAt(x, z);
    const c = s >= 0 ? this.cohorts[s]?.[p] : undefined;
    if (!c) return;
    let left = count;
    for (const stage of [ADULT, JUVENILE]) {
      const take = Math.min(left, c.count[stage] as number);
      c.count[stage] = (c.count[stage] as number) - take;
      left -= take;
    }
  }

  /** Moves the clock without simulating (time set backwards, or a jump too long to simulate). */
  jumpTo(seconds: number): void {
    this.seconds = seconds;
    this.dayIndex = Math.floor(seconds / DAY);
    this.hourCarry = 0;
  }

  /** Per stretch and species: the fish and trait statistics the view draws individual fish from (plan D19). */
  cohortView(): StretchCohorts[] {
    return this.stretches.map((st, s) => ({
      id: st.id,
      x: st.x,
      z: st.z,
      counts: this.species.map((_, p) => swimming(this.cohorts[s]?.[p] as Cohort)),
      cohorts: this.species.map((_, p) => {
        const c = this.cohorts[s]?.[p] as Cohort;
        return {
          juveniles: c.count[JUVENILE] as number,
          adults: c.count[ADULT] as number,
          juvenileTraits: c.traits[JUVENILE] as TraitStats,
          adultTraits: c.traits[ADULT] as TraitStats,
          patterns: c.patterns.slice(0, 16),
        };
      }),
    }));
  }

  /** The stretch nearest a point (by its center). */
  stretchAt(x: number, z: number): number {
    let best = -1;
    let bestD = Infinity;
    this.stretches.forEach((st, s) => {
      const d = (st.x - x) ** 2 + (st.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    });
    return best;
  }

  private point(): EcologyPoint {
    const populations = this.species.map((_, p) => this.total(p));
    const sum = populations.reduce((a, b) => a + b, 0);
    let h = 0;
    for (const n of populations) if (n > 0 && sum > 0) h -= (n / sum) * Math.log(n / sum);
    let area = 0;
    let oxygen = 0;
    let temp = 0;
    let oxygenMin = Infinity;
    this.stretches.forEach((st, s) => {
      const env = this.env[s] as StretchEnv;
      area += st.area;
      oxygen += env.oxygen * st.area;
      temp += env.waterTemp * st.area;
      oxygenMin = Math.min(oxygenMin, env.oxygenMin);
    });
    const trait = (p: number, t: number) => {
      let n = 0;
      let m = 0;
      for (const row of this.cohorts) {
        const c = row[p] as Cohort;
        const a = c.count[ADULT] as number;
        n += a;
        m += a * (c.traits[ADULT]?.mean[t] ?? 0);
      }
      return n > 0 ? m / n : 0;
    };
    return {
      day: Math.floor(this.days),
      populations,
      biodiversity: h,
      oxygen: area > 0 ? oxygen / area : 0,
      oxygenMin: Number.isFinite(oxygenMin) ? oxygenMin : 0,
      waterTemp: area > 0 ? temp / area : 0,
      turbidity: this.catchment.turbidity,
      discharge: this.catchment.discharge(this.dayOfYear),
      brightness: this.species.map((_, p) => trait(p, 3)),
      swimStrength: this.species.map((_, p) => trait(p, 1)),
    };
  }

  private record(): void {
    this.history.push(this.point());
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  snapshot(): EcologySnapshot {
    const p = this.point();
    return {
      ...p,
      year: this.year,
      dayOfYear: this.dayOfYear,
      weather: this.weather.state,
      fry: this.species.map((_, i) =>
        this.cohorts.reduce((s, row) => s + ((row[i] as Cohort).count[FRY] as number), 0),
      ),
      traits: this.species.map((_, i) =>
        [0, 1, 2, 3, 4].map((t) => {
          let n = 0;
          let m = 0;
          for (const row of this.cohorts) {
            const c = row[i] as Cohort;
            const a = c.count[ADULT] as number;
            n += a;
            m += a * (c.traits[ADULT]?.mean[t] ?? 0);
          }
          return n > 0 ? m / n : 0;
        }),
      ),
    };
  }

  /** The state as plain data (saving). The stretches and species come from the valley, not the save. */
  toJSON(): unknown {
    return {
      v: 1,
      seconds: this.seconds,
      dayIndex: this.dayIndex,
      hourCarry: this.hourCarry,
      day: [this.dayRain, this.dayCloud, this.dayHours],
      rng: this.rng.state(),
      weatherRng: this.weather.rng.state(),
      weather: [this.weather.state, this.weather.hoursLeft],
      catchment: [this.catchment.storage, this.catchment.turbidity],
      settings: this.settings,
      autoWeather: this.autoWeather,
      env: this.env,
      cohorts: this.cohorts,
      history: this.history,
    };
  }

  serialize(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(this.toJSON()));
  }

  /** Restores a saved state into an ecology built for the same valley (same stretches and species). */
  restore(bytes: Uint8Array): void {
    const d = JSON.parse(new TextDecoder().decode(bytes)) as {
      seconds: number;
      dayIndex: number;
      hourCarry: number;
      day: [number, number, number];
      rng: [number, number, number, number];
      weatherRng: [number, number, number, number];
      weather: [WeatherKind, number];
      catchment: [number, number];
      settings: EcologySettings;
      autoWeather: boolean;
      env: StretchEnv[];
      cohorts: Cohort[][];
      history: EcologyPoint[];
    };
    if (d.cohorts.length !== this.cohorts.length || d.cohorts[0]?.length !== this.cohorts[0]?.length)
      throw new Error('The saved ecology belongs to a different valley');
    this.seconds = d.seconds;
    this.dayIndex = d.dayIndex;
    this.hourCarry = d.hourCarry;
    [this.dayRain, this.dayCloud, this.dayHours] = d.day;
    this.rng = restoreRng(d.rng);
    this.weather.rng = restoreRng(d.weatherRng);
    [this.weather.state, this.weather.hoursLeft] = d.weather;
    [this.catchment.storage, this.catchment.turbidity] = d.catchment;
    this.settings = { ...DEFAULT_ECOLOGY, ...d.settings };
    this.autoWeather = d.autoWeather;
    this.env = d.env;
    d.cohorts.forEach((row, s) => row.forEach((c, p) => ((this.cohorts[s] as Cohort[])[p] = c)));
    this.history = d.history;
  }

  /** A short fingerprint of the whole state (the reproducibility test). */
  hash(): string {
    const text = JSON.stringify(this.toJSON(), (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

export { JUVENILE, ADULT };
