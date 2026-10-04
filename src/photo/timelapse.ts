/**
 * Time-lapse planning (plan 6.10): a span (a day, a season, a year) and a frame interval give the exact simulated
 * moment of every frame, so a recording steps the simulation in fixed amounts and stays reproducible. The camera is
 * fixed or follows a smooth path through 2–5 keyframes. Pure TypeScript.
 */

export type Span = 'day' | 'season' | 'year';

const HOUR = 3600;
const DAY = 86400;

/** Interval choices per span (simulated seconds per frame), the first one the default. */
export const INTERVALS: Record<Span, { label: string; seconds: number }[]> = {
  day: [
    { label: '2 minutes', seconds: 2 * 60 },
    { label: '1 minute', seconds: 60 },
    { label: '5 minutes', seconds: 5 * 60 },
  ],
  season: [
    { label: '3 hours', seconds: 3 * HOUR },
    { label: '1 hour', seconds: HOUR },
    { label: '1 day (same hour)', seconds: DAY },
  ],
  year: [
    { label: '1 day (same hour)', seconds: DAY },
    { label: '12 hours', seconds: 12 * HOUR },
    { label: '2 days (same hour)', seconds: 2 * DAY },
  ],
};

export const SPAN_SECONDS: Record<Span, number> = { day: DAY, season: 91 * DAY, year: 365 * DAY };

export interface TimelapsePlan {
  /** Simulated seconds of each frame (frame 0 = the start). */
  frameTimes: number[];
  /** Simulated seconds between frames. */
  interval: number;
  fps: number;
  /** Length of the video, seconds. */
  videoSeconds: number;
}

export function planTimelapse(startSeconds: number, span: Span, interval: number, fps = 30): TimelapsePlan {
  const count = Math.max(2, Math.floor(SPAN_SECONDS[span] / interval) + 1);
  const frameTimes = Array.from({ length: count }, (_, k) => startSeconds + k * interval);
  return { frameTimes, interval, fps, videoSeconds: count / fps };
}

export interface Keyframe {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Vertical field of view, degrees. */
  fov: number;
}

/** Catmull-Rom interpolation of one value through p0..p3 at t (0..1 between p1 and p2). */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Unwraps angles so the path turns the short way between keyframes. */
function unwrap(angles: number[]): number[] {
  const out = [...angles];
  for (let i = 1; i < out.length; i++) {
    let d = (out[i] as number) - (out[i - 1] as number);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    out[i] = (out[i - 1] as number) + d;
  }
  return out;
}

/**
 * The camera at `u` (0..1 over the whole recording) along a smooth path through the keyframes; a single keyframe is a
 * fixed camera. Eased at both ends so the move starts and stops gently.
 */
export function cameraAt(keys: readonly Keyframe[], u: number): Keyframe {
  if (keys.length === 0) throw new Error('A time-lapse needs at least one camera keyframe');
  if (keys.length === 1) return { ...(keys[0] as Keyframe) };
  const e = Math.min(1, Math.max(0, u));
  const eased = e * e * (3 - 2 * e);
  const segs = keys.length - 1;
  const x = eased * segs;
  const i = Math.min(segs - 1, Math.floor(x));
  const t = x - i;
  const yaws = unwrap(keys.map((k) => k.yaw));
  const at = (j: number) => keys[Math.min(keys.length - 1, Math.max(0, j))] as Keyframe;
  const yawAt = (j: number) => yaws[Math.min(keys.length - 1, Math.max(0, j))] as number;
  const v = (f: (k: Keyframe) => number) => catmullRom(f(at(i - 1)), f(at(i)), f(at(i + 1)), f(at(i + 2)), t);
  return {
    x: v((k) => k.x),
    y: v((k) => k.y),
    z: v((k) => k.z),
    yaw: catmullRom(yawAt(i - 1), yawAt(i), yawAt(i + 1), yawAt(i + 2), t),
    pitch: v((k) => k.pitch),
    fov: v((k) => k.fov),
  };
}
