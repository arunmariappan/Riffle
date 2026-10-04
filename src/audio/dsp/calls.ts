/**
 * One-shot nature sounds, generated fresh every time so no two are the same (plan 6.9): the whistling thrush's
 * human-like song at dawn, small songbirds, the kingfisher's sharp call, cicadas on hot afternoons, frogs on monsoon
 * nights, fish splashes, thunder and footsteps by surface. Each returns mono samples. Pure TypeScript.
 */
import { Biquad, BubbleBank, Brown, Noise, OnePole } from './core';

export type CallKind = 'thrush' | 'songbird' | 'kingfisher' | 'cicada' | 'frog';
export type Surface = 'gravel' | 'moss' | 'mud' | 'leaves' | 'grass' | 'rock' | 'water';

/** A short attack and release so notes never click. */
function envelope(t: number, length: number, attack = 0.01, release = 0.04): number {
  if (t < 0 || t > length) return 0;
  return Math.min(1, t / attack, (length - t) / release);
}

/** A whistled note gliding from `f0` to `f1`, with a touch of vibrato and a soft second harmonic. */
function note(
  out: Float32Array,
  sr: number,
  start: number,
  length: number,
  f0: number,
  f1: number,
  amp: number,
  vibrato = 0,
  vibratoRate = 30,
  harmonic = 0.08,
): void {
  const i0 = Math.max(0, Math.floor(start * sr));
  const i1 = Math.min(out.length, Math.floor((start + length) * sr));
  let phase = 0;
  for (let i = i0; i < i1; i++) {
    const t = i / sr - start;
    const u = t / length;
    // A smooth glide (ease in and out).
    const f = (f0 + (f1 - f0) * (u * u * (3 - 2 * u))) * (1 + vibrato * Math.sin(2 * Math.PI * vibratoRate * t));
    phase += (2 * Math.PI * f) / sr;
    out[i] = (out[i] as number) + amp * envelope(t, length) * (Math.sin(phase) + harmonic * Math.sin(2 * phase));
  }
}

/** The whistling thrush: a run of rich, rising and falling whistles, like someone whistling a tune. */
export function thrushSong(sr: number, noise: Noise): Float32Array {
  const notes = 3 + Math.floor(noise.next() * 6);
  const parts: [number, number, number, number][] = [];
  let t = 0.02;
  let f = noise.range(1500, 2400);
  for (let k = 0; k < notes; k++) {
    const length = noise.range(0.1, 0.32);
    const to = Math.min(3400, Math.max(1100, f * noise.range(0.75, 1.35)));
    parts.push([t, length, f, to]);
    t += length + noise.range(0.03, 0.14);
    f = to * noise.range(0.85, 1.2);
  }
  const out = new Float32Array(Math.ceil((t + 0.05) * sr));
  for (const [start, length, f0, f1] of parts) note(out, sr, start, length, f0, f1, 0.45, 0.012, noise.range(18, 32));
  return out;
}

/** A small songbird: a trill of fast chirps, a warble, or a two-note call. */
export function songbirdCall(sr: number, noise: Noise): Float32Array {
  const kind = noise.next();
  if (kind < 0.4) {
    const chirps = 4 + Math.floor(noise.next() * 10);
    const gap = noise.range(0.045, 0.09);
    const out = new Float32Array(Math.ceil((chirps * gap + 0.1) * sr));
    const hi = noise.range(4500, 7000);
    const lo = hi * noise.range(0.45, 0.7);
    for (let k = 0; k < chirps; k++)
      note(out, sr, 0.01 + k * gap, gap * 0.6, hi, lo, 0.3 * (0.7 + 0.3 * Math.sin(k)), 0, 1, 0.02);
    return out;
  }
  if (kind < 0.75) {
    const length = noise.range(0.4, 1.1);
    const out = new Float32Array(Math.ceil((length + 0.05) * sr));
    const base = noise.range(2800, 4500);
    note(
      out,
      sr,
      0.01,
      length,
      base,
      base * noise.range(0.9, 1.15),
      0.3,
      noise.range(0.08, 0.16),
      noise.range(14, 28),
      0.15,
    );
    return out;
  }
  const out = new Float32Array(Math.ceil(0.55 * sr));
  const a = noise.range(3000, 4200);
  note(out, sr, 0.01, 0.16, a, a * 1.05, 0.35);
  note(out, sr, 0.24, 0.2, a * noise.range(0.72, 0.85), a * noise.range(0.68, 0.8), 0.3);
  return out;
}

