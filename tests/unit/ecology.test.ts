import { describe, expect, it } from 'vitest';
import { Ecology } from '../../src/sim/ecology/ecology';
import { adultDeathRate, type SpeciesLife } from '../../src/sim/ecology/cohorts';
import {
  breedersEquation,
  mixKoiPatterns,
  mixStats,
  respond,
  selectionGradients,
  traitStats,
} from '../../src/sim/ecology/genetics';
import { buildStretches, type CellWater } from '../../src/sim/ecology/stretches';
import { oxygenSaturation } from '../../src/sim/ecology/environment';
import { WeatherSystem, Catchment } from '../../src/sim/weather/weatherSystem';
import { createRng } from '../../src/sim/rng';
import { seasonOf } from '../../src/sim/time/clock';
import { testValley, lives, fishDefs, speciesIndex } from './valleyFixture';
import { realValleyStretches } from './realValley';

const YEAR = 365 * 86400;

function generations(life: SpeciesLife, n: number): number {
  return Math.ceil((life.maturity + 0.5 / adultDeathRate(life)) * n);
}

describe('ecosystem (Phase 6)', () => {
  it('is reproducible: the same seed and inputs give the same valley after a year', () => {
    const run = (seed: string, predators = 0.5) => {
      const eco = new Ecology({
        seed,
        stretches: testValley(),
        species: lives,
        startSeconds: 95 * 86400,
        settings: { predators },
      });
      eco.advance(YEAR);
      return eco.hash();
    };
    const a = run('same');
    expect(run('same')).toBe(a);
    expect(run('other')).not.toBe(a);
    expect(run('same', 0.2)).not.toBe(a);
  });

  it('stays balanced for 10 years: no runaway populations or extinctions', () => {
    const eco = new Ecology({
      seed: 'balance',
      stretches: testValley(),
      species: lives,
      startSeconds: 0,
      settings: { restock: false },
    });
    const start = eco.snapshot().populations;
    for (let y = 1; y <= 10; y++) {
      eco.advance(YEAR);
      const now = eco.snapshot().populations;
      now.forEach((n, p) => {
        expect(n, `${lives[p]!.id} in year ${y}`).toBeGreaterThan(start[p]! * 0.25);
        expect(n, `${lives[p]!.id} in year ${y}`).toBeLessThan(start[p]! * 3);
        expect(n).toBeGreaterThan(1);
      });
    }
  });

  it('in fast water, swim strength rises over 20 generations; in slow water it does not', () => {
    const b = speciesIndex('denison-barb');
    const barb = [lives[b]!];
    const defs = [fishDefs[b]!];
    const years = generations(barb[0]!, 20);
    const change = (kind: 'fast' | 'slow') => {
      const eco = new Ecology({ seed: 'swim', stretches: testValley(kind, defs), species: barb, startSeconds: 0 });
      const before = eco.snapshot().swimStrength[0]!;
      eco.advance(years * YEAR);
      return eco.snapshot().swimStrength[0]! - before;
    };
    const fast = change('fast');
    const slow = change('slow');
    expect(fast).toBeGreaterThan(0.1);
    expect(slow).toBeLessThan(0.02);
  });

  it('with low predator pressure, color brightness rises over 20 generations (and falls under heavy pressure)', () => {
    const b = speciesIndex('denison-barb');
    const barb = [lives[b]!];
    const defs = [fishDefs[b]!];
    const years = generations(barb[0]!, 20);
    const change = (predators: number) => {
      const eco = new Ecology({
        seed: 'bright',
        stretches: testValley('default', defs),
        species: barb,
        startSeconds: 0,
        settings: { predators },
      });
      const before = eco.snapshot().brightness[0]!;
      eco.advance(years * YEAR);
      return eco.snapshot().brightness[0]! - before;
    };
    expect(change(0.05)).toBeGreaterThan(0.05);
    expect(change(0.9)).toBeLessThan(0);
  });

  it('does not evolve with evolution off', () => {
    const eco = new Ecology({
      seed: 'off',
      stretches: testValley(),
      species: lives,
      startSeconds: 0,
      settings: { evolution: false, predators: 0.05 },
    });
    const before = eco.snapshot().traits.map((t) => t.slice());
    eco.advance(5 * YEAR);
    eco
      .snapshot()
      .traits.forEach((t, p) => t.forEach((v, i) => expect(Math.abs(v - before[p]![i]!)).toBeLessThan(0.02)));
  });

  it('sends the mahseer upstream to the gravel in the monsoon floods', () => {
    const eco = new Ecology({ seed: 'migrate', stretches: testValley(), species: lives, startSeconds: 0 });
    const m = speciesIndex('golden-mahseer');
    const onGravel = () => {
      let gravel = 0;
      let all = 0;
      eco.stretches.forEach((s, i) => {
        const n = eco.cohorts[i]![m]!.count[2]!;
        all += n;
        if (s.gravel > 0.3) gravel += n;
      });
      return gravel / all;
    };
    eco.advance(80 * 86400); // late March
    const spring = onGravel();
    eco.advance(150 * 86400); // mid-August
    expect(onGravel()).toBeGreaterThan(spring + 0.2);
  });

  it('saves and restores exactly', () => {
    const a = new Ecology({ seed: 'save', stretches: testValley(), species: lives, startSeconds: 0 });
    a.advance(200 * 86400 + 4321);
    const bytes = a.serialize();
    const b = new Ecology({ seed: 'save', stretches: testValley(), species: lives, startSeconds: 0 });
    b.restore(bytes);
    expect(b.hash()).toBe(a.hash());
    a.advance(100 * 86400);
    b.advance(100 * 86400);
    expect(b.hash()).toBe(a.hash());
  });
});

