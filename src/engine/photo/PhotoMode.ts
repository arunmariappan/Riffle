import * as THREE from 'three/webgpu';
import type { World } from '../world/World';
import type { Input } from '../player/Input';
import { createPipeline, type QualityPreset } from '../post/pipeline';
import { Accumulator } from './Accumulator';
import {
  RESOLUTIONS,
  accumulationSamples,
  apertureRadius,
  fovFromFocalLength,
  lensShift,
  sunDiskDirection,
  type Resolution,
} from '../../photo/lens';
import { FILTERS, exposureFactor, type FilterId } from '../../photo/filters';
import { recordTimeLapse, type TimeLapseOptions, type TimeLapseProgress } from './TimeLapse';
import type { StreamTargetChunk } from 'mediabunny';

export interface PhotoSettings {
  /** Lens focal length, mm (full frame). */
  focalLength: number;
  /** Aperture f-number. */
  aperture: number;
  /** Focus distance, m. */
  focus: number;
  /** Exposure compensation, stops. */
  exposure: number;
  filter: FilterId;
  /** Frames averaged for a still. */
  samples: number;
  resolution: Resolution;
  /** Rule-of-thirds grid. */
  grid: boolean;
  /** Freeze the valley while in photo mode. */
  pause: boolean;
}

export function defaultPhotoSettings(): PhotoSettings {
  return {
    focalLength: 35,
    aperture: 8,
    focus: 10,
    exposure: 0,
    filter: 'natural',
    samples: 64,
    resolution: 'screen',
    grid: false,
    pause: true,
  };
}

export const PHOTO_LIMITS = {
  focalLength: [14, 200],
  aperture: [1.4, 22],
  focus: [0.3, 500],
  exposure: [-3, 3],
} as const;

const UP = new THREE.Vector3(0, 1, 0);

/** Waits for the next animation frame (keeps long captures gentle on the GPU and the page responsive). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Photo mode (plan 6.10): a free camera with collision, a real lens (focal length, aperture, focus distance; click to
 * focus), exposure compensation, filters and a rule-of-thirds grid. Taking a photo pauses the frame loop and
 * accumulates 64–256 frames, each with a sub-pixel shift, a point on the lens aperture (true depth of field and
 * bokeh) and a point on the sun's disk (soft shadows), then saves a PNG up to 4K.
 */
export class PhotoMode {
  settings: PhotoSettings = defaultPhotoSettings();
  readonly position = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  /** True while a still or a time-lapse is being made. */
  busy = false;
  /** 0..1 progress of the current capture. */
  progress = 0;
  /** Called when the camera changes a setting itself (click to focus, wheel zoom), so the panel can follow. */
  onChange: (() => void) | null = null;
  private readonly world: World;
  private saved: { saturation: number; contrast: number; tint: THREE.Color; vignette: number; bloom: number } | null =
    null;
  private wasPaused = false;
  private cancelled = false;

  constructor(world: World) {
    this.world = world;
  }

  /** Enters photo mode from the current view. */
  enter(camera: THREE.PerspectiveCamera): void {
    this.position.copy(camera.position);
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
    const c: any = this.world.post;
    this.saved = {
      saturation: c.saturation.value,
      contrast: c.contrast.value,
      tint: c.tint.value.clone(),
      vignette: c.vignette.value,
      bloom: c.bloomStrength.value,
    };
    this.wasPaused = this.world.clock.paused;
    this.world.input.dragLook = true;
    this.world.input.unlockPointer();
    this.apply();
  }

  exit(): void {
    const c: any = this.world.post;
    if (this.saved) {
      c.saturation.value = this.saved.saturation;
      c.contrast.value = this.saved.contrast;
      c.tint.value.copy(this.saved.tint);
      c.vignette.value = this.saved.vignette;
      c.bloomStrength.value = this.saved.bloom;
      this.saved = null;
    }
    this.world.input.dragLook = false;
    this.world.clock.paused = this.wasPaused;
    this.world.exposureBias = 1;
  }

  /** Applies the settings to the view (filter, exposure, pause). */
  apply(): void {
    const g = FILTERS[this.settings.filter].grade;
    const c: any = this.world.post;
    c.saturation.value = g.saturation;
    c.contrast.value = g.contrast;
    c.tint.value.setRGB(...g.tint);
    c.vignette.value = g.vignette;
    c.bloomStrength.value = g.bloom;
    this.world.exposureBias = exposureFactor(this.settings.exposure);
    // Pausing stops the clock; the world also holds the wind, the water and the fish still (World.update).
    this.world.clock.paused = this.settings.pause || this.wasPaused;
  }

