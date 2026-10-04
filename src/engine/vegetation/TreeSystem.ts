import * as THREE from 'three/webgpu';
import { attribute, positionLocal, vec2, vec3, float, mix, hash, uv } from 'three/tsl';
import type { TreeDef } from '../../content/schema';
import type { ScatterInstance } from '../../sim/scatter/scatter';
import type { SeasonWeights } from '../../sim/time/clock';
import { SEASONS } from '../../sim/time/clock';
import { generateTree } from '../../procgen/trees';
import { generateBamboo } from '../../procgen/bamboo';
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

/** Full-detail trees within this distance; lite trees beyond (plan 6.4 LOD). */
const NEAR = 55;

interface Variant {
  height: number;
  radius: number;
  parts: { mesh: THREE.InstancedMesh; geometry: THREE.BufferGeometry }[];
  count: number;
}

interface Species {
  def: TreeDef;
  look: FoliageLook;
  variants: Variant[];
  lite: { trunk: THREE.InstancedMesh; canopy: THREE.InstancedMesh; height: number; radius: number };
  instances: ScatterInstance[];
  /** Target height per instance (meters). */
  heights: Float32Array;
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

/**
 * Trees and bamboo (plan 6.4): generated variants per species with full detail near the camera and cheap lite
 * trees beyond, re-bucketed as you move. Seasonal looks (blossom, autumn color, leaf drop) come from content JSON.
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
    for (const def of defs) {
      const mine = instances.filter((i) => i.kind === def.id);
      if (mine.length === 0) continue;
      this.species.push(this.buildSpecies(def, mine));
      this.totalInstances += mine.length;
    }
  }

  private buildSpecies(def: TreeDef, instances: ScatterInstance[]): Species {
    const gen = def.generator;
    const look = createFoliageLook(hexColor(def.look.leafColor).getHex(), hexColor(def.look.leafColor).getHex());
    (look.stiffness as any).value = def.wind.stiffness;
    const variantCount = Math.max(1, gen.variants);
    const counts = new Array<number>(variantCount).fill(0);
    for (const inst of instances) counts[inst.variant % variantCount]! += 1;
    const [h0, h1] = gen.height;
    const heights = new Float32Array(instances.length);
    instances.forEach((inst, k) => {
      heights[k] = h0 + (h1 - h0) * (((inst.scale - 0.8) / 0.4 + (inst.phase / (Math.PI * 2)) * 0.3) % 1);
    });

    const variants: Variant[] = [];
    const seedBase = hashString(def.id) % 10000;
    let barkMat: THREE.Material | null = null;
    let leafMat: THREE.Material | null = null;
    for (let v = 0; v < variantCount; v++) {
      const parts: Variant['parts'] = [];
      let height = (h0 + h1) / 2;
      let radius = height * 0.3;
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
        for (const [geometry, material] of [
          [geo.branches, barkMat],
          [geo.leaves, leafMat],
        ] as const) {
          const g = shareGeometry(geometry);
          instanceAttributes(g, counts[v]!);
          const mesh = new THREE.InstancedMesh(g, material, counts[v]!);
          mesh.count = 0;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          this.group.add(mesh);
          parts.push({ mesh, geometry: g });
        }
      } else if (gen.kind === 'bamboo') {
        const bamboo = generateBamboo({ seed: seedBase + v * 31, minHeight: h0, maxHeight: h1 });
        height = bamboo.height;
        radius = bamboo.radius;
        barkMat ??= createBambooCulmMaterial(this.wind, look);
        leafMat ??= createPolyLeafMaterial(this.wind, look);
        for (const [geometry, material] of [
          [bamboo.culms, barkMat],
          [bamboo.leaves, leafMat],
        ] as const) {
          const g = shareGeometry(geometry);
          instanceAttributes(g, counts[v]!);
          const mesh = new THREE.InstancedMesh(g, material, counts[v]!);
          mesh.count = 0;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          this.group.add(mesh);
          parts.push({ mesh, geometry: g });
        }
      }
      variants.push({ height, radius, parts, count: 0 });
    }

    // Lite (far) tree for the species.
    const ref = variants[0] as Variant;
    const shape = gen.kind === 'ez-tree' ? gen.shape : 'round';
    const lite = generateLiteTree(seedBase, ref.height, ref.radius * 0.8, gen.kind === 'bamboo' ? 'spreading' : shape);
    const trunkGeo = lite.trunk;
    instanceAttributes(trunkGeo, instances.length);
    const canopyGeo = lite.canopy;
    instanceAttributes(canopyGeo, instances.length);
    const trunkMat = new THREE.MeshStandardNodeMaterial({ color: 0x4a3a2c, roughness: 0.95 });
    const canopyMat = this.createLiteCanopyMaterial(look);
    const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, instances.length);
    const canopy = new THREE.InstancedMesh(canopyGeo, canopyMat, instances.length);
    for (const mesh of [trunk, canopy]) {
      mesh.count = 0;
      // Far trees skip shadows (cost); the AO and fog carry them at distance.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    return { def, look, variants, lite: { trunk, canopy, height: ref.height, radius: ref.radius }, instances, heights };
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
      for (const v of sp.variants) v.count = 0;
      let liteCount = 0;
      const liteTrunk = sp.lite.trunk;
      const liteCanopy = sp.lite.canopy;
      const liteA = liteCanopy.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute;
      const liteB = liteCanopy.geometry.getAttribute('aInstB') as THREE.InstancedBufferAttribute;
      const liteTA = liteTrunk.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute;
      const liteTB = liteTrunk.geometry.getAttribute('aInstB') as THREE.InstancedBufferAttribute;
      sp.instances.forEach((inst, k) => {
        const targetHeight = sp.heights[k] as number;
        const d2 = (inst.x - camera.x) ** 2 + (inst.z - camera.z) ** 2;
        _q.setFromAxisAngle(UP, inst.yaw);
        if (d2 < near2) {
          const v = sp.variants[inst.variant % sp.variants.length] as Variant;
          const scale = targetHeight / v.height;
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
          const scale = targetHeight / sp.lite.height;
          _m.compose(_p.set(inst.x, inst.y - 0.15, inst.z), _q, _s.setScalar(scale));
          liteTrunk.setMatrixAt(liteCount, _m);
          liteCanopy.setMatrixAt(liteCount, _m);
          liteA.setXYZW(liteCount, inst.yaw, scale, inst.phase, stiffness);
          liteB.setXYZW(liteCount, inst.x, inst.z, sp.lite.height, sp.lite.radius);
          liteTA.setXYZW(liteCount, inst.yaw, scale, inst.phase, stiffness);
          liteTB.setXYZW(liteCount, inst.x, inst.z, sp.lite.height, sp.lite.radius);
          liteCount++;
        }
      });
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

  /** Near-detail instance count (for stats). */
  nearCount(): number {
    return this.species.reduce((sum, sp) => sum + sp.variants.reduce((s, v) => s + v.count, 0), 0);
  }
}
