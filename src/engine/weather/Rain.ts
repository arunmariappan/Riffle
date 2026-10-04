import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cross,
  float,
  hash,
  instanceIndex,
  mod,
  normalize,
  positionLocal,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';

/** Most raindrops drawn (a monsoon downpour); lighter rain draws a share of them. */
const MAX_DROPS = 9000;
/** The box of rain around the camera, m. */
const BOX = 40;
const HEIGHT = 24;

/**
 * Falling rain (plan 6.7): thin streaks in a box that follows the camera. Every drop's position comes from its index
 * and the time in the vertex shader (no per-frame CPU work); the wind tilts and carries them. The drop count follows
 * the rain rate, and the streaks face the camera.
 */
export class Rain {
  readonly mesh: THREE.InstancedMesh;
  /** 0..1 how hard it rains (share of the drops drawn). */
  intensity = 0;
  private readonly center = uniform(new THREE.Vector3());
  private readonly wind = uniform(new THREE.Vector2());
  private readonly time = uniform(0);
  private readonly light = uniform(1);

  constructor() {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: true });
    const i = float(instanceIndex);
    const hx = hash(i);
    const hz = hash(i.add(1931));
    const hy = hash(i.add(7517));
    const hs = hash(i.add(311));
    const t: any = this.time;
    const w: any = this.wind;
    const c: any = this.center;
    const speed = float(7.5).add(hs.mul(3));
    // Each drop falls from its own start, drifting with the wind, and wraps around inside the box at the camera.
    const px = hx.mul(BOX).add(w.x.mul(t).mul(0.7));
    const pz = hz.mul(BOX).add(w.y.mul(t).mul(0.7));
    const py = hy.mul(HEIGHT).sub(t.mul(speed));
    const wrap = (v: any, center: any, size: number) =>
      mod(v.sub(center).add(size / 2), size)
        .sub(size / 2)
        .add(center);
    const pos = vec3(wrap(px, c.x, BOX), wrap(py, c.y, HEIGHT), wrap(pz, c.z, BOX));
    const vel = normalize(vec3(w.x.mul(0.7), speed.negate(), w.y.mul(0.7)));
    const toCam = normalize(cameraPosition.sub(pos));
    const side = normalize(cross(vel, toCam));
    const len = float(0.3).add(hs.mul(0.3));
    material.positionNode = pos.add(side.mul(positionLocal.x.mul(0.014))).add(vel.mul(positionLocal.y.mul(len)));
    // Faint grey-white streaks, brighter in daylight, fading at both ends.
    const fade = smoothstep(0, 0.3, uv().y).mul(smoothstep(1, 0.6, uv().y));
    material.colorNode = vec4(vec3(0.72, 0.76, 0.8).mul(this.light), fade.mul(0.28));
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_DROPS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Rain rate (mm/h), wind (m/s), the camera, the time and the daylight (0..1). */
  update(rain: number, windX: number, windZ: number, camera: THREE.Vector3, time: number, daylight: number): void {
    // A light shower draws a few hundred drops; a downpour (30 mm/h) all of them.
    this.intensity = rain <= 0.05 ? 0 : Math.min(1, Math.pow(rain / 30, 0.6));
    this.mesh.count = Math.round(this.intensity * MAX_DROPS);
    (this.center.value as THREE.Vector3).copy(camera);
    (this.wind.value as THREE.Vector2).set(windX, windZ);
    this.time.value = time;
    this.light.value = 0.15 + daylight * 0.85;
  }
}
