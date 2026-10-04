import * as THREE from 'three/webgpu';
import { attribute, vec3, mix, smoothstep, uv, length, vec2, float } from 'three/tsl';
import { createRng } from '../../sim/rng';
import { windVelocityAt, type WindState } from '../../sim/wind/windField';

const COUNT = 260;
const RADIUS = 26;

/**
 * Petals, leaves and pollen in the air around you (plan 6.3, 6.4): spawn in the canopy layer, tumble down and drift
 * with the same gusts the trees show (the CPU wind twin). The mix follows the season.
 */
export class AirParticles {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(COUNT * 3);
  private readonly vel = new Float32Array(COUNT * 3);
  private readonly spin = new Float32Array(COUNT * 3);
  private readonly kind: THREE.InstancedBufferAttribute;
  private readonly rng = createRng('air');
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  /** How many particles are active (0..1) and the mix (petal, leaf, autumn leaf; the rest is pollen). */
  amount = 0.4;
  mix = { petal: 0.5, leaf: 0.2, autumnLeaf: 0 };
  private initialized = false;

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    const g = new THREE.PlaneGeometry(1, 1);
    this.kind = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1);
    g.setAttribute('aKind', this.kind);
    const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.7 });
    const k = attribute('aKind', 'float');
    const petal = vec3(0.98, 0.74, 0.82);
    const leafC = vec3(0.35, 0.55, 0.18);
    const autumn = vec3(0.8, 0.22, 0.08);
    const pollen = vec3(1, 0.95, 0.75);
    let c: any = mix(petal, leafC, smoothstep(0.5, 0.6, k));
    c = mix(c, autumn, smoothstep(1.5, 1.6, k));
    c = mix(c, pollen, smoothstep(2.5, 2.6, k));
    mat.colorNode = c;
    // Pollen glows a little in sunlight.
    mat.emissiveNode = pollen.mul(smoothstep(2.5, 2.6, k)).mul(0.4);
    const p = uv().sub(0.5);
    const isLeaf = smoothstep(0.5, 0.6, k).mul(float(1).sub(smoothstep(2.5, 2.6, k)));
    mat.opacityNode = smoothstep(0.5, 0.42, length(vec2(p.x.mul(mix(float(1), float(1.9), isLeaf)), p.y)));
    mat.alphaTest = 0.5;
    this.mesh = new THREE.InstancedMesh(g, mat, COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
  }

  private spawn(i: number, cx: number, cz: number, anyHeight: boolean): void {
    const a = this.rng.range(0, Math.PI * 2);
    const r = Math.sqrt(this.rng.next()) * RADIUS;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const ground = this.heightAt(x, z);
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = ground + (anyHeight ? this.rng.range(0.5, 11) : this.rng.range(6, 12));
    this.pos[i * 3 + 2] = z;
    const roll = this.rng.next();
    const kind =
      roll < this.mix.petal
        ? 0
        : roll < this.mix.petal + this.mix.leaf
          ? 1
          : roll < this.mix.petal + this.mix.leaf + this.mix.autumnLeaf
            ? 2
            : 3;
    this.kind.setX(i, kind);
    // Petals and leaves sink slowly while tumbling; pollen floats.
    this.vel[i * 3 + 1] = kind === 3 ? this.rng.range(-0.05, 0.05) : -this.rng.range(0.35, 0.9);
    for (let k = 0; k < 3; k++) this.spin[i * 3 + k] = this.rng.range(-3, 3);
  }

  update(dt: number, camera: THREE.Vector3, time: number, wind: WindState): void {
    if (!this.initialized) {
      for (let i = 0; i < COUNT; i++) this.spawn(i, camera.x, camera.z, true);
      this.kind.needsUpdate = true;
      this.initialized = true;
    }
    const active = Math.round(COUNT * Math.min(1, this.amount));
    let respawned = false;
    for (let i = 0; i < active; i++) {
      let x = this.pos[i * 3] as number;
      let y = this.pos[i * 3 + 1] as number;
      let z = this.pos[i * 3 + 2] as number;
      const [wx, wz] = windVelocityAt(wind, x, z, time);
      const kind = this.kind.getX(i);
      const drag = kind === 3 ? 0.9 : 0.5;
      x += (wx * drag + Math.sin(time * 1.7 + i) * 0.15) * dt;
      z += (wz * drag + Math.cos(time * 1.3 + i * 0.7) * 0.15) * dt;
      y += ((this.vel[i * 3 + 1] as number) + Math.sin(time * 2.3 + i * 1.3) * 0.12) * dt;
      const ground = this.heightAt(x, z);
      if (y < ground + 0.02 || (x - camera.x) ** 2 + (z - camera.z) ** 2 > RADIUS * RADIUS * 1.4 || y > ground + 20) {
        this.spawn(i, camera.x, camera.z, false);
        respawned = true;
        continue;
      }
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      this.e.set(
        time * (this.spin[i * 3] as number),
        time * (this.spin[i * 3 + 1] as number),
        time * (this.spin[i * 3 + 2] as number),
      );
      this.q.setFromEuler(this.e);
      const size = kind === 3 ? 0.012 : kind === 0 ? 0.03 : 0.06;
      this.m.compose(this.p.set(x, y, z), this.q, this.s.set(size, size * (kind === 1 || kind === 2 ? 0.55 : 1), size));
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.count = active;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (respawned) this.kind.needsUpdate = true;
  }
}
