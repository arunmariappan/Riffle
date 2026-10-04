/** AudioWorklet processor: the wind and the rustle of the plants around you, in stereo (plan 6.9). */
import { WindSynth, WIND_PARAMS } from '../dsp/wind';
import { descriptors, readParams, type ProcessorOptions } from './worklet';

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  constructor(options?: ProcessorOptions);
}
declare function registerProcessor(name: string, ctor: unknown): void;

class WindProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return descriptors(WIND_PARAMS);
  }

  private readonly synth: WindSynth;

  constructor(options?: ProcessorOptions) {
    super(options);
    this.synth = new WindSynth(sampleRate, options?.processorOptions?.seed ?? 2);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const channels = outputs[0];
    const left = channels?.[0];
    const right = channels?.[1] ?? left;
    if (!left || !right) return true;
    this.synth.set(readParams(WIND_PARAMS, parameters));
    this.synth.render(left, right);
    return true;
  }
}

registerProcessor('riffle-wind', WindProcessor);
