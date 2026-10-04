/**
 * Starts the engine and the valley (loaded on demand after the start screen, so the first page is small and quick,
 * plan P9). Creates the renderer, the world, the builder, the catalog thumbnails, the sound, the autosave and dynamic
 * resolution, and hands them back to the app.
 */
import { Engine } from '../engine/Engine';
import { buildTestScene, type TestSceneHandle } from '../engine/testScene';
import { World } from '../engine/world/World';
import { Builder } from '../engine/builder/Builder';
import { ThumbnailRenderer } from '../engine/thumbnails';
import { thumbnailJobs } from '../engine/builder/previews';
import { NatureAudio } from '../audio/NatureAudio';
import { Autosaver, type SaveStore } from '../save/autosave';
import { ResolutionController } from '../perf/resolution';
import { QUALITY, type QualityPreset } from '../state/quality';
import { useUi } from '../state/store';
import type { SaveData } from '../save/saveData';

export { runBenchmark } from '../engine/bench';

export interface BootParams {
  scene: 'valley' | 'test';
  quality: QualityPreset;
  seed: string;
  day?: number;
  hour?: number;
  spot?: string;
  freeze: boolean;
  allFish: boolean;
  bench: string | null;
  exposure?: number;
  autosave: boolean;
}

export interface BootSession {
  seed: string;
  restore?: SaveData;
  sections?: Record<string, Uint8Array>;
}

export interface BootCallbacks {
  onLoading: (state: { label: string; fraction: number } | null) => void;
  onSaved: () => void;
  onDeviceLost: (message: string) => void;
  /** Called once the world exists, before the first smooth frames (the app shows its panels). */
  onWorld: (world: World, builder: Builder) => void;
  isDisposed: () => boolean;
}

export interface Booted {
  engine: Engine;
  world: World | null;
  builder: Builder | null;
  audio: NatureAudio | null;
  autosaver: Autosaver | null;
  testScene: TestSceneHandle | null;
  /** Changes the quality preset (and dynamic resolution's range). */
  setQuality(q: QualityPreset): void;
  dispose(): void;
}

export async function boot(
  canvas: HTMLCanvasElement,
  params: BootParams,
  session: BootSession,
  store: SaveStore,
  cb: BootCallbacks,
): Promise<Booted | null> {
  const cleanups: (() => void)[] = [];
  const engine = await Engine.create(canvas);
  engine.onDeviceLost = cb.onDeviceLost;
  if (cb.isDisposed()) {
    engine.dispose();
    return null;
  }
  let world: World | null = null;
  let builder: Builder | null = null;
  let audio: NatureAudio | null = null;
  let autosaver: Autosaver | null = null;
  let testScene: TestSceneHandle | null = null;
  let timer = 0;
  const resolution = new ResolutionController({
    min: QUALITY[params.quality].minRenderScale,
    max: QUALITY[params.quality].renderScale,
  });
  const dispose = () => {
    window.clearInterval(timer);
    for (const c of cleanups) c();
    testScene?.dispose();
    builder?.dispose();
    world?.dispose();
    engine.dispose();
  };

  if (params.scene === 'test') {
    if (params.exposure) engine.renderer.toneMappingExposure = params.exposure;
    testScene = await buildTestScene(engine, params.quality);
  } else {
    cb.onLoading({ label: 'Waking up', fraction: 0 });
    world = await World.create(engine, {
      seed: session.seed,
      quality: params.quality,
      day: params.day,
      hour: params.hour,
      spot: params.spot,
      restore: session.restore,
      restoreSections: session.sections,
      allFish: params.allFish,
      onProgress: (label, fraction) => cb.onLoading({ label, fraction }),
    });
    if (cb.isDisposed()) {
      dispose();
      return null;
    }
    const w = world;
    if (params.freeze) w.clock.paused = true;
    const prefs = useUi.getState().prefs;
    w.applyPreferences(prefs);
    cleanups.push(useUi.subscribe((s) => w.applyPreferences(s.prefs)));
    builder = new Builder(w);
    const b = builder;
    await b.precompile();
    cleanups.push(engine.onFrame((info) => b.update(info.dt)));
    if (!params.bench) {
      cb.onLoading({ label: 'Painting the catalog', fraction: 0.985 });
      const thumbs = new ThumbnailRenderer(engine);
      await thumbs.renderAll(thumbnailJobs(w), (id, url) => useUi.getState().setThumbnail(id, url));
      thumbs.dispose();
      // The valley's sound starts at your first click (the browser's audio unlock).
      const a = new NatureAudio(w);
      audio = a;
      a.setVolume(prefs.volume, prefs.muted);
      void a.start().then(() => {
        const p = useUi.getState().prefs;
        a.setVolume(p.volume, p.muted);
      });
      cleanups.push(engine.onFrame((info) => a.update(info.dt)));
      cleanups.push(useUi.subscribe((s) => a.setVolume(s.prefs.volume, s.prefs.muted)));
      cleanups.push(() => a.dispose());
      // Dynamic resolution: holds the frame rate in heavy views (not during benchmarks, which measure the preset).
      cleanups.push(
        engine.onLateFrame((info) => {
          const p = useUi.getState().prefs;
          if (!p.dynamicResolution || w.photo.busy || info.dt <= 0) return;
          const ms = engine.stats.gpuMs > 0 ? engine.stats.gpuMs : 1000 / Math.max(1, engine.stats.fps);
          resolution.setTarget(1000 / p.maxFps);
          const scale = resolution.update(ms, info.dt);
          if (scale !== null) engine.setRenderScale(scale);
        }),
      );
    }
    cb.onWorld(w, b);
    cb.onLoading({ label: 'Letting the light settle', fraction: 0.99 });
    engine.start();
    await engine.waitForSmoothFrames();
    cb.onLoading(null);
    if (params.autosave) {
      const saver = new Autosaver(store, () => b.saveBytes());
      autosaver = saver;
      const save = () => void saver.save().then(cb.onSaved);
      timer = window.setInterval(() => {
        if (saver.tick()) setTimeout(cb.onSaved, 500);
      }, 10_000);
      const onHidden = () => {
        if (document.visibilityState === 'hidden') save();
      };
      document.addEventListener('visibilitychange', onHidden);
      window.addEventListener('pagehide', save);
      cleanups.push(() => {
        document.removeEventListener('visibilitychange', onHidden);
        window.removeEventListener('pagehide', save);
      });
    }
  }
  engine.start();
  return {
    engine,
    world,
    builder,
    audio,
    autosaver,
    testScene,
    setQuality(q: QualityPreset) {
      testScene?.setQuality(q);
      world?.setQuality(q);
      resolution.setRange(QUALITY[q].minRenderScale, QUALITY[q].renderScale);
    },
    dispose,
  };
}
