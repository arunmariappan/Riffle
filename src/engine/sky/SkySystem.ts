import * as THREE from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';

export interface SunState {
  /** Unit vector from the ground toward the sun. */
  direction: THREE.Vector3;
  /** Unit vector toward the moon. */
  moonDirection: THREE.Vector3;
  /** 0..1 cloud cover. */
  cloudCover: number;
  /** 0..1 haze (monsoon humidity, mist). */
  haze: number;
}

/**
 * Sky dome, sun and moon lights with cascaded shadows, and image-based lighting from the sky (plan 6.7).
 * The environment map is re-captured when the sun has moved noticeably or the clouds changed.
 */
export class SkySystem {
  readonly sky: SkyMesh;
  readonly sun: THREE.DirectionalLight;
  readonly moon: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly csm: CSMShadowNode;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envScene = new THREE.Scene();
  private readonly envSky: SkyMesh;
  private envTarget: THREE.RenderTarget | null = null;
  private lastEnvSun = new THREE.Vector3(0, -1, 0);
  private lastEnvCloud = -1;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene: THREE.Scene;
  /** Sun illuminance scale (tuned with AgX + exposure). */
  sunStrength = 8;
  /** Scale for image-based light from the sky. */
  skyLightStrength = 0.25;
  hemiStrength = 0.3;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, shadowFar = 260) {
    this.renderer = renderer;
    this.scene = scene;
    this.sky = new SkyMesh();
    this.sky.scale.setScalar(20000);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.envSky = new SkyMesh();
    this.envSky.scale.setScalar(1000);
    this.envSky.showSunDisc.value = 0;
    this.envScene.add(this.envSky);

    this.sun = new THREE.DirectionalLight(0xffffff, this.sunStrength);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 2000;
    this.csm = new CSMShadowNode(this.sun, { cascades: 3, maxFar: shadowFar, mode: 'practical', lightMargin: 120 });
    this.csm.fade = true;
    this.sun.shadow.shadowNode = this.csm as any;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.moon = new THREE.DirectionalLight(0x8aa6ff, 0);
    scene.add(this.moon);
    scene.add(this.moon.target);

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a5a32, 0.25);
    scene.add(this.hemi);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    void camera;
  }

  /** Updates sky, lights and (when needed) the environment map. */
  update(state: SunState, focus: THREE.Vector3): void {
    const sunUp = state.direction.y;
    const sunPos = state.direction.clone().multiplyScalar(10000);
    (this.sky.sunPosition.value as THREE.Vector3).copy(sunPos);
    (this.envSky.sunPosition.value as THREE.Vector3).copy(sunPos);

    // Atmosphere: hazier and warmer near the horizon and in humid weather.
    const haze = state.haze;
    this.sky.turbidity.value = 2.2 + haze * 6;
    this.sky.rayleigh.value = 1.1 + (1 - Math.max(0, sunUp)) * 1.4;
    this.sky.mieCoefficient.value = 0.004 + haze * 0.01;
    this.sky.cloudCoverage.value = 0.18 + state.cloudCover * 0.7;
    this.sky.cloudDensity.value = 0.35 + state.cloudCover * 0.5;
    this.envSky.turbidity.value = this.sky.turbidity.value;
    this.envSky.rayleigh.value = this.sky.rayleigh.value;
    this.envSky.mieCoefficient.value = this.sky.mieCoefficient.value;
    this.envSky.cloudCoverage.value = this.sky.cloudCoverage.value;
    this.envSky.cloudDensity.value = this.sky.cloudDensity.value;

    // Sun light: fades through the horizon, warms at low angles, dims under clouds.
    const daylight = THREE.MathUtils.smoothstep(sunUp, -0.04, 0.12);
    const warm = 1 - THREE.MathUtils.smoothstep(sunUp, 0.02, 0.45);
    this.sun.color.setRGB(1, 1 - warm * 0.28, 1 - warm * 0.55);
    this.sun.intensity = this.sunStrength * daylight * (1 - state.cloudCover * 0.65);
    this.sun.position.copy(focus).add(state.direction.clone().multiplyScalar(400));
    this.sun.target.position.copy(focus);
    // Never toggle castShadow at runtime: it changes the lighting setup and recompiles every material.
    this.sun.castShadow = true;

    // Moon light at night.
    const moonUp = state.moonDirection.y;
    const night = 1 - daylight;
    // Strong enough to clear the tone curve's dark toe: a moonlit night should still read (plan 4).
    this.moon.intensity = night * THREE.MathUtils.smoothstep(moonUp, -0.05, 0.25) * 1.1;
    this.moon.position.copy(focus).add(state.moonDirection.clone().multiplyScalar(400));
    this.moon.target.position.copy(focus);

    // Fill light from the sky: brighter by day, very low at night.
    // Sky fill: blue-grey glow at night and through twilight, warmer by day.
    const twilightGlow = THREE.MathUtils.smoothstep(sunUp, -0.2, -0.02) * (1 - daylight);
    this.hemi.color.setRGB(0.55 + daylight * 0.2, 0.65 + daylight * 0.2, 1);
    this.hemi.intensity = (0.5 * (1 - daylight) + twilightGlow * 0.9 + daylight * 0.15) * this.hemiStrength;

    const moved = this.lastEnvSun.angleTo(state.direction) > THREE.MathUtils.degToRad(0.5);
    const cloudChanged = Math.abs(this.lastEnvCloud - state.cloudCover) > 0.03;
    if (moved || cloudChanged || !this.envTarget) this.captureEnvironment(state.direction, state.cloudCover, daylight);
  }

  private captureEnvironment(direction: THREE.Vector3, cloud: number, daylight: number): void {
    this.lastEnvSun.copy(direction);
    this.lastEnvCloud = cloud;
    // Re-render into the same target: a new environment texture object would make every material recompile.
    const first = this.envTarget === null;
    this.envTarget = this.pmrem.fromScene(
      this.envScene,
      0.02,
      0.1,
      100,
      this.envTarget ? { renderTarget: this.envTarget } : {},
    );
    if (first) this.scene.environment = this.envTarget.texture;
    // Keep reflections and sky light dim at night (the sky model has no stars or moonlit sky).
    // The sky stays bright around sunrise and sunset even as direct sun fades: boost sky light at golden hour.
    const golden = Math.max(0, 1 - Math.abs(direction.y - 0.04) / 0.18);
    this.scene.environmentIntensity = (0.1 + daylight * 0.9) * this.skyLightStrength * (1 + golden * 1.4);
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.pmrem.dispose();
  }
}
