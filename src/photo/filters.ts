/**
 * Photo filters (plan 6.10: color grading): small, natural adjustments of the grading the valley already has
 * (saturation, contrast, tint, vignette, bloom). "Grading stays real" (plan 8): nothing garish. Pure TypeScript.
 */

export type FilterId = 'natural' | 'warm' | 'cool' | 'vivid' | 'film' | 'mono';

export interface Grade {
  saturation: number;
  contrast: number;
  /** Multiplier per channel. */
  tint: [number, number, number];
  vignette: number;
  bloom: number;
}

export const FILTERS: Record<FilterId, { name: string; grade: Grade }> = {
  natural: {
    name: 'Natural',
    grade: { saturation: 1.06, contrast: 1.04, tint: [1, 1, 1], vignette: 0.12, bloom: 0.12 },
  },
  warm: {
    name: 'Warm light',
    grade: { saturation: 1.08, contrast: 1.05, tint: [1.06, 1.0, 0.9], vignette: 0.15, bloom: 0.14 },
  },
  cool: {
    name: 'Cool morning',
    grade: { saturation: 1.0, contrast: 1.03, tint: [0.93, 0.99, 1.07], vignette: 0.12, bloom: 0.1 },
  },
  vivid: { name: 'Vivid', grade: { saturation: 1.22, contrast: 1.1, tint: [1, 1, 1], vignette: 0.14, bloom: 0.12 } },
  film: {
    name: 'Soft film',
    grade: { saturation: 0.9, contrast: 0.94, tint: [1.03, 1.0, 0.95], vignette: 0.22, bloom: 0.2 },
  },
  mono: {
    name: 'Black and white',
    grade: { saturation: 0, contrast: 1.12, tint: [1, 1, 1], vignette: 0.18, bloom: 0.1 },
  },
};

/** Applies a grade to a linear color the way the post-processing shader does (for tests and previews). */
export function applyGrade(rgb: [number, number, number], g: Grade): [number, number, number] {
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return rgb.map((c, i) => {
    const s = luma + (c - luma) * g.saturation;
    return Math.max(0, (s - 0.18) * g.contrast + 0.18) * (g.tint[i] as number);
  }) as [number, number, number];
}

/** Exposure compensation in stops → a multiplier. */
export function exposureFactor(ev: number): number {
  return Math.pow(2, ev);
}
