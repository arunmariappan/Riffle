import * as THREE from 'three/webgpu';
import {
  attribute,
  texture,
  triplanarTexture,
  positionWorld,
  normalWorld,
  float,
  mix,
  smoothstep,
  vec3,
  normalMap,
  vec2,
} from 'three/tsl';
import type { StoneDef } from '../../content/schema';
import type { ScatterInstance } from '../../sim/scatter/scatter';
import { generateRock } from '../../procgen/rocks';
import { hashString, createRng } from '../../sim/rng';
import { loadLayer } from '../terrain/terrainMaterial';
import { causticLight, waterLevelAt } from '../water/caustics';

/** Set before building rocks so their materials can show the waterline and caustics. */
let waterLevelSource: {
  map: THREE.Texture;
  hf: { originX: number; originZ: number; cell: number; size: number };
} | null = null;
export function setRockWaterLevel(
  map: THREE.Texture,
  hf: { originX: number; originZ: number; cell: number; size: number },
): void {
  waterLevelSource = { map, hf };
  materials.clear();
}

/** A placed stone in world space (for physics and the flow solver). */
export interface PlacedStone {
  /** Numeric id (flow solver obstacles). */
  id: number;
  /** Item registry id (`g:stones:<n>` generated, `u<n>` placed by you). */
  uid: string;
  kind: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  yaw: number;
  variant: number;
  /** 0..1 moss cover (grows in damp shade, plan 6.4). */
  moss: number;
  /** Full rotation once a dropped stone has tumbled and settled (x, y, z, w); yaw only otherwise. */
  quat?: [number, number, number, number];
  /** Size multiplier from the builder (radius and height already include it). */
  scale?: number;
}

interface VariantMesh {
  geometry: THREE.BufferGeometry;
  mesh: THREE.InstancedMesh;
}

interface KindMeshes {
  def: StoneDef;
  variants: VariantMesh[];
}

const materials = new Map<string, THREE.MeshStandardNodeMaterial>();

