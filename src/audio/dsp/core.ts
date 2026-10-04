/**
 * Building blocks for the generated nature sounds (plan 6.9): seeded noise, pink and brown noise, filters, parameter
 * smoothing and a bank of bubbles. Pure TypeScript with no Web Audio, so the same code runs in the audio worklets and
 * in Node tests. Every sound is synthesized live, so nothing ever loops.
 */

/** Seeded xorshift noise: fast, and its period (2³² samples, about a day at 48 kHz) never repeats audibly. */
export class Noise {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }

  /** Uniform in [−1, 1). */
  white(): number {
    return this.next() * 2 - 1;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}

/** Pink noise (−3 dB/octave) from white, Paul Kellet's economy filter. */
export class Pink {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;

  process(w: number): number {
    this.b0 = 0.99765 * this.b0 + w * 0.099046;
    this.b1 = 0.963 * this.b1 + w * 0.2965164;
    this.b2 = 0.57 * this.b2 + w * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + w * 0.1848) * 0.22;
  }
}

/** Brown (red) noise: a leaky integral of white noise, deep and rumbling. */
export class Brown {
  private y = 0;

  process(w: number): number {
    this.y = (this.y + 0.02 * w) / 1.02;
    return this.y * 3.5;
  }
}

/** One-pole low-pass filter. */
export class OnePole {
  private a = 1;
  private y = 0;

  constructor(cutoff: number, sampleRate: number) {
    this.setCutoff(cutoff, sampleRate);
  }

  setCutoff(cutoff: number, sampleRate: number): void {
    this.a = 1 - Math.exp((-2 * Math.PI * Math.min(cutoff, sampleRate * 0.45)) / sampleRate);
  }

  process(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

/** A biquad filter (RBJ cookbook), transposed direct form II. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  /** Band-pass with 0 dB peak gain. */
  bandpass(freq: number, q: number, sampleRate: number): this {
    const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    this.set(alpha, 0, -alpha, 1 + alpha, -2 * Math.cos(w), 1 - alpha);
    return this;
  }

  lowpass(freq: number, q: number, sampleRate: number): this {
    const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
    return this;
  }

  highpass(freq: number, q: number, sampleRate: number): this {
    const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
    return this;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Eases a control value toward its target (no zipper noise when parameters change). */
export class Smoothed {
  value: number;
  target: number;
  private readonly k: number;

  /** `seconds`: time constant; `rate`: how often `step` is called per second (per block or per sample). */
  constructor(value: number, seconds: number, rate: number) {
    this.value = value;
    this.target = value;
    this.k = 1 - Math.exp(-1 / Math.max(1e-6, seconds * rate));
  }

  step(): number {
    this.value += (this.target - this.value) * this.k;
    return this.value;
  }
}

/** A slowly wandering random level (flutter of leaves, gusty swells): new targets at random intervals, eased. */
export class Wander {
  private value = 0.5;
  private target = 0.5;
  private left = 0;
  private readonly k: number;

  constructor(
    private readonly noise: Noise,
    private readonly minSeconds: number,
    private readonly maxSeconds: number,
    private readonly sampleRate: number,
  ) {
    this.k = 1 - Math.exp(-1 / (minSeconds * 0.6 * sampleRate));
  }

  /** One sample; the value stays in 0..1. */
  step(): number {
    if (--this.left <= 0) {
      this.left = Math.ceil(this.noise.range(this.minSeconds, this.maxSeconds) * this.sampleRate);
      this.target = this.noise.next();
    }
    this.value += (this.target - this.value) * this.k;
    return this.value;
  }
}

/**
 * Bubbles (the sound of water is mostly bubbles ringing as they form, Minnaert 1933): each one a decaying sine whose
 * pitch rises a little as it nears the surface; small bubbles ring high and briefly, big ones low and longer.
 */
export class BubbleBank {
  private readonly freq: Float64Array;
  private readonly phase: Float64Array;
  private readonly amp: Float64Array;
  private readonly decay: Float64Array;
  private readonly rise: Float64Array;
  private count = 0;
  private readonly twoPiOverRate: number;

  constructor(
    private readonly sampleRate: number,
    private readonly max = 48,
  ) {
    this.freq = new Float64Array(max);
    this.phase = new Float64Array(max);
    this.amp = new Float64Array(max);
    this.decay = new Float64Array(max);
    this.rise = new Float64Array(max);
    this.twoPiOverRate = (2 * Math.PI) / sampleRate;
  }

  get active(): number {
    return this.count;
  }

  /** A bubble of radius `r` (m), with loudness `amp`; `rise` 0..1 how much its pitch climbs. */
  spawn(r: number, amp: number, rise = 0.15): void {
    if (this.count >= this.max) return;
    const f0 = Math.min(this.sampleRate * 0.4, 3.26 / Math.max(2e-4, r));
    const tau = 0.002 + 6 / f0;
    const i = this.count++;
    this.freq[i] = f0;
    this.phase[i] = 0;
    this.amp[i] = amp;
    this.decay[i] = Math.exp(-1 / (tau * this.sampleRate));
    this.rise[i] = 1 + rise / (tau * this.sampleRate);
  }

  /** Next sample: the sum of all ringing bubbles. */
  process(): number {
    let sum = 0;
    for (let i = 0; i < this.count; i++) {
      const a = this.amp[i] as number;
      // A soft start keeps the onset from clicking.
      sum += a * Math.sin(this.phase[i] as number);
      this.phase[i] = (this.phase[i] as number) + (this.freq[i] as number) * this.twoPiOverRate;
      this.freq[i] = (this.freq[i] as number) * (this.rise[i] as number);
      this.amp[i] = a * (this.decay[i] as number);
      if ((this.amp[i] as number) < 3e-4) {
        const last = --this.count;
        this.freq[i] = this.freq[last] as number;
        this.phase[i] = this.phase[last] as number;
        this.amp[i] = this.amp[last] as number;
        this.decay[i] = this.decay[last] as number;
        this.rise[i] = this.rise[last] as number;
        i--;
      }
    }
    return sum;
  }
}

/** A gentle limiter so many sounds together never clip harshly (a fast tanh: exact enough, much cheaper). */
export function softClip(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** Root mean square of a block (tests and meters). */
export function rms(data: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += (data[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, data.length));
}

/** Zero crossings per second: a cheap measure of how bright (high-pitched) a sound is. */
export function zeroCrossingRate(data: ArrayLike<number>, sampleRate: number): number {
  let n = 0;
  for (let i = 1; i < data.length; i++) if ((data[i - 1] as number) < 0 !== (data[i] as number) < 0) n++;
  return (n * sampleRate) / Math.max(1, data.length);
}

/** Energy-weighted mean frequency (Hz) from the slope of the signal: how bright a sound is where it is loud. */
export function brightness(data: ArrayLike<number>, sampleRate: number): number {
  let d = 0;
  let e = 0;
  for (let i = 1; i < data.length; i++) {
    const x = data[i] as number;
    const dx = x - (data[i - 1] as number);
    d += dx * dx;
    e += x * x;
  }
  return (Math.sqrt(d / Math.max(1e-12, e)) * sampleRate) / (2 * Math.PI);
}
