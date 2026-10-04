import { useCallback, useEffect, useRef, useState } from 'react';
import { Engine } from '../engine/Engine';
import { buildTestScene, type TestSceneHandle } from '../engine/testScene';
import { QUALITY_PRESETS, type QualityPreset } from '../engine/post/pipeline';
import { World } from '../engine/world/World';
import { runBenchmark } from '../engine/bench';
import { StatsOverlay } from './StatsOverlay';
import { LoadingScreen } from './LoadingScreen';

declare global {
  interface Window {
    /** Hooks for Playwright tests and the benchmark (dev and test only). */
    __riffle?: { ready: boolean; engine?: Engine; world?: World; error?: string; [key: string]: unknown };
  }
}

export interface AppParams {
  scene: 'valley' | 'test';
  quality: QualityPreset;
  autostart: boolean;
  seed: string;
  day?: number;
  hour?: number;
  spot?: string;
  freeze: boolean;
  bench: string | null;
  exposure?: number;
  stats: boolean;
}

export function readParams(): AppParams {
  const p = new URLSearchParams(window.location.search);
  const q = p.get('quality');
  const num = (k: string) => (p.has(k) ? Number(p.get(k)) : undefined);
  return {
    scene: p.get('scene') === 'test' ? 'test' : 'valley',
    quality: QUALITY_PRESETS.includes(q as QualityPreset) ? (q as QualityPreset) : 'high',
    autostart: p.has('autostart') || p.has('test') || p.has('bench'),
    seed: p.get('seed') ?? 'riffle',
    day: num('day'),
    hour: num('hour'),
    spot: p.get('spot') ?? undefined,
    freeze: p.has('freeze') || p.has('test'),
    bench: p.get('bench'),
    exposure: num('exposure'),
    stats: p.has('stats') || p.has('bench') || import.meta.env.DEV,
  };
}

export function App({ adapterInfo }: { adapterInfo: string }) {
  const params = useRef(readParams()).current;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [started, setStarted] = useState(false);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<{ label: string; fraction: number } | null>(null);
  const [quality, setQuality] = useState<QualityPreset>(params.quality);
  const [locked, setLocked] = useState(false);
  const sceneRef = useRef<TestSceneHandle | null>(null);

  const start = useCallback(() => setStarted(true), []);

  useEffect(() => {
    if (params.autostart) setStarted(true);
  }, [params.autostart]);

  useEffect(() => {
    if (!started || !canvasRef.current) return;
    let disposed = false;
    let created: Engine | null = null;
    let createdWorld: World | null = null;
    window.__riffle = { ready: false };
    (async () => {
      try {
        created = await Engine.create(canvasRef.current as HTMLCanvasElement);
        if (disposed) return created.dispose();
        if (params.scene === 'test') {
          if (params.exposure) created.renderer.toneMappingExposure = params.exposure;
          sceneRef.current = await buildTestScene(created, params.quality);
        } else {
          setLoading({ label: 'Waking up', fraction: 0 });
          createdWorld = await World.create(created, {
            seed: params.seed,
            quality: params.quality,
            day: params.day,
            hour: params.hour,
            spot: params.spot,
            onProgress: (label, fraction) => setLoading({ label, fraction }),
          });
          if (disposed) return;
          if (params.freeze) createdWorld.clock.paused = true;
          setWorld(createdWorld);
          setLoading({ label: 'Letting the light settle', fraction: 0.99 });
          created.start();
          await created.waitForSmoothFrames();
          setLoading(null);
        }
        created.start();
        setEngine(created);
        window.__riffle = { ready: true, engine: created, world: createdWorld ?? undefined };
        if (params.bench && createdWorld) {
          const result = await runBenchmark(created, createdWorld, params.bench);
          window.__riffle = { ...window.__riffle, bench: result };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(err);
        setError(message);
        setLoading(null);
        window.__riffle = { ready: false, error: message };
      }
    })();
    return () => {
      disposed = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
      createdWorld?.dispose();
      created?.dispose();
    };
  }, [started, params]);

  useEffect(() => {
    const onChange = () => setLocked(document.pointerLockElement === canvasRef.current);
    document.addEventListener('pointerlockchange', onChange);
    return () => document.removeEventListener('pointerlockchange', onChange);
  }, []);

  const onCanvasClick = () => {
    if (world && world.mode === 'explore') world.input.lockPointer();
  };

  const changeQuality = (q: QualityPreset) => {
    setQuality(q);
    sceneRef.current?.setQuality(q);
    world?.setQuality(q);
  };

  return (
    <div className="app">
      <canvas ref={canvasRef} className="viewport" data-testid="viewport" onClick={onCanvasClick} />
      {!started && (
        <div className="start-screen">
          <h1>Riffle</h1>
          <p className="tagline">A living monsoon mountain stream</p>
          <button className="enter" onClick={start} autoFocus>
            Enter the valley
          </button>
          <p className="hint">{adapterInfo}</p>
        </div>
      )}
      {loading && <LoadingScreen label={loading.label} fraction={loading.fraction} />}
      {world && !locked && !params.bench && !params.freeze && (
        <div className="explore-hint">
          Click to look around · WASD to walk · Shift to run · Space to jump · Esc to release
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          Something went wrong: {error}
        </div>
      )}
      {engine && params.stats && <StatsOverlay engine={engine} quality={quality} onQuality={changeQuality} />}
    </div>
  );
}
