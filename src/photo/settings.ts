/** Photo mode's settings and their ranges (plan 6.10). Pure TypeScript, shared by the engine and the panel. */
import type { Resolution } from './lens';
import type { FilterId } from './filters';

export interface PhotoSettings {
  /** Lens focal length, mm (full frame). */
  focalLength: number;
  /** Aperture f-number. */
  aperture: number;
  /** Focus distance, m. */
  focus: number;
  /** Exposure compensation, stops. */
  exposure: number;
  filter: FilterId;
  /** Frames averaged for a still. */
  samples: number;
  resolution: Resolution;
  /** Rule-of-thirds grid. */
  grid: boolean;
  /** Freeze the valley while in photo mode. */
  pause: boolean;
}

export function defaultPhotoSettings(): PhotoSettings {
  return {
    focalLength: 35,
    aperture: 8,
    focus: 10,
    exposure: 0,
    filter: 'natural',
    samples: 64,
    resolution: 'screen',
    grid: false,
    pause: true,
  };
}

export const PHOTO_LIMITS = {
  focalLength: [14, 200],
  aperture: [1.4, 22],
  focus: [0.3, 500],
  exposure: [-3, 3],
} as const;
