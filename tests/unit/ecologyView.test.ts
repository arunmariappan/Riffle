import { describe, expect, it } from 'vitest';
import {
  FishView,
  VIEW_DEFAULTS,
  outOfSight,
  schoolGenes,
  type ViewSpecies,
  type ViewStretch,
} from '../../src/sim/ecology/view';
import { traitStats } from '../../src/sim/ecology/genetics';
import { createRng } from '../../src/sim/rng';

/** A straight stream of 50 m stretches along z, each with the same fish. */
function stream(n: number, counts: number[]): ViewStretch[] {
  return Array.from({ length: n }, (_, id) => ({ id, x: 0, z: id * 50, counts }));
}

const SPECIES: ViewSpecies[] = [
  { share: 0.3, school: 12 },
  { share: 1, school: 3 },
];

function shown(view: FishView, stretch: number, species?: number): number {
  return view.shown
    .filter((s) => s.stretch === stretch && (species === undefined || s.species === species))
    .reduce((a, s) => a + s.count, 0);
}

describe('the two-level hand-off (plan D19)', () => {
  it('shows fish in the stretches near the camera and folds them back when you leave', () => {
    const view = new FishView();
    const st = stream(20, [100, 3]);
    const first = view.plan({ x: 0, z: 0 }, st, SPECIES);
    expect(first.remove).toHaveLength(0);
    expect([...view.active].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(shown(view, 0, 0)).toBe(30);
    expect(shown(view, 0, 1)).toBe(3);
    // Walk down the stream: stretches come into view ahead and fold back behind, never near you.
    let removedNear = 0;
    for (let z = 0; z <= 900; z += 10) {
      const o = view.plan({ x: 0, z }, st, SPECIES);
      for (const r of o.remove) if (Math.abs(st[r.stretch]!.z - z) < VIEW_DEFAULTS.leave) removedNear++;
      for (const a of o.add) expect(Math.abs(st[a.stretch]!.z - z)).toBeLessThan(VIEW_DEFAULTS.enter);
    }
    expect(removedNear).toBe(0);
    expect(view.active.has(0)).toBe(false);
    expect(shown(view, 0)).toBe(0);
    expect(view.active.has(18)).toBe(true);
  });

  it("doesn't flicker at the edge (hysteresis)", () => {
    const view = new FishView();
    const st = stream(5, [40, 0]);
    view.plan({ x: 0, z: 0 }, st, SPECIES);
    let changes = 0;
    for (let k = 0; k < 20; k++) {
      const o = view.plan({ x: 0, z: k % 2 ? 6 : -6 }, st, SPECIES);
      changes += o.add.length + o.remove.length;
    }
    expect(changes).toBe(0);
  });

  it('follows the cohorts: more fish when the population grows, fewer when it falls', () => {
    const view = new FishView();
    view.plan({ x: 0, z: 0 }, stream(1, [40, 0]), SPECIES);
    expect(shown(view, 0, 0)).toBe(12);
    const grow = view.plan({ x: 0, z: 0 }, stream(1, [120, 0]), SPECIES);
    expect(grow.add.length).toBeGreaterThan(0);
    expect(shown(view, 0, 0)).toBe(36);
    // A small change does nothing (no churn).
    expect(view.plan({ x: 0, z: 0 }, stream(1, [125, 0]), SPECIES).add).toHaveLength(0);
    const fall = view.plan({ x: 0, z: 0 }, stream(1, [20, 0]), SPECIES);
    expect(fall.remove.length).toBeGreaterThan(0);
    expect(shown(view, 0, 0)).toBeLessThan(20);
  });

  it('keeps within the budget and shows rare big fish', () => {
    const view = new FishView();
    const st = stream(3, [10_000, 1]);
    view.plan({ x: 0, z: 50 }, st, SPECIES, { ...VIEW_DEFAULTS, budget: 60, perStretch: 1000 });
    const total = view.shown.reduce((a, s) => a + s.count, 0);
    expect(total).toBeLessThanOrEqual(63);
    expect(shown(view, 1, 1)).toBe(1);
  });

  it('forgets schools that could not be placed, and tries again later', () => {
    const view = new FishView();
    const o = view.plan({ x: 0, z: 0 }, stream(1, [0, 2]), SPECIES);
    expect(o.add).toHaveLength(1);
    view.failed(o.add[0]!.school);
    expect(view.plan({ x: 0, z: 0 }, stream(1, [0, 2]), SPECIES).add).toHaveLength(1);
    view.placed(view.shown[0]!.school, 1);
    expect(shown(view, 0, 1)).toBe(1);
  });

  it('lets new fish appear only out of sight', () => {
    const cam = { x: 0, z: 0, dirX: 0, dirZ: 1 };
    expect(outOfSight(0, 10, cam, 30)).toBe(false); // right in front
    expect(outOfSight(0, 40, cam, 30)).toBe(true); // far away
    expect(outOfSight(0, -15, cam, 30)).toBe(true); // behind you
    expect(outOfSight(0, -4, cam, 30)).toBe(false); // at your feet
    expect(outOfSight(15, 0, cam, 30)).toBe(false); // to the side, in view
  });

  it('draws fish from the cohort statistics, juveniles smaller and younger', () => {
    const rng = createRng('genes');
    const adultTraits = traitStats([0.7, 0.8, 0.5, 0.9, 0.3], [0.05, 0.05, 0.05, 0.05, 0.05]);
    const juvenileTraits = traitStats([0.7, 0.6, 0.5, 0.5, 0.3], [0.05, 0.05, 0.05, 0.05, 0.05]);
    const fish = schoolGenes(
      { juveniles: 50, adults: 50, juvenileTraits, adultTraits, maturity: 2, lifespan: 8 },
      2000,
      rng,
    );
    const adults = fish.filter((f) => f.age >= 2);
    const young = fish.filter((f) => f.age < 2);
    expect(adults.length / fish.length).toBeGreaterThan(0.45);
    expect(adults.length / fish.length).toBeLessThan(0.55);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(adults.map((f) => f.genes.brightness))).toBeCloseTo(0.9, 1);
    expect(mean(young.map((f) => f.genes.brightness))).toBeCloseTo(0.5, 1);
    expect(mean(young.map((f) => f.genes.bodySize))).toBeLessThan(mean(adults.map((f) => f.genes.bodySize)) * 0.8);
  });
});
