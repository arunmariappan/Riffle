/** The real generated valley (smaller grid) with its solved stream, as ecology stretches (tests). */
import { generateValley } from '../../src/sim/terrain/valley';
import { sampleHeight } from '../../src/sim/terrain/heightfield';
import { FlowField } from '../../src/sim/flow/field';
import { FLOW_STRIDE } from '../../src/sim/flow/layout';
import { buildStretches, flowStretchSource, type Stretch } from '../../src/sim/ecology/stretches';
import { fishDefs } from './valleyFixture';

let cached: { stretches: Stretch[]; ns: number } | null = null;

export function realValleyStretches(): { stretches: Stretch[]; ns: number } {
  if (cached) return cached;
  const valley = generateValley({ seed: 'riffle', size: 513, cell: 2, droplets: 8000 });
  const hf = valley.heightfield;
  const field = new FlowField(valley.path, (x, z) => sampleHeight(hf, x, z), {
    cellsAcross: 49,
    reachStarts: valley.profile.reachStarts,
  });
  field.setDischarge(4);
  field.solve();
  const cells = new Float32Array(field.ns * field.nn * FLOW_STRIDE);
  for (let k = 0; k < field.ns * field.nn; k++) {
    const o = k * FLOW_STRIDE;
    cells[o] = field.velX[k]!;
    cells[o + 1] = field.velZ[k]!;
    cells[o + 2] = field.foam[k]!;
    cells[o + 3] = field.depth[k]!;
    cells[o + 4] = field.shelter[k]!;
    cells[o + 5] = field.bed[k]!;
  }
  const pond = valley.pond;
  const level = field.level[pond.section]!;
  let area = 0;
  let depthSum = 0;
  let maxDepth = 0;
  for (let z = pond.z - pond.radius; z <= pond.z + pond.radius; z++)
    for (let x = pond.x - pond.radius; x <= pond.x + pond.radius; x++) {
      if ((x - pond.x) ** 2 + (z - pond.z) ** 2 > pond.radius ** 2) continue;
      const d = level - sampleHeight(hf, x, z);
      if (d < 0.03) continue;
      area++;
      depthSum += d;
      maxDepth = Math.max(maxDepth, d);
    }
  const stretches = buildStretches(
    flowStretchSource({
      layout: { ns: field.ns, nn: field.nn, ds: field.ds, dn: field.dn },
      cells,
      points: valley.path.points,
      zones: valley.profile.zones,
      reachStarts: valley.profile.reachStarts,
      shade: () => 0.3,
      pond:
        area > 4 ? { area, meanDepth: depthSum / area, maxDepth, section: pond.section, x: pond.x, z: pond.z } : null,
    }),
    fishDefs.map((d) => ({ depth: d.habitat.depth, flow: d.habitat.flow })),
  );
  cached = { stretches, ns: field.ns };
  return cached;
}
