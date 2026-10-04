import { describe, expect, it } from 'vitest';
import {
  accumulationSamples,
  apertureRadius,
  depthOfField,
  focalLengthFromFov,
  fovFromFocalLength,
  lensShift,
  projectShifted,
  sunDiskDirection,
  SUN_RADIUS,
} from '../../src/photo/lens';
import { cameraAt, planTimelapse, INTERVALS, type Keyframe } from '../../src/photo/timelapse';
import { FILTERS, applyGrade, exposureFactor } from '../../src/photo/filters';
import { Ecology } from '../../src/sim/ecology/ecology';
import { testValley, lives } from './valleyFixture';

describe('the photo camera (plan 6.10)', () => {
  it('turns focal length into a field of view on a full-frame sensor', () => {
    expect(fovFromFocalLength(50)).toBeCloseTo(26.99, 1);
    expect(fovFromFocalLength(24)).toBeCloseTo(53.13, 1);
    expect(focalLengthFromFov(fovFromFocalLength(85))).toBeCloseTo(85);
    expect(apertureRadius(50, 2)).toBeCloseTo(0.0125);
  });

  it('has a shallower depth of field when the aperture opens', () => {
    const wide = depthOfField(85, 1.8, 5);
    const narrow = depthOfField(85, 11, 5);
    expect(wide.near).toBeLessThan(5);
    expect(wide.far).toBeGreaterThan(5);
    expect(wide.far - wide.near).toBeLessThan(narrow.far - narrow.near);
    // Focused beyond the hyperfocal distance, everything far is sharp.
    expect(depthOfField(24, 11, 50).far).toBe(Infinity);
  });

  it('keeps the focus plane sharp and blurs the rest across lens samples', () => {
    const fov = 30;
    const h = 2160;
    const focus = 8;
    const radius = apertureRadius(85, 2);
    const spread = (z: number) => {
      const xs: number[] = [];
      for (const s of accumulationSamples(64)) {
        const { eye, pixels } = lensShift({ x: s.lx, y: s.ly }, radius, focus, fov, h);
        xs.push(projectShifted([0.4, -0.2, z], eye, pixels, fov, h)[0]);
      }
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(spread(focus)).toBeLessThan(1e-6);
    expect(spread(2)).toBeGreaterThan(10);
    expect(spread(40)).toBeGreaterThan(5);
  });

  it('spreads its samples evenly: sub-pixel jitter, lens and sun disk', () => {
    const s = accumulationSamples(256);
    expect(s[0]).toEqual({ px: 0, py: 0, lx: 0, ly: 0, sx: 0, sy: 0 });
    const mean = (f: (x: (typeof s)[number]) => number) => s.reduce((a, x) => a + f(x), 0) / s.length;
    expect(Math.abs(mean((x) => x.px))).toBeLessThan(0.02);
    expect(Math.abs(mean((x) => x.lx))).toBeLessThan(0.03);
    for (const x of s) {
      expect(Math.abs(x.px)).toBeLessThanOrEqual(0.5);
      expect(Math.hypot(x.lx, x.ly)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.hypot(x.sx, x.sy)).toBeLessThanOrEqual(1 + 1e-9);
    }
    // Every quarter of the lens gets samples.
    const quads = new Set(s.slice(1).map((x) => `${x.lx > 0}${x.ly > 0}`));
    expect(quads.size).toBe(4);
  });

  it('jitters the sun within its disk', () => {
    const sun: [number, number, number] = [0.3, 0.8, 0.52];
    const l = Math.hypot(...sun);
    const dir = sun.map((v) => v / l) as [number, number, number];
    const edge = sunDiskDirection(dir, 1, 0);
    const angle = Math.acos(edge[0] * dir[0] + edge[1] * dir[1] + edge[2] * dir[2]);
    expect(angle).toBeCloseTo(SUN_RADIUS, 4);
    expect(Math.hypot(...edge)).toBeCloseTo(1);
  });
});

describe('time-lapse (plan 6.10)', () => {
  it('plans a frame for every interval of the span', () => {
    const year = planTimelapse(1000, 'year', INTERVALS.year[0]!.seconds);
    expect(year.frameTimes).toHaveLength(366);
    expect(year.frameTimes[1]! - year.frameTimes[0]!).toBe(86400);
    expect(year.videoSeconds).toBeCloseTo(12.2, 1);
    const day = planTimelapse(0, 'day', 120);
    expect(day.frameTimes.at(-1)).toBe(86400);
  });

  it('moves the camera smoothly through its keyframes, the short way round', () => {
    const k = (x: number, yaw: number): Keyframe => ({ x, y: 2, z: 0, yaw, pitch: 0, fov: 50 });
    const keys = [k(0, 3), k(10, -3), k(20, -2.5)];
    expect(cameraAt(keys, 0).x).toBeCloseTo(0);
    expect(cameraAt(keys, 1).x).toBeCloseTo(20);
    expect(cameraAt(keys, 0.5).x).toBeCloseTo(10);
    // From yaw 3 to −3 is a small turn across ±π, not a full spin.
    const mid = cameraAt(keys.slice(0, 2), 0.5).yaw;
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.3);
    let last = cameraAt(keys, 0).x;
    for (let u = 0.01; u <= 1; u += 0.01) {
      const x = cameraAt(keys, u).x;
      expect(x - last).toBeGreaterThanOrEqual(-1e-9);
      expect(x - last).toBeLessThan(0.6);
      last = x;
    }
    expect(cameraAt([k(5, 1)], 0.7)).toEqual(k(5, 1));
  });

  it("recording doesn't change the simulation: frame-by-frame steps give the same valley as one long run", () => {
    const start = 120 * 86400;
    const plan = planTimelapse(start, 'season', INTERVALS.season[0]!.seconds);
    const recorded = new Ecology({ seed: 'lapse', stretches: testValley(), species: lives, startSeconds: start });
    for (let f = 1; f < plan.frameTimes.length; f++) recorded.advance(plan.frameTimes[f]! - plan.frameTimes[f - 1]!);
    const straight = new Ecology({ seed: 'lapse', stretches: testValley(), species: lives, startSeconds: start });
    straight.advance(plan.frameTimes.at(-1)! - start);
    expect(recorded.hash()).toBe(straight.hash());
  });
});

describe('filters', () => {
  it('stay natural: mono is grey, warm is warmer, natural barely changes', () => {
    const c: [number, number, number] = [0.4, 0.3, 0.2];
    const mono = applyGrade(c, FILTERS.mono.grade);
    expect(mono[0]).toBeCloseTo(mono[1]);
    expect(mono[1]).toBeCloseTo(mono[2]);
    const warm = applyGrade([0.3, 0.3, 0.3], FILTERS.warm.grade);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const natural = applyGrade(c, FILTERS.natural.grade);
    natural.forEach((v, i) => expect(Math.abs(v - c[i]!)).toBeLessThan(0.05));
    expect(exposureFactor(1)).toBe(2);
    expect(exposureFactor(-1)).toBe(0.5);
  });
});
