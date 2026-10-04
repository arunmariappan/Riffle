/** AudioWorklet processor: one stream emitter's water (plan 6.9). */
import { WaterSynth, WATER_PARAMS } from '../dsp/water';
import { descriptors, readParams, type ProcessorOptions } from './worklet';

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  constructor(options?: ProcessorOptions);
}
declare function registerProcessor(name: string, ctor: unknown): void;

class WaterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return descriptors(WATER_PARAMS);
  }

  private readonly synth: WaterSynth;

  constructor(options?: ProcessorOptions) {
    super(options);
    this.synth = new WaterSynth(sampleRate, options?.processorOptions?.seed ?? 1);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const channels = outputs[0];
    const out = channels?.[0];
    if (!channels || !out) return true;
    this.synth.set(readParams(WATER_PARAMS, parameters));
    this.synth.render(out);
    for (let c = 1; c < channels.length; c++) channels[c]?.set(out);
    return true;
  }
}

registerProcessor('riffle-water', WaterProcessor);