  get fov(): number {
    return fovFromFocalLength(this.settings.focalLength);
  }

  /** The free camera: WASD to move, Q/E down and up, Shift faster, right-drag to look, the wheel zooms. */
  update(dt: number, input: Input, camera: THREE.PerspectiveCamera): void {
    if (this.busy) return;
    const [mx, my] = input.takeMouse();
    const sens = 0.0025 * (this.fov / 60);
    this.yaw -= mx * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - my * sens, -1.5, 1.5);
    const wheel = input.takeWheel();
    if (wheel !== 0) {
      const f = this.settings.focalLength * Math.pow(1.1, -wheel);
      this.settings.focalLength = THREE.MathUtils.clamp(f, PHOTO_LIMITS.focalLength[0], PHOTO_LIMITS.focalLength[1]);
      this.onChange?.();
    }
    const speed = (input.pressed('ShiftLeft', 'ShiftRight') ? 9 : 2.5) * dt;
    const cp = Math.cos(this.pitch);
    const forward = new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (input.pressed('KeyW', 'ArrowUp')) move.add(forward);
    if (input.pressed('KeyS', 'ArrowDown')) move.sub(forward);
    if (input.pressed('KeyD', 'ArrowRight')) move.add(right);
    if (input.pressed('KeyA', 'ArrowLeft')) move.sub(right);
    if (input.pressed('KeyE', 'Space')) move.y += 1;
    if (input.pressed('KeyQ', 'KeyC')) move.y -= 1;
    if (move.lengthSq() > 0) this.position.addScaledVector(move.normalize(), speed);
    this.collide();
    camera.position.copy(this.position);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (Math.abs(camera.fov - this.fov) > 1e-3) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  /** Keeps the camera above the ground and out of the stones (it can go under water). */
  private collide(): void {
    const w = this.world;
    const p = this.position;
    const ground = w.heightAt(p.x, p.z) + 0.2;
    if (p.y < ground) p.y = ground;
    for (const s of w.rocks.stones) {
      const dx = p.x - s.x;
      const dz = p.z - s.z;
      const r = s.radius + 0.15;
      if (dx * dx + dz * dz > r * r * 4) continue;
      const cy = s.y + s.height * 0.5;
      const dy = (p.y - cy) / Math.max(0.2, s.height * 0.5 + 0.15);
      const d = Math.hypot(dx / r, dy, dz / r);
      if (d >= 1 || d < 1e-6) continue;
      // Push out along the ellipsoid's normal.
      p.x = s.x + (dx / d) * 1.001;
      p.z = s.z + (dz / d) * 1.001;
      p.y = cy + (dy / d) * Math.max(0.2, s.height * 0.5 + 0.15) * 1.001;
    }
  }