describe('weather and the catchment', () => {
  it('rains more in the monsoon than in winter', () => {
    const w = new WeatherSystem(createRng('rain'));
    const rain = { monsoon: 0, winter: 0 };
    for (let h = 0; h < 365 * 24 * 3; h++) {
      const day = (h / 24) % 365;
      w.step(1, day);
      const s = seasonOf(day);
      if (s === 'monsoon') rain.monsoon += w.rain();
      if (s === 'winter') rain.winter += w.rain();
    }
    expect(rain.monsoon).toBeGreaterThan(rain.winter * 5);
  });

  it('raises the discharge after rain, with a delay, and clouds the water', () => {
    const c = new Catchment();
    const day = 200;
    const base = c.discharge(day);
    const t0 = c.turbidity;
    for (let h = 0; h < 6; h++) c.step(1, 30, day);
    const right = c.discharge(day);
    let peak = right;
    let peakHour = 0;
    for (let h = 1; h < 72; h++) {
      c.step(1, 0, day);
      if (c.discharge(day) > peak) {
        peak = c.discharge(day);
        peakHour = h;
      }
    }
    expect(right).toBeGreaterThan(base);
    expect(peak).toBeGreaterThan(base * 1.5);
    expect(peakHour).toBeGreaterThanOrEqual(0);
    expect(c.discharge(day)).toBeLessThan(peak);
    // It takes the stream more than a day to come back down.
    expect(c.discharge(day)).toBeGreaterThan(base);
    expect(c.turbidity).toBeLessThan(1);
    const after = new Catchment();
    after.step(3, 30, day);
    expect(after.turbidity).toBeGreaterThan(t0);
  });

  it('holds less oxygen in warm water', () => {
    expect(oxygenSaturation(25)).toBeLessThan(oxygenSaturation(10));
  });
});

