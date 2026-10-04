/**
 * Rain, generated live (plan 6.9): every drop is its own sound, different by what it hits. Drops on leaves patter
 * (short bright clicks ringing a leaf's resonance), on rock they tick, on water they plink (a small ringing bubble)
 * with a little splash; a downpour adds a roar. Stereo, each drop panned at random. Pure TypeScript.
 *
 * Cheap enough for thousands of drops a second: ticks and splashes share one noise source shaped by summed decaying
 * envelopes, leaf clicks excite a few resonators, and only some water drops ring as bubbles.
 */
import { Biquad, BubbleBank, Noise, Pink, Smoothed, softClip } from './core';

export interface RainParams {
  /** Rain rate, mm/h (a downpour is about 30). */
  rate: number;
  /** 0..1 what the drops around you land on. */
  leaves: number;
  rock: number;
  water: number;
  gain: number;
}

export const RAIN_PARAMS: readonly (keyof RainParams)[] = ['rate', 'leaves', 'rock', 'water', 'gain'];

/** One side's drop sounds. */
class Side {
  readonly pink = new Pink();
  readonly roar: Biquad;
  readonly drizzle: Biquad;
  readonly tick: Biquad;
  readonly splash: Biquad;
  /** Leaf resonances, rung by the clicks. */
  readonly leaves: Biquad[];
  readonly bubbles: BubbleBank;
  /** Summed envelopes of rock ticks and water splashes. */
  rockEnv = 0;
  splashEnv = 0;
  /** Impulses waiting to ring each leaf resonance this sample. */
  readonly kick: number[];

  constructor(sr: number, noise: Noise) {
    this.roar = new Biquad().lowpass(1800, 0.6, sr);
    this.drizzle = new Biquad().highpass(4200, 0.7, sr);
    this.tick = new Biquad().highpass(2500, 0.7, sr);
    this.splash = new Biquad().bandpass(1600, 0.8, sr);
    this.leaves = [1700, 2500, 3300, 4300].map((f) => new Biquad().bandpass(f * noise.range(0.9, 1.1), 7, sr));
    this.kick = this.leaves.map(() => 0);
    this.bubbles = new BubbleBank(sr, 24);
  }
}

export class RainSynth {
  private readonly noise: Noise;
  private readonly sides: [Side, Side];
  private readonly p: Record<keyof RainParams, Smoothed>;
  private readonly rockDecay: number;
  private readonly splashDecay: number;
  private clock = 0;
  private heavy = 0;
  private light = 0;

  constructor(
    private readonly sampleRate: number,
    seed: number,
  ) {
    this.noise = new Noise(seed);
    this.sides = [new Side(sampleRate, this.noise), new Side(sampleRate, this.noise)];
    this.rockDecay = Math.exp(-1 / (0.0012 * sampleRate));
    this.splashDecay = Math.exp(-1 / (0.004 * sampleRate));
    const s = (v: number) => new Smoothed(v, 0.5, sampleRate);
    this.p = { rate: s(0), leaves: s(0.4), rock: s(0.3), water: s(0.3), gain: s(0) };
  }

  set(params: Partial<RainParams>): void {
    for (const k of RAIN_PARAMS) {
      const v = params[k];
      if (v !== undefined && Number.isFinite(v)) this.p[k].target = Math.max(0, v);
    }
  }

  render(left: Float32Array, right: Float32Array): void {
    const sr = this.sampleRate;
    const n = this.noise;
    const [L, R] = this.sides;
    for (let i = 0; i < left.length; i++) {
      const rate = this.p.rate.step();
      const leaves = this.p.leaves.step();
      const rock = this.p.rock.step();
      const water = this.p.water.step();
      const gain = this.p.gain.step();
      if ((i & 31) === 0) {
        this.heavy = Math.pow(Math.min(1.5, rate / 30), 0.9);
        this.light = Math.sqrt(Math.min(1, rate / 6));
      }
      // Audible nearby drops per second: a light shower patters, a downpour is a dense hail of them.
      this.clock -= Math.min(2500, rate * 90) / sr;
      while (this.clock < 0) {
        this.clock += -Math.log(1 - n.next() + 1e-12);
        const pick = n.next() * (leaves + rock + water + 1e-6);
        const pan = n.next();
        const side = pan < 0.5 ? L : R;
        if (pick < water) {
          const a = n.range(0.02, 0.06);
          L.splashEnv += a * (1 - pan);
          R.splashEnv += a * pan;
          // About one water drop in four rings as a plink.
          if (n.next() < 0.25) side.bubbles.spawn(n.range(0.0008, 0.0026), n.range(0.03, 0.09), 0.25);
        } else if (pick < water + leaves) {
          const k = Math.floor(n.next() * side.kick.length);
          side.kick[k] = (side.kick[k] as number) + n.range(0.3, 1.2);
        } else {
          const a = n.range(0.03, 0.1);
          L.rockEnv += a * (1 - pan);
          R.rockEnv += a * pan;
        }
      }
      const shared = n.white();
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? L : R;
        const w = s === 0 ? shared : n.white();
        const pk = side.pink.process(w);
        let v = side.roar.process(pk) * this.heavy * 0.6;
        v += side.drizzle.process(w) * this.light * 0.035;
        // Ticks on rock and splashes on water: one noise, shaped by the drops' summed envelopes.
        v += side.tick.process(w * side.rockEnv) * (0.6 + rock * 0.8);
        v += side.splash.process(w * side.splashEnv) * 0.8;
        side.rockEnv *= this.rockDecay;
        side.splashEnv *= this.splashDecay;
        // Leaves: clicks ring their resonances.
        for (let k = 0; k < side.leaves.length; k++) {
          v += (side.leaves[k] as Biquad).process(side.kick[k] as number) * 0.25;
          side.kick[k] = 0;
        }
        v += side.bubbles.process();
        (s === 0 ? left : right)[i] = softClip(v * gain);
      }
    }
  }
}
