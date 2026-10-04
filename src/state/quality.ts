/**
 * The quality presets (plan 9: Low / Medium / High / Ultra): what each one renders and how much it simulates near you.
 * The post-processing chain per preset is in `engine/post/pipeline.ts`. Pure TypeScript.
 */

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export const QUALITY_PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

export interface QualityProfile {
  label: string;
  description: string;
  /** Render resolution as a share of the screen (TRAA upscales, plan D9); the most dynamic resolution may use. */
  renderScale: number;
  /** The least dynamic resolution may drop to. */
  minRenderScale: number;
  /** Grass blade density multiplier. */
  grass: number;
  /** Most individual fish shown near the camera. */
  fishBudget: number;
}

export const QUALITY: Record<QualityPreset, QualityProfile> = {
  low: {
    label: 'Low',
    description: 'No ambient occlusion or bounce light, sparse grass, fewer fish',
    renderScale: 0.7,
    minRenderScale: 0.5,
    grass: 0.35,
    fishBudget: 300,
  },
  medium: {
    label: 'Medium',
    description: 'Ambient occlusion, temporal anti-aliasing',
    renderScale: 0.8,
    minRenderScale: 0.55,
    grass: 0.6,
    fishBudget: 500,
  },
  high: {
    label: 'High',
    description: 'Screen-space bounce light (SSGI), full grass — the target on an RTX 3060-class card',
    renderScale: 0.85,
    minRenderScale: 0.6,
    grass: 1,
    fishBudget: 700,
  },
  ultra: {
    label: 'Ultra',
    description: 'Native resolution, finer bounce light, denser grass',
    renderScale: 1,
    minRenderScale: 0.7,
    grass: 1.3,
    fishBudget: 900,
  },
};

export function isQualityPreset(v: unknown): v is QualityPreset {
  return typeof v === 'string' && (QUALITY_PRESETS as readonly string[]).includes(v);
}
