import * as THREE from 'three/webgpu';

export interface FrameInfo {
  /** Seconds since the previous frame (clamped). */
  dt: number;
  /** Seconds since start. */
  time: number;
  frame: number;
}

export type FrameCallback = (info: FrameInfo) => void;

export interface EngineStats {
  fps: number;
  cpuMs: number;
  gpuMs: number;
  drawCalls: number;
  triangles: number;
}

/**
 * Owns the WebGPU renderer, the frame loop (capped at 60 fps, plan 3) and the render pipeline.
 * Systems register per-frame callbacks; the active camera and pipeline are swappable (Explore / Builder / Photo).
 */
export class Engine {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  pipeline: THREE.RenderPipeline | null = null;
  maxFps = 60;
  paused = false;
  /** Called when the GPU device is lost (plan Phase 9). */
  onDeviceLost: ((message: string) => void) | null = null;

  readonly stats: EngineStats = { fps: 0, cpuMs: 0, gpuMs: 0, drawCalls: 0, triangles: 0 };

  private readonly callbacks = new Set<FrameCallback>();
  private readonly lateCallbacks = new Set<FrameCallback>();
  private lastTime = -1;
  private elapsed = 0;
  private frame = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private timestampPending = false;
  private resizeObserver: ResizeObserver | null = null;
  private renderScale = 1;

  private constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 30000);
  }

  static async create(canvas: HTMLCanvasElement): Promise<Engine> {
    const renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      trackTimestamp: true,
    });
    await renderer.init();
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 0.35;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const engine = new Engine(renderer);
    renderer.onDeviceLost = (info) => {
      engine.onDeviceLost?.(info.message || 'The GPU device was lost.');
    };
    engine.observeResize(canvas);
    return engine;
  }

  get time(): number {
    return this.elapsed;
  }

  /** Fraction of the canvas resolution to render at (dynamic resolution, plan D9). */
  setRenderScale(scale: number): void {
    this.renderScale = Math.min(1, Math.max(0.5, scale));
    this.applySize();
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  onFrame(callback: FrameCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /** Runs after all regular frame callbacks, right before rendering. */
  onLateFrame(callback: FrameCallback): () => void {
    this.lateCallbacks.add(callback);
    return () => this.lateCallbacks.delete(callback);
  }

  start(): void {
    this.renderer.setAnimationLoop((now: number) => this.tick(now));
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
  }

  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.pipeline?.dispose();
    this.renderer.dispose();
  }

  /**
   * Resolves once frames come in smoothly (shader compilation finished), or after maxMs. The loading screen stays
   * up until then, so first-load compilation doesn't show as a frozen valley.
   */
  waitForSmoothFrames(count = 12, maxMs = 60000, frameMs = 70): Promise<void> {
    return new Promise((resolve) => {
      let good = 0;
      let last = performance.now();
      const start = last;
      const off = this.onLateFrame(() => {
        const now = performance.now();
        good = now - last < frameMs ? good + 1 : 0;
        last = now;
        if (good >= count || now - start > maxMs) {
          off();
          resolve();
        }
      });
    });
  }

  /** Renders one frame immediately (used by tests and photo accumulation). */
  renderNow(): void {
    if (this.pipeline) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  }

  private tick(nowMs: number): void {
    const now = nowMs / 1000;
    if (this.lastTime < 0) this.lastTime = now;
    const rawDt = now - this.lastTime;
    // Frame cap: skip frames that arrive early (with a little tolerance for vsync jitter).
    if (this.maxFps > 0 && rawDt < 1 / this.maxFps - 0.002) return;
    this.lastTime = now;
    const dt = Math.min(0.1, Math.max(0, rawDt));
    const cpuStart = performance.now();
    if (!this.paused) this.elapsed += dt;
    const info: FrameInfo = { dt: this.paused ? 0 : dt, time: this.elapsed, frame: this.frame++ };
    for (const cb of this.callbacks) cb(info);
    for (const cb of this.lateCallbacks) cb(info);
    this.renderNow();
    this.stats.cpuMs = performance.now() - cpuStart;
    this.stats.drawCalls = this.renderer.info.render.drawCalls;
    this.stats.triangles = this.renderer.info.render.triangles;

    this.fpsAccum += rawDt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    if (!this.timestampPending && this.frame % 15 === 0) {
      this.timestampPending = true;
      this.renderer
        .resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
        .then((ms) => {
          if (typeof ms === 'number' && ms > 0) this.stats.gpuMs = ms;
        })
        .catch(() => undefined)
        .finally(() => {
          this.timestampPending = false;
        });
    }
  }

  private observeResize(canvas: HTMLCanvasElement): void {
    this.resizeObserver = new ResizeObserver(() => this.applySize());
    this.resizeObserver.observe(canvas);
    this.applySize();
  }

  private applySize(): void {
    const canvas = this.renderer.domElement;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * this.renderScale);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
