/** AudioWorklet processor: rain on leaves, rock and water, in stereo (plan 6.9). */
import { RainSynth, RAIN_PARAMS } from '../dsp/rain';
import { descriptors, readParams, type ProcessorOptions } from './worklet';

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  constructor(options?: ProcessorOptions);
}
declare function registerProcessor(name: string, ctor: unknown): void;

class RainProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return descriptors(RAIN_PARAMS);
  }

  private readonly synth: RainSynth;

  constructor(options?: ProcessorOptions) {
    super(options);
    this.synth = new RainSynth(sampleRate, options?.processorOptions?.seed ?? 3);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const channels = outputs[0];
    const left = channels?.[0];
    const right = channels?.[1] ?? left;
    if (!left || !right) return true;
    this.synth.set(readParams(RAIN_PARAMS, parameters));
    this.synth.render(left, right);
    return true;
  }
}

registerProcessor('riffle-rain', RainProcessor);
