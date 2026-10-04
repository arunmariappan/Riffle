/**
 * Simple genetics (plan 6.6, D20): five traits per fish, each a 0..1 value with a population mean and variance.
 * Each trait's mean shifts by the breeder's equation, change = heritability × selection, where the selection on a
 * trait (its gradient β) comes from the local environment: fast water favors strong swimmers, predators favor
 * camouflage and shyness, mates favor brightness, scarce food favors small, bold fish. Small mutations keep the
 * variance alive. Koi patterns mix between parents. Pure TypeScript.
 */
import type { Rng } from '../rng';
import type { FishGenes } from '../boids/school';

export const TRAITS = ['bodySize', 'swimStrength', 'preferredFlow', 'brightness', 'shyness'] as const;
export type Trait = (typeof TRAITS)[number];
export const TRAIT_COUNT = TRAITS.length;

export interface TraitStats {
  mean: number[];
  variance: number[];
}

export function traitStats(mean: readonly number[], sd: readonly number[]): TraitStats {
  return { mean: [...mean], variance: sd.map((s) => s * s) };
}

export function cloneStats(s: TraitStats): TraitStats {
  return { mean: [...s.mean], variance: [...s.variance] };
}

/** The breeder's equation: the response to selection is heritability × the selection differential. */
export function breedersEquation(heritability: number, selectionDifferential: number): number {
  return heritability * selectionDifferential;
}

/** What the environment asks of the fish in a stretch, for the selection gradients. */
export interface SelectionContext {
  /** Mean current, m/s, and the current the species is at home in. */
  meanSpeed: number;
  comfortSpeed: number;
  /** The share of the stretch that is fast water. */
  fastShare: number;
  /** 0..1 how hard predators (kingfisher, mahseer) hunt this species here. */
  predation: number;
  /** Food supply / demand (1 = enough). */
  food: number;
}

/**
 * Selection gradients β (per year) on each trait in a context. Viability selection only; mate choice for brightness is
 * applied at spawning (`MATE_PREFERENCE`).
 */
export function selectionGradients(ctx: SelectionContext): number[] {
  // Strong swimmers hold station and feed in fast water; strength costs food, so it slowly fades in still water.
  const overSpeed = Math.max(0, ctx.meanSpeed - ctx.comfortSpeed * 0.6);
  const swim = 1.6 * overSpeed * (0.5 + ctx.fastShare) - 0.12;
  // Preferring the water you live in.
  const flow = 1.2 * (Math.min(1, ctx.meanSpeed / Math.max(0.2, ctx.comfortSpeed * 2.5)) - 0.5);
  // Bigger fish escape predators but need more food.
  const size = 0.4 * ctx.predation - 0.6 * Math.max(0, 1 - ctx.food) + 0.05;
  // Predators find bright fish more easily.
  const bright = -2.6 * ctx.predation;
  // Shy fish survive predators; bold fish feed better when food is short.
  const shy = 1.2 * ctx.predation - 0.5 * Math.max(0, 1 - ctx.food) - 0.1;
  return [size, swim, flow, bright, shy];
}

/** Mate choice favors brighter fish (applied to each new generation, plan D20). */
export const MATE_PREFERENCE: readonly number[] = [0.05, 0, 0, 2, 0];

/**
 * Moves trait means by selection over `years` (Lande: Δmean = h² · variance · β per year). Means stay inside 0..1:
 * the response slows near the ends.
 */
export function respond(stats: TraitStats, gradients: readonly number[], heritability: number, years: number): void {
  for (let i = 0; i < TRAIT_COUNT; i++) {
    const m = stats.mean[i] as number;
    const edge = Math.max(0.05, 4 * m * (1 - m));
    const delta = heritability * (stats.variance[i] as number) * (gradients[i] as number) * years * edge;
    stats.mean[i] = Math.min(0.995, Math.max(0.005, m + delta));
  }
}

/**
 * Variance drifts back toward a mutation–selection balance: mutation adds `mutation²` per generation-year, and it never
 * runs away above the species' founding variance × 2.
 */
export function mutate(stats: TraitStats, base: readonly number[], mutation: number, years: number): void {
  for (let i = 0; i < TRAIT_COUNT; i++) {
    const v = stats.variance[i] as number;
    const target = Math.max(1e-4, (base[i] as number) * 0.6 + mutation * mutation * 4);
    stats.variance[i] = Math.min((base[i] as number) * 2, v + (target - v) * Math.min(1, years * 0.5));
  }
}

/** Mixes two groups' trait statistics (fish moving between stretches or stages). */
export function mixStats(a: TraitStats, na: number, b: TraitStats, nb: number): TraitStats {
  const n = na + nb;
  if (n <= 1e-9) return cloneStats(a);
  const out: TraitStats = { mean: [], variance: [] };
  for (let i = 0; i < TRAIT_COUNT; i++) {
    const ma = a.mean[i] as number;
    const mb = b.mean[i] as number;
    const m = (ma * na + mb * nb) / n;
    // Pooled variance plus the spread between the two groups' means.
    const v =
      ((a.variance[i] as number) * na + (b.variance[i] as number) * nb) / n + (na * nb * (ma - mb) ** 2) / (n * n);
    out.mean.push(m);
    out.variance.push(v);
  }
  return out;
}

/** Offspring of a group of parents: their means plus the response to mate choice, their variance. */
export function offspring(parents: TraitStats, heritability: number, mateChoice: number): TraitStats {
  const kids = cloneStats(parents);
  respond(
    kids,
    MATE_PREFERENCE.map((g) => g * mateChoice),
    heritability,
    1,
  );
  return kids;
}

/** One fish's genes drawn from a group's statistics. */
export function sampleGenes(stats: TraitStats, rng: Rng): FishGenes {
  const g = (i: number) =>
    Math.min(1, Math.max(0, (stats.mean[i] as number) + rng.normal() * Math.sqrt(stats.variance[i] as number)));
  return { bodySize: g(0), swimStrength: g(1), preferredFlow: g(2), brightness: g(3), shyness: g(4) };
}

/**
 * Koi patterns are inherited: each new pattern seed comes from two parents' seeds (a blend with a little mutation), so
 * the pond's patterns drift and recombine over generations.
 */
export function mixKoiPatterns(pool: readonly number[], rng: Rng, mutation = 0.03, size = pool.length): number[] {
  if (pool.length === 0) return [];
  const out: number[] = [];
  for (let k = 0; k < size; k++) {
    const a = pool[rng.int(0, pool.length)] as number;
    const b = pool[rng.int(0, pool.length)] as number;
    // Pattern seeds pick koi varieties by range, so blend within the nearer parent's variety most of the time.
    const t = rng.next() < 0.7 ? rng.range(0, 0.35) : rng.range(0.35, 0.65);
    let v = a + (b - a) * t + rng.normal() * mutation;
    v -= Math.floor(v);
    out.push(v);
  }
  return out;
}
