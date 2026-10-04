import { describe, expect, it } from 'vitest';
import { Noise, brightness, rms, zeroCrossingRate } from '../../src/audio/dsp/core';
import { WaterSynth, type WaterParams } from '../../src/audio/dsp/water';
import { WindSynth, type WindParams } from '../../src/audio/dsp/wind';
import { RainSynth } from '../../src/audio/dsp/rain';
import { footstep, renderCall, splash, thunder, type Surface } from '../../src/audio/dsp/calls';
import {
  AmbienceScheduler,
  ambienceLevels,
  emitterSections,
  footstepSurface,
  rainShares,
  riverMix,
  underwaterFilter,
  type AmbienceInput,
} from '../../src/audio/scene';

const SR = 48000;

function water(params: Partial<WaterParams>, seconds = 2, seed = 1): Float32Array {
  const synth = new WaterSynth(SR, seed);
  synth.set({ rapids: 0, riffle: 0, pool: 0, fall: 0, gain: 1, ...params });
  const out = new Float32Array(SR * seconds);
  // Render in worklet-sized blocks, skipping the first half second while the parameters ease in.
  const block = new Float32Array(128);
  for (let i = 0; i < out.length; i += 128) {
    synth.render(block);
    out.set(block.subarray(0, Math.min(128, out.length - i)), i);
  }
  return out.subarray(SR / 2);
}

function wind(params: Partial<WindParams>, seconds = 2): [Float32Array, Float32Array] {
  const synth = new WindSynth(SR, 7);
  synth.set({ speed: 0, gust: 1, leaves: 0, bamboo: 0, pines: 0, grass: 0, gain: 1, ...params });
  const l = new Float32Array(SR * seconds);
  const r = new Float32Array(SR * seconds);
  const bl = new Float32Array(128);
  const br = new Float32Array(128);
  for (let i = 0; i < l.length; i += 128) {
    synth.render(bl, br);
    l.set(bl.subarray(0, Math.min(128, l.length - i)), i);
    r.set(br.subarray(0, Math.min(128, r.length - i)), i);
  }
  return [l.subarray(SR / 2), r.subarray(SR / 2)];
}

/** Correlation of two equal-length signals (−1..1). */
function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return ab / Math.sqrt(aa * bb + 1e-12);
}

function finiteAndBounded(data: Float32Array): void {
  for (const v of data) {
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(1);
  }
}

describe('the stream (plan 6.9)', () => {
  it('rapids roar louder than riffles, and riffles babble brighter than pools', () => {
    const rapids = water({ rapids: 1, gain: 1 });
    const riffle = water({ riffle: 1, gain: 1 });
    const pool = water({ pool: 1, gain: 1 });
    expect(rms(rapids)).toBeGreaterThan(rms(riffle));
    expect(rms(riffle)).toBeGreaterThan(rms(pool));
    expect(zeroCrossingRate(riffle, SR)).toBeGreaterThan(zeroCrossingRate(pool, SR));
    for (const d of [rapids, riffle, pool]) finiteAndBounded(d);
  });

  it('is silent at zero gain and follows the water speed', () => {
    expect(rms(water({ riffle: 1, gain: 0 }))).toBeLessThan(1e-4);
    const slow = riverMix(0.3, 0.05, 0.6);
    const fast = riverMix(1.4, 0.4, 0.5);
    expect(fast.gain).toBeGreaterThan(slow.gain * 1.8);
    expect(slow.pool).toBeGreaterThan(slow.rapids);
    expect(fast.rapids + fast.riffle).toBeGreaterThan(fast.pool);
    expect(riverMix(1, 0, 0.01).gain).toBe(0);
  });

  it('never repeats: no loop in the generated water', () => {
    const d = water({ riffle: 0.6, rapids: 0.4, gain: 1 }, 6);
    const n = SR;
    // Compare one second against later seconds: a looping sample would correlate strongly.
    for (const lag of [SR, 2 * SR, 3 * SR, 4 * SR]) {
      expect(Math.abs(correlation(d.subarray(0, n), d.subarray(lag, lag + n)))).toBeLessThan(0.1);
    }
    // Different seeds sound different.
    const other = water({ riffle: 0.6, rapids: 0.4, gain: 1 }, 2, 99);
    expect(Math.abs(correlation(d.subarray(0, n), other.subarray(0, n)))).toBeLessThan(0.1);
  });

  it('slides its emitters along the stream with you', () => {
    const a = emitterSections(500, 2000, 8, 24);
    expect(a).toHaveLength(8);
    expect(a[0]).toBeCloseTo(500 - 3.5 * 24);
    const b = emitterSections(510, 2000, 8, 24);
    // A small step moves every emitter a little, none jumps.
    a.forEach((s, k) => expect(Math.abs(b[k]! - s)).toBeCloseTo(10));
    const end = emitterSections(1995, 2000, 8, 24);
    expect(Math.max(...end)).toBeLessThanOrEqual(1999);
    expect(new Set(end).size).toBe(8);
  });
});

