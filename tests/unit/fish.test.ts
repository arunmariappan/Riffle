import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../../src/content/catalog';
import { behaviorFromDef } from '../../src/sim/boids/species';
import { School, fishEnvironment, type Fish, type FlowSampler } from '../../src/sim/boids/school';
import { makeFlow, POND } from './streamFixture';

const catalog = loadCatalog();
const behaviors = catalog.fish.map(behaviorFromDef);
const index = (id: string) => {
  const i = behaviors.findIndex((b) => b.id === id);
  if (i < 0) throw new Error(`no ${id}`);
  return i;
};

function inWater(sampler: FlowSampler, f: Fish): boolean {
  const s = sampler.sample(f.x, f.z);
  return !!s && f.y >= s.bed - 1e-6 && f.y <= s.surface + 1e-6;
}

function run(school: School, seconds: number, threat: Parameters<School['step']>[1] = null): void {
  for (let t = 0; t < seconds * 30; t++) school.step(1 / 30, threat);
}

describe('fish species (Phase 5)', () => {
  it('has all six species, each with sensible behavior', () => {
    expect(catalog.fish.map((f) => f.id).sort()).toEqual([
      'celestial-pearl-danio',
      'denison-barb',
      'golden-mahseer',
      'hillstream-loach',
      'koi',
      'white-cloud-minnow',
    ]);
    for (const b of behaviors) {
      expect(b.length[0]).toBeGreaterThan(0);
      expect(b.length[1]).toBeGreaterThanOrEqual(b.length[0]);
      expect(b.burst).toBeGreaterThan(b.cruise);
      expect(b.habitat).toBeDefined();
    }
  });

  it('keeps every fish of every species in the water for 10 simulated minutes', () => {
    const { sampler } = makeFlow();
    const school = new School(sampler, behaviors, { seed: 'soak' });
    school.env = fishEnvironment(140, 17.5);
    // Each species where it lives: mahseer in the pool, loaches in the fast middle, small fish at the edges, koi in
    // the pond.
    const at: Record<string, [number, number]> = {
      'golden-mahseer': [0, 30],
      'hillstream-loach': [0, -40],
      'denison-barb': [1, -30],
      'white-cloud-minnow': [2.5, -10],
      'celestial-pearl-danio': [3, -5],
      koi: [POND.x, POND.z],
    };
    for (const b of behaviors) {
      const [x, z] = at[b.id] as [number, number];
      expect(school.release(index(b.id), x, z, b.pondOnly ? 8 : 12, b.pondOnly ? 4 : 1.2), b.id).toBeGreaterThan(6);
    }
    let rises = 0;
    for (let t = 0; t < 600 * 30; t++) {
      school.step(1 / 30);
      for (const f of school.fish) if (f.rose) rises++;
    }
    for (const f of school.fish) {
      for (const v of [f.x, f.y, f.z, f.vx, f.vz, f.hx, f.hz, f.beat]) expect(Number.isFinite(v)).toBe(true);
      expect(inWater(sampler, f), behaviors[f.species]!.id).toBe(true);
      if (behaviors[f.species]!.pondOnly) expect(sampler.sample(f.x, f.z)?.pond).toBe(true);
    }
    // Late afternoon in the warm season: some fish rose to insects.
    expect(rises).toBeGreaterThan(0);
  });

  it('hillstream loaches cling to the bed in fast water and hold their place', () => {
    const { sampler } = makeFlow([]);
    const school = new School(sampler, behaviors, { seed: 'loach' });
    const i = index('hillstream-loach');
    school.release(i, 0, -30, 15, 1.2);
    run(school, 60);
    const fish = school.fish;
    const clinging = fish.filter((f) => f.clinging).length;
    expect(clinging / fish.length).toBeGreaterThan(0.6);
    for (const f of fish) {
      const s = sampler.sample(f.x, f.z)!;
      expect(f.y - s.bed).toBeLessThan(0.15);
    }
    // The current here is fast enough to carry a drifting fish tens of meters in a minute.
    const meanZ = fish.reduce((s, f) => s + f.z, 0) / fish.length;
    expect(meanZ).toBeLessThan(-24);
    const meanHz = fish.reduce((s, f) => s + f.hz, 0) / fish.length;
    expect(meanHz).toBeLessThan(-0.6);
  });

  it('golden mahseer gather in the calm water behind a boulder', () => {
    const { field, sampler } = makeFlow([{ id: 1, x: 0, z: 0, radius: 1.4, height: 1.3 }]);
    field.setDischarge(6);
    field.solve();
    const school = new School(sampler, behaviors, { seed: 'mahseer' });
    school.release(index('golden-mahseer'), 0, 4, 10, 3);
    run(school, 90);
    const calm = school.fish.filter((f) => {
      const s = sampler.sample(f.x, f.z)!;
      return s.shelter > 0.15 || Math.hypot(s.velocityX, s.velocityZ) < 0.45;
    }).length;
    expect(calm / school.fish.length).toBeGreaterThan(0.6);
  });

  it('koi come to food thrown into the pond', () => {
    const { sampler } = makeFlow([]);
    const school = new School(sampler, behaviors, { seed: 'koi' });
    school.release(index('koi'), POND.x - 5, POND.z, 8, 2);
    school.food = { x: POND.x + 5, y: POND.level, z: POND.z + 2, until: 40 };
    run(school, 30);
    const close = school.fish.filter((f) => Math.hypot(f.x - (POND.x + 5), f.z - (POND.z + 2)) < 2.5).length;
    expect(close / school.fish.length).toBeGreaterThan(0.6);
    // They rise to the surface to take it.
    const high = school.fish.filter((f) => POND.level - f.y < 0.2).length;
    expect(high).toBeGreaterThan(0);
  });

  it('curious koi come closer when you stand still', () => {
    const { sampler } = makeFlow([]);
    const school = new School(sampler, behaviors, { seed: 'curious' });
    school.release(index('koi'), POND.x + 1, POND.z, 6, 1.5);
    const you = { x: POND.x - 6, z: POND.z, calm: 20 };
    const mean = () => school.fish.reduce((s, f) => s + Math.hypot(f.x - you.x, f.z - you.z), 0) / school.fish.length;
    const before = mean();
    run(school, 25, you);
    expect(mean()).toBeLessThan(before - 2.5);
  });

  it('rests near the bottom at night', () => {
    const { sampler } = makeFlow([]);
    const height = (hour: number) => {
      const school = new School(sampler, behaviors, { seed: 'night' });
      school.env = fishEnvironment(200, hour);
      school.release(index('denison-barb'), 0, 30, 20, 1.5);
      run(school, 40);
      return (
        school.fish.reduce((s, f) => {
          const w = sampler.sample(f.x, f.z)!;
          return s + (f.y - w.bed) / w.depth;
        }, 0) / school.fish.length
      );
    };
    expect(height(1)).toBeLessThan(height(12) - 0.2);
  });

  it('seeks water that suits its species (minnows leave the fast middle)', () => {
    const { sampler } = makeFlow([]);
    const school = new School(sampler, behaviors, { seed: 'habitat' });
    school.env = fishEnvironment(80, 11);
    school.release(index('white-cloud-minnow'), 0, -30, 20, 0.8);
    const speed = () =>
      school.fish.reduce((s, f) => {
        const w = sampler.sample(f.x, f.z)!;
        return s + Math.hypot(w.velocityX, w.velocityZ);
      }, 0) / school.fish.length;
    const before = speed();
    run(school, 60);
    expect(speed()).toBeLessThan(before * 0.75);
  });

  it('strong swimmers hold station better than weak ones (the swim-strength gene)', () => {
    const { field, sampler } = makeFlow([]);
    field.setDischarge(7);
    field.solve();
    const drift = (strength: number) => {
      const school = new School(sampler, behaviors, { seed: `gene-${strength}` });
      const barb = index('denison-barb');
      school.release(barb, 0, -40, 20, 0.8, 0, () => ({
        genes: { bodySize: 0.5, swimStrength: strength, preferredFlow: 0.9, brightness: 0.5, shyness: 0.5 },
      }));
      run(school, 30);
      return school.fish.reduce((s, f) => s + f.z, 0) / school.fish.length + 40;
    };
    expect(drift(0.95)).toBeLessThan(drift(0.05));
  });
});
