/**
 * Wind, generated live (plan 6.9): filtered noise shaped by the same gust signal as the visuals, so it never loops,
 * plus rustle by the plants around you: broad leaves rustle and flutter, pines whoosh, grass hisses softly, and bamboo
 * hisses while its culms knock and creak. Stereo (two independent noise streams), not positioned. Pure TypeScript.
 */
import { Biquad, Brown, Noise, Pink, Smoothed, Wander, softClip } from './core';

export interface WindParams {
  /** Wind speed, m/s (the Wind panel's, with the weather's gusts). */
  speed: number;
  /** Local gust factor from the wind field (1 = the base speed). */
  gust: number;
  /** 0..1 how much of each kind of plant is around you. */
  leaves: number;
  bamboo: number;
  pines: number;
  grass: number;
  gain: number;
}

export const WIND_PARAMS: readonly (keyof WindParams)[] = [
  'speed',
  'gust',
  'leaves',
  'bamboo',
  'pines',
  'grass',
  'gain',
];

class Channel {
  readonly brown = new Brown();
  readonly pink = new Pink();
  readonly body: Biquad;
  readonly hiss: Biquad;
  readonly whistle: Biquad;
  readonly leaves: Biquad;
  readonly pines: Biquad;
  readonly grass: Biquad;
  readonly bambooHiss: Biquad;
  readonly flutter: Wander;
  readonly swell: Wander;

  constructor(sr: number, noise: Noise) {
    this.body = new Biquad().bandpass(250, 0.6, sr);
    this.hiss = new Biquad().lowpass(1300, 0.7, sr);
    this.whistle = new Biquad().bandpass(850, 14, sr);
    this.leaves = new Biquad().highpass(1900, 0.7, sr);
    this.pines = new Biquad().bandpass(700, 0.9, sr);
    this.grass = new Biquad().bandpass(3200, 1.1, sr);
    this.bambooHiss = new Biquad().bandpass(5200, 1.6, sr);
    this.flutter = new Wander(noise, 0.03, 0.12, sr);
    this.swell = new Wander(noise, 0.6, 2.5, sr);
  }
}

/** A culm knock: two resonant modes ringing briefly. */
interface Knock {
  f1: number;
  f2: number;
  phase: number;
  amp: number;
  decay: number;
  pan: number;
}

/** A creak: a low rasping tone that slides a little. */
interface Creak {
  freq: number;
  slide: number;
  phase: number;
  t: number;
  length: number;
  amp: number;
  pan: number;
}

export class WindSynth {
  private readonly noise: Noise;
  private readonly ch: [Channel, Channel];
  private readonly p: Record<keyof WindParams, Smoothed>;
  private knocks: Knock[] = [];
  private creaks: Creak[] = [];
  private knockClock = 1;
  private creakClock = 3;
  private block = 0;
  private eff = 0;
  private body = 0;
  private rustle = 0;
  private whistle = 0;
  private pineLevel = 0;
  private knockRate = 0;

  constructor(
    private readonly sampleRate: number,
    seed: number,
  ) {
    this.noise = new Noise(seed);
    this.ch = [new Channel(sampleRate, this.noise), new Channel(sampleRate, this.noise)];
    const s = (v: number) => new Smoothed(v, 0.3, sampleRate);
    this.p = { speed: s(0), gust: s(1), leaves: s(0), bamboo: s(0), pines: s(0), grass: s(0), gain: s(0) };
  }

  set(params: Partial<WindParams>): void {
    for (const k of WIND_PARAMS) {
      const v = params[k];
      if (v !== undefined && Number.isFinite(v)) this.p[k].target = Math.max(0, v);
    }
  }

