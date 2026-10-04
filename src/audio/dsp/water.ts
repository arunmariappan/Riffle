/**
 * Running water, generated live (plan 6.9): a mix of three characters set by the local flow. Pools gurgle with a few
 * large, low bubbles over a soft hush; riffles babble with many small bubbles and a mid-range wash; rapids roar with
 * dense tiny bubbles over broadband noise. The waterfall adds a deep rumble. Pure TypeScript (worklet and tests).
 */
import { Biquad, BubbleBank, Brown, Noise, OnePole, Pink, Smoothed, Wander, softClip } from './core';

export interface WaterParams {
  /** 0..1 shares of each character (the river mix). */
  rapids: number;
  riffle: number;
  pool: number;
  /** 0..1+ a falling sheet of water (the waterfall). */
  fall: number;
  /** Overall loudness. */
  gain: number;
}

export const WATER_PARAMS: readonly (keyof WaterParams)[] = ['rapids', 'riffle', 'pool', 'fall', 'gain'];

export class WaterSynth {
  private readonly noise: Noise;
  private readonly pink = new Pink();
  private readonly brown = new Brown();
  private readonly bubbles: BubbleBank;
  private readonly roarFilter: Biquad;
  private readonly washFilter: Biquad;
  private readonly hushFilter: OnePole;
  private readonly rumbleFilter: OnePole;
  private readonly washWander: Wander;
  private readonly roarWander: Wander;
  private readonly p: Record<keyof WaterParams, Smoothed>;
  private bubbleClock = 0;
  private block = 0;

  constructor(
    private readonly sampleRate: number,
    seed: number,
  ) {
    this.noise = new Noise(seed);
    this.bubbles = new BubbleBank(sampleRate, 64);
    this.roarFilter = new Biquad().lowpass(2400, 0.6, sampleRate);
    this.washFilter = new Biquad().bandpass(900, 0.7, sampleRate);
    this.hushFilter = new OnePole(500, sampleRate);
    this.rumbleFilter = new OnePole(140, sampleRate);
    this.washWander = new Wander(this.noise, 0.08, 0.4, sampleRate);
    this.roarWander = new Wander(this.noise, 0.3, 1.5, sampleRate);
    const s = (v: number) => new Smoothed(v, 0.25, sampleRate);
    this.p = { rapids: s(0), riffle: s(0), pool: s(1), fall: s(0), gain: s(0) };
  }

  set(params: Partial<WaterParams>): void {
    for (const k of WATER_PARAMS) {
      const v = params[k];
      if (v !== undefined && Number.isFinite(v)) this.p[k].target = Math.max(0, v);
    }
  }

  /** Fills `out` with the next samples (mono). */
  render(out: Float32Array): void {
    const sr = this.sampleRate;
    const n = this.noise;
    for (let i = 0; i < out.length; i++) {
      const rapids = this.p.rapids.step();
      const riffle = this.p.riffle.step();
      const pool = this.p.pool.step();
      const fall = this.p.fall.step();
      const gain = this.p.gain.step();
      // Bubbles: a Poisson stream whose rate and sizes follow the mix.
      const rate = pool * 7 + riffle * 95 + rapids * 230 + fall * 320;
      this.bubbleClock -= rate / sr;
      while (this.bubbleClock < 0) {
        this.bubbleClock += -Math.log(1 - n.next() + 1e-12);
        const pick = n.next() * (rate + 1e-9);
        let r: number;
        let amp: number;
        if (pick < pool * 7) {
          r = n.range(0.003, 0.011); // big slow gurgles
          amp = 0.22;
        } else if (pick < pool * 7 + riffle * 95) {
          r = Math.exp(n.range(Math.log(0.0011), Math.log(0.005)));
          amp = 0.12;
        } else {
          r = Math.exp(n.range(Math.log(0.0006), Math.log(0.003)));
          amp = 0.07;
        }
        this.bubbles.spawn(r, amp * (0.4 + n.next()), n.range(0.05, 0.3));
      }
      const w = n.white();
      const pk = this.pink.process(w);
      // Rapids and the waterfall: broadband roar that swells a little.
      const roar =
        this.roarFilter.process(pk) *
        (rapids * 0.55 + fall * 1.1 + riffle * 0.06) *
        (0.75 + 0.5 * this.roarWander.step());
      // Riffles: a babbling mid-range wash.
      const wash = this.washFilter.process(pk) * riffle * 0.5 * (0.5 + this.washWander.step());
      // Pools: a soft low hush.
      const hush = this.hushFilter.process(pk) * pool * 0.12;
      // The falling sheet: a deep rumble.
      const rumble = this.rumbleFilter.process(this.brown.process(w)) * (fall * 0.9 + rapids * 0.15);
      out[i] = softClip((this.bubbles.process() + roar + wash + hush + rumble) * gain);
    }
    // Retune the roar's brightness by the mix once per block.
    if (++this.block % 8 === 0) {
      const loud = this.p.rapids.value + this.p.fall.value;
      this.roarFilter.lowpass(1400 + 2400 * Math.min(1, loud), 0.6, sr);
    }
  }
}
