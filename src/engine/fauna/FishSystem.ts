import * as THREE from 'three/webgpu';
import * as Comlink from 'comlink';
import type { FlowSystem } from '../water/FlowSystem';
import type { FishWorkerApi } from '../../workers/fish.worker';
import { DoubleBuffer } from '../../sim/shared/doubleBuffer';
import { FISH_STRIDE, MAX_FISH } from '../../sim/boids/layout';
import type { SpeciesBehavior } from '../../sim/boids/school';
import { generateFish, SHAPES, type BodyTemplate } from '../../procgen/fish';
import { createFishMaterial, type FishPattern } from './fishMaterial';
import type { FishDef } from '../../content/schema';

export interface FishSpeciesVisual {
  behavior: SpeciesBehavior;
  template: BodyTemplate;
  pattern: FishPattern;
}

const hex = (c: string) => new THREE.Color(c).getHex();

/** A species' school behavior from its content file (plan 7). */
export function behaviorFromDef(def: FishDef): SpeciesBehavior {
  const b = def.behavior;
  return {
    id: def.id,
    length: def.body.length,
    cruise: b.cruise,
    burst: b.burst,
    comfortCurrent: b.comfortCurrent,
    depthPreference: b.depthPreference,
    minDepth: def.habitat.depth[0],
    schooling: b.schooling,
    shyness: b.shyness,
  };
}

/** A species' pattern from its content file. */
export function patternFromDef(def: FishDef): FishPattern {
  const p = def.pattern;
  const stripes = p.kind === 'stripes' ? 1 : 0;
  return {
    back: hex(p.back),
    flank: hex(p.flank),
    belly: hex(p.belly),
    stripe: stripes,
    stripeColor: hex(p.accent),
    stripe2: stripes,
    stripe2Color: hex(p.accent2),
    fin: hex(p.fin),
    finTip: hex(p.finTip),
    metal: p.metal,
    iridescence: p.iridescence,
  };
}

export function visualFromDef(def: FishDef): FishSpeciesVisual {
  return { behavior: behaviorFromDef(def), template: def.body.template, pattern: patternFromDef(def) };
}

/**
 * Fish on the main thread (plan 6.5): runs the school in the fish worker (30 Hz), reads positions from shared
 * memory, extrapolates them to the current frame and draws one instanced mesh per species.
 */
export class FishSystem {
  readonly group = new THREE.Group();
  private worker: Worker | null = null;
  private api: Comlink.Remote<FishWorkerApi> | null = null;
  private buffer: DoubleBuffer | null = null;
  private readonly local = new Float32Array(2 + MAX_FISH * FISH_STRIDE);
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly swimAttrs: THREE.InstancedBufferAttribute[] = [];
  private readonly prevYaw = new Float32Array(MAX_FISH);
  private readonly turn = new Float32Array(MAX_FISH);
  private readonly species: FishSpeciesVisual[];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private threatTimer = 0;
  private lastPlayer = new THREE.Vector3();
  count = 0;

