/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { FlowField, type SideInflow, type Stone, type SolveStats } from '../sim/flow/field';
import { buildRiverPath, type Vec2 } from '../sim/flow/path';
import { sampleHeight, type Heightfield } from '../sim/terrain/heightfield';
import { DoubleBuffer, type DoubleBufferHandle } from '../sim/shared/doubleBuffer';

import { FLOW_STRIDE } from '../sim/flow/layout';

export interface FlowInit {
  controls: Vec2[];
  heightfield: Heightfield;
  reachStarts: number[];
  cellsAcross: number;
  discharge: number;
}

export interface FlowLayout {
  ns: number;
  nn: number;
  ds: number;
  dn: number;
}

let field: FlowField | null = null;
let flowBuffer: DoubleBuffer | null = null;
let levelBuffer: DoubleBuffer | null = null;

function publish(): void {
  if (!field || !flowBuffer || !levelBuffer) return;
  const f = field;
  flowBuffer.write((out) => {
    const n = f.ns * f.nn;
    for (let k = 0; k < n; k++) {
      const o = k * FLOW_STRIDE;
      out[o] = f.velX[k] as number;
      out[o + 1] = f.velZ[k] as number;
      out[o + 2] = f.foam[k] as number;
      out[o + 3] = f.depth[k] as number;
      out[o + 4] = f.shelter[k] as number;
      out[o + 5] = f.bed[k] as number;
      out[o + 6] = f.velAlong[k] as number;
      out[o + 7] = f.velAcross[k] as number;
    }
  });
  levelBuffer.write((out) => out.set(f.level));
}

const api = {
  /** Builds the flow grid along the stream and runs the first full solve. */
  init(input: FlowInit, flow: DoubleBufferHandle, levels: DoubleBufferHandle): FlowLayout & { stats: SolveStats } {
    const path = buildRiverPath(input.controls, 0.5);
    const hf = input.heightfield;
    field = new FlowField(path, (x, z) => sampleHeight(hf, x, z), {
      cellsAcross: input.cellsAcross,
      reachStarts: input.reachStarts,
    });
    field.setDischarge(input.discharge);
    flowBuffer = new DoubleBuffer(flow);
    levelBuffer = new DoubleBuffer(levels);
    const stats = field.solve();
    publish();
    return { ns: field.ns, nn: field.nn, ds: field.ds, dn: field.dn, stats };
  },

  /** Replaces the stones; re-solves only around `changed` when given (plan 6.2: local re-solve after an edit). */
  setStones(stones: Stone[], changed?: { x: number; z: number; radius: number }): SolveStats | null {
    if (!field) return null;
    field.setStones(stones);
    const stats = changed ? field.solveLocal(changed.x, changed.z, changed.radius) : field.solve();
    publish();
    return stats;
  },

  setDischarge(discharge: number): SolveStats | null {
    if (!field) return null;
    field.setDischarge(discharge);
    const stats = field.solve();
    publish();
    return stats;
  },

  setSpeedMultiplier(multiplier: number): SolveStats | null {
    if (!field) return null;
    field.setSpeedMultiplier(multiplier);
    const stats = field.solve();
    publish();
    return stats;
  },

  setLevelOffset(offset: number): SolveStats | null {
    if (!field) return null;
    field.setLevelOffset(offset);
    const stats = field.solve();
    publish();
    return stats;
  },

  setInflows(inflows: SideInflow[]): SolveStats | null {
    if (!field) return null;
    field.setInflows(inflows);
    const stats = field.solve();
    publish();
    return stats;
  },
};

export type FlowWorkerApi = typeof api;
Comlink.expose(api);
