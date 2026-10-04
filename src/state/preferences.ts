/**
 * Your own preferences (not part of a valley): sound, graphics and comfort. Kept in this browser's local storage; it
 * may be unavailable (private windows), so every read and write is guarded and the defaults always work.
 */
import { isQualityPreset, type QualityPreset } from './quality';

export interface Preferences {
  /** 0..1 */
  volume: number;
  muted: boolean;
  /** The quality preset you chose (null: High, the default). */
  quality: QualityPreset | null;
  /** Lower the render resolution in heavy views to hold the frame rate. */
  dynamicResolution: boolean;
  /** Frame cap (plan 3: 60 on your monitor; 30 saves power and heat). */
  maxFps: 30 | 60;
  /** Vertical field of view while exploring, degrees. */
  fov: number;
  /** Mouse look speed multiplier. */
  mouseSensitivity: number;
  invertY: boolean;
  /** Gentle head bob while walking. */
  headBob: boolean;
  /** Softer lightning: no bright flashes or flicker. */
  reduceFlashes: boolean;
}

const KEY = 'riffle:preferences';

export const PREFERENCE_LIMITS = {
  fov: [50, 100],
  mouseSensitivity: [0.3, 3],
} as const;

export function defaultPreferences(): Preferences {
  return {
    volume: 0.8,
    muted: false,
    quality: null,
    dynamicResolution: true,
    maxFps: 60,
    fov: 68,
    mouseSensitivity: 1,
    invertY: false,
    headBob: false,
    reduceFlashes: false,
  };
}

export function normalizePreferences(raw: unknown): Preferences {
  const d = defaultPreferences();
  const r = (raw ?? {}) as Partial<Record<keyof Preferences, unknown>>;
  const num = (v: unknown, fallback: number, [lo, hi]: readonly [number, number]) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    volume: num(r.volume, d.volume, [0, 1]),
    muted: bool(r.muted, d.muted),
    quality: isQualityPreset(r.quality) ? r.quality : null,
    dynamicResolution: bool(r.dynamicResolution, d.dynamicResolution),
    maxFps: r.maxFps === 30 ? 30 : 60,
    fov: num(r.fov, d.fov, PREFERENCE_LIMITS.fov),
    mouseSensitivity: num(r.mouseSensitivity, d.mouseSensitivity, PREFERENCE_LIMITS.mouseSensitivity),
    invertY: bool(r.invertY, d.invertY),
    headBob: bool(r.headBob, d.headBob),
    reduceFlashes: bool(r.reduceFlashes, d.reduceFlashes),
  };
}

export function loadPreferences(): Preferences {
  try {
    const text = globalThis.localStorage?.getItem(KEY);
    return normalizePreferences(text ? JSON.parse(text) : null);
  } catch {
    return defaultPreferences();
  }
}

export function savePreferences(p: Preferences): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: the preference lasts for this visit only.
  }
}
