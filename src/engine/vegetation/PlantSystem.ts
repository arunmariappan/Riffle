import * as THREE from 'three/webgpu';
import type { BushDef, WaterPlantDef } from '../../content/schema';
import type { ScatterInstance } from '../../sim/scatter/scatter';
import type { SeasonWeights } from '../../sim/time/clock';
import { SEASONS } from '../../sim/time/clock';
import { hashString } from '../../sim/rng';
import {
  generateGroundFern,
  generateWildflowers,
  generateOrchid,
  generateLotus,
  generateLily,
  generateJavaFern,
  generateCryptocoryne,
  generateRotala,
  generateMoss,
  type PlantGeometry,
} from '../../procgen/plants';
import { createPlantMaterial } from './plantMaterial';
import { createFoliageLook, type FoliageLook } from './materials';
import type { WindUniforms } from './wind';
import type { PickShape } from '../../builder/picking';

type PlantDef = BushDef | WaterPlantDef;

export interface PlantInstance extends ScatterInstance {
  /** Water depth (water plants), for stem length. */
  depth?: number;
  /** The stone it grows on (Java fern, moss), so it moves and goes with the stone. */
  host?: string;
}

/** A plant in the world, with its stable id. */
export interface PlacedPlant extends PlantInstance {
  uid: string;
}

interface Variant {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  /** Generated vertex data (shared by every buffer this variant grows into). */
  source: THREE.BufferGeometry;
  height: number;
}

interface Kind {
  def: PlantDef;
  look: FoliageLook;
  material: THREE.MeshStandardNodeMaterial;
  aquatic: boolean;
  floating: boolean;
  variants: Variant[];
  instances: PlacedPlant[];
  radius: number;
  /** Generated plant size (for picking). */
  size: number;
}

