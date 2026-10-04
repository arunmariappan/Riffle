/**
 * Simulated time (plan 6.6, 6.7): time of day, day of year and monsoon seasons, plus sun and moon directions for a
 * valley in the Himalayan foothills. World axes: +x east, −z north, +y up.
 */

export const LATITUDE_DEG = 27.5;
const DEG = Math.PI / 180;
const DAYS_PER_YEAR = 365;
const LUNAR_MONTH = 29.53;

export type Season = 'winter' | 'spring' | 'premonsoon' | 'monsoon' | 'autumn';
export const SEASONS: readonly Season[] = ['winter', 'spring', 'premonsoon', 'monsoon', 'autumn'];

/** Season boundaries (day of year, 0 = 1 January). Winter wraps around the year end. */
const SEASON_STARTS: Record<Season, number> = {
  spring: 59, // 1 Mar
  premonsoon: 120, // 1 May
  monsoon: 165, // 15 Jun
  autumn: 273, // 1 Oct
  winter: 335, // 1 Dec
};

export type SeasonWeights = Record<Season, number>;

export interface SkyDirections {
  sun: [number, number, number];
  moon: [number, number, number];
  /** 0 new moon .. 1 full moon. */
  moonIllumination: number;
}

/** Time-speed presets from the Ecosystem panel: simulated seconds per real second. */
export const TIME_SPEEDS = {
  realtime: 1,
  minuteIsHour: 60,
  minuteIsDay: 1440,
  seasonLapse: 86400 * 3,
} as const;

export class SimClock {
  /** Simulated seconds since 1 January 00:00 of year 0. */
  seconds: number;
  /** Simulated seconds per real second. */
  timeScale = TIME_SPEEDS.minuteIsHour;
  paused = false;
  /** When set, the season looks stay locked to this day of year while time of day still runs. */
  lockedDay: number | null = null;

  constructor(dayOfYear = 95, hour = 8) {
    this.seconds = (dayOfYear * 24 + hour) * 3600;
  }

  /** Advances by a real time step; returns the simulated seconds that passed. */
  advance(realDt: number): number {
    if (this.paused) return 0;
    const dt = realDt * this.timeScale;
    this.seconds += dt;
    return dt;
  }

  get totalDays(): number {
    return this.seconds / 86400;
  }

  get year(): number {
    return Math.floor(this.totalDays / DAYS_PER_YEAR);
  }

  /** Day of year 0..365 (fractional). */
  get dayOfYear(): number {
    if (this.lockedDay !== null) return this.lockedDay;
    const d = this.totalDays % DAYS_PER_YEAR;
    return d < 0 ? d + DAYS_PER_YEAR : d;
  }

  /** Hour of day 0..24 (fractional). */
  get hour(): number {
    const h = (this.seconds / 3600) % 24;
    return h < 0 ? h + 24 : h;
  }

  setTime(dayOfYear: number, hour: number): void {
    this.seconds = (this.year * DAYS_PER_YEAR + dayOfYear) * 86400 + hour * 3600;
  }

  setHour(hour: number): void {
    const day = Math.floor(this.totalDays);
    this.seconds = day * 86400 + hour * 3600;
  }

  season(): Season {
    return seasonOf(this.dayOfYear);
  }

  seasonWeights(): SeasonWeights {
    return seasonWeights(this.dayOfYear);
  }

  sky(): SkyDirections {
    return skyDirections(this.dayOfYear, this.hour, this.totalDays);
  }
}

export function seasonOf(day: number): Season {
  if (day >= SEASON_STARTS.winter || day < SEASON_STARTS.spring) return 'winter';
  if (day < SEASON_STARTS.premonsoon) return 'spring';
  if (day < SEASON_STARTS.monsoon) return 'premonsoon';
  if (day < SEASON_STARTS.autumn) return 'monsoon';
  return 'autumn';
}

/** Smooth season weights (sum to 1) with ~10-day transitions, so looks blend instead of switching. */
export function seasonWeights(day: number, blendDays = 10): SeasonWeights {
  const weights: SeasonWeights = { winter: 0, spring: 0, premonsoon: 0, monsoon: 0, autumn: 0 };
  const order: Season[] = ['spring', 'premonsoon', 'monsoon', 'autumn', 'winter'];
  let total = 0;
  for (let k = 0; k < order.length; k++) {
    const season = order[k] as Season;
    const start = SEASON_STARTS[season];
    const next = SEASON_STARTS[order[(k + 1) % order.length] as Season];
    const end = next > start ? next : next + DAYS_PER_YEAR;
    for (const shift of [-DAYS_PER_YEAR, 0, DAYS_PER_YEAR]) {
      const d = day + shift;
      const rise = clamp01((d - (start - blendDays / 2)) / blendDays);
      const fall = clamp01((end + blendDays / 2 - d) / blendDays);
      const w = Math.min(rise, fall);
      if (w > 0) {
        weights[season] += w;
        total += w;
      }
    }
  }
  for (const s of order) weights[s] /= total || 1;
  return weights;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Direction toward a body from its declination and hour angle (radians), in world axes. */
function direction(declination: number, hourAngle: number, latitude: number): [number, number, number] {
  const sinAlt =
    Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const az = Math.atan2(
    -Math.cos(declination) * Math.sin(hourAngle),
    Math.sin(declination) * Math.cos(latitude) - Math.cos(declination) * Math.cos(hourAngle) * Math.sin(latitude),
  );
  const east = Math.sin(az) * Math.cos(alt);
  const north = Math.cos(az) * Math.cos(alt);
  return [east, Math.sin(alt), -north];
}

export function skyDirections(
  dayOfYear: number,
  hour: number,
  totalDays: number,
  latitudeDeg = LATITUDE_DEG,
): SkyDirections {
  const lat = latitudeDeg * DEG;
  const declination = -23.44 * DEG * Math.cos((2 * Math.PI * (dayOfYear + 10)) / DAYS_PER_YEAR);
  const hourAngle = (hour - 12) * 15 * DEG;
  const sun = direction(declination, hourAngle, lat);
  // Moon: lags the sun by its phase angle; declination follows the opposite season (full moon high in winter).
  const phase = (((totalDays % LUNAR_MONTH) + LUNAR_MONTH) % LUNAR_MONTH) / LUNAR_MONTH;
  const moonHourAngle = hourAngle - phase * 2 * Math.PI;
  const moonDecl = -declination * Math.cos(phase * 2 * Math.PI);
  const moon = direction(moonDecl, moonHourAngle, lat);
  const moonIllumination = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
  return { sun, moon, moonIllumination };
}
