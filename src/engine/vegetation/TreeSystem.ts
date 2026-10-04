import * as THREE from 'three/webgpu';
import { attribute, positionLocal, vec2, vec3, float, mix, hash, uv } from 'three/tsl';
import type { TreeDef } from '../../content/schema';
import type { ScatterInstance } from '../../sim/scatter/scatter';
import type { SeasonWeights } from '../../sim/time/clock';
import { SEASONS } from '../../sim/time/clock';
import { generateTree } from '../../procgen/trees';
import { generateBamboo } from '../../procgen/bamboo';
import { generateTreeFern } from '../../procgen/plants';
import { generateLiteTree } from '../../procgen/rocks';
import { plantSway, type WindUniforms } from './wind';
import {
  createBarkMaterial,
  createLeafCardMaterial,
  createBambooCulmMaterial,
  createPolyLeafMaterial,
  createFoliageLook,
  type FoliageLook,
} from './materials';
import { loadLayer } from '../terrain/terrainMaterial';
import { hashString } from '../../sim/rng';
import type { PickShape } from '../../builder/picking';

/** Full-detail trees within this distance; lite trees beyond (plan 6.4 LOD). */
const NEAR = 55;

/** One instanced draw: its source vertex data, material and shadow setting are fixed; only the capacity grows. */
interface Part {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  source: THREE.BufferGeometry;
  material: THREE.Material;
  castShadow: boolean;
}

interface Variant {
  height: number;
  radius: number;
  parts: Part[];
  count: number;
}

/** A tree in the world: its scatter placement plus a stable id and its height in meters. */
export interface TreeInstance extends ScatterInstance {
  uid: string;
  height: number;
}

interface Species {
  def: TreeDef;
  look: FoliageLook;
  variants: Variant[];
  lite: { trunk: Part; canopy: Part; height: number; radius: number };
  instances: TreeInstance[];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function instanceAttributes(geometry: THREE.BufferGeometry, capacity: number): void {
  geometry.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
  geometry.setAttribute('aInstB', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
}

/** Shares vertex data but gives each mesh its own per-instance attributes. */
function shareGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    if (name === 'aInst' || name === 'aInstB') continue;
    g.setAttribute(name, attr);
  }
  g.setIndex(src.index);
  g.boundingBox = src.boundingBox;
  g.boundingSphere = src.boundingSphere;
  return g;
}

function hexColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

/** Generated trees' height from their scatter scale and phase (stable for a seed). */
function generatedHeight(def: TreeDef, inst: ScatterInstance): number {
  const [h0, h1] = def.generator.height;
  return h0 + (h1 - h0) * (((inst.scale - 0.8) / 0.4 + (inst.phase / (Math.PI * 2)) * 0.3) % 1);
}

/**
 * Trees and bamboo (plan 6.4): generated variants per species with full detail near the camera and cheap lite
 * trees beyond, re-bucketed as you move. Seasonal looks (blossom, autumn color, leaf drop) come from content JSON.
 * Trees can be added, removed and moved (builder); instance buffers grow without new materials.
 */
export class TreeSystem {
  readonly group = new THREE.Group();
  private readonly species: Species[] = [];
  private readonly wind: WindUniforms;
  private lastCamera = new THREE.Vector3(Infinity, 0, 0);
  private lastUpdate = -1;
  totalInstances = 0;

  constructor(defs: readonly TreeDef[], instances: readonly ScatterInstance[], wind: WindUniforms) {
    this.wind = wind;
    let generated = 0;
    for (const def of defs) {
      const mine: TreeInstance[] = [];
      for (const inst of instances) {
        if (inst.kind !== def.id) continue;
        mine.push({ ...inst, uid: inst.uid ?? `g:trees:${generated}`, height: generatedHeight(def, inst) });
        generated++;
      }
      // Every species gets its meshes, even with no trees yet, so the builder can plant it.
      this.species.push(this.buildSpecies(def, mine));
      this.totalInstances += mine.length;
    }
  }

