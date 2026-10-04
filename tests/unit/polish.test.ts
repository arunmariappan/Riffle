import { describe, expect, it } from 'vitest';
import { ResolutionController } from '../../src/perf/resolution';
import { recoveryPlan } from '../../src/app/recovery';
import { defaultPreferences, normalizePreferences } from '../../src/state/preferences';
import { QUALITY, QUALITY_PRESETS, isQualityPreset } from '../../src/state/quality';
import { colormapHex, colormapRgb } from '../../src/builder/colormap';

/** Runs the controller for `seconds` at 60 updates a second with a frame time from `ms(scale)`. */
function run(c: ResolutionController, seconds: number, ms: (scale: number) => number): number[] {
  const scales: number[] = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    c.update(ms(c.scale), 1 / 60);
    scales.push(c.scale);
  }
  return scales;
}

describe('dynamic resolution (Phase 9)', () => {
  it('drops the resolution when frames run over budget, until they fit', () => {
    const c = new ResolutionController({ min: 0.5, max: 1 });
    // GPU time grows with the pixel count (scale²): 24 ms at full resolution.
    run(c, 20, (s) => 24 * s * s);
    expect(c.scale).toBeLessThan(0.9);
    expect(24 * c.scale * c.scale).toBeLessThan((1000 / 60) * 1.08);
    expect(c.scale).toBeGreaterThanOrEqual(0.5);
  });

  it('climbs back when there is room, without hunting up and down', () => {
    const c = new ResolutionController({ min: 0.5, max: 1 });
    run(c, 10, () => 30);
    const low = c.scale;
    expect(low).toBeLessThan(0.7);
    const scales = run(c, 60, (s) => 9 * s * s);
    expect(c.scale).toBe(1);
    // It only ever went up on the way.
    for (let i = 1; i < scales.length; i++) expect(scales[i]!).toBeGreaterThanOrEqual(scales[i - 1]!);
    // At a load that just fits, it settles instead of oscillating.
    const steady = new ResolutionController({ min: 0.5, max: 1 });
    const trace = run(steady, 60, (s) => 15.5 * s * s);
    const changes = trace.filter((v, i) => i > 0 && v !== trace[i - 1]).length;
    expect(changes).toBeLessThanOrEqual(1);
  });

  it('ignores a single slow frame (a shader compiling)', () => {
    const c = new ResolutionController({ min: 0.5, max: 1 });
    run(c, 2, () => 10);
    c.update(400, 1 / 60);
    run(c, 0.3, () => 10);
    expect(c.scale).toBe(1);
  });
});

describe('a lost GPU device (Phase 9)', () => {
  it('reloads from the autosave at the same quality the first time', () => {
    const plan = recoveryPlan([], 1_000_000, 'high', 'device reset');
    expect(plan.quality).toBe('high');
    expect(plan.search).toContain('continue');
    expect(plan.search).toContain('quality=high');
    expect(plan.message).toContain('device reset');
    expect(plan.history).toEqual([1_000_000]);
  });

  it('drops a preset when it happens again soon, but not after a long while', () => {
    expect(recoveryPlan([1_000_000], 1_060_000, 'ultra', 'x').quality).toBe('high');
    expect(recoveryPlan([1_000_000], 1_060_000, 'low', 'x').quality).toBe('low');
    expect(recoveryPlan([0], 3_600_000, 'high', 'x').quality).toBe('high');
  });
});

describe('preferences and presets', () => {
  it('clamps hand-edited or damaged preferences', () => {
    const p = normalizePreferences({
      fov: 300,
      mouseSensitivity: -2,
      maxFps: 144,
      quality: 'cinematic',
      invertY: 'yes',
    });
    expect(p.fov).toBe(100);
    expect(p.mouseSensitivity).toBe(0.3);
    expect(p.maxFps).toBe(60);
    expect(p.quality).toBeNull();
    expect(p.invertY).toBe(false);
    expect(normalizePreferences(null)).toEqual(defaultPreferences());
    expect(normalizePreferences({ quality: 'low', maxFps: 30 })).toMatchObject({ quality: 'low', maxFps: 30 });
  });

  it('has presets that grow from Low to Ultra', () => {
    for (let i = 1; i < QUALITY_PRESETS.length; i++) {
      const a = QUALITY[QUALITY_PRESETS[i - 1]!];
      const b = QUALITY[QUALITY_PRESETS[i]!];
      expect(b.renderScale).toBeGreaterThanOrEqual(a.renderScale);
      expect(b.grass).toBeGreaterThan(a.grass);
      expect(b.fishBudget).toBeGreaterThan(a.fishBudget);
      expect(b.minRenderScale).toBeLessThan(b.renderScale);
    }
    expect(isQualityPreset('ultra')).toBe(true);
    expect(isQualityPreset('epic')).toBe(false);
  });

  it('maps overlay values to the color scale', () => {
    expect(colormapHex(0)).toBe('#440154');
    expect(colormapHex(1)).toBe('#fde725');
    const mid = colormapRgb(0.5);
    expect(mid[1]).toBeGreaterThan(mid[0]);
  });
});
