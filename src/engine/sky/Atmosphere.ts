import * as THREE from 'three/webgpu';
import { Fn, fog, uniform, vec3, float, exp, positionView, positionWorld, max, color } from 'three/tsl';

export interface AtmosphereState {
  sun: THREE.Vector3;
  moonIllumination: number;
  /** 0..1 haze and mist (monsoon humidity, morning mist). */
  haze: number;
  cloudCover: number;
}

/**
 * Aerial perspective and height fog (plan 6.7, 8): distant ridges fade into blue haze, valley mist pools low,
 * plus stars at night and the exposure curve that makes dawn, noon, dusk and night read correctly.
 */
export class Atmosphere {
  readonly fogColor = uniform(new THREE.Color(0.6, 0.7, 0.8));
  readonly fogDensity = uniform(0.00022);
  /** Mist layer: extra density below this height (meters), e.g. morning mist over the water. */
  readonly mistHeight = uniform(100);
  readonly mistDensity = uniform(0.0);
  readonly stars: THREE.Points;
  private readonly starOpacity = uniform(0);
  /** Exposure the renderer should move toward. */
  targetExposure = 0.35;

  constructor(scene: THREE.Scene) {
    const fc: any = this.fogColor;
    const fd: any = this.fogDensity;
    const mh: any = this.mistHeight;
    const md: any = this.mistDensity;
    const factor = Fn(() => {
      const dist = positionView.z.negate();
      // Thinner air higher up: density halves every ~600 m above the valley floor.
      const heightTerm = exp(positionWorld.y.sub(100).max(0).negate().div(600)).max(0.08);
      const haze = dist.mul(fd).mul(heightTerm);
      // A mist layer pooling below mistHeight.
      const mistAmount = max(mh.sub(positionWorld.y), 0).div(12).min(1);
      const mist = dist.mul(md).mul(mistAmount);
      return float(1)
        .sub(exp(haze.add(mist).negate()))
        .min(0.985);
    });
    scene.fogNode = fog(vec3(fc), factor());

    // Stars: a shell inside the sky dome, rotating about the celestial pole.
    const count = 2600;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < count; i++) {
      const u = rand() * 2 - 1;
      const t = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      positions.set([r * Math.cos(t) * 15000, u * 15000, r * Math.sin(t) * 15000], i * 3);
      sizes[i] = rand();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const m = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, sizeAttenuation: false });
    m.colorNode = color(0xdfe8ff).mul(1.6);
    m.opacityNode = this.starOpacity as any;
    m.size = 1.6;
    m.fog = false;
    this.stars = new THREE.Points(g, m);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1;
    scene.add(this.stars);
  }

  update(state: AtmosphereState, hourAngleRad: number, camera: THREE.Vector3): void {
    const e = state.sun.y;
    // Fog color follows the sky near the horizon: blue haze by day, warm at sunrise/sunset, deep blue at night.
    const day = new THREE.Color(0.52, 0.64, 0.78);
    const dusk = new THREE.Color(0.86, 0.56, 0.42);
    const night = new THREE.Color(0.012, 0.018, 0.04);
    const golden = 1 - THREE.MathUtils.smoothstep(e, 0.0, 0.3);
    const daylight = THREE.MathUtils.smoothstep(e, -0.12, 0.08);
    const c = day
      .clone()
      .lerp(dusk, golden * 0.75)
      .lerp(night, 1 - daylight);
    const grey = (c.r + c.g + c.b) / 3;
    c.lerp(new THREE.Color(grey, grey, grey), state.cloudCover * 0.5);
    const brightness = 0.9 * daylight + 0.04;
    (this.fogColor.value as THREE.Color).copy(c).multiplyScalar(brightness * 1.05);
    this.fogDensity.value = 0.00016 + state.haze * 0.0006 + state.cloudCover * 0.0001;

    // Stars fade in after dusk; dimmer under a bright moon or clouds.
    (this.starOpacity as any).value =
      (1 - THREE.MathUtils.smoothstep(e, -0.2, -0.04)) * (1 - state.cloudCover) * (1 - 0.6 * state.moonIllumination);
    this.stars.position.copy(camera);
    this.stars.rotation.set(-(90 - 27.5) * (Math.PI / 180), hourAngleRad, 0, 'XYZ');

    // Exposure curve (plan 6.7) by sun height: bright noon, open wider through golden hour and twilight, and a
    // readable moonlit night (about a fifth of noon's brightness).
    const curve: [number, number][] = [
      [-0.3, 3.9],
      [-0.12, 2.6],
      [-0.04, 1.7],
      [0.02, 1.05],
      [0.1, 0.62],
      [0.25, 0.4],
      [0.45, 0.33],
    ];
    let exposure = curve[curve.length - 1]![1];
    if (e <= curve[0]![0]) exposure = curve[0]![1];
    for (let k = 0; k < curve.length - 1; k++) {
      const [e0, x0] = curve[k]!;
      const [e1, x1] = curve[k + 1]!;
      if (e >= e0 && e <= e1) exposure = x0 + ((x1 - x0) * (e - e0)) / (e1 - e0);
    }
    this.targetExposure = exposure * (1 + state.cloudCover * 0.35);
  }
}