  private makePart(
    source: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    castShadow: boolean,
  ): Part {
    const g = shareGeometry(source);
    instanceAttributes(g, capacity);
    const mesh = new THREE.InstancedMesh(g, material, capacity);
    mesh.count = 0;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return { mesh, geometry: g, source, material, castShadow };
  }

  /** Makes room for `needed` instances in a part (a new instance buffer; same material, so no recompile). */
  private ensure(part: Part, needed: number): void {
    const capacity = part.mesh.instanceMatrix.count;
    if (needed <= capacity) return;
    let next = Math.max(8, capacity);
    while (next < needed) next *= 2;
    const old = part.mesh;
    const g = shareGeometry(part.source);
    instanceAttributes(g, next);
    const mesh = new THREE.InstancedMesh(g, part.material, next);
    mesh.count = 0;
    mesh.castShadow = part.castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.remove(old);
    old.dispose();
    this.group.add(mesh);
    part.mesh = mesh;
    part.geometry = g;
  }

  private buildSpecies(def: TreeDef, instances: TreeInstance[]): Species {
    const gen = def.generator;
    const look = createFoliageLook(hexColor(def.look.leafColor).getHex(), hexColor(def.look.leafColor).getHex());
    (look.stiffness as any).value = def.wind.stiffness;
    const variantCount = Math.max(1, gen.variants);
    const counts = new Array<number>(variantCount).fill(0);
    for (const inst of instances) counts[inst.variant % variantCount]! += 1;
    const [h0, h1] = gen.height;
    const variants: Variant[] = [];
    const seedBase = hashString(def.id) % 10000;
    let barkMat: THREE.Material | null = null;
    let leafMat: THREE.Material | null = null;
    for (let v = 0; v < variantCount; v++) {
      const parts: Part[] = [];
      let height = (h0 + h1) / 2;
      let radius = height * 0.3;
      // Room for the near trees of this variant plus some for planting.
      const capacity = Math.max(8, counts[v]! + 8);
      let pair: [THREE.BufferGeometry, THREE.BufferGeometry] | null = null;
      if (gen.kind === 'ez-tree') {
        const geo = generateTree(
          { id: def.id, preset: gen.preset, height, barkTint: 0xffffff, leafTint: 0xffffff },
          seedBase + v * 7919,
        );
        radius = geo.radius;
        height = geo.height;
        const bark = loadLayer(gen.bark, 0x6a5a4a);
        barkMat ??= createBarkMaterial(this.wind, look, bark.diffuse, bark.normal, hexColor(gen.barkTint).getHex());
        leafMat ??= createLeafCardMaterial(this.wind, look, geo.leafMap);
        pair = [geo.branches, geo.leaves];
      } else if (gen.kind === 'bamboo') {
        const bamboo = generateBamboo({ seed: seedBase + v * 31, minHeight: h0, maxHeight: h1 });
        height = bamboo.height;
        radius = bamboo.radius;
        barkMat ??= createBambooCulmMaterial(this.wind, look);
        leafMat ??= createPolyLeafMaterial(this.wind, look);
        pair = [bamboo.culms, bamboo.leaves];
      } else if (gen.kind === 'tree-fern') {
        const fern = generateTreeFern(seedBase + v * 53, (h0 + h1) / 2);
        height = fern.height;
        radius = fern.radius;
        const bark = loadLayer('japanese_zelkova_bark', 0x5a4030);
        barkMat ??= createBarkMaterial(this.wind, look, bark.diffuse, bark.normal, 0x6a5040);
        leafMat ??= createPolyLeafMaterial(this.wind, look);
        pair = [fern.trunk, fern.crown];
      }
      if (pair && barkMat && leafMat) {
        parts.push(this.makePart(pair[0], barkMat, capacity, true));
        parts.push(this.makePart(pair[1], leafMat, capacity, true));
      }
      variants.push({ height, radius, parts, count: 0 });
    }

    // Lite (far) tree for the species. Far trees skip shadows (cost); the AO and fog carry them at distance.
    const ref = variants[0] as Variant;
    const shape = gen.kind === 'ez-tree' ? gen.shape : 'round';
    const lite = generateLiteTree(seedBase, ref.height, ref.radius * 0.8, gen.kind === 'bamboo' ? 'spreading' : shape);
    const trunkMat = new THREE.MeshStandardNodeMaterial({ color: 0x4a3a2c, roughness: 0.95 });
    const canopyMat = this.createLiteCanopyMaterial(look);
    const liteCapacity = Math.max(8, instances.length + 16);
    const trunk = this.makePart(lite.trunk, trunkMat, liteCapacity, false);
    const canopy = this.makePart(lite.canopy, canopyMat, liteCapacity, false);
    return { def, look, variants, lite: { trunk, canopy, height: ref.height, radius: ref.radius }, instances };
  }

