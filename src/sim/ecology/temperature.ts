/**
 * Air and water temperature (plan 6.6) for a valley around 1,200 m in the Himalayan foothills: a seasonal cycle with
 * a warm pre-monsoon, a cloud-cooled monsoon and cool, clear winters, plus the daily swing. Water lags the air, swings
 * less, and stays cooler in fast, deep or shaded water; the still pond runs warmer. Pure TypeScript.
 */

/** Monthly mean air temperature (°C), January first, at the valley floor. */
const MONTHLY_AIR = [8, 10, 15, 19, 23, 24, 22, 22, 21, 18, 13, 9];
/** Daily air swing (max − min, °C) by month: wide in dry clear months, narrow under monsoon cloud. */
const MONTHLY_SWING = [12, 12, 13, 13, 12, 9, 6, 6, 7, 10, 12, 12];
const DAYS_PER_YEAR = 365;

/** Smooth monthly interpolation (day 0 = 1 January). */
function monthly(table: readonly number[], dayOfYear: number): number {
  const m = ((dayOfYear / DAYS_PER_YEAR) * 12 - 0.5 + 12) % 12;
  const i = Math.floor(m);
  const t = m - i;
  const a = table[i % 12] as number;
  const b = table[(i + 1) % 12] as number;
  const s = t * t * (3 - 2 * t);
  return a + (b - a) * s;
}

/** Air temperature (°C) at a day of year and hour, optionally at a height above the valley floor (m). */
export function airTemperature(dayOfYear: number, hour: number, altitudeAboveFloor = 0): number {
  const mean = monthly(MONTHLY_AIR, dayOfYear);
  const swing = monthly(MONTHLY_SWING, dayOfYear);
  // Coldest just before dawn, warmest mid-afternoon.
  const daily = Math.cos(((hour - 14.5) / 24) * Math.PI * 2);
  return mean + daily * swing * 0.5 - altitudeAboveFloor * 0.0065;
}

export interface WaterSpot {
  dayOfYear: number;
  hour: number;
  /** Current speed, m/s. */
  speed: number;
  /** Water depth, m. */
  depth: number;
  /** The still backwater pond. */
  pond?: boolean;
  /** 0 open sky .. 1 deep shade. */
  shade?: number;
}

/** Water temperature (°C): lags the air by about two weeks, swings less, cooler where fast, deep or shaded. */
export function waterTemperature(s: WaterSpot): number {
  const lagged = monthly(MONTHLY_AIR, (s.dayOfYear - 14 + DAYS_PER_YEAR) % DAYS_PER_YEAR);
  // Snowmelt and springs keep the stream below the air in the warm months.
  let t = 2.5 + lagged * 0.82;
  const fast = Math.min(1, s.speed / 1.0);
  const shade = s.shade ?? 0;
  t -= fast * 1.6 + shade * 1.2;
  if (s.pond) t += 2.5;
  // Shallow, slow water follows the sun; deep or fast water barely does.
  const swing = monthly(MONTHLY_SWING, s.dayOfYear) * 0.22 * (1 - fast * 0.7) * Math.exp(-s.depth / 1.4);
  t += Math.cos(((s.hour - 16) / 24) * Math.PI * 2) * swing * (1 - shade * 0.6);
  return Math.max(0.5, t);
}
