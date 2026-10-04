import { describe, expect, it } from 'vitest';
import { KingfisherBrain, type KingfisherWorld } from '../../src/sim/fauna/kingfisher';
import { createRng } from '../../src/sim/rng';

/** A straight stream along z: perches on the bank at x = ±6 (1 m up), shallows in the middle (surface at 0). */
function world(active = true): KingfisherWorld {
  const rng = createRng('perches');
  return {
    active,
    perchNear: (x, z, minR, maxR) => {
      const r = rng.range(minR, maxR);
      return { x: rng.next() < 0.5 ? -6 : 6, y: 1, z: z + (rng.next() < 0.5 ? -r : r) };
    },
    shallowsNear: (x, z) => ({ x: x * 0.5, z: z + 2, surface: 0 }),
  };
}

describe('the kingfisher (plan 6.6)', () => {
  it('arrives, perches, flies and dives into the shallows', () => {
    const bird = new KingfisherBrain(createRng('bird'));
    const w = world();
    const seen = new Set<string>();
    let splashes = 0;
    let lowest = Infinity;
    for (let t = 0; t < 600; t += 0.05) {
      const ev = bird.step(0.05, w, { x: 0, z: 0 });
      seen.add(bird.state);
      if (ev.splash) splashes++;
      if (bird.visible) {
        lowest = Math.min(lowest, bird.y);
        // Never far from the camera while it is about.
        expect(Math.hypot(bird.x, bird.z)).toBeLessThan(100);
      }
    }
    for (const s of ['perch', 'fly', 'hover', 'dive', 'under', 'rise']) expect(seen.has(s), s).toBe(true);
    expect(splashes).toBeGreaterThan(4);
    // Only under the water out of sight: visible, it never dips more than its own body below the surface.
    expect(lowest).toBeGreaterThan(-0.2);
  });

  it('stays away at night (or with the setting off)', () => {
    const bird = new KingfisherBrain(createRng('night'));
    for (let t = 0; t < 120; t += 0.1) bird.step(0.1, world(false), { x: 0, z: 0 });
    expect(bird.state).toBe('away');
    expect(bird.visible).toBe(false);
  });
});
