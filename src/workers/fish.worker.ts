/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { SharedFlowSampler, type SharedFlowConfig } from '../sim/flow/sharedSampler';
import { DoubleBuffer, type DoubleBufferHandle } from '../sim/shared/doubleBuffer';
import { School, type SpeciesBehavior, type Threat } from '../sim/boids/school';
import { FISH_STRIDE } from '../sim/boids/layout';

let flow: SharedFlowSampler | null = null;
let school: School | null = null;
let out: DoubleBuffer | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let threat: Threat | null = null;
const HZ = 30;

function publish(): void {
  if (!school || !out) return;
  const fish = school.fish;
  const stamp = performance.timeOrigin + performance.now();
  out.write((buf) => {
    buf[0] = fish.length;
    buf[1] = stamp % 1e7; // ms, wrapped to keep float precision
    for (let k = 0; k < fish.length; k++) {
      const f = fish[k]!;
      const o = 2 + k * FISH_STRIDE;
      buf[o] = f.x;
      buf[o + 1] = f.y;
      buf[o + 2] = f.z;
      buf[o + 3] = f.vx;
      buf[o + 4] = f.vy;
      buf[o + 5] = f.vz;
      buf[o + 6] = Math.atan2(f.hx, f.hz);
      buf[o + 7] = f.phase;
      buf[o + 8] = f.beat;
      buf[o + 9] = f.length;
      buf[o + 10] = f.species;
      buf[o + 11] = f.fleeing > 0 ? 1 : 0;
    }
  });
}

const api = {
  init(config: SharedFlowConfig, output: DoubleBufferHandle, species: SpeciesBehavior[], seed: string): void {
    flow = new SharedFlowSampler(config);
    out = new DoubleBuffer(output);
    school = new School(flow, species, { seed });
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!school || !flow) return;
      flow.refresh();
      school.step(1 / HZ, threat);
      if (threat) threat.calm += 1 / HZ;
      publish();
    }, 1000 / HZ);
  },

  release(speciesIndex: number, x: number, z: number, count: number, spread = 2): number {
    const placed = school?.release(speciesIndex, x, z, count, spread) ?? 0;
    publish();
    return placed;
  },

  /** The player's position; `moving` = moved fast just now (scares shy fish). */
  setThreat(x: number, z: number, moving: boolean): void {
    if (!threat) threat = { x, z, calm: 10 };
    threat.x = x;
    threat.z = z;
    if (moving) threat.calm = 0;
  },

  throwFood(x: number, y: number, z: number, seconds = 25): void {
    if (school) school.food = { x, y, z, until: school.time + seconds };
  },

  count(): number {
    return school?.fish.length ?? 0;
  },
};

export type FishWorkerApi = typeof api;
Comlink.expose(api);
