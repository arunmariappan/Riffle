/**
 * Fish populations as cohorts (plan 6.6, D19): per stretch and species, counts in three life stages (fry, juveniles,
 * adults) with each stage's trait statistics. One step per day: growth through the stages, deaths (age, starvation,
 * low oxygen, heat or cold, crowding, predators), spawning in the species' seasons on its spawning ground, and
 * selection on the traits. Recruitment is density-dependent (Beverton–Holt), calibrated per species so that a
 * population settles at its stretch's carrying capacity. Pure TypeScript.
 */
import type { FishDef } from '../../content/schema';
import type { Season } from '../time/clock';
import { cloneStats, mixStats, mutate, offspring, respond, traitStats, type TraitStats } from './genetics';

export const FRY = 0;
export const JUVENILE = 1;
export const ADULT = 2;
export const STAGE_COUNT = 3;

/** Base death rates per year: fry are fragile, juveniles less so; adults by their lifespan. */
const FRY_DEATH = 2.5;
const JUVENILE_DEATH = 0.6;
/** Fry become juveniles after about a quarter year. */
const FRY_YEARS = 0.25;

export interface SpeciesLife {
  id: string;
  maturity: number;
  lifespan: number;
  fecundity: number;
  seasons: Season[];
  ground: 'gravel' | 'plants' | 'pond';
  migrates: boolean;
  oxygenMin: number;
  temperature: [number, number];
  /** Adults (and juveniles) per m² at full suitability and good food. */
  density: number;
  diet: string[];
  heritability: number;
  mutation: number;
  length: [number, number];
  baseMean: number[];
  baseVariance: number[];
  comfortSpeed: number;
  pondOnly: boolean;
  /** Small enough for kingfishers and mahseer to eat. */
  prey: boolean;
  /** Eats other fish. */
  predator: boolean;
  /** Density constant for Beverton–Holt recruitment (set so the population settles at K). */
  crowding: number;
}

/** Typical density at full suitability by adult size (big fish need much more room). */
function densityFor(length: number, pondOnly: boolean): number {
  if (pondOnly) return 0.02;
  if (length > 0.4) return 0.012;
  if (length > 0.1) return 0.5;
  if (length > 0.05) return 0.8;
  return 2.5;
}

export function adultDeathRate(life: { lifespan: number; maturity: number }): number {
  return 1.2 / Math.max(0.5, life.lifespan - life.maturity);
}

export function juvenileRate(life: { maturity: number }): number {
  return 1 / Math.max(0.15, life.maturity - FRY_YEARS);
}

/** Lifetime offspring per adult that reach adulthood, with no crowding (R0). */
export function basicReproduction(life: { fecundity: number; lifespan: number; maturity: number }): number {
  const rf = 1 / FRY_YEARS;
  const rj = juvenileRate(life);
  const sFry = rf / (rf + FRY_DEATH);
  const sJuv = rj / (rj + JUVENILE_DEATH);
  return 0.5 * life.fecundity * sFry * sJuv * (1 / adultDeathRate(life));
}

export function speciesLife(def: FishDef): SpeciesLife {
  const g = def.genes;
  const genes = [g.bodySize, g.swimStrength, g.preferredFlow, g.brightness, g.shyness];
  const life = {
    id: def.id,
    maturity: def.life.maturityYears,
    lifespan: def.life.lifespanYears,
    fecundity: def.life.fecundity,
    seasons: def.spawning.seasons,
    ground: def.spawning.ground,
    migrates: def.spawning.migrates,
    oxygenMin: def.habitat.oxygenMin,
    temperature: def.habitat.temperature,
    density: densityFor(def.body.length[1], def.habitat.pondOnly),
    diet: def.diet,
    heritability: g.heritability,
    mutation: g.mutation,
    length: def.body.length,
    baseMean: genes.map((x) => x.mean),
    baseVariance: genes.map((x) => x.sd * x.sd),
    comfortSpeed: def.behavior.comfortCurrent,
    pondOnly: def.habitat.pondOnly,
    prey: def.body.length[1] < 0.2,
    predator: def.diet.includes('fish'),
    crowding: 1,
  };
  // Typical spawning conditions are about two thirds of ideal.
  life.crowding = Math.max(1, basicReproduction(life) * 0.65 - 1);
  return life;
}

export interface Cohort {
  /** Fry, juveniles, adults. */
  count: number[];
  traits: TraitStats[];
  /** Koi pattern seeds in this population (inherited, mixed at spawning). */
  patterns: number[];
}

export function newCohort(
  life: SpeciesLife,
  adults: number,
  juveniles = adults * 0.6,
  patterns: number[] = [],
): Cohort {
  const sd = life.baseVariance.map(Math.sqrt);
  return {
    count: [juveniles * 0.3, juveniles, adults],
    traits: [0, 1, 2].map(() => traitStats(life.baseMean, sd)),
    patterns: [...patterns],
  };
}

export function cloneCohort(c: Cohort): Cohort {
  return { count: [...c.count], traits: c.traits.map(cloneStats), patterns: [...c.patterns] };
}

/** Juveniles and adults (what you see swimming). */
export function swimming(c: Cohort): number {
  return (c.count[JUVENILE] as number) + (c.count[ADULT] as number);
}

