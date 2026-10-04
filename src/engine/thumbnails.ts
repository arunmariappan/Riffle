import * as THREE from 'three/webgpu';
import type { Engine } from './Engine';

/**
 * Catalog thumbnails rendered live in the app (closes P13, C19): each item's preview (the real generated geometry and
 * materials) is rendered once into a small offscreen target under a soft studio light, read back, and turned into an
 * image. Results are cached in localStorage by content, so later loads skip the work.
 */

export interface ThumbnailJob {
  id: string;
  /** Changes when the item's content changes (busts the cache). */
  version: string;
  make: () => THREE.Object3D | null;
}

const CACHE_PREFIX = 'riffle-thumb:v1:';

function cacheKey(job: ThumbnailJob): string {
  return `${CACHE_PREFIX}${job.id}:${job.version}`;
}

function readCache(job: ThumbnailJob): string | null {
  try {
    return localStorage.getItem(cacheKey(job));
  } catch {
    return null;
  }
}

function writeCache(job: ThumbnailJob, url: string): void {
  try {
    // Drop older versions of this item first.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(`${CACHE_PREFIX}${job.id}:`)) localStorage.removeItem(k);
    }
    localStorage.setItem(cacheKey(job), url);
  } catch {
    // Storage full or blocked: thumbnails just re-render next time.
  }
}

/** A short hash of an item's content, so edited JSON re-renders its thumbnail. */
export function contentVersion(content: unknown): string {
  const text = JSON.stringify(content);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** AgX-like filmic curve + sRGB encode for one linear channel. */
function encode(v: number, exposure: number): number {
  const x = Math.max(0, v * exposure);
  const mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  const c = Math.min(1, Math.max(0, mapped));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

export class ThumbnailRenderer {
  private readonly engine: Engine;
  private readonly size: number;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.01, 200);
  private readonly target: THREE.RenderTarget;
  private readonly canvas: HTMLCanvasElement;

  constructor(engine: Engine, size = 128) {
    this.engine = engine;
    this.size = size;
    const key = new THREE.DirectionalLight(0xfff4e6, 3.2);
    key.position.set(3, 5, 4);
    const fill = new THREE.HemisphereLight(0xcfe3ff, 0x5a5040, 1.1);
    this.scene.add(key, key.target, fill);
    this.scene.environment = engine.scene.environment;
    this.scene.environmentIntensity = 0.5;
    this.target = new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, samples: 4 });
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
  }

  /**
   * Renders every job that isn't cached, calling `done` with each image URL (cached ones immediately). Yields to the
   * browser between items so the loading screen stays responsive.
   */
  async renderAll(jobs: readonly ThumbnailJob[], done: (id: string, url: string) => void): Promise<void> {
    const todo: ThumbnailJob[] = [];
    for (const job of jobs) {
      const cached = readCache(job);
      if (cached) done(job.id, cached);
      else todo.push(job);
    }
    if (todo.length === 0) return;
    const renderer = this.engine.renderer;
    const prevTone = renderer.toneMapping;
    const prevSpace = renderer.outputColorSpace;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    // Read back linear values and tone-map here, the same way for every item.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    try {
      for (const job of todo) {
        const url = await this.renderOne(job);
        if (url) {
          writeCache(job, url);
          done(job.id, url);
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.toneMapping = prevTone;
      renderer.outputColorSpace = prevSpace;
    }
  }

  private async renderOne(job: ThumbnailJob): Promise<string | null> {
    const object = job.make();
    if (!object) return null;
    const renderer = this.engine.renderer;
    const radius = Math.max(0.05, (object.userData.radius as number | undefined) ?? 1);
    const height = Math.max(0.05, (object.userData.height as number | undefined) ?? radius);
    // Frame the item from a three-quarter view a little above it.
    const centerY = height * 0.5;
    const span = Math.max(radius * 2, height) * 0.62;
    const dist = span / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.set(dist * 0.62, centerY + dist * 0.42, dist * 0.68);
    this.camera.near = Math.max(0.01, dist * 0.05);
    this.camera.far = dist * 6;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(0, centerY, 0);
    this.scene.add(object);
    try {
      await renderer.compileAsync(this.scene, this.camera);
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.scene, this.camera);
      const pixels = (await renderer.readRenderTargetPixelsAsync(
        this.target,
        0,
        0,
        this.size,
        this.size,
      )) as unknown as Uint16Array;
      const image = new ImageData(this.size, this.size);
      const fromHalf = THREE.DataUtils.fromHalfFloat;
      for (let y = 0; y < this.size; y++) {
        // WebGPU reads render targets back top row first, like an image.
        const src = y * this.size;
        for (let x = 0; x < this.size; x++) {
          const i = (src + x) * 4;
          const o = (y * this.size + x) * 4;
          image.data[o] = encode(fromHalf(pixels[i] as number), 1.6);
          image.data[o + 1] = encode(fromHalf(pixels[i + 1] as number), 1.6);
          image.data[o + 2] = encode(fromHalf(pixels[i + 2] as number), 1.6);
          image.data[o + 3] = Math.round(Math.min(1, Math.max(0, fromHalf(pixels[i + 3] as number))) * 255);
        }
      }
      const ctx = this.canvas.getContext('2d');
      if (!ctx) return null;
      ctx.putImageData(image, 0, 0);
      return this.canvas.toDataURL('image/webp', 0.85);
    } catch (err) {
      console.warn(`Thumbnail for ${job.id} failed`, err);
      return null;
    } finally {
      this.scene.remove(object);
    }
  }

  dispose(): void {
    this.target.dispose();
  }
}
