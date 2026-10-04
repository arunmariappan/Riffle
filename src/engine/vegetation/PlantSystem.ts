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

type PlantDef = BushDef | WaterPlantDef;

export interface PlantInstance extends ScatterInstance {
  /** Water depth (water plants), for stem length. */
  depth?: number;
}

interface Kind {
  def: PlantDef;
  look: FoliageLook;
  aquatic: boolean;
  variants: { mesh: THREE.InstancedMesh; geometry: THREE.BufferGeometry; height: number; capacity: number }[];
  instances: PlantInstance[];
  radius: number;
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

/**
 * Ground plants (ferns, wildflowers, orchids) and water plants (plan 6.4): generated variants, instanced, shown
 * within a radius of the camera (re-bucketed a few times a second). Water plants get the local current per instance.
 */
export class PlantSystem {
  readonly group = new THREE.Group();
  private readonly kinds: Kind[] = [];
  private readonly wind: WindUniforms;
  private flow: FlowLookup | null = null;
  private last = new THREE.Vector3(Infinity, 0, 0);
  private lastTime = -1;
  visibleCount = 0;

  constructor(defs: readonly PlantDef[], instances: readonly PlantInstance[], wind: WindUniforms) {
    this.wind = wind;
    for (const def of defs)
      this.addKind(
        def,
        instances.filter((i) => i.kind === def.id),
      );
  }

  setFlow(flow: FlowLookup): void {
    this.flow = flow;
    this.update(this.last.clone(), this.lastTime, true);
  }

  /** Adds more instances (water plants placed once the flow is solved, or builder placements). */
  addInstances(defs: readonly PlantDef[], instances: readonly PlantInstance[]): void {
    for (const def of defs) {
      const mine = instances.filter((i) => i.kind === def.id);
      if (mine.length === 0) continue;
      const existing = this.kinds.find((k) => k.def.id === def.id);
      if (existing) {
        this.group.remove(...existing.variants.map((v) => v.mesh));
        this.kinds.splice(this.kinds.indexOf(existing), 1);
        this.addKind(def, [...existing.instances, ...mine]);
      } else {
        this.addKind(def, mine);
      }
    }
    this.lastTime = -1;
  }

  private addKind(def: PlantDef, instances: PlantInstance[]): void {
    if (instances.length === 0) return;
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
    const variants: Kind['variants'] = [];
    const typicalDepth = floating ? 1 : 0;
    const counts = new Array<number>(def.generator.variants).fill(0);
    for (const inst of instances) counts[inst.variant % counts.length]! += 1;
    for (let v = 0; v < def.generator.variants; v++) {
      const pg = generate(def, seed + v * 17, typicalDepth);
      const g = pg.geometry;
      const capacity = Math.max(1, counts[v]!);
      g.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
      g.setAttribute('aInstB', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
      if (aquatic) g.setAttribute('aFlow', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
      const mesh = new THREE.InstancedMesh(g, material, capacity);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      variants.push({ mesh, geometry: g, height: pg.height, capacity });
    }
    const radius = aquatic ? 140 : def.generator.kind === 'fern' ? 70 : 80;
    this.kinds.push({ def, look, aquatic, variants, instances, radius });
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
      const counts = new Array<number>(k.variants.length).fill(0);
      for (const inst of k.instances) {
        if ((inst.x - camera.x) ** 2 + (inst.z - camera.z) ** 2 > r2) continue;
        const vi = inst.variant % k.variants.length;
        const v = k.variants[vi]!;
        const i = counts[vi]!;
        if (i >= v.capacity) continue;
        counts[vi] = i + 1;
        _q.setFromAxisAngle(UP, inst.yaw);
        // Water plants: stems reach the surface (vertical scale = depth / generated depth).
        const sy =
          k.aquatic && inst.depth !== undefined && (k.def.generator.kind === 'lotus' || k.def.generator.kind === 'lily')
            ? inst.depth / Math.max(0.2, v.height - (k.def.generator.kind === 'lotus' ? 0.5 : 0))
            : inst.scale;
        _m.compose(_p.set(inst.x, inst.y, inst.z), _q, _s.set(inst.scale, sy, inst.scale));
        v.mesh.setMatrixAt(i, _m);
        (v.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute).setXYZW(
          i,
          inst.yaw,
          inst.scale,
          inst.phase,
          1,
        );
        (v.geometry.getAttribute('aInstB') as THREE.InstancedBufferAttribute).setXYZW(
          i,
          inst.x,
          inst.z,
          v.height * inst.scale,
          0,
        );
        if (k.aquatic) {
          const s = this.flow?.sample(inst.x, inst.z);
          (v.geometry.getAttribute('aFlow') as THREE.InstancedBufferAttribute).setXYZW(
            i,
            s?.velocityX ?? 0,
            s?.velocityZ ?? 0,
            s?.depth ?? 0,
            s?.surface ?? 0,
          );
        }
      }
      k.variants.forEach((v, vi) => {
        v.mesh.count = counts[vi]!;
        v.mesh.instanceMatrix.needsUpdate = true;
        for (const name of ['aInst', 'aInstB', 'aFlow']) {
          const a = v.geometry.getAttribute(name) as THREE.InstancedBufferAttribute | undefined;
          if (a) a.needsUpdate = true;
        }
        visible += counts[vi]!;
      });
    }
    this.visibleCount = visible;
  }
}
