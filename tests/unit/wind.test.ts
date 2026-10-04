import { describe, expect, it } from 'vitest';
import { beaufort, CALM_BREEZE, MONSOON_STORM, windStrengthAt, windVelocityAt } from '../../src/sim/wind/windField';

describe('wind field', () => {
  it('names Beaufort forces', () => {
    expect(beaufort(0.2).name).toBe('Calm');
    expect(beaufort(4).force).toBe(3);
    expect(beaufort(30).name).toBe('Violent storm');
  });

  it('is stronger in a storm and never negative', () => {
    let calm = 0;
    let storm = 0;
    for (let i = 0; i < 400; i++) {
      const x = (i % 20) * 13;
      const z = Math.floor(i / 20) * 17;
      const a = windStrengthAt(CALM_BREEZE, x, z, i * 0.3);
      const b = windStrengthAt(MONSOON_STORM, x, z, i * 0.3);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThanOrEqual(0);
      calm += a;
      storm += b;
    }
    expect(storm).toBeGreaterThan(calm * 2.5);
  });

  it('gust fronts travel downwind', () => {
    // Find where a gust peaks along the wind line at t=0, then check it has moved downwind a few seconds later.
    const w = { ...CALM_BREEZE, turbulence: 0 };
    const peakAt = (t: number) => {
      let best = -1;
      let bestS = -Infinity;
      for (let s = 0; s < 140; s += 0.5) {
        const v = windStrengthAt(w, w.dirX * s, w.dirZ * s, t);
        if (v > best) {
          best = v;
          bestS = s;
        }
      }
      return bestS;
    };
    const p0 = peakAt(0);
    const p1 = peakAt(3);
    expect(p1).toBeGreaterThan(p0);
  });

  it('blows in the wind direction', () => {
    const [vx, vz] = windVelocityAt(CALM_BREEZE, 10, 10, 1);
    expect(vx * CALM_BREEZE.dirX + vz * CALM_BREEZE.dirZ).toBeGreaterThan(0);
  });
});
