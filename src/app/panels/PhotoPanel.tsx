import { useEffect, useState } from 'react';
import { Tabs } from 'radix-ui';
import type { World } from '../../engine/world/World';
import { PHOTO_LIMITS, type PhotoSettings } from '../../photo/settings';
import { SliderRow } from '../ui/SliderRow';
import { useUi } from '../../state/store';
import { depthOfField, type Resolution } from '../../photo/lens';
import { FILTERS, type FilterId } from '../../photo/filters';
import { INTERVALS, planTimelapse, type Keyframe, type Span } from '../../photo/timelapse';
import { captureName } from '../../photo/pixels';
import { MP4_FILE, PNG_FILE, pickWritable, saveToDisk } from '../../save/browserStorage';
import type { StreamTargetChunk } from 'mediabunny';
import styles from '../ui.module.css';

const F_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];
const RESOLUTION_NAMES: [Resolution, string][] = [
  ['screen', 'Screen'],
  ['1080p', '1080p'],
  ['1440p', '1440p'],
  ['4k', '4K'],
];
const SPANS: [Span, string][] = [
  ['day', 'One day'],
  ['season', 'One season'],
  ['year', 'One year'],
];

/** Log-scale slider helpers (focal length and focus distance span two or three decades). */
const toLog = (v: number, lo: number, hi: number) => Math.log(v / lo) / Math.log(hi / lo);
const fromLog = (t: number, lo: number, hi: number) => lo * Math.pow(hi / lo, t);

function meters(m: number): string {
  if (!Number.isFinite(m)) return '∞';
  return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;
}

