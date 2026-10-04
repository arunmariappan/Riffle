import { describe, expect, it } from 'vitest';
import { SimClock, seasonOf, seasonWeights, skyDirections, SEASONS } from '../../src/sim/time/clock';

describe('sim clock', () => {
  it('puts the sun high in the south at noon and below the horizon at midnight', () => {
    const noon = skyDirections(172, 12, 172);
    expect(noon.sun[1]).toBeGreaterThan(0.9); // midsummer at 27.5°N: ~86° high
    const winterNoon = skyDirections(355, 12, 355);
    expect(winterNoon.sun[1]).toBeGreaterThan(0.6);
    expect(winterNoon.sun[2]).toBeGreaterThan(0.3); // south is +z
    const midnight = skyDirections(95, 0, 95);
    expect(midnight.sun[1]).toBeLessThan(-0.3);
  });

  it('rises in the east and sets in the west', () => {
    const morning = skyDirections(95, 7, 95);
    const evening = skyDirections(95, 17, 95);
    expect(morning.sun[0]).toBeGreaterThan(0.5);
    expect(evening.sun[0]).toBeLessThan(-0.5);
  });

  it('returns unit vectors', () => {
    for (let h = 0; h < 24; h += 3) {
      const s = skyDirections(200, h, 200 + h / 24);
      expect(Math.hypot(...s.sun)).toBeCloseTo(1, 6);
      expect(Math.hypot(...s.moon)).toBeCloseTo(1, 6);
    }
  });

  it('follows the monsoon calendar', () => {
    expect(seasonOf(10)).toBe('winter');
    expect(seasonOf(95)).toBe('spring');
    expect(seasonOf(140)).toBe('premonsoon');
    expect(seasonOf(200)).toBe('monsoon');
    expect(seasonOf(300)).toBe('autumn');
    expect(seasonOf(350)).toBe('winter');
  });

  it('blends season weights smoothly and they sum to 1', () => {
    for (let d = 0; d < 365; d += 0.5) {
      const w = seasonWeights(d);
      const sum = SEASONS.reduce((s, k) => s + w[k], 0);
      expect(sum).toBeCloseTo(1, 6);
    }
    const edge = seasonWeights(165);
    expect(edge.monsoon).toBeGreaterThan(0.3);
    expect(edge.premonsoon).toBeGreaterThan(0.3);
  });

  it('advances with the time scale and can pause', () => {
    const clock = new SimClock(95, 8);
    clock.timeScale = 60;
    clock.advance(60);
    expect(clock.hour).toBeCloseTo(9, 6);
    clock.paused = true;
    clock.advance(60);
    expect(clock.hour).toBeCloseTo(9, 6);
  });
});
