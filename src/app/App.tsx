import { useCallback, useEffect, useRef, useState } from 'react';
import type { Engine } from '../engine/Engine';
import type { World } from '../engine/world/World';
import type { Builder } from '../engine/builder/Builder';
import type { Booted } from './boot';
import { QUALITY_PRESETS, type QualityPreset } from '../state/quality';
import { loadPreferences } from '../state/preferences';
import { recoveryPlan } from './recovery';
import { StatsOverlay } from './StatsOverlay';
import { LoadingScreen } from './LoadingScreen';
import { DevPanel } from './DevPanel';
import { TopBar } from './shell/TopBar';
import { PlacementHint, Toasts, Legend } from './shell/Overlays';
import { FishCard } from './shell/FishCard';
import { CatalogPanel } from './builder/CatalogPanel';
import { Toolbar } from './builder/Toolbar';
import { ControlPanel } from './panels/ControlPanel';
import { PhotoPanel, ThirdsGrid } from './panels/PhotoPanel';
import { useUi, type AppMode } from '../state/store';
import { decodeSave, type SaveData } from '../save/saveData';
import { Autosaver } from '../save/autosave';
import type { NatureAudio } from '../audio/NatureAudio';
import { createSaveStore, openFromDisk, requestPersistence, saveToDisk } from '../save/browserStorage';
import { unlockAudio } from '../audio/AudioEngine';