/** The kingfisher's call: one to three sharp, high "chee" notes with a harsh edge. */
export function kingfisherCall(sr: number, noise: Noise): Float32Array {
  const count = 1 + Math.floor(noise.next() * 3);
  const out = new Float32Array(Math.ceil((count * 0.2 + 0.05) * sr));
  for (let k = 0; k < count; k++) {
    const f = noise.range(6200, 7600);
    note(out, sr, 0.01 + k * 0.2, noise.range(0.09, 0.14), f, f * 0.88, 0.3, 0.03, 90, 0.3);
  }
  // A little breath noise makes it rasp.
  const bp = new Biquad().bandpass(6800, 3, sr);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * (1 + 0.6 * bp.process(noise.white()));
  return out;
}

/** A cicada's song: a buzzing band of noise pulsed hundreds of times a second, swelling and fading. */
export function cicadaSong(sr: number, noise: Noise, seconds = noise.range(3, 9)): Float32Array {
  const out = new Float32Array(Math.ceil(seconds * sr));
  const band = new Biquad().bandpass(noise.range(4300, 6200), 5, sr);
  const pulse = noise.range(140, 260);
  const throb = noise.next() < 0.5 ? noise.range(1.5, 4) : 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const swell = Math.min(1, t / 0.8, (seconds - t) / 1.2);
    const p = Math.pow(Math.abs(Math.sin(Math.PI * pulse * t)), 4);
    const th = throb > 0 ? 0.55 + 0.45 * Math.sin(2 * Math.PI * throb * t) : 1;
    out[i] = band.process(noise.white()) * p * swell * th * 1.2;
  }
  return out;
}

/** A frog's croak: a quick train of throaty pulses. */
export function frogCroak(sr: number, noise: Noise): Float32Array {
  const length = noise.range(0.18, 0.55);
  const out = new Float32Array(Math.ceil((length + 0.05) * sr));
  const rate = noise.range(22, 55);
  const f1 = noise.range(380, 850);
  const f2 = f1 * noise.range(2.1, 2.8);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const env = envelope(t, length, 0.02, 0.06);
    const pulse = Math.pow(Math.max(0, Math.sin(Math.PI * rate * t)), 3);
    out[i] = env * pulse * (0.5 * Math.sin(2 * Math.PI * f1 * t) + 0.25 * Math.sin(2 * Math.PI * f2 * t));
  }
  return out;
}

/** A splash: a burst of noise and a few bubbles (a rising fish, the kingfisher, a stone). `size` 0..1. */
export function splash(sr: number, noise: Noise, size = 0.3): Float32Array {
  const length = 0.12 + size * 0.35;
  const out = new Float32Array(Math.ceil(length * sr));
  const lp = new OnePole(1800 + 3000 * (1 - size), sr);
  const bubbles = new BubbleBank(sr, 24);
  const count = 3 + Math.floor(size * 12);
  const at = Array.from({ length: count }, () => Math.floor(noise.range(0, length * 0.6) * sr)).sort((a, b) => a - b);
  let next = 0;
  for (let i = 0; i < out.length; i++) {
    while (next < at.length && (at[next] as number) <= i) {
      bubbles.spawn(noise.range(0.0012, 0.004 + size * 0.006), noise.range(0.05, 0.15), 0.3);
      next++;
    }
    const t = i / sr;
    const burst = Math.exp(-t / (0.02 + size * 0.05));
    out[i] = lp.process(noise.white()) * burst * (0.3 + size * 0.4) + bubbles.process();
  }
  return out;
}

/** Bubbles rising past you underwater. */
export function bubbleRise(sr: number, noise: Noise): Float32Array {
  const length = noise.range(0.4, 1.2);
  const out = new Float32Array(Math.ceil(length * sr));
  const bubbles = new BubbleBank(sr, 24);
  const step = Math.floor(noise.range(0.04, 0.12) * sr);
  for (let i = 0; i < out.length; i++) {
    if (i % step === 0) bubbles.spawn(noise.range(0.002, 0.006), noise.range(0.05, 0.12), 0.5);
    out[i] = bubbles.process();
  }
  return out;
}

/**
 * Thunder `distance` meters away: a sharp crack when close, then a long rolling rumble; far thunder is a low grumble
 * (the air takes the high notes away).
 */
