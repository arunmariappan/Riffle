/**
 * A physical camera for photo mode (plan 6.10): focal length and aperture on a full-frame sensor, depth of field, and
 * the sample pattern for accumulation. Each accumulated frame shifts the camera by a fraction of a pixel (smooth
 * edges), moves the eye to a point on the lens aperture while keeping the focus plane fixed (real bokeh), and picks a
 * point on the sun's disk (soft shadows). Pure TypeScript.
 */

/** Full-frame sensor height, mm. */
export const SENSOR_HEIGHT = 24;
/** The sun's angular radius, radians (0.266°). */
export const SUN_RADIUS = (0.266 * Math.PI) / 180;

/** Vertical field of view (degrees) of a lens on a full-frame sensor. */
export function fovFromFocalLength(focalMm: number): number {
  return (2 * Math.atan(SENSOR_HEIGHT / 2 / focalMm) * 180) / Math.PI;
}

export function focalLengthFromFov(fovDeg: number): number {
  return SENSOR_HEIGHT / 2 / Math.tan((fovDeg * Math.PI) / 360);
}

/** Radius of the lens aperture in meters (the entrance pupil): focal length / f-number / 2. */
export function apertureRadius(focalMm: number, fNumber: number): number {
  return focalMm / 1000 / fNumber / 2;
}

/**
 * Near and far limits of acceptable sharpness (m) for a focus distance, with a circle of confusion of 0.03 mm (full
 * frame). `far` is Infinity beyond the hyperfocal distance.
 */
export function depthOfField(focalMm: number, fNumber: number, focus: number): { near: number; far: number } {
  const f = focalMm / 1000;
  const c = 0.00003;
  const hyperfocal = (f * f) / (fNumber * c) + f;
  const near = (focus * (hyperfocal - f)) / (hyperfocal + focus - 2 * f);
  const far = focus >= hyperfocal ? Infinity : (focus * (hyperfocal - f)) / (hyperfocal - focus);
  return { near, far };
}

/** Halton low-discrepancy sequence (well-spread jitter that never clumps). */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

export interface Sample {
  /** Sub-pixel jitter, pixels (−0.5..0.5). */
  px: number;
  py: number;
  /** Point on the unit lens disk. */
  lx: number;
  ly: number;
  /** Point on the unit sun disk. */
  sx: number;
  sy: number;
}

/** A unit-disk point from two numbers in 0..1 (Shirley's concentric mapping: even and undistorted). */
export function concentricDisk(u: number, v: number): [number, number] {
  const a = 2 * u - 1;
  const b = 2 * v - 1;
  if (a === 0 && b === 0) return [0, 0];
  let r: number;
  let phi: number;
  if (a * a > b * b) {
    r = a;
    phi = (Math.PI / 4) * (b / a);
  } else {
    r = b;
    phi = Math.PI / 2 - (Math.PI / 4) * (a / b);
  }
  return [r * Math.cos(phi), r * Math.sin(phi)];
}

/** The first `count` accumulation samples. Sample 0 is the plain view (no shift). */
export function accumulationSamples(count: number): Sample[] {
  const out: Sample[] = [];
  for (let k = 0; k < count; k++) {
    if (k === 0) {
      out.push({ px: 0, py: 0, lx: 0, ly: 0, sx: 0, sy: 0 });
      continue;
    }
    const [lx, ly] = concentricDisk(halton(k, 5), halton(k, 7));
    const [sx, sy] = concentricDisk(halton(k, 11), halton(k, 13));
    out.push({ px: halton(k, 2) - 0.5, py: halton(k, 3) - 0.5, lx, ly, sx, sy });
  }
  return out;
}

/**
 * The thin-lens shift for one sample: move the eye by `eye` (meters, camera right and up) and offset the view by
 * `pixels` (three.js `setViewOffset`, y down) so points on the focus plane land on the same pixel.
 */
export function lensShift(
  lens: { x: number; y: number },
  radius: number,
  focus: number,
  fovDeg: number,
  heightPx: number,
): { eye: [number, number]; pixels: [number, number] } {
  const ex = lens.x * radius;
  const ey = lens.y * radius;
  // Pixels per meter at the focus distance.
  const scale = heightPx / 2 / (Math.tan((fovDeg * Math.PI) / 360) * Math.max(0.05, focus));
  return { eye: [ex, ey], pixels: [-ex * scale, ey * scale] };
}

/**
 * Where a camera-space point (x right, y up, z = distance in front) lands on the image (pixels from the center, y
 * down), seen from an eye shifted by `eye` with the image shifted by `pixels` (a check for `lensShift`).
 */
export function projectShifted(
  point: [number, number, number],
  eye: [number, number],
  pixels: [number, number],
  fovDeg: number,
  heightPx: number,
): [number, number] {
  const f = heightPx / 2 / Math.tan((fovDeg * Math.PI) / 360);
  const x = ((point[0] - eye[0]) / point[2]) * f;
  const y = (-(point[1] - eye[1]) / point[2]) * f;
  // A view offset moves the visible window by +offset, so the picture moves by −offset.
  return [x - pixels[0], y - pixels[1]];
}

/** A direction toward a point on the sun's disk around `dir` (unit), for sample (sx, sy) on the unit disk. */
export function sunDiskDirection(dir: [number, number, number], sx: number, sy: number): [number, number, number] {
  const [x, y, z] = dir;
  // Two axes perpendicular to the sun direction.
  const ax = Math.abs(y) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = cross(ax, dir);
  const len = Math.hypot(ux[0], ux[1], ux[2]) || 1;
  ux = [ux[0] / len, ux[1] / len, ux[2] / len];
  const vx: [number, number, number] = [y * ux[2] - z * ux[1], z * ux[0] - x * ux[2], x * ux[1] - y * ux[0]];
  const r = Math.tan(SUN_RADIUS);
  const d: [number, number, number] = [
    x + (ux[0] * sx + vx[0] * sy) * r,
    y + (ux[1] * sx + vx[1] * sy) * r,
    z + (ux[2] * sx + vx[2] * sy) * r,
  ];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}

function cross(a: number[], b: [number, number, number]): [number, number, number] {
  return [
    (a[1] as number) * b[2] - (a[2] as number) * b[1],
    (a[2] as number) * b[0] - (a[0] as number) * b[2],
    (a[0] as number) * b[1] - (a[1] as number) * b[0],
  ];
}

/** Output sizes for stills and time-lapses. */
export const RESOLUTIONS = {
  screen: null,
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4k': [3840, 2160],
} as const satisfies Record<string, readonly [number, number] | null>;
export type Resolution = keyof typeof RESOLUTIONS;
