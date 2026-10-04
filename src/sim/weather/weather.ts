/**
 * Weather states (plan 6.7): clear, overcast, mist, light rain, monsoon downpour and storm, each with the look it
 * gives the sky, the air and the water. The builder picks one by hand; Phase 6 adds the automatic weather that follows
 * the seasons and raises the discharge after rain. Pure TypeScript.
 */

export type WeatherKind = 'clear' | 'overcast' | 'mist' | 'light-rain' | 'downpour' | 'storm';

export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'overcast', 'mist', 'light-rain', 'downpour', 'storm'];

export const WEATHER_NAMES: Record<WeatherKind, string> = {
  clear: 'Clear',
  overcast: 'Overcast',
  mist: 'Mist',
  'light-rain': 'Light rain',
  downpour: 'Monsoon downpour',
  storm: 'Storm',
};

export interface WeatherLook {
  /** 0..1 cloud cover. */
  cloudCover: number;
  /** 0..1 haze. */
  haze: number;
  /** 0..1 valley mist (fog pooling low). */
  mist: number;
  /** Rain rate, mm/h. */
  rain: number;
  /** Wind the weather brings (m/s), blended with the Wind panel's setting. */
  wind: number;
  gustiness: number;
  /** Lightning flashes and thunder. */
  lightning: boolean;
}

export const WEATHER_LOOKS: Record<WeatherKind, WeatherLook> = {
  clear: { cloudCover: 0.1, haze: 0.15, mist: 0, rain: 0, wind: 0, gustiness: 0, lightning: false },
  overcast: { cloudCover: 0.8, haze: 0.35, mist: 0.05, rain: 0, wind: 2, gustiness: 0.3, lightning: false },
  mist: { cloudCover: 0.6, haze: 0.7, mist: 0.9, rain: 0, wind: 0, gustiness: 0, lightning: false },
  'light-rain': { cloudCover: 0.85, haze: 0.5, mist: 0.3, rain: 3, wind: 2, gustiness: 0.4, lightning: false },
  downpour: { cloudCover: 1, haze: 0.75, mist: 0.5, rain: 30, wind: 5, gustiness: 0.7, lightning: false },
  storm: { cloudCover: 1, haze: 0.6, mist: 0.3, rain: 18, wind: 14, gustiness: 1.2, lightning: true },
};

/** Blends two looks (for smooth transitions between weather states). */
export function blendWeather(a: WeatherLook, b: WeatherLook, t: number): WeatherLook {
  const k = Math.min(1, Math.max(0, t));
  const m = (x: number, y: number) => x + (y - x) * k;
  return {
    cloudCover: m(a.cloudCover, b.cloudCover),
    haze: m(a.haze, b.haze),
    mist: m(a.mist, b.mist),
    rain: m(a.rain, b.rain),
    wind: m(a.wind, b.wind),
    gustiness: m(a.gustiness, b.gustiness),
    lightning: k < 0.5 ? a.lightning : b.lightning,
  };
}