export interface FlowLookup {
  sample(x: number, z: number): { velocityX: number; velocityZ: number; depth: number; surface: number } | null;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function generate(def: PlantDef, seed: number, depth: number): PlantGeometry {
  const [h0, h1] = def.generator.height;
  const h = (h0 + h1) / 2;
  switch (def.generator.kind) {
    case 'fern':
      return generateGroundFern(seed, h);
    case 'wildflowers':
      return generateWildflowers(seed, h, Math.max(1, (def as BushDef).generator.flowerColors.length));
    case 'orchid':
      return generateOrchid(seed, h);
    case 'lotus':
      return generateLotus(seed, depth);
    case 'lily':
      return generateLily(seed, depth);
    case 'java-fern':
      return generateJavaFern(seed, h);
    case 'cryptocoryne':
      return generateCryptocoryne(seed, h);
    case 'rotala':
      return generateRotala(seed, h);
    case 'moss':
      return generateMoss(seed, h);
  }
}

function withInstanceAttributes(
  source: THREE.BufferGeometry,
  capacity: number,
  aquatic: boolean,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(source.attributes)) g.setAttribute(name, attr);
  g.setIndex(source.index);
  g.boundingBox = source.boundingBox;
  g.boundingSphere = source.boundingSphere;
  g.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
  g.setAttribute('aInstB', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
  if (aquatic) g.setAttribute('aFlow', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
  return g;
}

/**
 * Ground plants (ferns, wildflowers, orchids) and water plants (plan 6.4): generated variants, instanced, shown
 * within a radius of the camera (re-bucketed a few times a second). Water plants get the local current per instance.
 * One material per kind, made once: adding plants only grows instance buffers, so it never recompiles a shader.
 */
export class PlantSystem {
  readonly group = new THREE.Group();
  private readonly kinds: Kind[] = [];
  private readonly wind: WindUniforms;
  private flow: FlowLookup | null = null;
  private last = new THREE.Vector3(Infinity, 0, 0);
  private lastTime = -1;
  private generated = 0;
  visibleCount = 0;

  constructor(defs: readonly PlantDef[], instances: readonly PlantInstance[], wind: WindUniforms) {
    this.wind = wind;
    for (const def of defs) this.kindFor(def);
    this.addInstances(defs, instances);
  }

  setFlow(flow: FlowLookup): void {
    this.flow = flow;
    this.update(this.last.clone(), this.lastTime, true);
  }

  /** Adds generated instances (water plants placed once the flow is solved). */
  addInstances(defs: readonly PlantDef[], instances: readonly PlantInstance[]): void {
    for (const def of defs) {
      const kind = this.kindFor(def);
      for (const inst of instances) {
        if (inst.kind !== def.id) continue;
        kind.instances.push({ ...inst, uid: inst.uid ?? `g:${def.category}:${this.generated++}` });
      }
    }
    this.invalidate();
  }

  /** The kind for a definition, made on first use (its material and variant geometry). */
  private kindFor(def: PlantDef): Kind {
    const existing = this.kinds.find((k) => k.def.id === def.id);
    if (existing) return existing;
    const aquatic = def.category === 'plants';
    const floating = def.generator.kind === 'lotus' || def.generator.kind === 'lily';
    const leaf = new THREE.Color(def.look.leafColor);
    const look = createFoliageLook(leaf.getHex(), leaf.getHex());
    const colors =
      def.category === 'bushes'
        ? def.generator.flowerColors.map((c) => new THREE.Color(c))
        : def.generator.flowerColor
          ? [new THREE.Color(def.generator.flowerColor)]
          : [new THREE.Color(0xffffff)];
    const tip =
      def.category === 'plants' && def.generator.tipColor ? new THREE.Color(def.generator.tipColor) : undefined;
    const material = createPlantMaterial({ wind: this.wind, look, flowers: colors, tip, aquatic, floating });
    const seed = hashString(def.id) % 10000;
    const typicalDepth = floating ? 1 : 0;
    const variants: Variant[] = [];
    let size = 0.3;
    for (let v = 0; v < def.generator.variants; v++) {
      const pg = generate(def, seed + v * 17, typicalDepth);
      size = Math.max(size, pg.radius);
      const geometry = withInstanceAttributes(pg.geometry, 16, aquatic);
      const mesh = this.makeMesh(geometry, material, 16);
      variants.push({ mesh, geometry, source: pg.geometry, height: pg.height });
    }
    const radius = aquatic ? 140 : def.generator.kind === 'fern' ? 70 : 80;
    const kind: Kind = { def, look, material, aquatic, floating, variants, instances: [], radius, size };
    this.kinds.push(kind);
    return kind;
  }

  private makeMesh(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  private ensure(kind: Kind, v: Variant, needed: number): void {
    const capacity = v.mesh.instanceMatrix.count;
    if (needed <= capacity) return;
    let next = capacity;
    while (next < needed) next *= 2;
    this.group.remove(v.mesh);
    v.mesh.dispose();
    v.geometry = withInstanceAttributes(v.source, next, kind.aquatic);
    v.mesh = this.makeMesh(v.geometry, kind.material, next);
  }

  setSeason(weights: SeasonWeights): void {
    for (const k of this.kinds) {
      const look = k.def.look;
      const base = new THREE.Color(look.leafColor);
      let mixTotal = 0;
      const acc = new THREE.Color(0, 0, 0);
      let leaf = 0;
      for (const s of SEASONS) {
        const w = weights[s];
        const e = look[s];
        if (e && e.mix > 0) {
          const c = new THREE.Color(e.color);
          acc.r += c.r * w * e.mix;
          acc.g += c.g * w * e.mix;
          acc.b += c.b * w * e.mix;
          mixTotal += w * e.mix;
        }
        leaf += w * (look.leafAmount?.[s] ?? 1);
      }
      (k.look.leafColor as any).value.copy(base);
      (k.look.seasonColor as any).value.copy(mixTotal > 0 ? acc.multiplyScalar(1 / mixTotal) : base);
      (k.look.seasonMix as any).value = Math.min(1, mixTotal);
      (k.look.leafAmount as any).value = leaf;
    }
  }

  update(camera: THREE.Vector3, time: number, force = false): void {
    if (
      !force &&
      (time - this.lastTime < 0.25 || (camera.distanceToSquared(this.last) < 4 && time - this.lastTime < 1))
    )
      return;
    this.last.copy(camera);
    this.lastTime = time;
    let visible = 0;
    for (const k of this.kinds) {
      const r2 = k.radius * k.radius;
      const near: PlacedPlant[][] = k.variants.map(() => []);
      for (const inst of k.instances) {
        if ((inst.x - camera.x) ** 2 + (inst.z - camera.z) ** 2 > r2) continue;
        near[inst.variant % k.variants.length]!.push(inst);
      }
      k.variants.forEach((v, vi) => {
        const list = near[vi]!;
        this.ensure(k, v, list.length);
        const aInst = v.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute;
        const aInstB = v.geometry.getAttribute('aInstB') as THREE.InstancedBufferAttribute;
        const aFlow = v.geometry.getAttribute('aFlow') as THREE.InstancedBufferAttribute | undefined;
        list.forEach((inst, i) => {
          _q.setFromAxisAngle(UP, inst.yaw);
          // Floating plants: stems reach the surface (vertical scale = depth / generated depth).
          const sy =
            k.floating && inst.depth !== undefined
              ? inst.depth / Math.max(0.2, v.height - (k.def.generator.kind === 'lotus' ? 0.5 : 0))
              : inst.scale;
          v.mesh.setMatrixAt(i, _m.compose(_p.set(inst.x, inst.y, inst.z), _q, _s.set(inst.scale, sy, inst.scale)));
          aInst.setXYZW(i, inst.yaw, inst.scale, inst.phase, 1);
          aInstB.setXYZW(i, inst.x, inst.z, v.height * inst.scale, 0);
          if (aFlow) {
            const s = this.flow?.sample(inst.x, inst.z);
            aFlow.setXYZW(i, s?.velocityX ?? 0, s?.velocityZ ?? 0, s?.depth ?? 0, s?.surface ?? 0);
          }
        });
        v.mesh.count = list.length;
        v.mesh.instanceMatrix.needsUpdate = true;
        aInst.needsUpdate = true;
        aInstB.needsUpdate = true;
        if (aFlow) aFlow.needsUpdate = true;
        visible += list.length;
      });
    }
    this.visibleCount = visible;
  }

  /** Forces a refresh on the next update (after an edit or a new flow solve). */
  invalidate(): void {
    this.lastTime = -1;
  }

  private find(uid: string): { kind: Kind; index: number } | null {
    for (const kind of this.kinds) {
      const index = kind.instances.findIndex((i) => i.uid === uid);
      if (index >= 0) return { kind, index };
    }
    return null;
  }

  get(uid: string): PlacedPlant | null {
    const f = this.find(uid);
    return f ? (f.kind.instances[f.index] as PlacedPlant) : null;
  }

  /** Plants one (builder). The definition is needed the first time a kind is used. */
  add(def: PlantDef, inst: PlacedPlant): void {
    this.kindFor(def).instances.push({ ...inst });
    this.invalidate();
  }

  remove(uid: string): PlacedPlant | null {
    const f = this.find(uid);
    if (!f) return null;
    const [inst] = f.kind.instances.splice(f.index, 1);
    this.invalidate();
    return inst ?? null;
  }

  move(uid: string, t: { x: number; y: number; z: number; yaw: number; scale: number; depth?: number }): void {
    const p = this.get(uid);
    if (!p) return;
    p.x = t.x;
    p.y = t.y;
    p.z = t.z;
    p.yaw = t.yaw;
    p.scale = t.scale;
    if (t.depth !== undefined) p.depth = t.depth;
    this.invalidate();
  }

  *all(): Generator<PlacedPlant & { category: 'bushes' | 'plants' }> {
    for (const k of this.kinds) for (const inst of k.instances) yield { ...inst, category: k.def.category };
  }

  /** Small upright cylinders, for picking in the builder. */
  *pickShapes(): Generator<PickShape> {
    for (const k of this.kinds) {
      for (const inst of k.instances) {
        const r = Math.max(0.15, k.size * inst.scale * 0.6);
        const h = Math.max(0.2, (k.variants[0]?.height ?? 0.5) * inst.scale);
        yield { uid: inst.uid, shape: 'cylinder', x: inst.x, y: inst.y - 0.05, z: inst.z, rx: r, ry: h, rz: 0 };
      }
    }
  }

  /** One plant with the real material (catalog thumbnails, drag ghosts). */
  preview(def: PlantDef, depth = 0.8): THREE.Object3D {
    const kind = this.kindFor(def);
    const v = kind.variants[0] as Variant;
    const g = withInstanceAttributes(v.source, 1, kind.aquatic);
    const scale = 1;
    const sy = kind.floating ? depth / Math.max(0.2, v.height - (def.generator.kind === 'lotus' ? 0.5 : 0)) : scale;
    (g.getAttribute('aInst') as THREE.InstancedBufferAttribute).setXYZW(0, 0, scale, 0, 1);
    (g.getAttribute('aInstB') as THREE.InstancedBufferAttribute).setXYZW(0, 0, 0, v.height, 0);
    if (kind.aquatic) (g.getAttribute('aFlow') as THREE.InstancedBufferAttribute).setXYZW(0, 0, 0, depth, depth);
    const mesh = new THREE.InstancedMesh(g, kind.material, 1);
    mesh.setMatrixAt(0, _m.compose(_p.set(0, 0, 0), _q.identity(), _s.set(scale, sy, scale)));
    mesh.frustumCulled = false;
    const group = new THREE.Group();
    group.add(mesh);
    group.userData.radius = Math.max(0.2, kind.size);
    group.userData.height = kind.floating ? depth + 0.3 : v.height;
    return group;
  }
}
