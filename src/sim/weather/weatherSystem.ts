/**
 * Weather over time and the stream's catchment (plan 6.7): weather states follow each other with season-dependent
 * odds (dry clear winters, pre-monsoon storms, monsoon downpours), and rain fills the catchment, which raises the
 * discharge after a delay and clouds the water. Pure TypeScript and seeded.
 */
import type { Rng } from '../rng';
import { seasonWeights, SEASONS, type Season } from '../time/clock';
import { WEATHER_KINDS, WEATHER_LOOKS, type WeatherKind } from './weather';

/** How often each weather comes up in each season (relative weights). */
const ODDS: Record<Season, Partial<Record<WeatherKind, number>>> = {
  winter: { clear: 0.55, overcast: 0.25, mist: 0.15, 'light-rain': 0.05 },
  spring: { clear: 0.45, overcast: 0.25, mist: 0.1, 'light-rain': 0.15, storm: 0.05 },
  premonsoon: { clear: 0.45, overcast: 0.2, storm: 0.18, 'light-rain': 0.1, downpour: 0.07 },
  monsoon: { overcast: 0.25, 'light-rain': 0.25, downpour: 0.35, mist: 0.1, storm: 0.05 },
  autumn: { clear: 0.6, overcast: 0.2, mist: 0.15, 'light-rain': 0.05 },
};

/** How long each weather lasts, hours (min, max). */
const DURATION: Record<WeatherKind, [number, number]> = {
  clear: [12, 48],
  overcast: [6, 24],
  mist: [3, 8],
  'light-rain': [3, 12],
  downpour: [2, 10],
  storm: [1, 4],
};

export class WeatherSystem {
  state: WeatherKind = 'clear';
  hoursLeft = 12;

  rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  /** Advances by `hours`; returns true when the weather changed. */
  step(hours: number, dayOfYear: number): boolean {
    this.hoursLeft -= hours;
    if (this.hoursLeft > 0) return false;
    const w = seasonWeights(dayOfYear);
    const odds = WEATHER_KINDS.map((k) => SEASONS.reduce((sum, s) => sum + w[s] * (ODDS[s][k] ?? 0), 0));
    // Rarely the same weather twice in a row (it just ran out), except in the monsoon.
    const total = odds.reduce((a, b) => a + b, 0);
    let roll = this.rng.next() * total;
    let next: WeatherKind = 'clear';
    for (let i = 0; i < WEATHER_KINDS.length; i++) {
      roll -= odds[i] as number;
      if (roll <= 0) {
        next = WEATHER_KINDS[i] as WeatherKind;
        break;
      }
    }
    const [lo, hi] = DURATION[next];
    this.state = next;
    this.hoursLeft = lo + (hi - lo) * this.rng.next();
    return true;
  }

  /** Rain falling now, mm/h. */
  rain(): number {
    return WEATHER_LOOKS[this.state].rain;
  }
}

/**
 * The catchment above the valley as a linear reservoir: rain fills it, it drains into the stream over about a day
 * and a half, on top of a seasonal base flow (snowmelt in spring, high in the monsoon). Rain also washes silt in.
 */
export class Catchment {
  /** Water stored in the catchment, mm. */
  storage = 0;
  /** 0..1 silt in the stream. */
  turbidity = 0.08;
  /** Usual (dry weather) discharge, m³/s, the discharge slider's reference. */
  readonly nominal = 4;
  /** Catchment area, km². */
  readonly area = 8;
  /** Drainage time constant, hours. */
  readonly k = 30;

  baseflow(dayOfYear: number): number {
    const w = seasonWeights(dayOfYear);
    return w.winter * 2.6 + w.spring * 3.6 + w.premonsoon * 2.4 + w.monsoon * 5.5 + w.autumn * 4;
  }

  /** Advances by `hours` with rain (mm/h). */
  step(hours: number, rain: number, dayOfYear: number): void {
    // Wet ground runs off more.
    const runoff = 0.35 + Math.min(0.45, this.storage / 120);
    this.storage += rain * hours * runoff;
    this.storage -= this.storage * (1 - Math.exp(-hours / this.k));
    const silt = rain * hours * 0.012;
    const w = seasonWeights(dayOfYear);
    const base = 0.05 + w.monsoon * 0.12;
    this.turbidity = Math.min(1, base + (this.turbidity - base) * Math.exp(-hours / 20) + silt);
  }

  /** Discharge now, m³/s: base flow plus what the catchment is draining (1 mm/h over 8 km² ≈ 2.2 m³/s). */
  discharge(dayOfYear: number): number {
    const drain = this.storage / this.k; // mm/h
    return this.baseflow(dayOfYear) + (drain * this.area * 1e6 * 0.001) / 3600;
  }

  /** Discharge relative to the usual level. */
  ratio(dayOfYear: number): number {
    return this.discharge(dayOfYear) / this.nominal;
  }
}
