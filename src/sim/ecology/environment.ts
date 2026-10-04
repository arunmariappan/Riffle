/**
 * The water's daily environment per stretch (plan 6.6): temperature, dissolved oxygen (with its pre-dawn low), light
 * at the water, drifting insects, algae and nutrients. Pure TypeScript; one step per simulated day.
 */
import type { Stretch } from './stretches';
import { waterTemperature } from './temperature';
import { seasonWeights } from '../time/clock';

export interface StretchEnv {
  /** Daily mean water temperature, °C. */
  waterTemp: number;
  /** Daily mean dissolved oxygen and its pre-dawn minimum, mg/L. */
  oxygen: number;
  oxygenMin: number;
  /** Light reaching the water, 0..1. */
  light: number;
  /** Drifting and falling insects, 0..1 (food for most fish). */
  insects: number;
  /** Algae on stones and the bed, 0..1 (grazed by loaches and minnows, scoured by floods). */
  algae: number;
  /** Dissolved nutrients, 0..1 (leaf litter, fish waste, decay). */
  nutrients: number;
  turbidity: number;
}

/** The valley-wide weather of a day, as the stretches feel it. */
export interface Climate {
  dayOfYear: number;
  /** 0..1 average cloud cover. */
  cloudCover: number;
  /** Rain over the day, mm. */
  rain: number;
  /** Stream turbidity from the catchment, 0..1. */
  turbidity: number;
  /** Discharge relative to its usual level (floods > 1.5). */
  flowRatio: number;
}

/** Dissolved oxygen at saturation, mg/L, at the valley's altitude (about 87% of sea level). */
export function oxygenSaturation(t: number): number {
  return (14.652 - 0.41022 * t + 0.007991 * t * t - 0.000077774 * t * t * t) * 0.87;
}

/** Length of the day in hours at the valley's latitude (27.5°N). */
export function dayLength(dayOfYear: number): number {
  const lat = (27.5 * Math.PI) / 180;
  const decl = -0.4091 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365);
  const c = Math.min(1, Math.max(-1, -Math.tan(lat) * Math.tan(decl)));
  return (24 / Math.PI) * Math.acos(c);
}

export function initialEnv(): StretchEnv {
  return {
    waterTemp: 14,
    oxygen: 9,
    oxygenMin: 8.5,
    light: 0.5,
    insects: 0.5,
    algae: 0.3,
    nutrients: 0.3,
    turbidity: 0.1,
  };
}

/**
 * One day of a stretch's environment. `fishBiomass` (kg/m²) adds waste and oxygen demand; `grazing` (kg/m² of
 * algae eaters) eats algae; `litter` (0..1) is the leaf fall on it today.
 */
export function stepEnvironment(
  s: Stretch,
  prev: StretchEnv,
  climate: Climate,
  fishBiomass: number,
  grazing: number,
  litter: number,
): StretchEnv {
  const w = seasonWeights(climate.dayOfYear);
  const t = waterTemperature({
    dayOfYear: climate.dayOfYear,
    hour: 10,
    speed: s.meanSpeed,
    depth: s.meanDepth,
    pond: s.pond,
    shade: s.shade,
  });
  const turbidity = s.pond ? prev.turbidity + (climate.turbidity * 0.6 - prev.turbidity) * 0.15 : climate.turbidity;
  // Light at the water: day length and sun height by season, cloud, canopy shade, murky water.
  const sun = (dayLength(climate.dayOfYear) - 10) / 4;
  const light = Math.min(
    1,
    Math.max(0, (0.55 + sun * 0.35) * (1 - climate.cloudCover * 0.5) * (1 - s.shade * 0.75) * (1 - turbidity * 0.5)),
  );
  // Insects: the warm seasons, riffles (drift), plants and an overhanging canopy (terrestrial insects falling in).
  const season = w.winter * 0.2 + w.spring * 0.65 + w.premonsoon * 1 + w.monsoon * 0.8 + w.autumn * 0.5;
  const insects = Math.min(1, season * (0.35 + s.turbulence * 0.9 + s.plants * 0.25 + s.shade * 0.3 + s.gravel * 0.2));
  const tf = Math.pow(1.07, t - 20);
  // Nutrients: leaf litter and fish waste in, flushing out (faster water and floods), algae take some up.
  const flush = (s.pond ? 0.02 : 0.03 + s.meanSpeed * 0.05) * climate.flowRatio;
  const uptake = (prev.algae * 0.01 + s.plants * 0.015) * tf;
  let nutrients = prev.nutrients + litter * 0.06 + fishBiomass * 0.15 - prev.nutrients * (flush + uptake);
  nutrients = Math.min(1, Math.max(0.02, nutrients));
  // Algae: grow with light, nutrients and warmth; grazed; scoured away by floods.
  const growth = 0.12 * light * (nutrients / (nutrients + 0.15)) * tf;
  const scour = climate.flowRatio > 1.6 ? (climate.flowRatio - 1.6) * 0.15 : 0;
  let algae =
    prev.algae + growth * prev.algae * (1 - prev.algae) + 0.002 - grazing * 2 * prev.algae - scour * prev.algae;
  algae = Math.min(1, Math.max(0.01, algae));
  // Oxygen: saturation by temperature; turbulent and fast water re-aerates; plants and algae add it by day;
  // decay and fish use it (more when warm). The night minimum has no photosynthesis.
  const sat = oxygenSaturation(t);
  const reaeration = s.pond ? 0.15 : 0.25 + s.turbulence * 1.4 + s.meanSpeed * 0.6;
  const respiration = (nutrients * 1.0 + fishBiomass * 3 + algae * 0.4) * tf;
  const photosynthesis = (s.plants * 1.2 + algae * 1.5) * light;
  const deficit = Math.min(0.9, Math.max(-0.15, (respiration - photosynthesis * 0.6) / (reaeration * 10 + 1)));
  const nightDeficit = Math.min(0.95, Math.max(0, (respiration + photosynthesis * 0.15) / (reaeration * 10 + 1)));
  return {
    waterTemp: t,
    oxygen: sat * (1 - deficit),
    oxygenMin: sat * (1 - nightDeficit),
    light,
    insects,
    algae,
    nutrients,
    turbidity,
  };
}