  private createLiteCanopyMaterial(look: FoliageLook): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
    const l: any = look;
    const a = attribute('aInst', 'vec4');
    const b = attribute('aInstB', 'vec4');
    const variation = hash(a.z.mul(13.1)).mul(0.25).add(0.85);
    const shade = positionLocal.y.div(b.z).clamp(0, 1).mul(0.35).add(0.65);
    // From afar, blossom and autumn color read as a blend over the green crown.
    const leafy = mix(vec3(l.leafColor), vec3(l.seasonColor), l.seasonMix.mul(0.55));
    m.colorNode = leafy.mul(variation).mul(shade).mul(0.85);
    // Thin the canopy when leaves drop: hide a share of instances' canopies (stable per instance).
    m.opacityNode = hash(a.z.mul(7.7)).lessThan(l.leafAmount).select(float(1), float(0));
    m.alphaTest = 0.5;
    m.positionNode = positionLocal.add(
      plantSway(positionLocal, vec2(b.x, b.y), a.x, b.z, b.w, a.w, a.z, float(0.3), this.wind),
    );
    void uv;
    return m;
  }

  /** Applies season weights to every species' look (plan 6.7). */
  setSeason(weights: SeasonWeights): void {
    for (const sp of this.species) {
      const look = sp.def.look;
      const base = new THREE.Color(look.leafColor);
      let mixTotal = 0;
      const acc = new THREE.Color(0, 0, 0);
      let leaf = 0;
      for (const s of SEASONS) {
        const w = weights[s];
        const entry = look[s];
        if (entry && entry.mix > 0) {
          const c = new THREE.Color(entry.color);
          acc.r += c.r * w * entry.mix;
          acc.g += c.g * w * entry.mix;
          acc.b += c.b * w * entry.mix;
          mixTotal += w * entry.mix;
        }
        leaf += w * (look.leafAmount?.[s] ?? 1);
      }
      const seasonColor = mixTotal > 0 ? acc.multiplyScalar(1 / mixTotal) : base;
      (sp.look.leafColor as any).value.copy(base);
      (sp.look.seasonColor as any).value.copy(seasonColor);
      (sp.look.seasonMix as any).value = Math.min(1, mixTotal);
      (sp.look.leafAmount as any).value = leaf;
    }
  }

  /** Per-species flexibility override from the Trees panel (1 = as the species is). */
  setSpeciesFlexibility(kind: string, flexibility: number): void {
    const sp = this.species.find((x) => x.def.id === kind);
    if (sp) (sp.look.stiffness as any).value = sp.def.wind.stiffness / Math.max(0.1, flexibility);
  }

  speciesIds(): string[] {
    return this.species.map((sp) => sp.def.id);
  }

  /** Re-buckets instances into near (full) and far (lite) meshes when the camera has moved. */
  update(camera: THREE.Vector3, time: number, force = false): void {
    // At most four times a second, and only when the camera has moved (or once a second regardless).
    if (
      !force &&
      (time - this.lastUpdate < 0.25 || (camera.distanceToSquared(this.lastCamera) < 9 && time - this.lastUpdate < 1))
    )
      return;
    this.lastCamera.copy(camera);
    this.lastUpdate = time;
    const near2 = NEAR * NEAR;
    for (const sp of this.species) {
      const stiffness = sp.def.wind.stiffness;
      // Make room first (planting can push a variant past its buffer).
      const perVariant = new Array<number>(sp.variants.length).fill(0);
      for (const inst of sp.instances) perVariant[inst.variant % sp.variants.length]! += 1;
      sp.variants.forEach((v, i) => v.parts.forEach((part) => this.ensure(part, perVariant[i]!)));
      this.ensure(sp.lite.trunk, sp.instances.length);
      this.ensure(sp.lite.canopy, sp.instances.length);
      for (const v of sp.variants) v.count = 0;
      let liteCount = 0;
      const liteTrunk = sp.lite.trunk.mesh;
      const liteCanopy = sp.lite.canopy.mesh;
      const liteA = sp.lite.canopy.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute;
      const liteB = sp.lite.canopy.geometry.getAttribute('aInstB') as THREE.InstancedBufferAttribute;
      const liteTA = sp.lite.trunk.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute;
      const liteTB = sp.lite.trunk.geometry.getAttribute('aInstB') as THREE.InstancedBufferAttribute;
      for (const inst of sp.instances) {
        const d2 = (inst.x - camera.x) ** 2 + (inst.z - camera.z) ** 2;
        _q.setFromAxisAngle(UP, inst.yaw);
        if (d2 < near2) {
          const v = sp.variants[inst.variant % sp.variants.length] as Variant;
          const scale = inst.height / v.height;
          _m.compose(_p.set(inst.x, inst.y - 0.15, inst.z), _q, _s.setScalar(scale));
          for (const part of v.parts) {
            part.mesh.setMatrixAt(v.count, _m);
            (part.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute).setXYZW(
              v.count,
              inst.yaw,
              scale,
              inst.phase,
              stiffness,
            );
            (part.geometry.getAttribute('aInstB') as THREE.InstancedBufferAttribute).setXYZW(
              v.count,
              inst.x,
              inst.z,
              v.height,
              v.radius,
            );
          }
          v.count++;
        } else {
          const scale = inst.height / sp.lite.height;
          _m.compose(_p.set(inst.x, inst.y - 0.15, inst.z), _q, _s.setScalar(scale));
          liteTrunk.setMatrixAt(liteCount, _m);
          liteCanopy.setMatrixAt(liteCount, _m);
          liteA.setXYZW(liteCount, inst.yaw, scale, inst.phase, stiffness);
          liteB.setXYZW(liteCount, inst.x, inst.z, sp.lite.height, sp.lite.radius);
          liteTA.setXYZW(liteCount, inst.yaw, scale, inst.phase, stiffness);
          liteTB.setXYZW(liteCount, inst.x, inst.z, sp.lite.height, sp.lite.radius);
          liteCount++;
        }
      }
      for (const v of sp.variants) {
        for (const part of v.parts) {
          part.mesh.count = v.count;
          part.mesh.instanceMatrix.needsUpdate = true;
          (part.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute).needsUpdate = true;
          (part.geometry.getAttribute('aInstB') as THREE.InstancedBufferAttribute).needsUpdate = true;
        }
      }
      for (const mesh of [liteTrunk, liteCanopy]) {
        mesh.count = liteCount;
        mesh.instanceMatrix.needsUpdate = true;
      }
      liteA.needsUpdate = true;
      liteB.needsUpdate = true;
      liteTA.needsUpdate = true;
      liteTB.needsUpdate = true;
    }
  }

  /** Forces a re-bucket on the next update (after an edit). */
  invalidate(): void {
    this.lastUpdate = -1;
    this.lastCamera.set(Infinity, 0, 0);
  }

  private find(uid: string): { sp: Species; index: number } | null {
    for (const sp of this.species) {
      const index = sp.instances.findIndex((i) => i.uid === uid);
      if (index >= 0) return { sp, index };
    }
    return null;
  }

  get(uid: string): TreeInstance | null {
    const f = this.find(uid);
    return f ? (f.sp.instances[f.index] as TreeInstance) : null;
  }

  /** Plants a tree (builder). `height` defaults to the middle of the species range times `scale`. */
  add(inst: ScatterInstance & { uid: string; height?: number }): boolean {
    const sp = this.species.find((x) => x.def.id === inst.kind);
    if (!sp) return false;
    const [h0, h1] = sp.def.generator.height;
    sp.instances.push({ ...inst, height: inst.height ?? ((h0 + h1) / 2) * inst.scale });
    this.totalInstances++;
    this.invalidate();
    return true;
  }

  remove(uid: string): TreeInstance | null {
    const f = this.find(uid);
    if (!f) return null;
    const [inst] = f.sp.instances.splice(f.index, 1);
    this.totalInstances--;
    this.invalidate();
    return inst ?? null;
  }

  /** Moves, turns or rescales a tree; height follows the scale. */
  move(uid: string, t: { x: number; y: number; z: number; yaw: number; scale: number }): void {
    const f = this.get(uid);
    if (!f) return;
    if (f.scale > 0 && t.scale !== f.scale) f.height *= t.scale / f.scale;
    f.x = t.x;
    f.y = t.y;
    f.z = t.z;
    f.yaw = t.yaw;
    f.scale = t.scale;
    this.invalidate();
  }

  /** Every tree, for the builder's item registry. */
  *all(): Generator<TreeInstance> {
    for (const sp of this.species) yield* sp.instances;
  }

  /** Upright cylinders around trunks and the lower crown, for picking in the builder. */
  *pickShapes(): Generator<PickShape> {
    for (const sp of this.species) {
      const ref = sp.variants[0] as Variant;
      const crown = ref.radius / Math.max(0.1, ref.height);
      for (const inst of sp.instances) {
        const r = Math.max(0.5, Math.min(3, inst.height * crown * 0.45));
        yield { uid: inst.uid, shape: 'cylinder', x: inst.x, y: inst.y, z: inst.z, rx: r, ry: inst.height, rz: 0 };
      }
    }
  }

  /** The tree closest to (x, z), with its height (tests and camera framing). */
  nearest(x: number, z: number): { kind: string; x: number; y: number; z: number; height: number } | null {
    let best: { kind: string; x: number; y: number; z: number; height: number } | null = null;
    let bestD = Infinity;
    for (const sp of this.species) {
      for (const inst of sp.instances) {
        const d = (inst.x - x) ** 2 + (inst.z - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { kind: sp.def.id, x: inst.x, y: inst.y, z: inst.z, height: inst.height };
        }
      }
    }
    return best;
  }

  /** One full-detail tree of a species with the real materials (catalog thumbnails, drag ghosts). */
  preview(kind: string): THREE.Object3D | null {
    const sp = this.species.find((x) => x.def.id === kind);
    if (!sp) return null;
    const v = sp.variants[0] as Variant;
    const [h0, h1] = sp.def.generator.height;
    const height = (h0 + h1) / 2;
    const scale = height / v.height;
    const group = new THREE.Group();
    for (const part of v.parts) {
      const g = shareGeometry(part.source);
      g.setAttribute(
        'aInst',
        new THREE.InstancedBufferAttribute(new Float32Array([0, scale, 0, sp.def.wind.stiffness]), 4),
      );
      g.setAttribute('aInstB', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, v.height, v.radius]), 4));
      const mesh = new THREE.InstancedMesh(g, part.material, 1);
      mesh.setMatrixAt(0, _m.compose(_p.set(0, 0, 0), _q.identity(), _s.setScalar(scale)));
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    group.userData.radius = v.radius * scale;
    group.userData.height = height;
    return group;
  }

  /** Near-detail instance count (for stats). */
  nearCount(): number {
    return this.species.reduce((sum, sp) => sum + sp.variants.reduce((s, v) => s + v.count, 0), 0);
  }
}
