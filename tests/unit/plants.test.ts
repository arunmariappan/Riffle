import { describe, expect, it } from 'vitest';
import {
  PlantEcology,
  plantFitness,
  toleranceFit,
  type PlantSpecies,
  type PlantWorld,
} from '../../src/sim/ecology/plants';
import { canopyGrid, shadeAt } from '../../src/sim/ecology/canopy';

const FERN: PlantSpecies = {
  id: 'fern',
  aquatic: false,
  tolerance: {
    light: { limits: [0.02, 1.01], ideal: [0.15, 0.7] },
    moisture: { limits: [0.1, 1.01], ideal: [0.35, 1] },
  },
  yearsToMature: 2,
  lifespanYears: 15,
  spread: 'wind-seeds',
  spreadRate: 0.8,
  spreadDistance: 8,
};

const CRYPT: PlantSpecies = {
  id: 'crypt',
  aquatic: true,
  tolerance: { depth: { limits: [0.05, 1.8], ideal: [0.15, 1.2] }, flow: { limits: [-1, 0.6], ideal: [0, 0.35] } },
  yearsToMature: 1,
  lifespanYears: 10,
  spread: 'drift',
  spreadRate: 0.6,
  spreadDistance: 6,
};

/** An open field (or a stream bed flowing +x) with room for everything inside ±60 m. */
function field(
  site: (x: number, z: number) => { light: number; moisture: number; depth?: number; flow?: number } | null,
): PlantWorld & {
  placed: { x: number; z: number }[];
} {
  const placed: { x: number; z: number }[] = [];
  return {
    placed,
    site: (r) => {
      const s = site(r.x, r.z);
      return s ? { temperature: 18, ...s } : null;
    },
    place: (_kind, x, z) => {
      if (Math.abs(x) > 60 || Math.abs(z) > 60 || !site(x, z)) return null;
      placed.push({ x, z });
      return { x, z };
    },
    wind: [1, 0],
    downstream: () => [1, 0],
  };
}

function start(eco: PlantEcology, kind: string, n: number): void {
  eco.sync(
    Array.from({ length: n }, (_, i) => ({
      uid: `g:bushes:${i}`,
      kind,
      x: (i % 5) * 3 - 6,
      z: Math.floor(i / 5) * 3 - 6,
      scale: 1,
    })),
  );
}

function years(eco: PlantEcology, world: PlantWorld, n: number) {
  const ev = { born: 0, died: 0 };
  for (let d = 0; d < 365 * n; d++) {
    const e = eco.step(world);
    ev.born += e.born.length;
    ev.died += e.died.length;
  }
  return ev;
}

describe('plant ecology (plan 6.6)', () => {
  it('reads tolerance curves', () => {
    const t = { limits: [0, 10] as [number, number], ideal: [4, 6] as [number, number] };
    expect(toleranceFit(5, t)).toBe(1);
    expect(toleranceFit(2, t)).toBeCloseTo(0.5);
    expect(toleranceFit(-1, t)).toBe(0);
    expect(toleranceFit(8, t)).toBeCloseTo(0.5);
    expect(toleranceFit(3, undefined)).toBe(1);
    expect(plantFitness(FERN, { light: 0.4, moisture: 0.6, temperature: 18 })).toBe(1);
    expect(plantFitness(FERN, { light: 1, moisture: 0.05, temperature: 18 })).toBe(0);
  });

  it('spreads where it suits it, downwind for wind-borne seeds', () => {
    const eco = new PlantEcology([FERN], 'spread');
    start(eco, 'fern', 15);
    const world = field(() => ({ light: 0.4, moisture: 0.7 }));
    const ev = years(eco, world, 4);
    expect(ev.born).toBeGreaterThan(10);
    expect(eco.count('fern')).toBeGreaterThan(25);
    const meanX = world.placed.reduce((a, p) => a + p.x, 0) / world.placed.length;
    expect(meanX).toBeGreaterThan(2);
  });

  it('dies back where it does not (too dry)', () => {
    const eco = new PlantEcology([FERN], 'dry');
    start(eco, 'fern', 15);
    const ev = years(
      eco,
      field(() => ({ light: 0.9, moisture: 0.12 })),
      3,
    );
    expect(ev.born).toBe(0);
    expect(eco.count('fern')).toBe(0);
    expect(eco.removed.size).toBe(15);
  });

  it('water plants drift downstream and die when the water leaves them', () => {
    const eco = new PlantEcology([CRYPT], 'drift');
    start(eco, 'crypt', 10);
    const world = field(() => ({ light: 0.5, moisture: 1, depth: 0.5, flow: 0.2 }));
    years(eco, world, 3);
    const meanX = world.placed.reduce((a, p) => a + p.x, 0) / world.placed.length;
    expect(meanX).toBeGreaterThan(2);
    // The stream dries up: every plant dies within months.
    const dry = eco.step(
      field(() => null),
      0.25,
    );
    expect(dry.died.length).toBeGreaterThan(0);
    years(
      eco,
      field(() => null),
      1,
    );
    expect(eco.records.size).toBe(0);
  });

  it('grows its young toward full size', () => {
    const eco = new PlantEcology([FERN], 'grow');
    start(eco, 'fern', 15);
    years(
      eco,
      field(() => ({ light: 0.4, moisture: 0.7 })),
      2,
    );
    const young = [...eco.records.values()].filter((r) => r.uid.startsWith('e'));
    expect(young.length).toBeGreaterThan(0);
    expect(Math.max(...young.map((r) => r.size))).toBeGreaterThan(0.6);
    expect(PlantEcology.scaleOf({ ...young[0]!, size: 1, baseScale: 2 })).toBe(2);
  });

  it('is reproducible and saves exactly', () => {
    const run = () => {
      const eco = new PlantEcology([FERN], 'same');
      start(eco, 'fern', 15);
      years(
        eco,
        field(() => ({ light: 0.4, moisture: 0.7 })),
        2,
      );
      return eco;
    };
    const a = run();
    expect(JSON.stringify(run().toJSON())).toBe(JSON.stringify(a.toJSON()));
    const b = new PlantEcology([FERN], 'other');
    b.restore(JSON.parse(JSON.stringify(a.toJSON())));
    const world = () => field(() => ({ light: 0.4, moisture: 0.7 }));
    years(a, world(), 1);
    years(b, world(), 1);
    expect(JSON.stringify(b.toJSON())).toBe(JSON.stringify(a.toJSON()));
  });

  it('forgets plants you removed and takes in plants you placed', () => {
    const eco = new PlantEcology([FERN], 'sync');
    start(eco, 'fern', 3);
    eco.sync([
      { uid: 'g:bushes:0', kind: 'fern', x: 0, z: 0, scale: 1 },
      { uid: 'u7', kind: 'fern', x: 5, z: 5, scale: 1.2 },
      { uid: 'u8', kind: 'mystery', x: 5, z: 5, scale: 1 },
    ]);
    expect([...eco.records.keys()].sort()).toEqual(['g:bushes:0', 'u7']);
  });
});

describe('canopy shade', () => {
  it('shades the ground under the crowns only', () => {
    const grid = canopyGrid(
      [
        { x: 0, z: 0, radius: 6 },
        { x: 4, z: 0, radius: 6 },
      ],
      200,
      -100,
      4,
    );
    expect(shadeAt(grid, 2, 0)).toBeGreaterThan(0.7);
    expect(shadeAt(grid, 2, 0)).toBeLessThanOrEqual(1);
    expect(shadeAt(grid, 40, 40)).toBe(0);
    expect(shadeAt(grid, 500, 0)).toBe(0);
  });
});
