/**
 * The CPU twin of the wind shader (plan 6.3, D15): one wind state with travelling gust fronts, so particles, audio
 * and the ecology (seed spread) read the same gusts the trees show. Must match src/engine/vegetation/wind.ts.
 */
import { createSimplex2 } from '../noise';

export interface WindState {
  /** Unit direction the wind blows toward (x, z). */
  dirX: number;
  dirZ: number;
  /** m/s. */
  speed: number;
  gustiness: number;
  turbulence: number;
}

export const CALM_BREEZE: WindState = { dirX: 0.8, dirZ: 0.6, speed: 4, gustiness: 0.5, turbulence: 0.4 };
export const MONSOON_STORM: WindState = { dirX: -0.6, dirZ: 0.8, speed: 16, gustiness: 1.2, turbulence: 1 };

/** Beaufort force for a wind speed (m/s), for the Wind panel label. */
export function beaufort(speed: number): { force: number; name: string } {
  const limits = [0.5, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  const names = [
    'Calm',
    'Light air',
    'Light breeze',
    'Gentle breeze',
    'Moderate breeze',
    'Fresh breeze',
    'Strong breeze',
    'Near gale',
    'Gale',
    'Strong gale',
    'Storm',
    'Violent storm',
    'Hurricane force',
  ];
  let force = limits.findIndex((l) => speed < l);
  if (force < 0) force = 12;
  return { force, name: names[force] as string };
}

const noise3 = createSimplex2('wind-turbulence');

/** Wind strength (0 .. ~2), the same formula as `windStrengthAt` in the wind shader. */
export function windStrengthAt(w: WindState, x: number, z: number, time: number): number {
  const along = x * w.dirX + z * w.dirZ;
  const across = x * -w.dirZ + z * w.dirX;
  const front = Math.sin(along * 0.045 - time * w.speed * 0.045 * 0.8 + Math.sin(across * 0.02) * 1.5);
  const gust = Math.pow(Math.max(front, 0), 3) * w.gustiness;
  // The shader uses 3D MaterialX noise; a 2D noise drifting with time is close enough for gameplay.
  const turbulence = noise3(x * 0.03 + time * 0.2, z * 0.03 - time * 0.13) * w.turbulence * 0.5;
  const base = Math.min(2, Math.max(0, w.speed / 12));
  return Math.max(0, base * (1 + gust + turbulence));
}

/** Wind velocity (m/s) at a point: direction × speed × local gust strength relative to the base. */
export function windVelocityAt(w: WindState, x: number, z: number, time: number): [number, number] {
  const base = Math.min(2, Math.max(0, w.speed / 12));
  const k = base > 0 ? windStrengthAt(w, x, z, time) / base : 0;
  return [w.dirX * w.speed * k, w.dirZ * w.speed * k];
}
