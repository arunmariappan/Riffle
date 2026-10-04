import * as THREE from 'three/webgpu';
import { attribute, vec3, mix, uv, smoothstep, float, length, vec2 } from 'three/tsl';
import type { FlowSystem } from './FlowSystem';
import { createRng } from '../../sim/rng';

const COUNT = 320;
const RADIUS = 42;

/** Kinds of floating debris; the mix follows the season (petals in spring, leaves in autumn). */
const KINDS = { petal: 0, leaf: 1, autumnLeaf: 2, foam: 3 } as const;

/**
 * Petals, leaves and foam flecks drifting on the current around you (plan 6.2). Advected on the CPU with the solved
 * flow, drawn as small instanced quads lying on the surface.
 */
export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private readonly x = new Float32Array(COUNT);
  private readonly z = new Float32Array(COUNT);
  private readonly spin = new Float32Array(COUNT);
  private readonly spinRate = new Float32Array(COUNT);
  private readonly kind: THREE.InstancedBufferAttribute;
  private readonly flow: FlowSystem;
  private readonly rng = createRng('debris');
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  /** Season mix: chance of petals, leaves, autumn leaves (rest is foam). */
  mix = { petal: 0.4, leaf: 0.2, autumnLeaf: 0 };

  constructor(flow: FlowSystem) {
    this.flow = flow;
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.kind = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1);
    g.setAttribute('aKind', this.kind);
    const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.7, transparent: false });
    const k = attribute('aKind', 'float');
    const petal = vec3(0.98, 0.72, 0.8);
    const leaf = vec3(0.32, 0.5, 0.16);
    const autumn = vec3(0.75, 0.2, 0.08);
    const foam = vec3(0.92, 0.94, 0.94);
    const c0 = mix(petal, leaf, smoothstep(0.5, 0.6, k));
    const c1 = mix(c0, autumn, smoothstep(1.5, 1.6, k));
    mat.colorNode = mix(c1, foam, smoothstep(2.5, 2.6, k));
    // Rounded shapes: petals and flecks are discs, leaves are pointed ovals.
    const p = uv().sub(0.5);
    const isLeaf = smoothstep(0.5, 0.6, k).mul(float(1).sub(smoothstep(2.5, 2.6, k)));
    const ovalP = vec2(p.x.mul(mix(float(1), float(1.8), isLeaf)), p.y);
    mat.opacityNode = smoothstep(0.5, 0.45, length(ovalP));
    mat.alphaTest = 0.5;
    this.mesh = new THREE.InstancedMesh(g, mat, COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 3;
    this.mesh.count = 0;
  }

  private spawn(i: number, cx: number, cz: number, anywhere: boolean): boolean {
    for (let tries = 0; tries < 12; tries++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = anywhere ? Math.sqrt(this.rng.next()) * RADIUS : RADIUS * this.rng.range(0.6, 1);
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const s = this.flow.sample(x, z);
      if (!s || s.depth < 0.1) continue;
      this.x[i] = x;
      this.z[i] = z;
      this.spin[i] = this.rng.range(0, Math.PI * 2);
      this.spinRate[i] = this.rng.range(-0.6, 0.6);
      const roll = this.rng.next();
      const kind =
        roll < this.mix.petal
          ? KINDS.petal
          : roll < this.mix.petal + this.mix.leaf
            ? KINDS.leaf
            : roll < this.mix.petal + this.mix.leaf + this.mix.autumnLeaf
              ? KINDS.autumnLeaf
              : KINDS.foam;
      this.kind.setX(i, kind);
      return true;
    }
    this.x[i] = Number.NaN;
    return false;
  }

  update(dt: number, camera: THREE.Vector3, time: number): void {
    if (this.mesh.count === 0) {
      for (let i = 0; i < COUNT; i++) this.spawn(i, camera.x, camera.z, true);
      this.kind.needsUpdate = true;
    }
    let respawned = false;
    for (let i = 0; i < COUNT; i++) {
      let x = this.x[i] as number;
      let z = this.z[i] as number;
      const s = Number.isNaN(x) ? null : this.flow.sample(x, z);
      if (!s || s.depth < 0.05 || (x - camera.x) ** 2 + (z - camera.z) ** 2 > RADIUS * RADIUS * 1.2) {
        respawned = this.spawn(i, camera.x, camera.z, false) || respawned;
        x = this.x[i] as number;
        z = this.z[i] as number;
        if (Number.isNaN(x)) {
          this.m.makeScale(0, 0, 0);
          this.mesh.setMatrixAt(i, this.m);
          continue;
        }
      }
      // Drift with the surface current (a little faster than the depth average), plus a slow wobble.
      const vx = (s?.velocityX ?? 0) * 1.1 + Math.sin(time * 0.7 + i) * 0.03;
      const vz = (s?.velocityZ ?? 0) * 1.1 + Math.cos(time * 0.6 + i * 1.7) * 0.03;
      x += vx * dt;
      z += vz * dt;
      this.x[i] = x;
      this.z[i] = z;
      this.spin[i] = (this.spin[i] as number) + (this.spinRate[i] as number) * dt * (1 + (s?.foam ?? 0) * 4);
      const kind = this.kind.getX(i);
      const size = kind === KINDS.foam ? 0.05 + (i % 7) * 0.012 : kind === KINDS.petal ? 0.035 : 0.07;
      this.e.set(0, this.spin[i] as number, 0);
      this.q.setFromEuler(this.e);
      const surface = s ? s.surface + 0.012 : 0;
      this.m.compose(
        new THREE.Vector3(x, surface, z),
        this.q,
        new THREE.Vector3(size, 1, size * (kind === KINDS.leaf || kind === KINDS.autumnLeaf ? 0.55 : 1)),
      );
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.count = COUNT;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (respawned) this.kind.needsUpdate = true;
  }
}
