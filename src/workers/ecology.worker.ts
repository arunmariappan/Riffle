/// <reference lib="webworker" />
/**
 * The ecology worker (plan 5, 6.6): the valley's ecosystem runs here, a few steps per call, so the main thread only
 * sees the results. The main thread sends the clock and the weather choice; the worker catches the ecosystem up in
 * fixed hourly and daily steps and reports the populations, the weather, the stream and each stretch's water.
 */
import * as Comlink from 'comlink';
import {
  Ecology,
  type EcologyPoint,
  type EcologySettings,
  type EcologySnapshot,
  type StretchCohorts,
} from '../sim/ecology/ecology';
import type { Stretch } from '../sim/ecology/stretches';
import type { SpeciesLife } from '../sim/ecology/cohorts';
import type { StretchEnv } from '../sim/ecology/environment';
import { WEATHER_LOOKS, type WeatherKind } from '../sim/weather/weather';

export interface EcologyInit {
  seed: string;
  stretches: Stretch[];
  species: SpeciesLife[];
  startSeconds: number;
  settings: Partial<EcologySettings>;
  weather: 'auto' | WeatherKind;
  /** A saved state to continue from (same valley). */
  saved?: Uint8Array;
}

export interface EcologyReport {
  seconds: number;
  snapshot: EcologySnapshot;
  weather: WeatherKind;
  /** Rain falling now, mm/h. */
  rain: number;
  /** Discharge relative to the usual level (the catchment after rain, the season's base flow). */
  dischargeRatio: number;
  turbidity: number;
  stretches: StretchCohorts[];
  env: StretchEnv[];
  /** Days simulated in this call. */
  days: number;
  /** Graph points recorded so far. */
  historyLength: number;
}

/** At most this many days per call; a longer jump catches up over the next calls. */
const MAX_DAYS = 120;
/** A jump of more than this is not simulated (the valley simply continues from the new date). */
const MAX_JUMP_DAYS = 3 * 365;

let eco: Ecology | null = null;

function report(days: number): EcologyReport | null {
  if (!eco) return null;
  return {
    seconds: eco.seconds,
    snapshot: eco.snapshot(),
    weather: eco.weather.state,
    rain: WEATHER_LOOKS[eco.weather.state].rain,
    dischargeRatio: eco.catchment.ratio(eco.dayOfYear),
    turbidity: eco.catchment.turbidity,
    stretches: eco.cohortView(),
    env: eco.env,
    days,
    historyLength: eco.history.length,
  };
}

function setWeather(mode: 'auto' | WeatherKind): void {
  if (!eco) return;
  if (mode === 'auto') eco.autoWeather = true;
  else {
    eco.autoWeather = false;
    eco.setWeather(mode, 1e6);
  }
}

const api = {
  init(init: EcologyInit): EcologyReport | null {
    eco = new Ecology({
      seed: init.seed,
      stretches: init.stretches,
      species: init.species,
      startSeconds: init.startSeconds,
      settings: init.settings,
    });
    if (init.saved) {
      try {
        eco.restore(init.saved);
      } catch (err) {
        console.warn('The saved ecosystem could not be restored; starting fresh', err);
      }
    }
    eco.settings = { ...eco.settings, ...init.settings };
    setWeather(init.weather);
    return report(0);
  },

  /** Catches the ecosystem up to the clock (simulated seconds since year 0). */
  sync(seconds: number): EcologyReport | null {
    if (!eco) return null;
    const behind = seconds - eco.seconds;
    let days = 0;
    if (behind < -3600 || behind > MAX_JUMP_DAYS * 86400) eco.jumpTo(seconds);
    else if (behind > 0) days = eco.advance(Math.min(behind, MAX_DAYS * 86400));
    return report(days);
  },

  setSettings(settings: Partial<EcologySettings>): void {
    if (eco) eco.settings = { ...eco.settings, ...settings };
  },

  setWeather,

  setStretches(stretches: Stretch[]): void {
    eco?.setStretches(stretches);
  },

  addFish(x: number, z: number, species: number, count: number): void {
    eco?.addFish(x, z, species, count);
  },

  removeFish(x: number, z: number, species: number, count: number): void {
    eco?.removeFish(x, z, species, count);
  },

  /** Graph points from index `from` on. */
  history(from = 0): EcologyPoint[] {
    return eco ? eco.history.slice(from) : [];
  },

  serialize(): Uint8Array | null {
    return eco ? eco.serialize() : null;
  },

  hash(): string {
    return eco?.hash() ?? '';
  },
};

export type EcologyWorkerApi = typeof api;
Comlink.expose(api);
