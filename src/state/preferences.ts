/**
 * Your own preferences (not part of a valley): sound volume and mute. Kept in this browser's local storage; it may be
 * unavailable (private windows), so every read and write is guarded and the defaults always work.
 */

export interface Preferences {
  /** 0..1 */
  volume: number;
  muted: boolean;
}

const KEY = 'riffle:preferences';

export function defaultPreferences(): Preferences {
  return { volume: 0.8, muted: false };
}

export function normalizePreferences(raw: unknown): Preferences {
  const d = defaultPreferences();
  const r = (raw ?? {}) as Partial<Record<keyof Preferences, unknown>>;
  return {
    volume: typeof r.volume === 'number' && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : d.volume,
    muted: typeof r.muted === 'boolean' ? r.muted : d.muted,
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
