import * as THREE from 'three/webgpu';
import * as Comlink from 'comlink';
import type { FlowSystem } from '../water/FlowSystem';
import type { FishWorkerApi, FishDetails } from '../../workers/fish.worker';
import { DoubleBuffer } from '../../sim/shared/doubleBuffer';
import { FISH, FISH_STRIDE, FLAG_ROSE, MAX_FISH } from '../../sim/boids/layout';
import type { FishGenes, SpeciesBehavior } from '../../sim/boids/school';
import { behaviorFromDef } from '../../sim/boids/species';
import { generateFish, shapeFor } from '../../procgen/fish';
import { createFishMaterial, lookFromDef } from './fishMaterial';
import type { FishDef } from '../../content/schema';
import type { PickShape } from '../../builder/picking';

export interface FishState {
  id: number;
  species: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  length: number;
}

/**
 * Fish on the main thread (plan 6.5): runs the schools in the fish worker (30 Hz), reads positions from shared
 * memory, extrapolates them to the current frame and draws one instanced mesh per species (its own body template,
 * fins and pattern). Rising fish make a little splash.
 */
export class FishSystem {
  readonly group = new THREE.Group();
  readonly defs: FishDef[];
  readonly behaviors: SpeciesBehavior[];
  /** Called when a fish takes an insect at the surface (splash, sound). */
  onRise: ((x: number, z: number, length: number) => void) | null = null;
  private worker: Worker | null = null;
  private api: Comlink.Remote<FishWorkerApi> | null = null;
  private buffer: DoubleBuffer | null = null;
  private readonly local = new Float32Array(2 + MAX_FISH * FISH_STRIDE);
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly swimAttrs: THREE.InstancedBufferAttribute[] = [];
  private readonly geneAttrs: THREE.InstancedBufferAttribute[] = [];
  /** Per fish id: last heading, smoothed turn rate, whether it was rising. */
  private readonly motion = new Map<number, { yaw: number; turn: number; rose: boolean; seen: number }>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private threatTimer = 0;
  private envTimer = 0;
  private frame = 0;
  private lastPlayer = new THREE.Vector3();
  count = 0;

