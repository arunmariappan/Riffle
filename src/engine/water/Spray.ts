import * as THREE from 'three/webgpu';
import { attribute, uv, vec3, float, smoothstep, length, mx_noise_float, mix } from 'three/tsl';
import { SprayField, WATERFALL_MIST, WATERFALL_SPRAY, SPLASH, type Emitter } from '../../sim/particles/spray';
import { globals } from '../globals';

export interface SprayLook {
  /** Base color in full sun. */
  color: number;
  /** Break the disc up with drifting noise (mist puffs). */
  puffy: boolean;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const VIEW_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Draws a SprayField as soft camera-facing quads (one instanced draw). Lit from the sun and sky uniforms rather than
 * the scene lights, so the spray stays cheap and glows white in sunlight.
 */
export class SprayRenderer {
  readonly mesh: THREE.InstancedMesh;
  readonly field: SprayField;
  private readonly fade: THREE.InstancedBufferAttribute;

  constructor(field: SprayField, look: SprayLook) {
    this.field = field;
    const g = new THREE.PlaneGeometry(1, 1);
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(field.config.capacity * 2), 2);
    this.fade.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aSpray', this.fade);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const a = attribute('aSpray', 'vec2');
    const p = uv().sub(0.5);
    let shape: any = smoothstep(0.5, 0.05, length(p));
    if (look.puffy) {
      const n = mx_noise_float(vec3(p.mul(3.2), a.y.mul(37).add((globals.time as any).mul(0.15))))
        .mul(0.5)
        .add(0.5);
      shape = shape.mul(n.mul(1.2).add(0.2)).clamp(0, 1);
    }
    const c = new THREE.Color(look.color);
    const sun: any = globals.sunLight;
    const lit = sun.mul(0.85).add(0.12);
    m.colorNode = mix(vec3(c.r, c.g, c.b).mul(0.8), vec3(c.r, c.g, c.b), a.y).mul(lit);
    m.opacityNode = shape.mul(a.x).mul(float(1));
    this.mesh = new THREE.InstancedMesh(g, m, field.config.capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 4;
    this.mesh.count = 0;
  }

  /** Writes the live particles (camera-facing) into the instance buffer. */
  update(camera: THREE.Camera): void {
    const f = this.field;
    let n = 0;
    const fade = this.fade.array as Float32Array;
    for (let i = 0; i < f.config.capacity; i++) {
      const alpha = f.opacityAt(i);
      if (alpha <= 0.002) continue;
      const size = f.sizeAt(i);
      // Each particle keeps its own spin about the view axis, so the discs don't line up.
      _r.setFromAxisAngle(VIEW_AXIS, (f.seed[i] as number) * Math.PI * 2);
      _q.copy(camera.quaternion).multiply(_r);
      _m.compose(_p.set(f.x[i] as number, f.y[i] as number, f.z[i] as number), _q, _s.set(size, size, size));
      this.mesh.setMatrixAt(n, _m);
      fade[n * 2] = alpha;
      fade[n * 2 + 1] = f.seed[i] as number;
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.fade.clearUpdateRanges();
    this.fade.addUpdateRange(0, Math.max(1, n) * 2);
    this.fade.needsUpdate = true;
  }
}

/** Where the waterfall is, from the flow system (lip center, downstream tangent, across normal, width, levels). */
export interface WaterfallInfo {
  x: number;
  z: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  halfWidth: number;
  top: number;
  foot: number;
  /** Discharge relative to the default (more water, more spray). */
  strength: number;
}

/** Only run the waterfall effects when the camera is this close (meters). */
const ACTIVE_RANGE = 260;

/**
 * Spray and mist at the waterfall (plan 6.2, closes P11), plus splashes for things dropped in the water (stones from
 * the builder). Spray is thrown up where the falling sheet hits the pool; mist billows off it and drifts downwind.
 */
export class WaterEffects {
  readonly group = new THREE.Group();
  readonly spray: SprayRenderer;
  readonly mist: SprayRenderer;
  readonly splashes: SprayRenderer;
  private readonly sprayField = new SprayField(WATERFALL_SPRAY, 'waterfall-spray');
  private readonly mistField = new SprayField(WATERFALL_MIST, 'waterfall-mist');
  private readonly splashField = new SprayField(SPLASH, 'splash');
  private plunge = new THREE.Vector3();
  private active = false;

