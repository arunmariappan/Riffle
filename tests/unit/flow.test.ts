import { describe, expect, it } from 'vitest';
import { FlowField, type Stone } from '../../src/sim/flow/field';
import { buildRiverPath } from '../../src/sim/flow/path';

/** A straight 200 m test channel along +z with a pool and a riffle (plan Phase 0, task 5). */
function testBed(x: number, z: number): number {
  const along = -0.003 * z; // gentle downhill toward +z
  const pool = z > -25 && z < 15 ? -0.9 * Math.sin((Math.PI * (z + 25)) / 40) : 0;
  const riffle = z > 35 && z < 60 ? 0.45 * Math.sin((Math.PI * (z - 35)) / 25) : 0;
  const ax = Math.abs(x);
  const channel = ax < 5 ? -1.2 * (1 - (ax / 5) ** 2) : (ax - 5) * 0.6;
  return along + pool + riffle + channel;
}

function makeField(stones: Stone[] = []): FlowField {
  const path = buildRiverPath(
    [
      { x: 0, z: -100 },
      { x: 0, z: 0 },
      { x: 0, z: 100 },
    ],
    0.5,
  );
  const field = new FlowField(path, testBed, { cellsAcross: 33, dn: 0.5 });
  field.setDischarge(3);
  field.setStones(stones);
  field.solve();
  return field;
}

const STONES: Stone[] = [
  { id: 1, x: 1, z: -60, radius: 0.7, height: 0.9 },
  { id: 2, x: -1.5, z: 0, radius: 0.8, height: 1.0 },
  { id: 3, x: 2, z: 70, radius: 0.6, height: 0.7 },
];

function sectionAt(field: FlowField, z: number): number {
  return Math.round((z + 100) / field.ds);
}

/** This path's normal points toward -x, so the across-stream offset of world x is -x. */
function offsetOf(x: number): number {
  return -x;
}

function unitDischarge(field: FlowField, i: number, offset: number): number {
  const j = Math.round(offset / field.dn + (field.nn - 1) / 2);
  const idx = field.index(i, j);
  return (field.velAlong[idx] as number) * Math.max(field.depth[idx] as number, 0.05);
}

describe('flow solver', () => {
  it('conserves the discharge through every cross-section away from stones', () => {
    const field = makeField();
    for (const z of [-80, -40, 0, 30, 50, 80]) {
      const measured = field.measuredDischarge(sectionAt(field, z));
      expect(measured).toBeGreaterThan(3 * 0.97);
      expect(measured).toBeLessThan(3 * 1.03);
    }
  });

  it('runs fast in the deep channel and slow at the shallow edges', () => {
    const field = makeField();
    const i = sectionAt(field, -70);
    const center = field.sample(i, 0);
    const edge = field.sample(i, 4.2);
    expect(center).not.toBeNull();
    expect(edge).not.toBeNull();
    const centerSpeed = Math.hypot(center!.velocityX, center!.velocityZ);
    const edgeSpeed = Math.hypot(edge!.velocityX, edge!.velocityZ);
    expect(centerSpeed).toBeGreaterThan(edgeSpeed * 1.5);
    // Flow goes downstream (+z).
    expect(center!.velocityZ).toBeGreaterThan(0.1);
  });

  it('holds a deeper, slower pool and a shallow, faster riffle', () => {
    const field = makeField();
    const pool = field.sample(sectionAt(field, -5), 0)!;
    const riffle = field.sample(sectionAt(field, 47), 0)!;
    expect(pool.depth).toBeGreaterThan(riffle.depth);
    expect(Math.hypot(riffle.velocityX, riffle.velocityZ)).toBeGreaterThan(Math.hypot(pool.velocityX, pool.velocityZ));
  });

  it('routes water around a stone and leaves a calm wake behind it', () => {
    const plain = makeField();
    const withStones = makeField(STONES);
    const stone = STONES[0]!;
    const atStone = sectionAt(withStones, stone.z);
    // Less water passes over the stone than over the same spot without it...
    expect(unitDischarge(withStones, atStone, offsetOf(stone.x))).toBeLessThan(
      unitDischarge(plain, atStone, offsetOf(stone.x)) * 0.5,
    );
    // ...and more passes beside it.
    const beside = offsetOf(stone.x - stone.radius * 2);
    expect(unitDischarge(withStones, atStone, beside)).toBeGreaterThan(unitDischarge(plain, atStone, beside) * 1.02);
    // Behind the stone: shelter, slower water.
    const behind = withStones.sample(sectionAt(withStones, stone.z + stone.radius * 2.5), offsetOf(stone.x))!;
    const behindPlain = plain.sample(sectionAt(plain, stone.z + stone.radius * 2.5), offsetOf(stone.x))!;
    expect(behind.shelter).toBeGreaterThan(0.2);
    expect(Math.hypot(behind.velocityX, behind.velocityZ)).toBeLessThan(
      Math.hypot(behindPlain.velocityX, behindPlain.velocityZ),
    );
  });

  it('raises the water and speeds it up when the discharge grows', () => {
    const field = makeField();
    const i = sectionAt(field, -70);
    const before = field.sample(i, 0)!;
    field.setDischarge(6);
    field.solve();
    const after = field.sample(i, 0)!;
    expect(after.surface).toBeGreaterThan(before.surface + 0.05);
    expect(Math.hypot(after.velocityX, after.velocityZ)).toBeGreaterThan(
      Math.hypot(before.velocityX, before.velocityZ),
    );
    expect(field.measuredDischarge(i)).toBeCloseTo(6, 0);
  });

  it('re-solves locally in under 100 ms after a stone moves', () => {
    const field = makeField(STONES);
    const moved = STONES.map((s) => (s.id === 2 ? { ...s, x: 1.0, z: 5 } : s));
    field.setStones(moved);
    const stats = field.solveLocal(1.0, 5, 3);
    expect(stats.milliseconds).toBeLessThan(100);
    expect(stats.residual).toBeLessThan(1e-4);
    // Conservation still holds away from the stones after the local solve.
    expect(field.measuredDischarge(sectionAt(field, 30))).toBeCloseTo(3, 1);
  });

  it('keeps every value finite', () => {
    const field = makeField(STONES);
    for (const arr of [field.velX, field.velZ, field.depth, field.foam, field.shelter]) {
      for (const v of arr) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
