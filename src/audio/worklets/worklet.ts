/**
 * The bits of the AudioWorklet global scope the processors use (not in TypeScript's DOM library). Imported by each
 * processor file; at run time these names are the browser's own.
 */
export interface ProcessorOptions {
  processorOptions?: { seed?: number };
}

export interface ParameterDescriptor {
  name: string;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: 'k-rate' | 'a-rate';
}

/** Control parameters for a synth: non-negative, eased inside the synth, so k-rate is enough. */
export function descriptors(names: readonly string[], max = 64): ParameterDescriptor[] {
  return names.map((name) => ({ name, defaultValue: 0, minValue: 0, maxValue: max, automationRate: 'k-rate' }));
}

/** Reads the current value of each named parameter. */
export function readParams<K extends string>(
  names: readonly K[],
  parameters: Record<string, Float32Array>,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of names) out[k] = parameters[k]?.[0] ?? 0;
  return out;
}
