import { describe, expect, it } from 'vitest';
import { loadCatalog, findItem } from '../../src/content/catalog';
import { checkPlacement, type PlacementProbe } from '../../src/builder/placement';
import {
  addItem,
  applyEdits,
  createEditLayer,
  generatedUid,
  moveItem,
  newUid,
  removeItem,
  validateEditLayer,
  type PlacedItem,
} from '../../src/builder/editLayer';
import { rayCylinder, rayEllipsoid, rayHeight, pickNearest, type Ray } from '../../src/builder/picking';
import { applyGrassStroke, itemsInCircle, scatterDab } from '../../src/builder/brush';
import { waterTemperature, airTemperature } from '../../src/sim/ecology/temperature';

const catalog = loadCatalog();
const item = (id: string) => {
  const found = findItem(catalog, id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};

const land: PlacementProbe = {
  ground: { height: 10, slope: 0.05, riverDistance: 12, wetness: 0.5 },
  water: null,
  stone: null,
};
const stream = (depth: number, speed: number, temperature = 18): PlacementProbe => ({
  ground: { height: 8, slope: 0.02, riverDistance: -3, wetness: 1 },
  water: { depth, speed, surface: 8 + depth, bed: 8, temperature, pond: false },
  stone: null,
});
const pond = (depth: number): PlacementProbe => ({
  ground: { height: 5, slope: 0.01, riverDistance: 20, wetness: 1 },
  water: { depth, speed: 0, surface: 5 + depth, bed: 5, temperature: 22, pond: true },
  stone: null,
});

describe('placement rules', () => {
  it('lets every catalog item go somewhere', () => {
    expect(catalog.fish.length).toBeGreaterThanOrEqual(1);
    for (const t of catalog.trees) expect(checkPlacement(t, land).ok, t.id).toBe(true);
    for (const b of catalog.bushes) expect(checkPlacement(b, land).ok, b.id).toBe(true);
    for (const s of catalog.stones) {
      expect(checkPlacement(s, land).ok, s.id).toBe(true);
      expect(checkPlacement(s, stream(0.6, 0.8)).ok, s.id).toBe(true);
    }
  });

  it('keeps trees out of the water and off cliffs, with a reason', () => {
    const r = checkPlacement(item('japanese-maple'), stream(0.5, 0.5));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Japanese maple can't grow in the water");
    const steep = checkPlacement(item('bamboo'), { ...land, ground: { ...land.ground, slope: 0.5 } });
    expect(steep.ok).toBe(false);
    expect(steep.reason).toMatch(/^Bamboo needs gentler ground \(max \d+°\)$/);
  });

  it('wants lotus in still water of the right depth', () => {
    const lotus = item('lotus');
    expect(checkPlacement(lotus, pond(1)).ok).toBe(true);
    const shallow = checkPlacement(lotus, pond(0.1));
    expect(shallow.ok).toBe(false);
    expect(shallow.reason).toBe('Lotus needs still water 0.3–1.8 m deep');
    expect(checkPlacement(lotus, stream(1, 0.6)).ok).toBe(false);
    expect(checkPlacement(lotus, land).reason).toBe('Lotus needs still water 0.3–1.8 m deep');
  });

  it('puts bed plants in water within their depth and current', () => {
    const rotala = item('red-rotala');
    expect(checkPlacement(rotala, stream(0.5, 0.1)).ok).toBe(true);
    const fast = checkPlacement(rotala, stream(0.5, 0.9));
    expect(fast.ok).toBe(false);
    expect(fast.reason).toBe('Red Rotala needs slower water (max 0.25 m/s)');
    expect(checkPlacement(rotala, stream(1.6, 0.1)).reason).toBe('Red Rotala needs water 0.2–1 m deep');
  });

  it('grows Java fern only on a stone under water', () => {
    const fern = item('java-fern');
    expect(checkPlacement(fern, stream(0.8, 0.5)).reason).toBe(
      'Java fern grows on stones: drop it onto a stone in the water',
    );
    const onStone = checkPlacement(fern, { ...stream(0.8, 0.5), stone: { uid: 'g:stones:4', top: 8.4, radius: 0.6 } });
    expect(onStone.ok).toBe(true);
    expect(onStone.host).toBe('g:stones:4');
    expect(onStone.y).toBeCloseTo(8.4);
    const dry = checkPlacement(fern, { ...stream(0.3, 0.5), stone: { uid: 'g:stones:4', top: 8.35, radius: 0.6 } });
    expect(dry.ok).toBe(false);
    expect(dry.reason).toBe('Java fern needs a stone under the water');
  });

  it('checks fish against depth, current and temperature', () => {
    const barb = item('denison-barb');
    expect(checkPlacement(barb, stream(0.6, 0.5)).ok).toBe(true);
    expect(checkPlacement(barb, land).reason).toBe('Denison barbs need water');
    expect(checkPlacement(barb, stream(0.1, 0.5)).reason).toBe('Denison barbs need water at least 0.22 m deep');
    expect(checkPlacement(barb, stream(0.6, 0.5, 29)).reason).toBe(
      "Denison barbs need water under 26 °C (it's 29 °C here)",
    );
  });
});

describe('edit layer', () => {
  const generated: PlacedItem[] = [0, 1, 2].map((i) => ({
    uid: generatedUid('stones', i),
    category: 'stones',
    kind: 'boulder-medium',
    variant: 0,
    x: i,
    y: 0,
    z: 0,
    yaw: 0,
    scale: 1,
  }));

  it('applies removals, moves and additions on top of the generated valley', () => {
    const layer = createEditLayer();
    removeItem(layer, 'g:stones:1');
    moveItem(layer, 'g:stones:2', { x: 9, y: 1, z: 9, yaw: 1, scale: 2 });
    const uid = newUid(layer);
    addItem(layer, { ...generated[0]!, uid, x: 50 });
    const out = applyEdits(generated, layer);
    expect(out.map((i) => i.uid)).toEqual(['g:stones:0', 'g:stones:2', 'u1']);
    expect(out[1]!.x).toBe(9);
    expect(out[2]!.x).toBe(50);
  });

  it('round-trips through JSON and survives a re-add on undo', () => {
    const layer = createEditLayer();
    removeItem(layer, 'g:stones:0');
    addItem(layer, generated[0]!);
    expect(layer.removed).toEqual([]);
    const uid = newUid(layer);
    addItem(layer, { ...generated[1]!, uid });
    const removed = removeItem(layer, uid);
    expect(removed?.uid).toBe(uid);
    expect(layer.added).toEqual([]);
    const copy = validateEditLayer(JSON.parse(JSON.stringify(layer)));
    expect(copy).toEqual(layer);
    expect(() => validateEditLayer({ version: 9 })).toThrow();
  });
});

describe('picking', () => {
  const down: Ray = { ox: 0, oy: 100, oz: 0, dx: 0, dy: -1, dz: 0 };
  it('hits a height map', () => {
    const slope = (x: number) => x * 0.5;
    const ray: Ray = { ox: -50, oy: 40, oz: 0, dx: Math.SQRT1_2, dy: -Math.SQRT1_2, dz: 0 };
    const hit = rayHeight(ray, (x) => slope(x))!;
    expect(Math.abs(hit.y - slope(hit.x))).toBeLessThan(0.01);
    expect(rayHeight(down, () => 10)!.y).toBeCloseTo(10, 2);
  });

  it('hits water only where there is water', () => {
    const surface = (x: number) => (x > 5 ? 3 : null);
    const ray: Ray = { ox: 0, oy: 10, oz: 0, dx: 0.6, dy: -0.8, dz: 0 };
    const hit = rayHeight(ray, surface)!;
    expect(hit.x).toBeGreaterThan(5);
    expect(hit.y).toBeCloseTo(3, 2);
  });

  it('hits ellipsoids and cylinders, nearest first', () => {
    expect(rayEllipsoid(down, 0, 0, 0, 1, 2, 1)).toBeCloseTo(98);
    expect(rayEllipsoid(down, 5, 0, 0, 1, 1, 1)).toBeNull();
    expect(rayCylinder(down, 0, 0, 0, 0.5, 12)).toBeCloseTo(88);
    const side: Ray = { ox: -10, oy: 1, oz: 0, dx: 1, dy: 0, dz: 0 };
    expect(rayCylinder(side, 0, 0, 0, 0.5, 12)).toBeCloseTo(9.5);
    const pick = pickNearest(down, [
      { uid: 'far', shape: 'sphere', x: 0, y: 0, z: 0, rx: 1, ry: 1, rz: 1 },
      { uid: 'near', shape: 'cylinder', x: 0, y: 0, z: 0, rx: 0.4, ry: 20, rz: 0 },
    ]);
    expect(pick?.uid).toBe('near');
    expect(pickNearest(down, [{ uid: 'a', shape: 'sphere', x: 0, y: 0, z: 0, rx: 1, ry: 1, rz: 1 }], 50)).toBeNull();
  });
});

describe('brushes', () => {
  it('scatters with natural spacing inside the circle, the same for the same seed', () => {
    const a = scatterDab('dab', 10, 10, { radius: 4, density: 1 }, 1, 3);
    const b = scatterDab('dab', 10, 10, { radius: 4, density: 1 }, 1, 3);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(15);
    for (const p of a) expect(Math.hypot(p.x - 10, p.z - 10)).toBeLessThanOrEqual(4);
    for (let i = 0; i < a.length; i++)
      for (let j = i + 1; j < a.length; j++)
        expect(Math.hypot(a[i]!.x - a[j]!.x, a[i]!.z - a[j]!.z)).toBeGreaterThanOrEqual(1);
    const sparse = scatterDab('dab', 10, 10, { radius: 4, density: 0.2 }, 1, 3);
    expect(sparse.length).toBeLessThan(a.length / 2);
    const avoid = scatterDab('dab2', 10, 10, { radius: 4, density: 1 }, 1, 3, a);
    for (const p of avoid) for (const q of a) expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThanOrEqual(1);
  });

  it('erases what is inside the circle', () => {
    const items = [
      { uid: 'a', x: 0, z: 0 },
      { uid: 'b', x: 3, z: 0 },
      { uid: 'c', x: 0, z: 1.5 },
    ];
    expect(itemsInCircle(items, 0, 0, 2)).toEqual(['a', 'c']);
  });

  it('paints grass density within 0..1 with a soft edge', () => {
    const grid = { data: new Float32Array(21 * 21).fill(0.5), size: 21, cell: 1, originX: -10, originZ: -10 };
    applyGrassStroke(grid, { x: 0, z: 0, radius: 4, amount: 1 });
    expect(grid.data[10 * 21 + 10]).toBe(1);
    expect(grid.data[10 * 21 + 13]!).toBeGreaterThan(0.5);
    expect(grid.data[10 * 21 + 13]!).toBeLessThan(1);
    expect(grid.data[0]).toBe(0.5);
    applyGrassStroke(grid, { x: 0, z: 0, radius: 4, amount: -3 });
    expect(grid.data[10 * 21 + 10]).toBe(0);
  });
});

describe('temperature', () => {
  it('is warm before the monsoon, cool in winter, and water swings less than air', () => {
    expect(airTemperature(140, 14)).toBeGreaterThan(airTemperature(15, 14) + 10);
    const airSwing = airTemperature(100, 15) - airTemperature(100, 5);
    const w = (h: number) => waterTemperature({ dayOfYear: 100, hour: h, speed: 0.3, depth: 1 });
    expect(Math.abs(w(16) - w(4))).toBeLessThan(airSwing * 0.3);
  });

  it('runs warmer in the still pond than in fast water', () => {
    const base = { dayOfYear: 200, hour: 15, depth: 0.8 };
    expect(waterTemperature({ ...base, speed: 0, pond: true })).toBeGreaterThan(
      waterTemperature({ ...base, speed: 1.2 }) + 2,
    );
  });
});
