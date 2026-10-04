/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { generateValley, type Valley } from '../sim/terrain/valley';
import { computeGrassDensity } from '../sim/scatter/grassDensity';

function transferables(v: Valley): Transferable[] {
  return [
    v.heightfield.heights.buffer,
    v.path.points.buffer,
    v.path.tangents.buffer,
    v.path.normals.buffer,
    v.profile.thalweg.buffer,
    v.profile.bank.buffer,
    v.profile.halfWidth.buffer,
    v.profile.floodplain.buffer,
    v.masks.riverDistance.buffer,
    v.masks.riverSection.buffer,
    v.masks.wetness.buffer,
    v.masks.flow.buffer,
    v.masks.sediment.buffer,
    ...(v.grassDensity ? [v.grassDensity.buffer] : []),
  ] as Transferable[];
}

const api = {
  generate(seed: string, onProgress?: (stage: string, fraction: number) => void): Valley {
    const valley = generateValley({ seed, onProgress: onProgress ? (s, f) => void onProgress(s, f) : undefined });
    valley.grassDensity = computeGrassDensity(valley, seed);
    return Comlink.transfer(valley, transferables(valley));
  },
};

export type TerrainWorkerApi = typeof api;
Comlink.expose(api);
