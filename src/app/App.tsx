import { useCallback, useEffect, useRef, useState } from 'react';
import { Engine } from '../engine/Engine';
import { buildTestScene, type TestSceneHandle } from '../engine/testScene';
import { QUALITY_PRESETS, type QualityPreset } from '../engine/post/pipeline';
import { StatsOverlay } from './StatsOverlay';

declare global {
  interface Window {
    /** Hooks for Playwright tests and the benchmark (dev and test only). */
    __riffle?: { ready: boolean; engine?: Engine; error?: string; [key: string]: unknown };
  }
}

function readParams(): { scene: string; quality: QualityPreset; autostart: boolean } {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('quality');
  return {
    scene: params.get('scene') ?? 'test',
    quality: QUALITY_PRESETS.includes(q as QualityPreset) ? (q as QualityPreset) : 'high',
    autostart: params.has('autostart') || params.has('test') || params.has('bench'),
  };
}

export function App({ adapterInfo }: { adapterInfo: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [started, setStarted] = useState(false);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityPreset>(readParams().quality);
  const sceneRef = useRef<TestSceneHandle | null>(null);

  const start = useCallback(() => setStarted(true), []);

  useEffect(() => {
    if (readParams().autostart) setStarted(true);
  }, []);

  useEffect(() => {
    if (!started || !canvasRef.current) return;
    let disposed = false;
    let created: Engine | null = null;
    window.__riffle = { ready: false };
    (async () => {
      try {
        created = await Engine.create(canvasRef.current as HTMLCanvasElement);
        if (disposed) {
          created.dispose();
          return;
        }
        const exposure = Number(new URLSearchParams(window.location.search).get('exposure'));
        if (exposure > 0) created.renderer.toneMappingExposure = exposure;
        sceneRef.current = await buildTestScene(created, readParams().quality);
        created.start();
        setEngine(created);
        window.__riffle = { ready: true, engine: created };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(err);
        setError(message);
        window.__riffle = { ready: false, error: message };
      }
    })();
    return () => {
      disposed = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
      created?.dispose();
    };
  }, [started]);

  const changeQuality = (q: QualityPreset) => {
    setQuality(q);
    sceneRef.current?.setQuality(q);
  };

  return (
    <div className="app">
      <canvas ref={canvasRef} className="viewport" data-testid="viewport" />
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
      {error && (
        <div className="error-banner" role="alert">
          Something went wrong: {error}
        </div>
      )}
      {engine && <StatsOverlay engine={engine} quality={quality} onQuality={changeQuality} />}
    </div>
  );
}
