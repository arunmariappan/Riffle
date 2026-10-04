/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { SharedFlowSampler, type SharedFlowConfig } from '../sim/flow/sharedSampler';
import { DoubleBuffer, type DoubleBufferHandle } from '../sim/shared/doubleBuffer';
import { School, fishEnvironment, type FishGenes, type SpeciesBehavior, type Threat } from '../sim/boids/school';
import { FISH, FISH_STRIDE, FLAG_CLINGING, FLAG_ROSE, MAX_FISH } from '../sim/boids/layout';

let flow: SharedFlowSampler | null = null;
let school: School | null = null;
let out: DoubleBuffer | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let threat: Threat | null = null;
const HZ = 30;
/** A rise stays flagged for a few publishes, so the main thread (at its own frame rate) never misses it. */
const roseUntil = new Map<number, number>();

function publish(): void {
  if (!school || !out) return;
  const fish = school.fish;
  const stamp = performance.timeOrigin + performance.now();
  const now = school.time;
  for (const f of fish) if (f.rose) roseUntil.set(f.id, now + 0.25);
  out.write((buf) => {
    const n = Math.min(MAX_FISH, fish.length);
    buf[0] = n;
    buf[1] = stamp % 1e7; // ms, wrapped to keep float precision
    for (let k = 0; k < n; k++) {
      const f = fish[k]!;
      const o = 2 + k * FISH_STRIDE;
      buf[o + FISH.x] = f.x;
      buf[o + FISH.y] = f.y;
      buf[o + FISH.z] = f.z;
      buf[o + FISH.vx] = f.vx;
      buf[o + FISH.vy] = f.vy;
      buf[o + FISH.vz] = f.vz;
      buf[o + FISH.yaw] = Math.atan2(f.hx, f.hz);
      buf[o + FISH.phase] = f.phase;
      buf[o + FISH.beat] = f.beat;
      buf[o + FISH.length] = f.length;
      buf[o + FISH.species] = f.species;
      buf[o + FISH.fleeing] = f.fleeing > 0 ? 1 : 0;
      buf[o + FISH.id] = f.id;
      buf[o + FISH.brightness] = f.genes.brightness;
      buf[o + FISH.pattern] = f.pattern;
      const rose = (roseUntil.get(f.id) ?? -1) > now;
      buf[o + FISH.flags] = (rose ? FLAG_ROSE : 0) | (f.clinging ? FLAG_CLINGING : 0);
    }
  });
  for (const [id, until] of roseUntil) if (until <= now) roseUntil.delete(id);
}

export interface FishDetails {
  id: number;
  species: number;
  length: number;
  age: number;
  genes: FishGenes;
  x: number;
  y: number;
  z: number;
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

  release(
    speciesIndex: number,
    x: number,
    z: number,
    count: number,
    spread = 2,
    schoolId = 0,
    genes?: { genes: FishGenes; age?: number; pattern?: number }[],
  ): number {
    const placed =
      school?.release(
        speciesIndex,
        x,
        z,
        count,
        spread,
        schoolId,
        genes ? (k) => genes[k % genes.length]! : undefined,
      ) ?? 0;
    publish();
    return placed;
  },

  removeSchool(schoolId: number): number {
    const removed = school?.removeSchool(schoolId) ?? 0;
    publish();
    return removed;
  },

  /** The time of day and season (daylight, insect activity and water temperature for the fish). */
  setEnvironment(dayOfYear: number, hour: number): void {
    if (school) school.env = fishEnvironment(dayOfYear, hour);
  },

  /** The player's position; \`moving\` = moved fast just now (scares shy fish). */
  setThreat(x: number, z: number, moving: boolean): void {
    if (!threat) threat = { x, z, calm: 10 };
    threat.x = x;
    threat.z = z;
    if (moving) threat.calm = 0;
  },

  throwFood(x: number, y: number, z: number, seconds = 25): void {
    if (school) school.food = { x, y, z, until: school.time + seconds };
  },

  /** One fish's species, size, age and traits (the inspect card). */
  inspect(id: number): FishDetails | null {
    const f = school?.find(id);
    if (!f) return null;
    return {
      id: f.id,
      species: f.species,
      length: f.length,
      age: f.age,
      genes: { ...f.genes },
      x: f.x,
      y: f.y,
      z: f.z,
    };
  },

  count(): number {
    return school?.fish.length ?? 0;
  },
};

export type FishWorkerApi = typeof api;
Comlink.expose(api);