  constructor() {
    this.spray = new SprayRenderer(this.sprayField, { color: 0xf4f8f8, puffy: false });
    this.mist = new SprayRenderer(this.mistField, { color: 0xe8eff0, puffy: true });
    this.splashes = new SprayRenderer(this.splashField, { color: 0xf0f6f6, puffy: false });
    this.group.add(this.spray.mesh, this.mist.mesh, this.splashes.mesh);
  }

  /** Places the emitters at the foot of the fall (call after each flow solve). */
  setWaterfall(w: WaterfallInfo): void {
    // The sheet lands about 2.4 m past the lip (see FlowSystem.buildWaterfall).
    const cx = w.x + w.tx * 2.4;
    const cz = w.z + w.tz * 2.4;
    const hw = w.halfWidth * 0.8;
    this.plunge.set(cx, w.foot, cz);
    const across = (k: number): Pick<Emitter, 'ax' | 'ay' | 'az' | 'bx' | 'by' | 'bz'> => ({
      ax: cx - w.nx * hw,
      ay: w.foot + k,
      az: cz - w.nz * hw,
      bx: cx + w.nx * hw,
      by: w.foot + k,
      bz: cz + w.nz * hw,
    });
    const s = Math.sqrt(Math.max(0.1, w.strength));
    this.sprayField.intensity = s;
    this.mistField.intensity = s;
    this.sprayField.emitters = [
      { ...across(0.05), rate: 240, vx: w.tx * 1.4, vy: 2.6, vz: w.tz * 1.4, spread: 1.3 },
      // A little spray off the face of the falling sheet.
      {
        ...across(Math.max(0.5, (w.top - w.foot) * 0.4)),
        rate: 40,
        vx: w.tx * 0.9,
        vy: 0.2,
        vz: w.tz * 0.9,
        spread: 0.5,
      },
    ];
    this.mistField.emitters = [{ ...across(0.3), rate: 13, vx: w.tx * 0.7, vy: 0.45, vz: w.tz * 0.7, spread: 0.45 }];
  }

  /** A splash where something hit the water (strength ~ 1 for a boulder). */
  splash(x: number, y: number, z: number, strength = 1): void {
    const count = Math.round(30 + strength * 50);
    this.splashField.burst(
      { ax: x, ay: y, az: z, bx: x, by: y, bz: z, rate: 0, vx: 0, vy: 2.2 + strength * 1.6, vz: 0, spread: 1.1 },
      count,
    );
  }

  update(
    dt: number,
    camera: THREE.Camera,
    wind: (x: number, z: number) => [number, number],
    floor: (x: number, z: number) => number | null,
  ): void {
    const near = camera.position.distanceTo(this.plunge) < ACTIVE_RANGE;
    if (near || this.active) {
      const [wx, wz] = wind(this.plunge.x, this.plunge.z);
      // Freshly entering range: run a couple of seconds so the spray is already there.
      const warm = near && !this.active ? 2.5 : 0;
      for (let t = 0; t < warm; t += 1 / 20) {
        this.sprayField.step(1 / 20, wx, wz, floor);
        this.mistField.step(1 / 20, wx, wz, null);
      }
      if (near) {
        this.sprayField.step(dt, wx, wz, floor);
        this.mistField.step(dt, wx, wz, null);
        this.spray.update(camera);
        this.mist.update(camera);
      } else {
        this.spray.mesh.count = 0;
        this.mist.mesh.count = 0;
      }
      this.active = near;
    }
    const [sx, sz] = wind(camera.position.x, camera.position.z);
    this.splashField.step(dt, sx, sz, floor);
    this.splashes.update(camera);
  }
}