describe('wind and rain', () => {
  it('blows louder with the wind slider, in stereo', () => {
    const calm = wind({ speed: 2, gain: 1 });
    const storm = wind({ speed: 18, gust: 1.4, gain: 1 });
    expect(rms(storm[0])).toBeGreaterThan(rms(calm[0]) * 3);
    // Two independent channels: wide, not a mono copy.
    expect(Math.abs(correlation(storm[0], storm[1]))).toBeLessThan(0.5);
    finiteAndBounded(storm[0]);
  });

  it('rustles by plant: bamboo knocks stand out above the wind', () => {
    const plain = wind({ speed: 10, gust: 1.3, gain: 1 });
    const bamboo = wind({ speed: 10, gust: 1.3, bamboo: 1, gain: 1 });
    const leaves = wind({ speed: 10, gust: 1.3, leaves: 1, gain: 1 });
    const peak = (d: Float32Array) => d.reduce((m, v) => Math.max(m, Math.abs(v)), 0) / rms(d);
    expect(rms(bamboo[0])).toBeGreaterThan(rms(plain[0]));
    expect(zeroCrossingRate(leaves[0], SR)).toBeGreaterThan(zeroCrossingRate(plain[0], SR) * 1.5);
    expect(peak(bamboo[0])).toBeGreaterThan(2.5);
  });

  it('rains harder with the rain rate, and is silent without rain', () => {
    const run = (rate: number, shares = { leaves: 0.4, rock: 0.3, water: 0.3 }) => {
      const synth = new RainSynth(SR, 3);
      synth.set({ rate, gain: 1, ...shares });
      const l = new Float32Array(SR);
      const r = new Float32Array(SR);
      for (let k = 0; k < 2; k++) synth.render(l, r);
      return l;
    };
    expect(rms(run(0))).toBeLessThan(1e-3);
    expect(rms(run(30))).toBeGreaterThan(rms(run(3)) * 1.5);
    finiteAndBounded(run(30));
    const s = rainShares(0.8, 0.1);
    expect(s.leaves).toBeGreaterThan(s.water);
    expect(s.leaves + s.water + s.rock).toBeCloseTo(1);
    expect(rainShares(0, 1).water).toBeGreaterThan(0.6);
  });
});