function rockMaterial(textureId: string): THREE.MeshStandardNodeMaterial {
  const cached = materials.get(textureId);
  if (cached) return cached;
  const layer = loadLayer(textureId, 0x6a6660);
  const moss = loadLayer('moss_wood', 0x617020, false);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const base = triplanarTexture(texture(layer.diffuse), null, null, float(0.45), positionWorld, normalWorld).rgb;
  const mossC = triplanarTexture(texture(moss.diffuse), null, null, float(0.6), positionWorld, normalWorld).rgb;
  const mossAmount = attribute('aRock', 'vec4').x;
  // Moss sits on the upward-facing parts.
  const up = smoothstep(0.2, 0.75, normalWorld.y);
  // Granite reads darker and cooler than the raw texture; moss sits on top where it is damp.
  const granite = base.mul(0.95);
  const green = mix(granite, mossC.mul(vec3(0.75, 0.95, 0.6)), up.mul(mossAmount).mul(1.2).min(1));
  if (waterLevelSource) {
    const level = waterLevelAt(waterLevelSource.map, positionWorld, waterLevelSource.hf);
    const below = level.sub(positionWorld.y);
    const under = smoothstep(-0.02, 0.05, below);
    // Dark wet band at the waterline (plan 8) and darker, glossier stone below it.
    const wetLine = smoothstep(-0.35, 0, below).mul(float(1).sub(under));
    const wet = green.mul(float(1).sub(wetLine.mul(0.45)).sub(under.mul(0.2)));
    m.colorNode = wet;
    m.roughnessNode = mix(float(0.85), float(0.3), wetLine.max(under));
    m.emissiveNode = wet.mul(causticLight(positionWorld, level));
  } else {
    m.colorNode = green;
  }
  if (layer.normal)
    m.normalNode = normalMap(
      triplanarTexture(texture(layer.normal), null, null, float(0.45), positionWorld, normalWorld),
      vec2(1, 1),
    );
  materials.set(textureId, m);
  return m;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Boulders, slabs, cobbles and pebbles (plan 6.4): generated rock variants per stone type, instanced.
 * Clusters (cobbles, pebbles) expand into several small rocks around one placement. Stones can be added, removed and
 * moved (builder); instance buffers grow when they fill up, reusing the same materials (no shader recompiles).
 */
export class RockSystem {
  readonly group = new THREE.Group();
  readonly stones: PlacedStone[] = [];
  private readonly kinds = new Map<string, KindMeshes>();
  private readonly slots = new Map<string, { mesh: THREE.InstancedMesh; index: number }>();
  private nextId = 1;

  constructor(
    defs: readonly StoneDef[],
    instances: readonly ScatterInstance[],
    heightAt: (x: number, z: number) => number,
    wetnessAt: (x: number, z: number) => number,
  ) {
    let generated = 0;
    for (const def of defs) {
      const rng = createRng(`rocks:${def.id}`);
      const mine = instances.filter((i) => i.kind === def.id);
      for (const inst of mine) {
        const [r0, r1] = def.generator.radius;
        const [f0, f1] = def.generator.flatness;
        const count = def.generator.cluster;
        for (let c = 0; c < count; c++) {
          const radius = r0 + (r1 - r0) * rng.next();
          const flat = f0 + (f1 - f0) * rng.next();
          const spread = count > 1 ? def.generator.radius[1] * 4 : 0;
          const a = rng.range(0, Math.PI * 2);
          const d = count > 1 ? Math.sqrt(rng.next()) * spread : 0;
          const x = inst.x + Math.cos(a) * d;
          const z = inst.z + Math.sin(a) * d;
          this.stones.push({
            id: this.nextId++,
            uid: `g:stones:${generated++}`,
            kind: def.id,
            x,
            y: heightAt(x, z) - radius * flat * 0.25,
            z,
            radius,
            height: radius * flat,
            yaw: rng.range(0, Math.PI * 2),
            variant: rng.int(0, def.generator.variants),
            moss: Math.min(1, wetnessAt(x, z) * 1.2) * rng.range(0.5, 1),
          });
        }
      }
      this.kinds.set(def.id, this.buildKind(def, Math.max(64, mine.length * def.generator.cluster * 2)));
    }
    this.refresh();
  }

  private buildKind(def: StoneDef, capacity: number): KindMeshes {
    const seed = hashString(def.id) % 1000;
    const variants: VariantMesh[] = [];
    for (let v = 0; v < def.generator.variants; v++) {
      const detail = def.generator.radius[1] < 0.3 ? 1 : 2;
      // Flatness is applied per instance through the matrix; the base rock is round.
      const geometry = generateRock(seed + v * 101, 1, def.generator.roughness, detail);
      geometry.setAttribute('aRock', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
      const mesh = this.makeMesh(def, geometry, capacity);
      this.group.add(mesh);
      variants.push({ geometry, mesh });
    }
    return { def, variants };
  }

  private makeMesh(def: StoneDef, geometry: THREE.BufferGeometry, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, rockMaterial(def.generator.texture), capacity);
    mesh.count = 0;
    // Decided once per kind (never toggled later: that would recompile the shader).
    mesh.castShadow = def.generator.radius[1] > 0.2;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Doubles a variant's instance buffer (same material and vertex data, so no shader recompile). */
  private grow(kind: KindMeshes, v: number, needed: number): void {
    const old = kind.variants[v] as VariantMesh;
    let capacity = old.mesh.instanceMatrix.count;
    while (capacity < needed) capacity *= 2;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(old.geometry.attributes))
      if (name !== 'aRock') g.setAttribute(name, attr);
    g.setIndex(old.geometry.index);
    g.boundingBox = old.geometry.boundingBox;
    g.boundingSphere = old.geometry.boundingSphere;
    g.setAttribute('aRock', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
    const mesh = this.makeMesh(kind.def, g, capacity);
    this.group.remove(old.mesh);
    old.mesh.dispose();
    this.group.add(mesh);
    kind.variants[v] = { geometry: g, mesh };
  }

  private compose(s: PlacedStone): THREE.Matrix4 {
    if (s.quat) _q.set(s.quat[0], s.quat[1], s.quat[2], s.quat[3]);
    else _q.setFromAxisAngle(UP, s.yaw);
    return _m.compose(_p.set(s.x, s.y, s.z), _q, _s.set(s.radius, s.height, s.radius));
  }

  /** Rewrites all instance data (after adding, moving or removing stones). */
  refresh(): void {
    const counts = new Map<THREE.InstancedMesh, number>();
    for (const kind of this.kinds.values()) {
      const need = new Array<number>(kind.variants.length).fill(0);
      for (const s of this.stones) if (s.kind === kind.def.id) need[s.variant % kind.variants.length]! += 1;
      need.forEach((n, v) => {
        if (n > (kind.variants[v] as VariantMesh).mesh.instanceMatrix.count) this.grow(kind, v, n);
      });
      for (const v of kind.variants) counts.set(v.mesh, 0);
    }
    this.slots.clear();
    for (const s of this.stones) {
      const kind = this.kinds.get(s.kind);
      if (!kind) continue;
      const v = kind.variants[s.variant % kind.variants.length]!;
      const i = counts.get(v.mesh) ?? 0;
      v.mesh.setMatrixAt(i, this.compose(s));
      (v.geometry.getAttribute('aRock') as THREE.InstancedBufferAttribute).setXYZW(i, s.moss, 0, 0, 0);
      this.slots.set(s.uid, { mesh: v.mesh, index: i });
      counts.set(v.mesh, i + 1);
    }
    for (const [mesh, n] of counts) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      (mesh.geometry.getAttribute('aRock') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  /** Rewrites one stone's transform in place (a stone tumbling as it falls, a gizmo drag). */
  updateOne(uid: string): void {
    const s = this.get(uid);
    const slot = this.slots.get(uid);
    if (!s || !slot) return;
    slot.mesh.setMatrixAt(slot.index, this.compose(s));
    slot.mesh.instanceMatrix.needsUpdate = true;
  }

  get(uid: string): PlacedStone | undefined {
    return this.stones.find((s) => s.uid === uid);
  }

  /** Adds a stone (builder) and returns it. */
  add(stone: Omit<PlacedStone, 'id'>): PlacedStone {
    const placed = { ...stone, id: this.nextId++ };
    this.stones.push(placed);
    this.refresh();
    return placed;
  }

  /** Removes a stone by registry id; returns it. */
  remove(uid: string): PlacedStone | null {
    const i = this.stones.findIndex((s) => s.uid === uid);
    if (i < 0) return null;
    const [stone] = this.stones.splice(i, 1);
    this.refresh();
    return stone ?? null;
  }

  /** Base rock vertices (radius 1) of a kind's variant, for a physics convex hull. */
  hullPoints(kind: string, variant: number): Float32Array | null {
    const k = this.kinds.get(kind);
    if (!k) return null;
    const v = k.variants[variant % k.variants.length] as VariantMesh;
    return (v.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  }

  /** A single stone using the real material (catalog thumbnails, drag ghosts). Shares the vertex data. */
  preview(kind: string, variant = 0): THREE.Object3D | null {
    const k = this.kinds.get(kind);
    if (!k) return null;
    const src = k.variants[variant % k.variants.length] as VariantMesh;
    const def = k.def;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(src.geometry.attributes))
      if (name !== 'aRock') g.setAttribute(name, attr);
    g.setIndex(src.geometry.index);
    g.setAttribute('aRock', new THREE.InstancedBufferAttribute(new Float32Array([0.4, 0, 0, 0]), 4));
    g.boundingSphere = src.geometry.boundingSphere;
    const mesh = new THREE.InstancedMesh(g, rockMaterial(def.generator.texture), 1);
    const r = (def.generator.radius[0] + def.generator.radius[1]) / 2;
    const h = r * ((def.generator.flatness[0] + def.generator.flatness[1]) / 2);
    mesh.setMatrixAt(0, _m.compose(_p.set(0, 0, 0), _q.identity(), _s.set(r, h, r)));
    mesh.frustumCulled = false;
    const group = new THREE.Group();
    if (def.generator.cluster > 1) {
      // A few stones for clusters, so pebbles read as a cluster.
      mesh.dispose();
      const n = Math.min(6, def.generator.cluster);
      const cluster = new THREE.InstancedMesh(g, rockMaterial(def.generator.texture), n);
      g.setAttribute('aRock', new THREE.InstancedBufferAttribute(new Float32Array(n * 4).fill(0.3), 4));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const d = i === 0 ? 0 : r * 2.4;
        cluster.setMatrixAt(
          i,
          _m.compose(_p.set(Math.cos(a) * d, 0, Math.sin(a) * d), _q.setFromAxisAngle(UP, a), _s.set(r, h, r)),
        );
      }
      cluster.frustumCulled = false;
      group.add(cluster);
      group.userData.radius = r * 3.5;
    } else {
      group.add(mesh);
      group.userData.radius = r * 1.2;
    }
    group.userData.height = h;
    return group;
  }
}
