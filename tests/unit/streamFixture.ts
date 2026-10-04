/**
 * A test stream (the Phase 0 channel, straight along +z, 200 m) with a deep pool between z = 15 and 45, and a round
 * pond beside it, as fish flow samplers.
 */
import { FlowField, type Stone } from '../../src/sim/flow/field';
import { buildRiverPath } from '../../src/sim/flow/path';
import type { FlowProbe, FlowSampler } from '../../src/sim/boids/school';

export const POND = { x: 40, z: 0, radius: 10, depth: 1.6, level: 0.5 };

export function makeFlow(stones: Stone[] = [{ id: 1, x: 0, z: 0, radius: 0.9, height: 1.1 }], discharge = 4) {
  const bed = (x: number, z: number) => {
    const ax = Math.abs(x);
    const pool = z > 15 && z < 45 ? 1.4 * Math.sin(((z - 15) / 30) * Math.PI) ** 2 : 0;
    return -0.004 * z + (ax < 5 ? -(1.1 + pool) * (1 - (ax / 5) ** 2) : (ax - 5) * 0.6);
  };
  const path = buildRiverPath(
    [
      { x: 0, z: -100 },
      { x: 0, z: 100 },
    ],
    0.5,
  );
  const field = new FlowField(path, bed, { cellsAcross: 33 });
  field.setDischarge(discharge);
  field.setStones(stones);
  field.solve();
  const pond = (x: number, z: number): FlowProbe | null => {
    const d = Math.hypot(x - POND.x, z - POND.z);
    if (d > POND.radius) return null;
    const bedY = POND.level - POND.depth * (1 - (d / POND.radius) ** 2);
    const depth = POND.level - bedY;
    if (depth < 0.005) return null;
    return { velocityX: 0, velocityZ: 0, depth, surface: POND.level, bed: bedY, shelter: 0, pond: true };
  };
  const sampler: FlowSampler = {
    sample: (x, z) => {
      const p = pond(x, z);
      if (p) return p;
      const s = field.sample((z + 100) / 0.5, -x);
      return s && s.depth > 0.01
        ? {
            velocityX: s.velocityX,
            velocityZ: s.velocityZ,
            depth: s.depth,
            surface: s.surface,
            bed: s.bed,
            shelter: s.shelter,
          }
        : null;
    },
    towardChannel: (x, z) => {
      const d = Math.hypot(x - POND.x, z - POND.z);
      if (d < POND.radius + 3 && d > 0.01) return [(POND.x - x) / d, (POND.z - z) / d];
      return [-Math.sign(x) || 1, 0];
    },
  };
  return { field, sampler };
}
