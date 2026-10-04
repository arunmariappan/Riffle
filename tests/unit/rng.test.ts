import { describe, expect, it } from 'vitest';
import { createSimplex2, fbm } from '../../src/sim/noise';
import { createRng, restoreRng } from '../../src/sim/rng';

describe('seeded random numbers', () => {
  it('gives the same sequence for the same seed', () => {
    const a = createRng('riffle');
    const b = createRng('riffle');
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('gives different sequences for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
    expect(same).toBeLessThan(3);
  });

  it('restores a saved state exactly', () => {
    const a = createRng(42);
    for (let i = 0; i < 10; i++) a.next();
    const b = restoreRng(a.state());
    for (let i = 0; i < 50; i++) expect(b.next()).toBe(a.next());
  });

  it('keeps forks independent of later draws on the parent', () => {
    const parent1 = createRng(7);
    const fork1 = parent1.fork('fish');
    const parent2 = createRng(7);
    const fork2 = parent2.fork('fish');
    parent2.next();
    expect(fork1.next()).toBe(fork2.next());
  });

  it('stays within range and has a sensible mean', () => {
    const rng = createRng(3);
    let sum = 0;
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 10000).toBeCloseTo(0.5, 1);
  });
});

describe('noise', () => {
  it('is deterministic and bounded', () => {
    const n1 = createSimplex2('valley');
    const n2 = createSimplex2('valley');
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37;
      const y = i * 0.11;
      expect(n1(x, y)).toBe(n2(x, y));
      expect(Math.abs(n1(x, y))).toBeLessThanOrEqual(1.01);
      expect(Math.abs(fbm(n1, x, y, { octaves: 5, frequency: 0.01 }))).toBeLessThanOrEqual(1.01);
    }
  });
});