describe('calls, thunder and footsteps', () => {
  it('never sings the same call twice', () => {
    const noise = new Noise(5);
    for (const kind of ['thrush', 'songbird', 'kingfisher', 'cicada', 'frog'] as const) {
      const a = renderCall(kind, SR, noise);
      const b = renderCall(kind, SR, noise);
      expect(a.length, kind).toBeGreaterThan(SR * 0.05);
      expect(a.length, kind).toBeLessThan(SR * 10);
      const n = Math.min(a.length, b.length);
      const same = a.length === b.length && Math.abs(correlation(a.subarray(0, n), b.subarray(0, n))) > 0.95;
      expect(same, kind).toBe(false);
      expect(rms(a), kind).toBeGreaterThan(0.005);
      for (const v of a) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('thunder rumbles low from afar and cracks up close', () => {
    const noise = new Noise(8);
    const near = thunder(SR, noise, 400);
    const far = thunder(SR, noise, 4000);
    expect(near.length).toBeGreaterThan(SR * 3);
    expect(zeroCrossingRate(near.subarray(0, SR / 4), SR)).toBeGreaterThan(
      zeroCrossingRate(far.subarray(0, SR / 4), SR),
    );
    expect(rms(near)).toBeGreaterThan(rms(far));
  });

  it('footsteps sound different on each surface', () => {
    const noise = new Noise(9);
    const surfaces: Surface[] = ['gravel', 'moss', 'mud', 'leaves', 'grass', 'rock', 'water'];
    const zcr = new Map(surfaces.map((s) => [s, brightness(footstep(SR, noise, s), SR)]));
    expect(zcr.get('gravel')!).toBeGreaterThan(zcr.get('moss')!);
    expect(zcr.get('leaves')!).toBeGreaterThan(zcr.get('grass')!);
    expect(footstep(SR, noise, 'water').length).toBeGreaterThan(footstep(SR, noise, 'grass').length);
    expect(rms(splash(SR, noise, 0.8))).toBeGreaterThan(rms(splash(SR, noise, 0.1)));
  });

  it('knows what your feet are on', () => {
    const g = { waterDepth: 0, riverDistance: 20, slope: 0.1, wetness: 0.3, forest: 0, rainWet: 0 };
    expect(footstepSurface({ ...g, waterDepth: 0.2 })).toBe('water');
    expect(footstepSurface({ ...g, riverDistance: 1 })).toBe('gravel');
    expect(footstepSurface({ ...g, slope: 0.7 })).toBe('rock');
    expect(footstepSurface({ ...g, forest: 0.8 })).toBe('leaves');
    expect(footstepSurface({ ...g, forest: 0.8, wetness: 0.8 })).toBe('moss');
    expect(footstepSurface({ ...g, rainWet: 0.8 })).toBe('mud');
    expect(footstepSurface(g)).toBe('grass');
  });

  it('muffles the world underwater, more the deeper you go', () => {
    expect(underwaterFilter(0).cutoff).toBe(20000);
    expect(underwaterFilter(0.3).cutoff).toBeLessThan(1000);
    expect(underwaterFilter(1.5).cutoff).toBeLessThan(underwaterFilter(0.3).cutoff);
  });
});

describe('who sings when', () => {
  const base: AmbienceInput = {
    hour: 6.3,
    season: { winter: 0, spring: 1, premonsoon: 0, monsoon: 0, autumn: 0 },
    airTemp: 15,
    rain: 0,
    wind: 2,
    nearWater: 0.5,
  };
  const monsoon = { winter: 0, spring: 0, premonsoon: 0, monsoon: 1, autumn: 0 };

  it('birds sing the dawn chorus, thrushes at dawn, nothing at midnight', () => {
    const dawn = ambienceLevels(base);
    const noon = ambienceLevels({ ...base, hour: 13 });
    const night = ambienceLevels({ ...base, hour: 0 });
    expect(dawn.birds).toBeGreaterThan(noon.birds * 1.5);
    expect(dawn.thrush).toBeGreaterThan(noon.thrush * 5);
    expect(night.birds).toBeLessThan(0.05);
    expect(ambienceLevels({ ...base, rain: 30 }).birds).toBeLessThan(dawn.birds * 0.3);
  });

  it('cicadas on hot afternoons before and in the monsoon; frogs on monsoon nights', () => {
    const hot = ambienceLevels({ ...base, hour: 14, airTemp: 28, season: { ...monsoon, monsoon: 0, premonsoon: 1 } });
    const winter = ambienceLevels({ ...base, hour: 14, airTemp: 12, season: { ...monsoon, monsoon: 0, winter: 1 } });
    expect(hot.cicadas).toBeGreaterThan(2);
    expect(winter.cicadas).toBe(0);
    const frogs = ambienceLevels({ ...base, hour: 22, season: monsoon, rain: 5, nearWater: 1 });
    expect(frogs.frogs).toBeGreaterThan(10);
    expect(ambienceLevels({ ...base, hour: 13, season: monsoon }).frogs).toBeLessThan(1);
  });

  it('schedules calls at random moments at the right rate', () => {
    const s = new AmbienceScheduler(new Noise(4));
    let birds = 0;
    for (let t = 0; t < 600; t += 0.05)
      for (const e of s.step(0.05, { birds: 6, thrush: 0, cicadas: 0, frogs: 0 })) if (e.kind === 'songbird') birds++;
    // 6 a minute for 10 minutes.
    expect(birds).toBeGreaterThan(40);
    expect(birds).toBeLessThan(85);
  });
});