declare global {
  interface Window {
    /** Hooks for Playwright tests and the benchmark (dev and test only). */
    __riffle?: {
      ready: boolean;
      engine?: Engine;
      world?: World;
      builder?: Builder;
      autosaver?: Autosaver;
      audio?: NatureAudio;
      error?: string;
      [key: string]: unknown;
    };
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
  /** Show fish in every stretch at once (tests, the fish benchmark). */
  allFish: boolean;
  bench: string | null;
  exposure?: number;
  stats: boolean;
  dev: boolean;
  /** Open the valley file handed over before a reload ("Open valley…"). */
  open: boolean;
  /** Start from the latest autosave. */
  resume: boolean;
  /** Autosave even in test modes. */
  autosave: boolean;
}

export function readParams(): AppParams {
  const p = new URLSearchParams(window.location.search);
  const q = p.get('quality');
  const num = (k: string) => (p.has(k) ? Number(p.get(k)) : undefined);
  const testMode = p.has('test') || p.has('bench') || p.has('freeze');
  return {
    scene: p.get('scene') === 'test' ? 'test' : 'valley',
    quality: QUALITY_PRESETS.includes(q as QualityPreset)
      ? (q as QualityPreset)
      : (loadPreferences().quality ?? 'high'),
    autostart: p.has('autostart') || p.has('test') || p.has('bench') || p.has('open') || p.has('continue'),
    seed: p.get('seed') ?? 'riffle',
    day: num('day'),
    hour: num('hour'),
    spot: p.get('spot') ?? undefined,
    freeze: p.has('freeze') || p.has('test'),
    allFish: p.has('allfish') || p.get('bench') === 'fish',
    bench: p.get('bench'),
    exposure: num('exposure'),
    stats: p.has('stats') || p.has('bench') || import.meta.env.DEV,
    dev: (import.meta.env.DEV || p.has('dev')) && !testMode,
    open: p.has('open'),
    resume: p.has('continue'),
    autosave: p.has('autosave') || !testMode,
  };
}

/** Recent GPU device losses this session (a second one reloads at a lighter preset). */
const LOST_KEY = 'riffle:device-lost';

/** Name of the hand-over file used by "Open valley…" (the page reloads to build the other valley). */
const PENDING = 'open-pending.riffle';

interface Session {
  seed: string;
  restore?: SaveData;
  sections?: Record<string, Uint8Array>;
}

function ago(time: number): string {
  const s = Math.max(0, (Date.now() - time) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function App({ adapterInfo }: { adapterInfo: string }) {
  const params = useRef(readParams()).current;
  const store = useRef(createSaveStore()).current;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [builder, setBuilder] = useState<Builder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<{ label: string; fraction: number } | null>(null);
  const [quality, setQuality] = useState<QualityPreset>(params.quality);
  const [locked, setLocked] = useState(false);
  const [latest, setLatest] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const bootedRef = useRef<Booted | null>(null);
  const [lost, setLost] = useState<string | null>(null);
  const mode = useUi((s) => s.mode);
  const toast = useUi((s) => s.toast);
  const hideUi = useUi((s) => s.hideUi);
  const photoGrid = useUi((s) => s.photoGrid);

  const latestAutosave = useCallback(async () => {
    const saver = new Autosaver(store, async () => new Uint8Array());
    return saver.latest();
  }, [store]);

  // The start screen offers to continue from the latest autosave.
  useEffect(() => {
    void latestAutosave().then((l) => setLatest(l?.entry.time ?? null));
  }, [latestAutosave]);

  const startNew = useCallback(() => {
    void requestPersistence();
    setSession({ seed: params.seed });
  }, [params.seed]);

  const startFrom = useCallback(
    async (bytes: Uint8Array) => {
      try {
        const { data, sections } = await decodeSave(bytes);
        void requestPersistence();
        setSession({ seed: data.seed, restore: data, sections });
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [toast],
  );

  const resume = useCallback(async () => {
    const l = await latestAutosave();
    if (l) await startFrom(l.bytes);
    else startNew();
  }, [latestAutosave, startFrom, startNew]);

  const openFile = useCallback(async () => {
    const file = await openFromDisk();
    if (!file) return;
    if (!world) {
      await startFrom(file.bytes);
      return;
    }
    try {
      await decodeSave(file.bytes);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      return;
    }
    // Build the opened valley from scratch: hand the file to the reloaded page.
    await store.write(PENDING, file.bytes);
    const q = new URLSearchParams({ autostart: '', open: '', quality });
    window.location.search = q.toString();
  }, [world, store, quality, startFrom, toast]);

  useEffect(() => {
    if (!params.autostart || session) return;
    if (params.open) {
      void store.read(PENDING).then(async (bytes) => {
        await store.remove(PENDING);
        if (bytes) await startFrom(bytes);
        else startNew();
      });
    } else if (params.resume) void resume();
    else startNew();
  }, [params, session, store, startFrom, startNew, resume]);

  // A lost GPU device (driver reset, sleep): save the valley (its state is on the CPU) and reload from the autosave.
  const recover = useCallback(
    async (reason: string) => {
      let history: number[];
      try {
        history = JSON.parse(sessionStorage.getItem(LOST_KEY) ?? '[]') as number[];
      } catch {
        history = [];
      }
      const plan = recoveryPlan(Array.isArray(history) ? history : [], Date.now(), params.quality, reason);
      try {
        sessionStorage.setItem(LOST_KEY, JSON.stringify(plan.history));
      } catch {
        // Without session storage every loss counts as the first.
      }
      setLost(plan.message);
      const saver = bootedRef.current?.autosaver;
      if (saver) await Promise.race([saver.save(), new Promise((r) => setTimeout(r, 4000))]).catch(() => undefined);
      setTimeout(() => {
        window.location.search = plan.search;
      }, 1500);
    },
    [params.quality],
  );

  useEffect(() => {
    if (!session || !canvasRef.current) return;
    let disposed = false;
    let booted: Booted | null = null;
    window.__riffle = { ready: false };
    (async () => {
      try {
        // The engine loads only now (code-split behind the start screen).
        const { boot, runBenchmark } = await import('./boot');
        booted = await boot(canvasRef.current as HTMLCanvasElement, params, session, store, {
          onLoading: setLoading,
          onSaved: () => setSavedAt(Date.now()),
          onDeviceLost: (message) => void recover(message),
          onWorld: (w, b) => {
            setWorld(w);
            setBuilder(b);
          },
          isDisposed: () => disposed,
        });
        if (!booted) return;
        bootedRef.current = booted;
        setEngine(booted.engine);
        window.__riffle = {
          ready: true,
          engine: booted.engine,
          world: booted.world ?? undefined,
          builder: booted.builder ?? undefined,
          autosaver: booted.autosaver ?? undefined,
          audio: booted.audio ?? undefined,
        };
        if (params.bench && booted.world) {
          const result = await runBenchmark(booted.engine, booted.world, params.bench);
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
      booted?.dispose();
      bootedRef.current = null;
    };
  }, [session, params, store, recover]);

  // Browsers allow sound only after you interact: the first click or key press anywhere unlocks it.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, []);

  useEffect(() => {
    const onChange = () => setLocked(document.pointerLockElement === canvasRef.current);
    document.addEventListener('pointerlockchange', onChange);
    return () => document.removeEventListener('pointerlockchange', onChange);
  }, []);

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!world) return;
    if (world.mode === 'explore') world.input.lockPointer();
    else if (world.mode === 'photo' && !world.photo.busy) {
      // Click to focus where you point.
      const r = e.currentTarget.getBoundingClientRect();
      world.photo.focusAt(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    }
  };

  const changeQuality = (q: QualityPreset) => {
    setQuality(q);
    bootedRef.current?.setQuality(q);
    useUi.getState().setPrefs({ quality: q });
  };

  const onMode = (m: AppMode) => builder?.setMode(m);

  const saveAs = async () => {
    if (!builder || !world) return;
    try {
      const bytes = await builder.saveBytes();
      const date = new Date().toISOString().slice(0, 10);
      if (await saveToDisk(bytes, `riffle-${world.valley.seed}-${date}.riffle`)) toast('Valley saved');
    } catch (err) {
      toast(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const newValley = () => {
    const seed = window.prompt('Seed for the new valley (the same seed always grows the same valley):', 'riffle');
    if (!seed) return;
    window.location.search = new URLSearchParams({ autostart: '', seed, quality }).toString();
  };

  const ui = !params.bench && !params.freeze;
  return (
    <div className="app">
      <canvas ref={canvasRef} className="viewport" data-testid="viewport" onClick={onCanvasClick} />
      {!session && (
        <div className="start-screen">
          <h1>Riffle</h1>
          <p className="tagline">A living monsoon mountain stream</p>
          <button className="enter" onClick={startNew} autoFocus={latest === null}>
            Enter the valley
          </button>
          {latest !== null && (
            <button className="enter" onClick={() => void resume()} autoFocus>
              Continue where you left off ({ago(latest)})
            </button>
          )}
          <button className="enter secondary" onClick={() => void openFile()}>
            Open a valley file…
          </button>
          <p className="hint">{adapterInfo}</p>
        </div>
      )}
      {loading && <LoadingScreen label={loading.label} fraction={loading.fraction} />}
      {world && mode === 'photo' && photoGrid && ui && <ThirdsGrid />}
      {world && builder && !loading && ui && !(mode === 'photo' && hideUi) && (
        <>
          <TopBar
            onMode={onMode}
            onSave={() => void saveAs()}
            onOpen={() => void openFile()}
            onNew={newValley}
            savedAt={savedAt ? ago(savedAt) : null}
            quality={quality}
            onQuality={changeQuality}
          />
          {mode === 'builder' && (
            <>
              <CatalogPanel builder={builder} />
              <ControlPanel builder={builder} />
              <Toolbar builder={builder} />
              <Legend />
              <PlacementHint />
            </>
          )}
          {mode === 'photo' && <PhotoPanel world={world} />}
          <FishCard builder={builder} />
          <Toasts />
        </>
      )}
      {world && mode === 'explore' && !locked && ui && !loading && (
        <div className="explore-hint">
          Click to look around · WASD to walk · Shift to run · Space to jump · F to throw food · E to look at a fish ·
          Tab to build · Esc to release
        </div>
      )}
      {lost && (
        <div className="device-lost" role="alert" data-testid="device-lost">
          {lost}
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          Something went wrong: {error}
        </div>
      )}
      {engine && params.stats && <StatsOverlay engine={engine} quality={quality} onQuality={changeQuality} />}
      {world && params.dev && <DevPanel world={world} />}
    </div>
  );
}
