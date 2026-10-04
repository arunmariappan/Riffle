import { describe, expect, it } from 'vitest';
import { FlowField } from '../../src/sim/flow/field';
import { buildRiverPath } from '../../src/sim/flow/path';
import { School, DENISON_BARB, type FlowSampler } from '../../src/sim/boids/school';

/** The Phase 0 test channel (straight along +z, 200 m) as a flow sampler. */
function makeFlow(stones = [{ id: 1, x: 0, z: 0, radius: 0.9, height: 1.1 }]): {
  field: FlowField;
  sampler: FlowSampler;
} {
  const bed = (x: number, z: number) => {
    const ax = Math.abs(x);
    return -0.004 * z + (ax < 5 ? -1.1 * (1 - (ax / 5) ** 2) : (ax - 5) * 0.6);
  };
  const path = buildRiverPath(
    [
      { x: 0, z: -100 },
      { x: 0, z: 100 },
    ],
    0.5,
  );
  const field = new FlowField(path, bed, { cellsAcross: 33 });
  field.setDischarge(4);
  field.setStones(stones);
  field.solve();
  const sampler: FlowSampler = {
    sample: (x, z) => {
      const s = field.sample((z + 100) / 0.5, -x);
      return s && s.depth > 0.01
        ? {
            velocityX: s.velocityX,
            velocityZ: s.velocityZ,
            depth: s.depth,
            surface: s.surface,
            bed: s.bed,
            shelter: s.shelter,
          }
        : null;
    },
    towardChannel: (x) => [-Math.sign(x) || 1, 0],
  };
  return { field, sampler };
}

describe('fish school', () => {
  it('keeps every fish in the water and every value finite for 10 simulated minutes', () => {
    const { sampler } = makeFlow();
    const school = new School(sampler, [DENISON_BARB], { seed: 'test' });
    expect(school.release(0, 0, -20, 40)).toBe(40);
    for (let t = 0; t < 600 * 30; t++) school.step(1 / 30);
    for (const f of school.fish) {
      for (const v of [f.x, f.y, f.z, f.vx, f.vz, f.hx, f.hz]) expect(Number.isFinite(v)).toBe(true);
      const s = sampler.sample(f.x, f.z);
      expect(s).not.toBeNull();
      expect(f.y).toBeGreaterThanOrEqual(s!.bed);
      expect(f.y).toBeLessThanOrEqual(s!.surface);
      expect(Math.abs(f.z)).toBeLessThan(100);
    }
  });

  it('faces upstream in the current (holding station)', () => {
    const { sampler } = makeFlow([]);
    const school = new School(sampler, [DENISON_BARB], { seed: 'rheo' });
    school.release(0, 0, -30, 30, 1.5);
    for (let t = 0; t < 30 * 30; t++) school.step(1 / 30);
    // The current runs toward +z; facing upstream means heading z < 0.
    const meanHz = school.fish.reduce((s, f) => s + f.hz, 0) / school.fish.length;
    expect(meanHz).toBeLessThan(-0.5);
    // They hold roughly in place instead of washing downstream at the current's speed.
    const meanZ = school.fish.reduce((s, f) => s + f.z, 0) / school.fish.length;
    expect(meanZ).toBeLessThan(0);
  });

  it('gathers in the calm water behind a stone when the current is strong', () => {
    const { field, sampler } = makeFlow();
    field.setDischarge(6); // strong, but still swimmable near the edges
    field.solve();
    const school = new School(sampler, [DENISON_BARB], { seed: 'shelter' });
    // Around the stone: in strong current they should drift into the calm wake right behind it.
    school.release(0, 0, 2.5, 40, 3);
    for (let t = 0; t < 60 * 30; t++) school.step(1 / 30);
    const sheltered = school.fish.filter((f) => (sampler.sample(f.x, f.z)?.shelter ?? 0) > 0.15).length;
    expect(sheltered / school.fish.length).toBeGreaterThan(0.25);
  });

  it('gathers at thrown food', () => {
    const { sampler } = makeFlow([]);
    const school = new School(sampler, [DENISON_BARB], { seed: 'food' });
    school.release(0, 2, -20, 25, 2);
    // Across and a little downstream: reachable in a current (upstream of a strong current may not be).
    school.food = { x: -2, y: 0, z: -16, until: 30 };
    for (let t = 0; t < 20 * 30; t++) school.step(1 / 30);
    const close = school.fish.filter((f) => Math.hypot(f.x + 2, f.z + 16) < 2.5).length;
    expect(close / school.fish.length).toBeGreaterThan(0.6);
  });
});
