/**
 * The Web Audio graph (plan 6.9, D22): one AudioContext, unlocked by your first click (browsers block sound until
 * then), the generated-sound worklets, HRTF panners for sounds in the valley, and a master chain with the underwater
 * low-pass filter, a gentle limiter and the volume.
 */
import waterUrl from './worklets/water.worklet.ts?worker&url';
import windUrl from './worklets/wind.worklet.ts?worker&url';
import rainUrl from './worklets/rain.worklet.ts?worker&url';

let context: AudioContext | null = null;
let unlocked: (() => void) | null = null;
const unlockedPromise = new Promise<void>((resolve) => (unlocked = resolve));

/** Creates or resumes the audio context; call from a click or key handler (the start screen does). */
export function unlockAudio(): void {
  try {
    context ??= new AudioContext({ latencyHint: 'playback' });
    if (context.state === 'suspended') void context.resume();
    unlocked?.();
  } catch (err) {
    console.warn('Audio is not available', err);
  }
}

/** Resolves once a click or key press has unlocked audio. */
export function whenAudioUnlocked(): Promise<void> {
  return unlockedPromise;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A sound source placed in the valley. */
export interface Emitter {
  node: AudioWorkletNode;
  panner: PannerNode;
  params: Map<string, AudioParam>;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly muffle: BiquadFilterNode;
  private readonly underwaterGain: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  /** Sounds placed in the valley go here (before the underwater filter). */
  readonly world: GainNode;
  private loaded: Promise<void> | null = null;
  /** Taps the final mix (tests and meters). */
  private readonly analyser: AnalyserNode;
  private volume = 0.8;
  private muted = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.world = ctx.createGain();
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.7;
    this.underwaterGain = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.world.connect(this.muffle).connect(this.underwaterGain).connect(this.limiter).connect(this.master);
    this.master.connect(ctx.destination);
    this.analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.5 });
    this.limiter.connect(this.analyser);
  }

  /** Loudness (RMS) and brightness (spectral centroid, Hz) of what you hear now, before the volume. */
  meter(): { rms: number; centroid: number } {
    const a = this.analyser;
    const time = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(time);
    let s = 0;
    for (const v of time) s += v * v;
    const freq = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(freq);
    let num = 0;
    let den = 0;
    const hz = this.ctx.sampleRate / a.fftSize;
    freq.forEach((db, k) => {
      const m = Math.pow(10, db / 20);
      num += m * k * hz;
      den += m;
    });
    return { rms: Math.sqrt(s / time.length), centroid: den > 0 ? num / den : 0 };
  }

  /** The audio context, once unlocked (null before your first click). */
  static context(): AudioContext | null {
    return context;
  }

  /** Loads the sound generators (once). */
  ready(): Promise<void> {
    this.loaded ??= Promise.all([waterUrl, windUrl, rainUrl].map((url) => this.ctx.audioWorklet.addModule(url))).then(
      () => undefined,
    );
    return this.loaded;
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  setVolume(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    this.master.gain.setTargetAtTime(muted ? 0 : volume * volume, this.now, 0.05);
  }

  get audible(): boolean {
    return !this.muted && this.volume > 0 && this.ctx.state === 'running';
  }

  /** Muffles everything while your head is underwater. */
  setUnderwater(cutoff: number, gain: number): void {
    this.muffle.frequency.setTargetAtTime(cutoff, this.now, 0.08);
    this.underwaterGain.gain.setTargetAtTime(gain, this.now, 0.08);
  }

  /** Puts the listener at the camera. */
  setListener(p: Vec3, forward: Vec3, up: Vec3): void {
    const l = this.ctx.listener;
    const t = this.now;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(forward.x, t, 0.02);
      l.forwardY.setTargetAtTime(forward.y, t, 0.02);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  private panner(refDistance: number, rolloff: number): PannerNode {
    return new PannerNode(this.ctx, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance,
      rolloffFactor: rolloff,
      maxDistance: 400,
    });
  }

  /** A generator worklet (`riffle-water`, …) placed in the valley through an HRTF panner. */
  emitter(processor: string, seed: number, refDistance = 3, rolloff = 1): Emitter {
    const node = new AudioWorkletNode(this.ctx, processor, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { seed },
    });
    const panner = this.panner(refDistance, rolloff);
    node.connect(panner).connect(this.world);
    return { node, panner, params: node.parameters as unknown as Map<string, AudioParam> };
  }

  /** A stereo generator that surrounds you (wind, rain). */
  ambient(processor: string, seed: number): { node: AudioWorkletNode; params: Map<string, AudioParam> } {
    const node = new AudioWorkletNode(this.ctx, processor, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { seed },
    });
    node.connect(this.world);
    return { node, params: node.parameters as unknown as Map<string, AudioParam> };
  }

  /** Eases an emitter's parameter toward a value. */
  static set(params: Map<string, AudioParam>, name: string, value: number, now: number, seconds = 0.15): void {
    params.get(name)?.setTargetAtTime(Number.isFinite(value) ? value : 0, now, seconds);
  }

  static place(panner: PannerNode, p: Vec3, now: number, seconds = 0.1): void {
    panner.positionX.setTargetAtTime(p.x, now, seconds);
    panner.positionY.setTargetAtTime(p.y, now, seconds);
    panner.positionZ.setTargetAtTime(p.z, now, seconds);
  }

  /**
   * Plays generated samples once: at a point in the valley (HRTF), or around you when `at` is null. `delay` in
   * seconds (thunder after its lightning).
   */
  play(samples: Float32Array, at: Vec3 | null, gain = 1, delay = 0, refDistance = 4): void {
    if (samples.length === 0) return;
    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = new AudioBufferSourceNode(this.ctx, { buffer });
    const level = new GainNode(this.ctx, { gain });
    source.connect(level);
    if (at) {
      const p = this.panner(refDistance, 1.2);
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = at.z;
      level.connect(p).connect(this.world);
    } else level.connect(this.world);
    source.start(this.now + Math.max(0, delay));
    source.onended = () => {
      source.disconnect();
      level.disconnect();
    };
  }

  dispose(): void {
    this.master.disconnect();
  }
}