  /** Fills the two channels with the next samples. */
  render(left: Float32Array, right: Float32Array): void {
    const sr = this.sampleRate;
    const n = this.noise;
    // Retune the wind's body with its strength (stronger wind sounds higher and wider).
    if (this.block++ % 4 === 0) {
      const eff = this.p.speed.value * this.p.gust.value;
      for (const c of this.ch) {
        c.body.bandpass(140 + eff * 22, 0.55, sr);
        c.whistle.bandpass(650 + 450 * c.swell.step() + eff * 6, 14, sr);
      }
    }
    for (let i = 0; i < left.length; i++) {
      const speed = this.p.speed.step();
      const gust = this.p.gust.step();
      const leaves = this.p.leaves.step();
      const bamboo = this.p.bamboo.step();
      const pines = this.p.pines.step();
      const grass = this.p.grass.step();
      const gain = this.p.gain.step();
      // Levels from the wind's strength change slowly: refresh them every 32 samples.
      if ((i & 31) === 0) {
        const e = speed * gust;
        this.eff = e;
        this.body = Math.min(1.3, Math.pow(e / 18, 1.3));
        this.rustle = Math.min(1.5, e / 9);
        this.whistle = Math.max(0, (e - 11) / 14);
        this.pineLevel = Math.pow(this.rustle, 1.3);
        this.knockRate = Math.pow(e / 7, 2) * 7;
      }
      const { eff, body, rustle, whistle } = this;
      // Bamboo culms knock in the gusts and creak now and then.
      this.knockClock -= (bamboo * this.knockRate) / sr;
      if (this.knockClock < 0) {
        this.knockClock += -Math.log(1 - n.next() + 1e-12);
        if (this.knocks.length < 24) {
          const f = n.range(380, 900);
          this.knocks.push({
            f1: f,
            f2: f * n.range(2.3, 2.9),
            phase: 0,
            amp: n.range(0.05, 0.25) * Math.min(1, rustle),
            decay: Math.exp(-1 / (n.range(0.012, 0.035) * sr)),
            pan: n.next(),
          });
        }
      }
      this.creakClock -= (bamboo * Math.min(1.5, eff / 10) * 0.35) / sr;
      if (this.creakClock < 0) {
        this.creakClock += -Math.log(1 - n.next() + 1e-12);
        if (this.creaks.length < 3)
          this.creaks.push({
            freq: n.range(85, 210),
            slide: n.range(-0.4, 0.5),
            phase: 0,
            t: 0,
            length: n.range(0.3, 0.9),
            amp: n.range(0.02, 0.06),
            pan: n.next(),
          });
      }
      let kL = 0;
      let kR = 0;
      for (let k = this.knocks.length - 1; k >= 0; k--) {
        const o = this.knocks[k] as Knock;
        const s = o.amp * (Math.sin(o.phase * o.f1) + 0.4 * Math.sin(o.phase * o.f2));
        o.phase += (2 * Math.PI) / sr;
        o.amp *= o.decay;
        kL += s * (1 - o.pan);
        kR += s * o.pan;
        if (o.amp < 1e-4) this.knocks.splice(k, 1);
      }
      for (let k = this.creaks.length - 1; k >= 0; k--) {
        const c = this.creaks[k] as Creak;
        const u = c.t / c.length;
        const env = Math.sin(Math.PI * Math.min(1, u));
        // A rasp: a pulse-like wave with jitter.
        const f = c.freq * (1 + c.slide * u) * (1 + 0.02 * n.white());
        c.phase += f / sr;
        const wave = Math.pow(Math.abs(Math.sin(Math.PI * c.phase)), 6) * 2 - 0.3;
        const s = wave * env * c.amp;
        kL += s * (1 - c.pan);
        kR += s * c.pan;
        c.t += 1 / sr;
        if (c.t >= c.length) this.creaks.splice(k, 1);
      }
      for (let side = 0; side < 2; side++) {
        const c = this.ch[side] as Channel;
        const w = n.white();
        const pk = c.pink.process(w);
        const swell = 0.7 + 0.6 * c.swell.step();
        let v = c.body.process(c.brown.process(w)) * body * 1.6 * swell;
        v += c.hiss.process(pk) * body * body * 0.35;
        v += c.whistle.process(w) * whistle * 0.5;
        const flutter = 0.35 + 0.9 * c.flutter.step();
        v += c.leaves.process(w) * leaves * rustle * flutter * 0.16;
        v += c.pines.process(pk) * pines * this.pineLevel * swell * 0.5;
        v += c.grass.process(w) * grass * rustle * 0.07;
        v += c.bambooHiss.process(w) * bamboo * rustle * flutter * 0.12;
        v += side === 0 ? kL : kR;
        (side === 0 ? left : right)[i] = softClip(v * gain);
      }
    }
  }
}