/** Photo mode's panel (plan 6.10): the lens, exposure and filters, taking a photo, and the time-lapse recorder. */
export function PhotoPanel({ world }: { world: World }) {
  const photo = world.photo;
  const toast = useUi((s) => s.toast);
  const [s, setS] = useState<PhotoSettings>(() => ({ ...photo.settings }));
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [keys, setKeys] = useState<Keyframe[]>([]);
  const [span, setSpan] = useState<Span>('day');
  const [interval, setInterval_] = useState(INTERVALS.day[0]!.seconds);
  const [lapseRes, setLapseRes] = useState<Resolution>('1080p');
  const [lapseSamples, setLapseSamples] = useState(4);

  // The camera changes focus (click) and focal length (wheel) itself.
  useEffect(() => {
    photo.onChange = () => setS({ ...photo.settings });
    return () => {
      photo.onChange = null;
    };
  }, [photo]);

  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => setProgress(photo.progress), 200);
    return () => window.clearInterval(t);
  }, [busy, photo]);

  const change = (patch: Partial<PhotoSettings>) => {
    Object.assign(photo.settings, patch);
    photo.apply();
    setS({ ...photo.settings });
    if (patch.grid !== undefined) useUi.getState().set({ photoGrid: patch.grid });
  };

  const takePhoto = async () => {
    setBusy('Developing the photo');
    try {
      const png = await photo.takePhoto();
      if (png && (await saveToDisk(png, captureName('photo', new Date(), 'png'), PNG_FILE))) toast('Photo saved');
    } catch (err) {
      toast(`Couldn't take the photo: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const addKey = () => {
    if (keys.length >= 5) return;
    setKeys([
      ...keys,
      {
        x: photo.position.x,
        y: photo.position.y,
        z: photo.position.z,
        yaw: photo.yaw,
        pitch: photo.pitch,
        fov: photo.fov,
      },
    ]);
  };

  const record = async () => {
    const path = keys.length
      ? keys
      : [
          {
            x: photo.position.x,
            y: photo.position.y,
            z: photo.position.z,
            yaw: photo.yaw,
            pitch: photo.pitch,
            fov: photo.fov,
          },
        ];
    const name = captureName('timelapse', new Date(), 'mp4');
    const writable = await pickWritable(name, MP4_FILE);
    if (writable === null) return;
    setBusy('Recording the time-lapse');
    try {
      const blob = await photo.recordTimeLapse(
        { span, interval, keyframes: path, resolution: lapseRes, samples: lapseSamples },
        writable === 'unsupported' ? null : (writable as unknown as WritableStream<StreamTargetChunk>),
        () => undefined,
      );
      if (blob) await saveToDisk(blob, name, MP4_FILE);
      toast(photo.isCancelled ? 'Time-lapse stopped' : 'Time-lapse saved');
    } catch (err) {
      toast(`Couldn't record: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const dof = depthOfField(s.focalLength, s.aperture, s.focus);
  const plan = planTimelapse(0, span, interval);
  const stop = F_STOPS.reduce(
    (best, f, i) => (Math.abs(f - s.aperture) < Math.abs((F_STOPS[best] as number) - s.aperture) ? i : best),
    0,
  );

  if (busy)
    return (
      <div className={styles.panel} data-testid="photo-busy">
        <div className={styles.subhead}>{busy}</div>
        <div className={styles.progress}>
          <div className={styles.progressBar} style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className={styles.readout}>{Math.round(progress * 100)}%</div>
        <button className={styles.button} onClick={() => photo.cancel()}>
          Stop
        </button>
      </div>
    );

  return (
    <Tabs.Root className={styles.panel} defaultValue="photo">
      <Tabs.List className={styles.tabs} aria-label="Photo">
        <Tabs.Trigger className={styles.tab} value="photo">
          Photo
        </Tabs.Trigger>
        <Tabs.Trigger className={styles.tab} value="lapse">
          Time-lapse
        </Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content className={styles.tabBody} value="photo">
        <div className={styles.readout}>
          Right-drag to look · WASD, Q/E to move · wheel to zoom · click to focus · H hides this · Esc leaves
        </div>
        <SliderRow
          label="Focal length"
          value={toLog(s.focalLength, ...PHOTO_LIMITS.focalLength)}
          min={0}
          max={1}
          step={0.001}
          format={(t) => `${Math.round(fromLog(t, ...PHOTO_LIMITS.focalLength))} mm`}
          onChange={(t) => change({ focalLength: fromLog(t, ...PHOTO_LIMITS.focalLength) })}
        />
        <SliderRow
          label="Aperture"
          value={stop}
          min={0}
          max={F_STOPS.length - 1}
          step={1}
          format={(i) => `f/${F_STOPS[Math.round(i)]}`}
          onChange={(i) => change({ aperture: F_STOPS[Math.round(i)] as number })}
          testId="slider-aperture"
        />
        <SliderRow
          label="Focus"
          value={toLog(s.focus, ...PHOTO_LIMITS.focus)}
          min={0}
          max={1}
          step={0.001}
          format={(t) => meters(fromLog(t, ...PHOTO_LIMITS.focus))}
          onChange={(t) => change({ focus: fromLog(t, ...PHOTO_LIMITS.focus) })}
          hint="Or click the view to focus there"
        />
        <div className={styles.readout} data-testid="dof">
          Sharp from {meters(dof.near)} to {meters(dof.far)}
        </div>
        <SliderRow
          label="Exposure"
          value={s.exposure}
          min={PHOTO_LIMITS.exposure[0]}
          max={PHOTO_LIMITS.exposure[1]}
          step={0.1}
          format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} EV`}
          onChange={(v) => change({ exposure: v })}
        />
        <select
          className={styles.select}
          value={s.filter}
          onChange={(e) => change({ filter: e.target.value as FilterId })}
          aria-label="Filter"
        >
          {Object.entries(FILTERS).map(([id, f]) => (
            <option key={id} value={id}>
              {f.name}
            </option>
          ))}
        </select>
        <div className={styles.buttonRow}>
          <button className={s.grid ? styles.buttonOn : styles.button} onClick={() => change({ grid: !s.grid })}>
            Grid
          </button>
          <button className={s.pause ? styles.buttonOn : styles.button} onClick={() => change({ pause: !s.pause })}>
            {s.pause ? 'Paused' : 'Running'}
          </button>
        </div>
        <div className={styles.subhead}>Quality</div>
        <div className={styles.buttonRow}>
          {[64, 128, 256].map((n) => (
            <button
              key={n}
              className={s.samples === n ? styles.buttonOn : styles.button}
              onClick={() => change({ samples: n })}
            >
              {n} frames
            </button>
          ))}
        </div>
        <div className={styles.buttonRow}>
          {RESOLUTION_NAMES.map(([r, label]) => (
            <button
              key={r}
              className={s.resolution === r ? styles.buttonOn : styles.button}
              onClick={() => change({ resolution: r })}
            >
              {label}
            </button>
          ))}
        </div>
        <button className={styles.buttonOn} onClick={() => void takePhoto()} data-testid="take-photo">
          Take photo
        </button>
      </Tabs.Content>

      <Tabs.Content className={styles.tabBody} value="lapse">
        <div className={styles.subhead}>Camera</div>
        <div className={styles.readout}>
          {keys.length === 0
            ? 'Fixed: the current view'
            : `A path through ${keys.length} keyframe${keys.length > 1 ? 's' : ''}`}
        </div>
        <div className={styles.buttonRow}>
          <button className={styles.button} onClick={addKey} disabled={keys.length >= 5}>
            Add this view as a keyframe
          </button>
          <button className={styles.button} onClick={() => setKeys([])} disabled={keys.length === 0}>
            Clear
          </button>
        </div>
        <div className={styles.subhead}>Span</div>
        <div className={styles.buttonRow}>
          {SPANS.map(([id, label]) => (
            <button
              key={id}
              className={span === id ? styles.buttonOn : styles.button}
              onClick={() => {
                setSpan(id);
                setInterval_(INTERVALS[id][0]!.seconds);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          className={styles.select}
          value={interval}
          onChange={(e) => setInterval_(Number(e.target.value))}
          aria-label="Frame interval"
        >
          {INTERVALS[span].map((i) => (
            <option key={i.seconds} value={i.seconds}>
              A frame every {i.label}
            </option>
          ))}
        </select>
        <div className={styles.buttonRow}>
          {RESOLUTION_NAMES.filter(([r]) => r !== 'screen').map(([r, label]) => (
            <button key={r} className={lapseRes === r ? styles.buttonOn : styles.button} onClick={() => setLapseRes(r)}>
              {label}
            </button>
          ))}
        </div>
        <div className={styles.buttonRow}>
          {[1, 4, 8].map((n) => (
            <button
              key={n}
              className={lapseSamples === n ? styles.buttonOn : styles.button}
              onClick={() => setLapseSamples(n)}
            >
              {n === 1 ? 'Draft' : `${n}× smooth`}
            </button>
          ))}
        </div>
        <div className={styles.readout}>
          {plan.frameTimes.length} frames · a {plan.videoSeconds.toFixed(1)} s video at 30 fps
        </div>
        <button className={styles.buttonOn} onClick={() => void record()} data-testid="record-timelapse">
          Record
        </button>
      </Tabs.Content>
    </Tabs.Root>
  );
}

/** The rule-of-thirds grid over the view. */
export function ThirdsGrid() {
  return (
    <div className={styles.thirds} aria-hidden>
      <div />
      <div />
      <div />
      <div />
    </div>
  );
}