/** What a cohort faces today. */
export interface CohortDay {
  /** Carrying capacity here (juveniles + adults). */
  capacity: number;
  /** The species' fish per capacity across the valley (recruitment crowding), or undefined to use this stretch's. */
  crowding?: number;
  /** Extra death rate per year from stress (oxygen, temperature, starvation). */
  stress: number;
  /** Death rate per year from predators (prey species only). */
  predation: number;
  /** 0..1 how good conditions are for spawning today (season × ground × condition); 0 outside the season. */
  spawning: number;
  /** Selection gradients on the five traits (per year), or null when evolution is off. */
  gradients: number[] | null;
  mutation: number;
  /** How strongly mates prefer bright partners (1 = normal). */
  mateChoice: number;
  /** Days in this species' spawning season (spreads the year's eggs over it). */
  seasonDays: number;
}

/** One day (dt in years) of a cohort. Returns the eggs laid. */
export function stepCohort(
  c: Cohort,
  life: SpeciesLife,
  day: CohortDay,
  dt: number,
  rngPatterns?: (pool: number[]) => number[],
): number {
  const K = Math.max(1e-6, day.capacity);
  const N = swimming(c);
  // Crowding: the valley-wide ratio, or this stretch's when it is fuller (capped, so a few fish passing through
  // water that doesn't suit them aren't wiped out).
  // Migrants (mahseer spawning upstream) only count the valley-wide ratio.
  const local = life.migrates && day.crowding !== undefined ? 0 : Math.min(3, N / K);
  const crowd = Math.max(0, Math.max(day.crowding ?? 0, local) - 1) * 0.5;
  const rf = 1 / FRY_YEARS;
  const rj = juvenileRate(life);
  const mFry = FRY_DEATH + day.stress * 1.5 + day.predation * 1.2;
  const mJuv = JUVENILE_DEATH + day.stress + day.predation + crowd * 0.5;
  const mAdult = adultDeathRate(life) + day.stress + day.predation * 0.6 + crowd * 0.8;
  const [fry, juv, adult] = c.count as [number, number, number];

  // Spawning: the year's eggs spread over the season, fewer when crowded (Beverton–Holt).
  let eggs = 0;
  if (day.spawning > 0 && adult > 0.01) {
    const bh = 1 / (1 + life.crowding * (day.crowding ?? N / K));
    eggs = ((adult * 0.5 * life.fecundity) / Math.max(10, day.seasonDays)) * day.spawning * bh * dt * 365;
  }

  const toJuv = fry * rf * dt;
  const toAdult = juv * rj * dt;
  const nextFry = Math.max(0, fry + eggs - fry * mFry * dt - toJuv);
  const nextJuv = Math.max(0, juv + toJuv - juv * mJuv * dt - toAdult);
  const nextAdult = Math.max(0, adult + toAdult - adult * mAdult * dt);

  // Traits follow the fish: newborns inherit from the adults; each stage takes in the one before.
  const T = c.traits as [TraitStats, TraitStats, TraitStats];
  if (eggs > 0) {
    const kids = offspring(T[ADULT], life.heritability, day.mateChoice);
    T[FRY] = mixStats(T[FRY], Math.max(0, fry - toJuv), kids, eggs);
    if (c.patterns.length && rngPatterns && eggs > fry * 0.05) c.patterns = rngPatterns(c.patterns);
  }
  if (toJuv > 0) T[JUVENILE] = mixStats(T[JUVENILE], Math.max(0, juv - toAdult), T[FRY], toJuv);
  if (toAdult > 0) T[ADULT] = mixStats(T[ADULT], adult, T[JUVENILE], toAdult);
  if (day.gradients) {
    for (const s of [JUVENILE, ADULT]) respond(T[s] as TraitStats, day.gradients, life.heritability, dt);
  }
  for (const s of [FRY, JUVENILE, ADULT])
    mutate(T[s] as TraitStats, life.baseVariance, life.mutation * day.mutation, dt);
  c.count = [nextFry, nextJuv, nextAdult];
  return eggs;
}

/** Moves a share of a cohort's juveniles and adults into another cohort (dispersal, migration). */
export function moveFish(
  from: Cohort,
  to: Cohort,
  share: number,
  stages: readonly number[] = [JUVENILE, ADULT],
): number {
  let moved = 0;
  for (const s of stages) {
    const n = (from.count[s] as number) * share;
    if (n <= 0) continue;
    to.traits[s] = mixStats(to.traits[s] as TraitStats, to.count[s] as number, from.traits[s] as TraitStats, n);
    to.count[s] = (to.count[s] as number) + n;
    from.count[s] = (from.count[s] as number) - n;
    moved += n;
  }
  if (from.patterns.length && to.patterns.length === 0 && moved > 0) to.patterns = [...from.patterns];
  return moved;
}

/** Adds released fish (the builder) to a cohort as adults with their own traits. */
export function addAdults(c: Cohort, count: number, traits: TraitStats): void {
  c.traits[ADULT] = mixStats(c.traits[ADULT] as TraitStats, c.count[ADULT] as number, traits, count);
  c.count[ADULT] = (c.count[ADULT] as number) + count;
}

export { cloneStats };