describe('genetics', () => {
  it('follows the breeder’s equation', () => {
    expect(breedersEquation(0.4, 0.2)).toBeCloseTo(0.08);
    const s = traitStats([0.5, 0.5, 0.5, 0.5, 0.5], [0.1, 0.1, 0.1, 0.1, 0.1]);
    respond(s, [1, 0, 0, -1, 0], 0.4, 1);
    // Δmean = h² · variance · β = 0.4 · 0.01 · 1.
    expect(s.mean[0]).toBeCloseTo(0.504, 5);
    expect(s.mean[3]).toBeCloseTo(0.496, 5);
    expect(s.mean[1]).toBe(0.5);
  });

  it('keeps means inside 0..1 under strong selection', () => {
    const s = traitStats([0.98, 0.02, 0.5, 0.5, 0.5], [0.3, 0.3, 0.1, 0.1, 0.1]);
    for (let k = 0; k < 1000; k++) respond(s, [10, -10, 0, 0, 0], 1, 1);
    for (const m of s.mean) {
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThan(1);
    }
  });

  it('pulls color two ways: predators against brightness, so it falls when predators are many', () => {
    const calm = selectionGradients({ meanSpeed: 0.4, comfortSpeed: 0.45, fastShare: 0.2, predation: 0, food: 1 });
    const hunted = selectionGradients({ meanSpeed: 0.4, comfortSpeed: 0.45, fastShare: 0.2, predation: 1, food: 1 });
    expect(hunted[3]!).toBeLessThan(calm[3]!);
    expect(hunted[4]!).toBeGreaterThan(calm[4]!);
    const fast = selectionGradients({ meanSpeed: 1.2, comfortSpeed: 0.45, fastShare: 0.7, predation: 0.3, food: 1 });
    expect(fast[1]!).toBeGreaterThan(0);
    expect(calm[1]!).toBeLessThan(0.1);
  });

  it('mixes groups and koi patterns', () => {
    const a = traitStats([0.2, 0.2, 0.2, 0.2, 0.2], [0.1, 0.1, 0.1, 0.1, 0.1]);
    const b = traitStats([0.8, 0.8, 0.8, 0.8, 0.8], [0.1, 0.1, 0.1, 0.1, 0.1]);
    const m = mixStats(a, 10, b, 30);
    expect(m.mean[0]).toBeCloseTo(0.65, 5);
    expect(m.variance[0]!).toBeGreaterThan(0.01);
    const pool = mixKoiPatterns([0.1, 0.5, 0.95], createRng('koi'));
    expect(pool).toHaveLength(3);
    for (const v of pool) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('stretches', () => {
  it('summarizes the water into stretches with habitat for each species', () => {
    const ns = 400;
    const nn = 9;
    const cell = (i: number, j: number): CellWater => {
      const fast = i < 200;
      const edge = Math.abs(j - 4) / 4;
      return {
        depth: (fast ? 0.4 : 1.6) * (1 - edge * 0.8),
        speed: (fast ? 1.0 : 0.15) * (1 - edge * 0.5),
        foam: fast ? 0.4 : 0,
        shelter: 0,
      };
    };
    const stretches = buildStretches(
      {
        ns,
        nn,
        ds: 0.5,
        dn: 0.5,
        cell,
        center: (i) => [0, i * 0.5],
        zoneOf: (i) => (i < 200 ? 'rapids' : 'pool'),
        shade: () => 0.2,
        pond: { area: 300, meanDepth: 1.2, maxDepth: 2, section: 350, x: 20, z: 175 },
        reachStarts: [],
      },
      fishDefs.map((d) => d.habitat),
    );
    expect(stretches.length).toBe(5);
    const loach = speciesIndex('hillstream-loach');
    const mahseer = speciesIndex('golden-mahseer');
    const koi = speciesIndex('koi');
    expect(stretches[0]!.suitability[loach]!).toBeGreaterThan(stretches[3]!.suitability[loach]!);
    expect(stretches[3]!.suitability[mahseer]!).toBeGreaterThan(stretches[0]!.suitability[mahseer]!);
    expect(stretches[0]!.meanSpeed).toBeGreaterThan(stretches[3]!.meanSpeed);
    const pond = stretches[4]!;
    expect(pond.pond).toBe(true);
    expect(pond.suitability[koi]!).toBeGreaterThan(0.5);
    expect(pond.upstream).toBe(3);
  });
});

describe('the real valley (generated terrain, solved stream)', () => {
  it('splits the stream into stretches from the headwaters to the outflow, plus the pond', () => {
    const { stretches, ns } = realValleyStretches();
    expect(stretches.length).toBeGreaterThan(15);
    expect(stretches[0]!.first).toBe(0);
    expect(stretches[stretches.length - 2]!.last).toBe(ns - 1);
    expect(stretches.at(-1)!.pond).toBe(true);
    const best = (id: string) => {
      const p = speciesIndex(id);
      return stretches.filter((s) => !s.pond).reduce((a, s) => (s.suitability[p]! > a.suitability[p]! ? s : a));
    };
    expect(best('golden-mahseer').zone).toBe('pool');
    expect(['rapids', 'riffles', 'headwaters']).toContain(best('hillstream-loach').zone);
    // Nothing swims up the waterfall.
    expect(stretches.filter((s) => s.upstream === -1 && !s.pond).length).toBe(2);
  });

  it('stays balanced for 10 years: no runaway populations or extinctions (plan 6.6 safety net)', () => {
    const { stretches } = realValleyStretches();
    const eco = new Ecology({
      seed: 'riffle',
      stretches,
      species: lives,
      startSeconds: 0,
      settings: { restock: false },
    });
    const start = eco.snapshot().populations;
    for (let y = 1; y <= 10; y++) {
      eco.advance(YEAR);
      eco.snapshot().populations.forEach((n, p) => {
        expect(n, `${lives[p]!.id} in year ${y}`).toBeGreaterThan(Math.max(2, start[p]! * 0.25));
        expect(n, `${lives[p]!.id} in year ${y}`).toBeLessThan(start[p]! * 3);
      });
    }
  });
});
