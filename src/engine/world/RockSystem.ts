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

/** A placed stone in world space (for physics and the flow solver). */
export interface PlacedStone {
  id: number;
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
}

interface KindMeshes {
  def: StoneDef;
  variants: { geometry: THREE.BufferGeometry; mesh: THREE.InstancedMesh }[];
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
  m.colorNode = green;
  if (layer.normal)
    m.normalNode = normalMap(
      triplanarTexture(texture(layer.normal), null, null, float(0.45), positionWorld, normalWorld),
      vec2(1, 1),
    );
  materials.set(textureId, m);
  return m;
}

/**
 * Boulders, slabs, cobbles and pebbles (plan 6.4): generated rock variants per stone type, instanced.
 * Clusters (cobbles, pebbles) expand into several small rocks around one placement.
 */
export class RockSystem {
  readonly group = new THREE.Group();
  readonly stones: PlacedStone[] = [];
  private readonly kinds = new Map<string, KindMeshes>();
  private nextId = 1;

  constructor(
    defs: readonly StoneDef[],
    instances: readonly ScatterInstance[],
    heightAt: (x: number, z: number) => number,
    wetnessAt: (x: number, z: number) => number,
  ) {
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
    const flatness = (def.generator.flatness[0] + def.generator.flatness[1]) / 2;
    const variants = [];
    for (let v = 0; v < def.generator.variants; v++) {
      const detail = def.generator.radius[1] < 0.3 ? 1 : 2;
      const geometry = generateRock(seed + v * 101, 1, def.generator.roughness, detail);
      // Flatness is applied per instance through the matrix; the base rock is round.
      void flatness;
      geometry.setAttribute('aRock', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
      const mesh = new THREE.InstancedMesh(geometry, rockMaterial(def.generator.texture), capacity);
      mesh.count = 0;
      mesh.castShadow = def.generator.radius[1] > 0.2;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      variants.push({ geometry, mesh });
    }
    return { def, variants };
  }

  /** Rewrites all instance data (after adding, moving or removing stones). */
  refresh(): void {
    const counts = new Map<THREE.InstancedMesh, number>();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const kind of this.kinds.values()) for (const v of kind.variants) counts.set(v.mesh, 0);
    for (const s of this.stones) {
      const kind = this.kinds.get(s.kind);
      if (!kind) continue;
      const v = kind.variants[s.variant % kind.variants.length]!;
      const i = counts.get(v.mesh) ?? 0;
      if (i >= v.mesh.instanceMatrix.count) continue;
      q.setFromAxisAngle(up, s.yaw);
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(s.radius, s.height, s.radius));
      v.mesh.setMatrixAt(i, m);
      (v.geometry.getAttribute('aRock') as THREE.InstancedBufferAttribute).setXYZW(i, s.moss, 0, 0, 0);
      counts.set(v.mesh, i + 1);
    }
    for (const [mesh, n] of counts) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      (mesh.geometry.getAttribute('aRock') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  /** Adds a stone (builder) and returns it. */
  add(stone: Omit<PlacedStone, 'id'>): PlacedStone {
    const placed = { ...stone, id: this.nextId++ };
    this.stones.push(placed);
    this.refresh();
    return placed;
  }

  remove(id: number): void {
    const i = this.stones.findIndex((s) => s.id === id);
    if (i >= 0) this.stones.splice(i, 1);
    this.refresh();
  }
}