  /** Click to focus: the distance to whatever is under the pointer. */
  focusAt(ndcX: number, ndcY: number): number | null {
    const cam = this.world.engine.camera;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
    const o = ray.ray.origin;
    const dir = ray.ray.direction;
    const hit = this.world.items.raycast({ ox: o.x, oy: o.y, oz: o.z, dx: dir.x, dy: dir.y, dz: dir.z });
    let d: number | null = null;
    if (hit.point) d = cam.position.distanceTo(new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z));
    if (hit.item) {
      const item = this.world.items.get(hit.item);
      if (item) d = cam.position.distanceTo(new THREE.Vector3(item.x, item.y, item.z));
    }
    if (d === null) return null;
    this.settings.focus = THREE.MathUtils.clamp(d, PHOTO_LIMITS.focus[0], PHOTO_LIMITS.focus[1]);
    this.onChange?.();
    return this.settings.focus;
  }

  cancel(): void {
    this.cancelled = true;
  }

  /** The output size for a resolution choice (the screen's own size, or a fixed 16:9 size). */
  outputSize(resolution: Resolution): [number, number] {
    const fixed = RESOLUTIONS[resolution];
    if (fixed) return [fixed[0], fixed[1]];
    const canvas = this.world.engine.renderer.domElement;
    return [Math.max(1, Math.round(canvas.clientWidth)), Math.max(1, Math.round(canvas.clientHeight))];
  }

  /**
   * Runs `work` with the frame loop stopped, the renderer at `width × height` and a pipeline without TRAA, then puts
   * everything back. Used by stills and time-lapses.
   */
  async withCaptureSetup<T>(
    width: number,
    height: number,
    work: (render: () => void, acc: Accumulator) => Promise<T>,
  ): Promise<T> {
    const w = this.world;
    const engine = w.engine;
    const renderer = engine.renderer;
    const camera = engine.camera;
    const quality: QualityPreset = w.quality === 'low' || w.quality === 'medium' ? 'high' : w.quality;
    const pipeline = createPipeline(renderer, engine.scene, camera, quality, w.post, { temporal: false });
    const previous = engine.pipeline;
    const aspect = camera.aspect;
    this.busy = true;
    this.cancelled = false;
    this.progress = 0;
    engine.stop();
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const acc = new Accumulator(renderer, width, height);
    try {
      return await work(() => pipeline.pipeline.render(), acc);
    } finally {
      acc.dispose();
      pipeline.dispose();
      engine.pipeline = previous;
      camera.clearViewOffset();
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      engine.refreshSize();
      this.busy = false;
      engine.start();
    }
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Accumulates one image from the current view: `count` frames with jitter, lens and sun-disk samples (`lens` false:
   * jitter only, for time-lapse frames). Shows it developing when `show`.
   */
  async accumulate(
    render: () => void,
    acc: Accumulator,
    count: number,
    options: { lens: boolean; show: boolean; onSample?: (k: number) => void },
  ): Promise<void> {
    const w = this.world;
    const camera = w.engine.camera;
    const sun = w.sky.sun;
    const basePos = camera.position.clone();
    const sunTarget = sun.target.position.clone();
    const sunDir = sun.position.clone().sub(sunTarget);
    const sunDist = sunDir.length();
    sunDir.normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = UP.clone().applyQuaternion(camera.quaternion);
    const radius = options.lens ? apertureRadius(this.settings.focalLength, this.settings.aperture) : 0;
    const { width, height } = acc;
    acc.reset();
    const samples = accumulationSamples(count);
    try {
      for (let k = 0; k < samples.length; k++) {
        if (this.cancelled) break;
        const s = samples[k]!;
        const shift = lensShift({ x: s.lx, y: s.ly }, radius, this.settings.focus, camera.fov, height);
        camera.position.copy(basePos).addScaledVector(right, shift.eye[0]).addScaledVector(up, shift.eye[1]);
        camera.updateMatrixWorld();
        camera.setViewOffset(width, height, s.px + shift.pixels[0], s.py + shift.pixels[1], width, height);
        const d = sunDiskDirection([sunDir.x, sunDir.y, sunDir.z], s.sx, s.sy);
        sun.position.set(sunTarget.x + d[0] * sunDist, sunTarget.y + d[1] * sunDist, sunTarget.z + d[2] * sunDist);
        acc.add(render);
        options.onSample?.(k);
        if (options.show && (k % 4 === 3 || k === samples.length - 1)) {
          acc.show();
          await nextFrame();
        }
      }
    } finally {
      camera.position.copy(basePos);
      camera.clearViewOffset();
      camera.updateMatrixWorld();
      sun.position.copy(sunTarget).addScaledVector(sunDir, sunDist);
    }
  }

  /**
   * Records a time-lapse into `writable` (a file), or into memory when it is null (the MP4 is returned as a Blob).
   */
  recordTimeLapse(
    options: TimeLapseOptions,
    writable: WritableStream<StreamTargetChunk> | null,
    onProgress: (p: TimeLapseProgress) => void = () => undefined,
  ): Promise<Blob | null> {
    return recordTimeLapse(this.world, this, options, writable, onProgress);
  }

  /** Takes a photo: accumulates the frames and returns the PNG (null when cancelled). */
  async takePhoto(): Promise<Blob | null> {
    const [width, height] = this.outputSize(this.settings.resolution);
    return this.withCaptureSetup(width, height, async (render, acc) => {
      const count = Math.max(1, Math.round(this.settings.samples));
      await this.accumulate(render, acc, count, {
        lens: true,
        show: true,
        onSample: (k) => (this.progress = (k + 1) / count),
      });
      if (this.cancelled) return null;
      const pixels = await acc.read();
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2D canvas for the PNG');
      ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      return canvas.convertToBlob({ type: 'image/png' });
    });
  }
}
