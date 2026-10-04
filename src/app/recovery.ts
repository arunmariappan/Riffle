/**
 * What to do when the GPU device is lost (plan 9: an "oops, reloading" message that restores from the last
 * autosave). If it keeps happening, the reload drops to a lighter quality preset. Pure TypeScript.
 */
import { QUALITY_PRESETS, type QualityPreset } from '../state/quality';

/** Device losses closer together than this count as "again". */
const WINDOW_MS = 5 * 60 * 1000;

export interface RecoveryPlan {
  /** Quality to reload at. */
  quality: QualityPreset;
  /** The message on screen while reloading. */
  message: string;
  /** Query string for the reload (continue from the autosave). */
  search: string;
  /** Losses to remember (this one included). */
  history: number[];
}

export function recoveryPlan(
  history: readonly number[],
  now: number,
  quality: QualityPreset,
  reason: string,
): RecoveryPlan {
  const recent = [...history.filter((t) => now - t < WINDOW_MS), now];
  let next = quality;
  if (recent.length >= 2) {
    const i = QUALITY_PRESETS.indexOf(quality);
    next = QUALITY_PRESETS[Math.max(0, i - 1)] as QualityPreset;
  }
  const lighter = next !== quality ? ` It happened again, so Riffle will use the ${next} quality preset.` : '';
  return {
    quality: next,
    message: `The graphics device stopped (${reason}). Reloading your valley from the last autosave…${lighter}`,
    search: new URLSearchParams({ continue: '', quality: next }).toString(),
    history: recent,
  };
}
