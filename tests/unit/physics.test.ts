import { describe, expect, it } from 'vitest';
import { Physics } from '../../src/engine/physics/Physics';
import { sampleHeight } from '../../src/sim/terrain/heightfield';
import { generateValley } from '../../src/sim/terrain/valley';

describe('physics heightfield', () => {
  it('matches the terrain heights within a few centimeters', async () => {
    const valley = generateValley({ seed: 'riffle', size: 257, cell: 4, droplets: 3000 });
    const physics = await Physics.create(valley.heightfield);
    const points: [number, number][] = [
      [0, 0],
      [100, -200],
      [-300, 250],
      [valley.pond.x, valley.pond.z],
      [valley.spots[0]!.x, valley.spots[0]!.z],
    ];
    for (const [x, z] of points) {
      const hit = physics.groundHeight(x, z);
      expect(hit).not.toBeNull();
      expect(Math.abs((hit as number) - sampleHeight(valley.heightfield, x, z))).toBeLessThan(0.75);
    }
    physics.dispose();
  });
});