  constructor(species: FishSpeciesVisual[]) {
    this.species = species;
    for (const sp of species) {
      const geometry = generateFish(SHAPES[sp.template]);
      const swim = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FISH * 4), 4);
      swim.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aSwim', swim);
      const mesh = new THREE.InstancedMesh(geometry, createFishMaterial(sp.pattern), MAX_FISH);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.swimAttrs.push(swim);
    }
  }

  async init(flow: FlowSystem, seed: string): Promise<void> {
    const config = flow.sharedConfig();
    if (!config) throw new Error('The flow system must be initialized before the fish');
    this.buffer = new DoubleBuffer(2 + MAX_FISH * FISH_STRIDE);
    this.worker = new Worker(new URL('../../workers/fish.worker.ts', import.meta.url), { type: 'module' });
    this.api = Comlink.wrap<FishWorkerApi>(this.worker);
    await this.api.init(
      config,
      this.buffer.handle(),
      this.species.map((s) => s.behavior),
      seed,
    );
  }

  /** Releases a school of `count` fish of species `index` around (x, z), tagged with a school id. */
  async release(index: number, x: number, z: number, count: number, spread = 2.5, school = 0): Promise<number> {
    return (await this.api?.release(index, x, z, count, spread, school)) ?? 0;
  }

  async removeSchool(school: number): Promise<number> {
    return (await this.api?.removeSchool(school)) ?? 0;
  }

  /** Index of a species by content id, or -1. */
  speciesIndex(id: string): number {
    return this.species.findIndex((s) => s.behavior.id === id);
  }

  /** A few fish of a species with the real material (catalog thumbnails, drag ghosts). */
  preview(index: number, count = 5): THREE.Object3D | null {
    const src = this.meshes[index];
    const sp = this.species[index];
    if (!src || !sp) return null;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(src.geometry.attributes))
      if (name !== 'aSwim') g.setAttribute(name, attr);
    g.setIndex(src.geometry.index);
    const swim = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    g.setAttribute('aSwim', swim);
    const mesh = new THREE.InstancedMesh(g, src.material, count);
    const len = (sp.behavior.length[0] + sp.behavior.length[1]) / 2;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const d = i === 0 ? 0 : len * 1.6;
      this.p.set(Math.cos(a) * d, (i % 2) * len * 0.3, Math.sin(a) * d);
      this.q.setFromAxisAngle(this.up, 0.3 + i * 0.07);
      mesh.setMatrixAt(i, this.m.compose(this.p, this.q, this.s.setScalar(len)));
      swim.setXYZW(i, i * 1.3, 6, 0, len);
    }
    mesh.frustumCulled = false;
    const group = new THREE.Group();
    group.add(mesh);
    group.userData.radius = len * 2.6;
    group.userData.height = len * 0.6;
    return group;
  }

  async throwFood(x: number, y: number, z: number): Promise<void> {
    await this.api?.throwFood(x, y, z);
  }

  update(dt: number, player: THREE.Vector3): void {
    if (!this.buffer) return;
    // Tell the school where you are; moving quickly near them scares them.
    this.threatTimer -= dt;
    if (this.threatTimer <= 0 && this.api) {
      this.threatTimer = 0.1;
      const speed = player.distanceTo(this.lastPlayer) / 0.1;
      this.lastPlayer.copy(player);
      void this.api.setThreat(player.x, player.z, speed > 2.2);
    }
    this.buffer.copyTo(this.local);
    const n = Math.min(MAX_FISH, this.local[0] as number);
    const stamp = this.local[1] as number;
    const now = (performance.timeOrigin + performance.now()) % 1e7;
    let age = (now - stamp) / 1000;
    if (age < 0 || age > 0.25) age = 0;
    const counts = new Array<number>(this.meshes.length).fill(0);
    for (let k = 0; k < n; k++) {
      const o = 2 + k * FISH_STRIDE;
      const sp = this.local[o + 10] as number;
      const mesh = this.meshes[sp];
      const swim = this.swimAttrs[sp];
      if (!mesh || !swim) continue;
      const i = counts[sp]!;
      counts[sp] = i + 1;
      const yaw = this.local[o + 6] as number;
      let dyaw = yaw - (this.prevYaw[k] as number);
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      this.prevYaw[k] = yaw;
      this.turn[k] =
        (this.turn[k] as number) * 0.85 + THREE.MathUtils.clamp(dyaw / Math.max(dt, 1e-3), -3, 3) * 0.15 * 0.08;
      const length = this.local[o + 9] as number;
      this.p.set(
        (this.local[o] as number) + (this.local[o + 3] as number) * age,
        (this.local[o + 1] as number) + (this.local[o + 4] as number) * age,
        (this.local[o + 2] as number) + (this.local[o + 5] as number) * age,
      );
      this.q.setFromAxisAngle(this.up, yaw);
      this.m.compose(this.p, this.q, this.s.setScalar(length));
      mesh.setMatrixAt(i, this.m);
      const beat = this.local[o + 8] as number;
      swim.setXYZW(i, (this.local[o + 7] as number) + beat * age, beat, this.turn[k] as number, length);
    }
    this.meshes.forEach((mesh, sp) => {
      mesh.count = counts[sp] ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      const swim = this.swimAttrs[sp]!;
      swim.clearUpdateRanges();
      swim.addUpdateRange(0, Math.max(1, mesh.count) * 4);
      swim.needsUpdate = true;
    });
    this.count = n;
  }

  /** Current fish positions and headings (tests and camera framing). */
  positions(): { x: number; y: number; z: number; yaw: number }[] {
    const out: { x: number; y: number; z: number; yaw: number }[] = [];
    const n = Math.min(MAX_FISH, this.local[0] as number);
    for (let k = 0; k < n; k++) {
      const o = 2 + k * FISH_STRIDE;
      out.push({
        x: this.local[o] as number,
        y: this.local[o + 1] as number,
        z: this.local[o + 2] as number,
        yaw: this.local[o + 6] as number,
      });
    }
    return out;
  }

  dispose(): void {
    this.worker?.terminate();
  }
}
