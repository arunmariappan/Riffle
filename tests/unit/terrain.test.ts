import { describe, expect, it } from 'vitest';
import { distanceTransform } from '../../src/sim/terrain/edt';
import { sampleHeight } from '../../src/sim/terrain/heightfield';
import { generateValley } from '../../src/sim/terrain/valley';
import { createRng } from '../../src/sim/rng';

describe('distance transform', () => {
  it('matches brute force', () => {
    const w = 37;
    const h = 29;
    const rng = createRng(5);
    const seeds = new Uint8Array(w * h);
    const points: [number, number][] = [];
    for (let k = 0; k < 9; k++) {
      const x = rng.int(0, w);
      const y = rng.int(0, h);
      seeds[y * w + x] = 1;
      points.push([x, y]);
    }
    const dt = distanceTransform(seeds, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const brute = Math.min(...points.map(([px, py]) => Math.hypot(px - x, py - y)));
        expect(dt.distance[y * w + x]).toBeCloseTo(brute, 5);
        const nearest = dt.nearest[y * w + x] as number;
        const nx = nearest % w;
        const ny = Math.floor(nearest / w);
        expect(Math.hypot(nx - x, ny - y)).toBeCloseTo(brute, 5);
      }
    }
  });
});

describe('valley generator', () => {
  const small = { size: 257, cell: 4, droplets: 6000 };

  it('is reproducible: the same seed gives the same valley', () => {
    const a = generateValley({ seed: 'riffle', ...small });
    const b = generateValley({ seed: 'riffle', ...small });
    expect(a.heightfield.heights).toEqual(b.heightfield.heights);
    const c = generateValley({ seed: 'other', ...small });
    expect(c.heightfield.heights).not.toEqual(a.heightfield.heights);
  });

  it('carves a channel below its banks along the whole stream', () => {
    const v = generateValley({ seed: 'riffle', droplets: 30000 });
    const { path, profile } = v;
    let checked = 0;
    for (let i = 20; i < path.count - 20; i += 97) {
      if (Math.abs(i - profile.waterfall.section) < 30 || Math.abs(i - v.pond.section) < 40) continue;
      const x = path.points[i * 2] as number;
      const z = path.points[i * 2 + 1] as number;
      const nx = path.normals[i * 2] as number;
      const nz = path.normals[i * 2 + 1] as number;
      const off = (profile.halfWidth[i] as number) + 6;
      const center = sampleHeight(v.heightfield, x, z);
      const left = sampleHeight(v.heightfield, x - nx * off, z - nz * off);
      const right = sampleHeight(v.heightfield, x + nx * off, z + nz * off);
      expect(center).toBeLessThan(left - 0.4);
      expect(center).toBeLessThan(right - 0.4);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('has a waterfall drop, a deeper pool and a pond basin', () => {
    const v = generateValley({ seed: 'riffle', ...small });
    const { profile, pond } = v;
    const w = profile.waterfall.section;
    expect((profile.thalweg[w - 2] as number) - (profile.thalweg[w + 2] as number)).toBeGreaterThan(
      profile.waterfall.drop * 0.9,
    );
    const pool = profile.zones.find((z) => z.name === 'pool')!;
    const poolMid = Math.round((pool.start + pool.end) / 2);
    const poolDepth = (profile.bank[poolMid] as number) - (profile.thalweg[poolMid] as number);
    const riffles = profile.zones.find((z) => z.name === 'riffles')!;
    const riffleMid = Math.round((riffles.start + riffles.end) / 2);
    const riffleDepth = (profile.bank[riffleMid] as number) - (profile.thalweg[riffleMid] as number);
    expect(poolDepth).toBeGreaterThan(riffleDepth + 1);
    const bottom = sampleHeight(v.heightfield, pond.x, pond.z);
    const rim = sampleHeight(v.heightfield, pond.x + pond.radius + 12, pond.z);
    expect(bottom).toBeLessThan(rim - 1);
  });

  it('keeps every height finite and the slopes rising to ridges', () => {
    const v = generateValley({ seed: 'riffle', ...small });
    let min = Infinity;
    let max = -Infinity;
    for (const value of v.heightfield.heights) {
      expect(Number.isFinite(value)).toBe(true);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    expect(min).toBeGreaterThan(0);
    expect(max).toBeGreaterThan(200);
    expect(max).toBeLessThan(900);
    expect(v.spots).toHaveLength(6);
  });

  it('generates the full 1025² valley in reasonable time', () => {
    const start = performance.now();
    const v = generateValley({ seed: 'riffle' });
    const ms = performance.now() - start;
    console.log(`full valley: ${ms.toFixed(0)} ms, ${v.path.count} sections`);
    expect(v.heightfield.size).toBe(1025);
    expect(ms).toBeLessThan(20_000);
  });
});
