/**
 * A fish species' content file (content/fish/*.json) as school behavior (plan 7: adding a fish needs no code).
 * Pure TypeScript, shared by the fish worker, the engine and the tests.
 */
import type { FishDef } from '../../content/schema';
import type { SpeciesBehavior } from './school';

export function behaviorFromDef(def: FishDef): SpeciesBehavior {
  const b = def.behavior;
  const h = def.habitat;
  return {
    id: def.id,
    length: def.body.length,
    cruise: b.cruise,
    burst: b.burst,
    comfortCurrent: b.comfortCurrent,
    depthPreference: b.depthPreference,
    minDepth: h.depth[0],
    schooling: b.schooling,
    shyness: b.shyness,
    rheotaxis: b.rheotaxis,
    clings: b.clings,
    glides: b.glides,
    curiosity: b.curiosity,
    habitat: { depth: h.depth, flow: h.flow, temperature: h.temperature },
    pondOnly: h.pondOnly,
    eatsInsects: def.diet.includes('insects'),
    // Bold, curious fish (koi) come to food from across the pond.
    foodRange: b.curiosity > 0.6 ? 30 : 14,
    genes: {
      bodySize: def.genes.bodySize,
      swimStrength: def.genes.swimStrength,
      preferredFlow: def.genes.preferredFlow,
      brightness: def.genes.brightness,
      shyness: def.genes.shyness,
    },
  };
}