export function thunder(sr: number, noise: Noise, distance: number, strength = 1): Float32Array {
  const near = Math.max(0, 1 - distance / 1500);
  const seconds = 4 + noise.next() * 5;
  const out = new Float32Array(Math.ceil(seconds * sr));
  const brown = new Brown();
  const lp = new OnePole(180 + 2200 * near, sr);
  const crackHp = new Biquad().highpass(900, 0.7, sr);
  // A few rolls: bumps of loudness at random moments.
  const rolls = Array.from({ length: 3 + Math.floor(noise.next() * 4) }, () => ({
    at: noise.range(0.1, seconds * 0.7),
    width: noise.range(0.3, 1.4),
    amp: noise.range(0.4, 1),
  }));
  const loud = Math.min(1, strength) * (0.35 + 0.65 * Math.max(0.15, 1 - distance / 5000));
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let roll = 0;
    for (const r of rolls) roll += r.amp * Math.exp(-(((t - r.at) / r.width) ** 2));
    const fade = Math.min(1, t / 0.05) * Math.exp(-t / (seconds * 0.45));
    let v = lp.process(brown.process(noise.white())) * roll * fade * 1.4;
    if (near > 0 && t < 0.4) v += crackHp.process(noise.white()) * near * Math.exp(-t / 0.08) * 0.8;
    out[i] = v * loud;
  }
  return out;
}

/** One footstep on a surface (`speed`: walking 0 .. running 1). */
export function footstep(sr: number, noise: Noise, surface: Surface, speed = 0.3): Float32Array {
  const hard = 0.6 + speed * 0.6;
  const length = surface === 'water' ? 0.25 : surface === 'mud' ? 0.22 : 0.14;
  const out = new Float32Array(Math.ceil(length * sr));
  const lp = new OnePole(surface === 'moss' || surface === 'grass' ? 700 : 3500, sr);
  const hp = new Biquad().highpass(surface === 'leaves' ? 2500 : 1200, 0.7, sr);
  const thud = new OnePole(160, sr);
  const bubbles = new BubbleBank(sr, 16);
  // Grains: the crunch of gravel, the crackle of dry leaves.
  const grains = surface === 'gravel' ? 45 : surface === 'leaves' ? 40 : surface === 'rock' ? 2 : 0;
  // Dry leaves crackle a little longer than gravel crunches.
  const grainDecay = surface === 'leaves' ? 0.96 : 0.85;
  const grainAt = new Set(Array.from({ length: grains }, () => Math.floor(noise.range(0, length * 0.7) * sr)));
  let grain = 0;
  const sweep = new Biquad();
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = noise.white();
    let v = thud.process(w) * Math.exp(-t / 0.03) * 2.5;
    if (grainAt.has(i)) grain = noise.range(0.2, 0.6);
    v += hp.process(w) * grain;
    grain *= grainDecay;
    switch (surface) {
      case 'moss':
      case 'grass':
        v += lp.process(w) * Math.exp(-t / 0.05) * 0.3;
        break;
      case 'mud': {
        // A squelch: a resonance sweeping down as the foot sinks.
        if (i % 64 === 0) sweep.bandpass(900 - 600 * (t / length), 4, sr);
        v += sweep.process(w) * Math.sin(Math.PI * Math.min(1, t / length)) * 0.7;
        break;
      }
      case 'rock':
        v += hp.process(w) * Math.exp(-t / 0.006) * 0.6;
        break;
      case 'water':
        if (i % 1200 === 0) bubbles.spawn(noise.range(0.002, 0.007), noise.range(0.05, 0.15), 0.3);
        v = lp.process(w) * Math.exp(-t / 0.08) * 0.5 + bubbles.process();
        break;
      default:
        break;
    }
    out[i] = v * hard * 0.4;
  }
  return out;
}

/** Any call by kind (the ambience scheduler's events). */
export function renderCall(kind: CallKind, sr: number, noise: Noise): Float32Array {
  switch (kind) {
    case 'thrush':
      return thrushSong(sr, noise);
    case 'songbird':
      return songbirdCall(sr, noise);
    case 'kingfisher':
      return kingfisherCall(sr, noise);
    case 'cicada':
      return cicadaSong(sr, noise);
    case 'frog':
      return frogCroak(sr, noise);
  }
}
