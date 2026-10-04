import { describe, expect, it } from 'vitest';
import { SprayField, WATERFALL_MIST, WATERFALL_SPRAY, SPLASH, type Emitter } from '../../src/sim/particles/spray';

const plunge: Emitter = { ax: -3, ay: 0, az: 0, bx: 3, by: 0, bz: 0, rate: 200, vx: 0, vy: 2.5, vz: 1, spread: 1 };

describe('spray and mist particles', () => {
  it('emits at the emitter rate and scales with intensity', () => {
    const f = new SprayField({ ...WATERFALL_SPRAY, life: [5, 5] }, 'rate');
    f.emitters = [plunge];
    for (let k = 0; k < 20; k++) f.step(0.05, 0, 0, null);
    expect(f.alive).toBeGreaterThanOrEqual(195);
    expect(f.alive).toBeLessThanOrEqual(201);
    const g = new SprayField({ ...WATERFALL_SPRAY, life: [5, 5] }, 'rate');
    g.emitters = [plunge];
    g.intensity = 0.5;
    for (let k = 0; k < 20; k++) g.step(0.05, 0, 0, null);
    expect(g.alive).toBeLessThan(f.alive * 0.6);
  });

  it('spray rises, falls back and dies at the water surface', () => {
    const f = new SprayField(SPLASH, 'fall');
    f.burst({ ...plunge, ax: 0, bx: 0 }, 50);
    let maxY = 0;
    for (let k = 0; k < 40; k++) {
      f.step(0.05, 0, 0, () => 0);
      for (let i = 0; i < f.config.capacity; i++) if (f.lifeFraction(i) < 1) maxY = Math.max(maxY, f.y[i]!);
    }
    expect(maxY).toBeGreaterThan(0.1);
    // Two seconds later every droplet has landed back in the water.
    expect(f.alive).toBe(0);
  });

  it('mist drifts downwind', () => {
    const f = new SprayField(WATERFALL_MIST, 'mist');
    f.emitters = [{ ...plunge, rate: 20, vz: 0 }];
    for (let k = 0; k < 120; k++) f.step(0.05, 3, 0, null);
    let sumX = 0;
    let n = 0;
    for (let i = 0; i < f.config.capacity; i++) {
      if (f.lifeFraction(i) < 1) {
        sumX += f.x[i]!;
        n++;
      }
    }
    expect(n).toBeGreaterThan(20);
    expect(sumX / n).toBeGreaterThan(1.5);
  });

  it('fades in and out and grows over its life', () => {
    const f = new SprayField({ ...WATERFALL_MIST, life: [4, 4] }, 'fade');
    f.burst({ ...plunge, ax: 0, bx: 0 }, 1);
    const i = f.x.findIndex((_, k) => f.lifeFraction(k) < 1);
    expect(f.opacityAt(i)).toBe(0);
    const s0 = f.sizeAt(i);
    f.step(1, 0, 0, null);
    const mid = f.opacityAt(i);
    expect(mid).toBeGreaterThan(0);
    expect(f.sizeAt(i)).toBeGreaterThan(s0);
    f.step(2.9, 0, 0, null);
    expect(f.opacityAt(i)).toBeLessThan(mid);
    f.step(0.2, 0, 0, null);
    expect(f.opacityAt(i)).toBe(0);
  });

  it('gives the same particles for the same seed', () => {
    const run = () => {
      const f = new SprayField(WATERFALL_SPRAY, 'same');
      f.emitters = [plunge];
      for (let k = 0; k < 30; k++) f.step(1 / 30, 1, 0.5, () => -0.2);
      return Array.from(f.y);
    };
    expect(run()).toEqual(run());
  });
});