  constructor(defs: readonly FishDef[]) {
    this.defs = [...defs];
    this.behaviors = this.defs.map(behaviorFromDef);
    for (const def of this.defs) {
      const geometry = generateFish(shapeFor(def.body.template, def.body.fins, def.body.barbels));
      const swim = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FISH * 4), 4);
      swim.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aSwim', swim);
      const gene = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FISH * 4), 4);
      gene.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aGene', gene);
      const mesh = new THREE.InstancedMesh(geometry, createFishMaterial(lookFromDef(def)), MAX_FISH);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.swimAttrs.push(swim);
      this.geneAttrs.push(gene);
    }
  }

  async init(flow: FlowSystem, seed: string): Promise<void> {
    const config = flow.sharedConfig();
    if (!config) throw new Error('The flow system must be initialized before the fish');
    this.buffer = new DoubleBuffer(2 + MAX_FISH * FISH_STRIDE);
    this.worker = new Worker(new URL('../../workers/fish.worker.ts', import.meta.url), { type: 'module' });
    this.api = Comlink.wrap<FishWorkerApi>(this.worker);
    await this.api.init(config, this.buffer.handle(), this.behaviors, seed);
  }

  /**
   * Releases a school of `count` fish of species `index` around (x, z), tagged with a school id. `genes` (optional)
   * gives the fish their traits and ages (cohorts from the ecology).
   */
  async release(
    index: number,
    x: number,
    z: number,
    count: number,
    spread = 2.5,
    school = 0,
    genes?: { genes: FishGenes; age?: number; pattern?: number }[],
  ): Promise<number> {
    return (await this.api?.release(index, x, z, count, spread, school, genes)) ?? 0;
  }

  async removeSchool(school: number): Promise<number> {
    return (await this.api?.removeSchool(school)) ?? 0;
  }

  async throwFood(x: number, y: number, z: number): Promise<void> {
    await this.api?.throwFood(x, y, z);
  }

  async inspect(id: number): Promise<FishDetails | null> {
    return (await this.api?.inspect(id)) ?? null;
  }

  /** Index of a species by content id, or -1. */
  speciesIndex(id: string): number {
    return this.defs.findIndex((d) => d.id === id);
  }

  update(dt: number, player: THREE.Vector3, dayOfYear: number, hour: number): void {
    if (!this.buffer) return;
    // Tell the school where you are; moving quickly near them scares them.
    this.threatTimer -= dt;
    if (this.threatTimer <= 0 && this.api) {
      this.threatTimer = 0.1;
      const speed = player.distanceTo(this.lastPlayer) / 0.1;
      this.lastPlayer.copy(player);
      void this.api.setThreat(player.x, player.z, speed > 2.2);
    }
    this.envTimer -= dt;
    if (this.envTimer <= 0 && this.api) {
      this.envTimer = 1;
      void this.api.setEnvironment(dayOfYear, hour);
    }
    this.frame++;
    this.buffer.copyTo(this.local);
    const n = Math.min(MAX_FISH, this.local[0] as number);
    const stamp = this.local[1] as number;
    const now = (performance.timeOrigin + performance.now()) % 1e7;
    let age = (now - stamp) / 1000;
    if (age < 0 || age > 0.25) age = 0;
    const counts = new Array<number>(this.meshes.length).fill(0);
    for (let k = 0; k < n; k++) {
      const o = 2 + k * FISH_STRIDE;
      const L = this.local;
      const sp = L[o + FISH.species] as number;
      const mesh = this.meshes[sp];
      const swim = this.swimAttrs[sp];
      const gene = this.geneAttrs[sp];
      if (!mesh || !swim || !gene) continue;
      const i = counts[sp]!;
      counts[sp] = i + 1;
      const id = L[o + FISH.id] as number;
      const yaw = L[o + FISH.yaw] as number;
      let state = this.motion.get(id);
      if (!state) {
        state = { yaw, turn: 0, rose: false, seen: this.frame };
        this.motion.set(id, state);
      }
      let dyaw = yaw - state.yaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      state.yaw = yaw;
      state.turn = state.turn * 0.85 + THREE.MathUtils.clamp(dyaw / Math.max(dt, 1e-3), -3, 3) * 0.15 * 0.08;
      state.seen = this.frame;
      const length = L[o + FISH.length] as number;
      this.p.set(
        (L[o + FISH.x] as number) + (L[o + FISH.vx] as number) * age,
        (L[o + FISH.y] as number) + (L[o + FISH.vy] as number) * age,
        (L[o + FISH.z] as number) + (L[o + FISH.vz] as number) * age,
      );
      // A rise: the fish takes an insect at the surface.
      const rose = ((L[o + FISH.flags] as number) & FLAG_ROSE) !== 0;
      if (rose && !state.rose) this.onRise?.(this.p.x, this.p.z, length);
      state.rose = rose;
      this.q.setFromAxisAngle(this.up, yaw);
      this.m.compose(this.p, this.q, this.s.setScalar(length));
      mesh.setMatrixAt(i, this.m);
      const beat = L[o + FISH.beat] as number;
      swim.setXYZW(i, (L[o + FISH.phase] as number) + beat * age, beat, state.turn, length);
      // Body depth varies a little per fish (its size gene shows in proportions too).
      const pattern = L[o + FISH.pattern] as number;
      gene.setXYZW(i, L[o + FISH.brightness] as number, pattern, 0.92 + ((pattern * 7.31) % 1) * 0.16, 0);
    }
    this.meshes.forEach((mesh, sp) => {
      mesh.count = counts[sp] ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      for (const attr of [this.swimAttrs[sp]!, this.geneAttrs[sp]!]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, Math.max(1, mesh.count) * 4);
        attr.needsUpdate = true;
      }
    });
    // Forget fish that are gone.
    if (this.frame % 120 === 0) for (const [id, s] of this.motion) if (this.frame - s.seen > 60) this.motion.delete(id);
    this.count = n;
  }

  /** Current fish positions and headings (tests, picking and the follow camera). */
  positions(): FishState[] {
    const out: FishState[] = [];
    const n = Math.min(MAX_FISH, this.local[0] as number);
    for (let k = 0; k < n; k++) {
      const o = 2 + k * FISH_STRIDE;
      out.push({
        id: this.local[o + FISH.id] as number,
        species: this.local[o + FISH.species] as number,
        x: this.local[o + FISH.x] as number,
        y: this.local[o + FISH.y] as number,
        z: this.local[o + FISH.z] as number,
        yaw: this.local[o + FISH.yaw] as number,
        length: this.local[o + FISH.length] as number,
      });
    }
    return out;
  }

  /** One fish by id (the follow camera), or null when it's gone. */
  get(id: number): FishState | null {
    const n = Math.min(MAX_FISH, this.local[0] as number);
    for (let k = 0; k < n; k++) {
      const o = 2 + k * FISH_STRIDE;
      if (this.local[o + FISH.id] !== id) continue;
      return {
        id,
        species: this.local[o + FISH.species] as number,
        x: this.local[o + FISH.x] as number,
        y: this.local[o + FISH.y] as number,
        z: this.local[o + FISH.z] as number,
        yaw: this.local[o + FISH.yaw] as number,
        length: this.local[o + FISH.length] as number,
      };
    }
    return null;
  }

  /** Spheres around each fish, for clicking one to inspect it (a little bigger than the fish: they're small). */
  *pickShapes(): Generator<PickShape> {
    for (const f of this.positions()) {
      const r = Math.max(0.12, f.length * 0.6);
      yield { uid: `fish:${f.id}`, shape: 'sphere', x: f.x, y: f.y, z: f.z, rx: r, ry: r, rz: r };
    }
  }

  /** A few fish of a species with the real material (catalog thumbnails, drag ghosts). */
  preview(index: number, count = 5): THREE.Object3D | null {
    const src = this.meshes[index];
    const sp = this.behaviors[index];
    if (!src || !sp) return null;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(src.geometry.attributes))
      if (name !== 'aSwim' && name !== 'aGene') g.setAttribute(name, attr);
    g.setIndex(src.geometry.index);
    const swim = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    const gene = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    g.setAttribute('aSwim', swim);
    g.setAttribute('aGene', gene);
    const mesh = new THREE.InstancedMesh(g, src.material, count);
    const len = (sp.length[0] + sp.length[1]) / 2;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const d = i === 0 ? 0 : len * 1.6;
      this.p.set(Math.cos(a) * d, (i % 2) * len * 0.3, Math.sin(a) * d);
      this.q.setFromAxisAngle(this.up, 0.3 + i * 0.07);
      mesh.setMatrixAt(i, this.m.compose(this.p, this.q, this.s.setScalar(len)));
      swim.setXYZW(i, i * 1.3, 6, 0, len);
      gene.setXYZW(i, 0.75, (i * 0.37 + 0.11) % 1, 1, 0);
    }
    mesh.frustumCulled = false;
    const group = new THREE.Group();
    group.add(mesh);
    group.userData.radius = len * 2.6;
    group.userData.height = len * 0.6;
    return group;
  }

  dispose(): void {
    this.worker?.terminate();
  }
}
