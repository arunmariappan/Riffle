import * as THREE from 'three/webgpu';
import { createGrassLook, createGrassMaterial, bladeGeometry, type GrassLook } from './grass';
import type { WindUniforms } from './wind';
import { hash01 } from '../../sim/rng';

export interface GrassField {
  heightAt(x: number, z: number): number;
  /** 0..1 grass density at a point (a fast lookup into a precomputed grid). */
  densityAt(x: number, z: number): number;
}

const RADIUS = 46;
const SPACING = 0.2;
const REBUILD_DISTANCE = 6;
const CAPACITY = 150_000;

/**
 * Grass blades streamed around the camera (plan 6.4; instanced blades instead of compute, see C4). One fixed-size
 * instance buffer is refilled when the camera moves (no new meshes or materials), from a precomputed density grid.
 * Blade positions come from a stable hash grid, so they don't shimmer when the field is refilled.
 */
export class GrassSystem {
  readonly look: GrassLook;
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly attrA: THREE.InstancedBufferAttribute;
  private readonly attrB: THREE.InstancedBufferAttribute;
  private readonly center = new THREE.Vector3(Infinity, 0, Infinity);
  private readonly field: GrassField;
  bladeCount = 0;
  /** Density multiplier (quality preset). */
  density = 1;
  /** Milliseconds the last refill took (for stats). */
  lastRefillMs = 0;

  constructor(field: GrassField, wind: WindUniforms) {
    this.field = field;
    this.look = createGrassLook();
    const geometry = bladeGeometry();
    this.attrA = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
    this.attrB = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
    this.attrA.setUsage(THREE.DynamicDrawUsage);
    this.attrB.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aBlade', this.attrA);
    geometry.setAttribute('aBladeB', this.attrB);
    this.mesh = new THREE.InstancedMesh(geometry, createGrassMaterial(wind, this.look), CAPACITY);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.group.add(this.mesh);
  }

  update(camera: THREE.Vector3, force = false): void {
    const dx = camera.x - this.center.x;
    const dz = camera.z - this.center.z;
    if (!force && dx * dx + dz * dz < REBUILD_DISTANCE * REBUILD_DISTANCE) return;
    this.center.set(Math.round(camera.x / 2) * 2, 0, Math.round(camera.z / 2) * 2);
    this.refill();
  }

  private refill(): void {
    const t0 = performance.now();
    const a = this.attrA.array as Float32Array;
    const b = this.attrB.array as Float32Array;
    const spacing = SPACING / Math.sqrt(Math.max(0.1, this.density));
    const cx = this.center.x;
    const cz = this.center.z;
    const n = Math.ceil(RADIUS / spacing);
    const gx0 = Math.floor(cx / spacing);
    const gz0 = Math.floor(cz / spacing);
    const r2 = RADIUS * RADIUS;
    let count = 0;
    for (let j = -n; j <= n && count < CAPACITY; j++) {
      for (let i = -n; i <= n; i++) {
        const gx = gx0 + i;
        const gz = gz0 + j;
        const x = (gx + hash01(gx, gz, 1)) * spacing;
        const z = (gz + hash01(gx, gz, 2)) * spacing;
        const ddx = x - cx;
        const ddz = z - cz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 > r2) continue;
        const edge = 1 - d2 / r2;
        const density = this.field.densityAt(x, z) * Math.min(1, edge * 3);
        if (density <= 0 || hash01(gx, gz, 3) > density) continue;
        const o = count * 4;
        a[o] = x;
        a[o + 1] = this.field.heightAt(x, z);
        a[o + 2] = z;
        a[o + 3] = 0.12 + hash01(gx, gz, 4) ** 2 * 0.42 * (0.6 + density * 0.6);
        b[o] = hash01(gx, gz, 5) * Math.PI * 2;
        b[o + 1] = hash01(gx, gz, 6) * Math.PI * 2;
        b[o + 2] = hash01(gx, gz, 7);
        b[o + 3] = 0.02 + hash01(gx, gz, 8) * 0.025;
        count++;
        if (count >= CAPACITY) break;
      }
    }
    this.mesh.count = count;
    this.attrA.clearUpdateRanges();
    this.attrB.clearUpdateRanges();
    this.attrA.addUpdateRange(0, count * 4);
    this.attrB.addUpdateRange(0, count * 4);
    this.attrA.needsUpdate = true;
    this.attrB.needsUpdate = true;
    this.bladeCount = count;
    this.lastRefillMs = performance.now() - t0;
  }

  /** 0..1 grass density at a point (tests pick a meadow with it). */
  densityAt(x: number, z: number): number {
    return this.field.densityAt(x, z);
  }

  setLook(lushness: number): void {
    (this.look.dryness as any).value = 1 - lushness;
  }
}

export { createGrassLook };
