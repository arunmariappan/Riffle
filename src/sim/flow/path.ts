/**
 * The stream's center line, resampled at even arc-length spacing. The flow grid's cross-sections sit at these
 * points, which keeps bank boundaries and per-section water levels simple (plan 6.2).
 */

export interface Vec2 {
  x: number;
  z: number;
}

export interface RiverPath {
  /** Number of samples (cross-sections). */
  count: number;
  /** Spacing between samples along the line, in meters. */
  spacing: number;
  /** Total length in meters. */
  length: number;
  /** Interleaved x, z of each sample. */
  points: Float64Array;
  /** Interleaved unit tangent (downstream direction). */
  tangents: Float64Array;
  /** Interleaved unit normal, pointing to the right bank when facing downstream. */
  normals: Float64Array;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Builds a smooth path through the control points (Catmull-Rom) and resamples it every `spacing` meters. */
export function buildRiverPath(controls: readonly Vec2[], spacing: number): RiverPath {
  if (controls.length < 2) throw new Error('A river path needs at least two control points');

  // Densely sample the spline first.
  const dense: Vec2[] = [];
  const steps = 64;
  for (let k = 0; k < controls.length - 1; k++) {
    const p0 = controls[Math.max(0, k - 1)] as Vec2;
    const p1 = controls[k] as Vec2;
    const p2 = controls[k + 1] as Vec2;
    const p3 = controls[Math.min(controls.length - 1, k + 2)] as Vec2;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      dense.push({ x: catmullRom(p0.x, p1.x, p2.x, p3.x, t), z: catmullRom(p0.z, p1.z, p2.z, p3.z, t) });
    }
  }
  dense.push({ ...(controls[controls.length - 1] as Vec2) });

  // Cumulative arc length.
  const cumulative = new Float64Array(dense.length);
  for (let i = 1; i < dense.length; i++) {
    const a = dense[i - 1] as Vec2;
    const b = dense[i] as Vec2;
    cumulative[i] = (cumulative[i - 1] as number) + Math.hypot(b.x - a.x, b.z - a.z);
  }
  const length = cumulative[dense.length - 1] as number;
  const count = Math.max(2, Math.floor(length / spacing) + 1);

  const points = new Float64Array(count * 2);
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const target = Math.min(length, i * spacing);
    while (seg < dense.length - 2 && (cumulative[seg + 1] as number) < target) seg++;
    const a = dense[seg] as Vec2;
    const b = dense[seg + 1] as Vec2;
    const segLength = (cumulative[seg + 1] as number) - (cumulative[seg] as number);
    const t = segLength > 1e-9 ? (target - (cumulative[seg] as number)) / segLength : 0;
    points[i * 2] = a.x + (b.x - a.x) * t;
    points[i * 2 + 1] = a.z + (b.z - a.z) * t;
  }

  const tangents = new Float64Array(count * 2);
  const normals = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    const i0 = Math.max(0, i - 2);
    const i1 = Math.min(count - 1, i + 2);
    let tx = (points[i1 * 2] as number) - (points[i0 * 2] as number);
    let tz = (points[i1 * 2 + 1] as number) - (points[i0 * 2 + 1] as number);
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    tangents[i * 2] = tx;
    tangents[i * 2 + 1] = tz;
    // Right-hand normal when facing downstream in an x-right, z-toward-viewer frame (y up).
    normals[i * 2] = -tz;
    normals[i * 2 + 1] = tx;
  }

  return { count, spacing, length: (count - 1) * spacing, points, tangents, normals };
}

export interface PathLookup {
  /** Origin (min corner) and cell size of the lookup grid, in meters. */
  originX: number;
  originZ: number;
  cell: number;
  width: number;
  height: number;
  /** Nearest cross-section index for each lookup cell, or -1 when far from the stream. */
  nearest: Int32Array;
}

/** Precomputes the nearest cross-section for every cell near the stream, for fast world → (s, n) mapping. */
export function buildPathLookup(
  path: RiverPath,
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
  cell: number,
  radius: number,
): PathLookup {
  const width = Math.ceil((bounds.maxX - bounds.minX) / cell);
  const height = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
  const nearest = new Int32Array(width * height).fill(-1);
  const best = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);
  const r2 = radius * radius;
  for (let i = 0; i < path.count; i++) {
    const px = path.points[i * 2] as number;
    const pz = path.points[i * 2 + 1] as number;
    const cx0 = Math.max(0, Math.floor((px - radius - bounds.minX) / cell));
    const cx1 = Math.min(width - 1, Math.ceil((px + radius - bounds.minX) / cell));
    const cz0 = Math.max(0, Math.floor((pz - radius - bounds.minZ) / cell));
    const cz1 = Math.min(height - 1, Math.ceil((pz + radius - bounds.minZ) / cell));
    for (let cz = cz0; cz <= cz1; cz++) {
      const wz = bounds.minZ + (cz + 0.5) * cell;
      for (let cx = cx0; cx <= cx1; cx++) {
        const wx = bounds.minX + (cx + 0.5) * cell;
        const d2 = (wx - px) * (wx - px) + (wz - pz) * (wz - pz);
        if (d2 > r2) continue;
        const idx = cz * width + cx;
        if (d2 < (best[idx] as number)) {
          best[idx] = d2;
          nearest[idx] = i;
        }
      }
    }
  }
  return { originX: bounds.minX, originZ: bounds.minZ, cell, width, height, nearest };
}

export interface StreamCoords {
  /** Fractional cross-section index. */
  section: number;
  /** Signed distance from the center line in meters, positive toward the right bank. */
  offset: number;
}

/** Maps a world point to stream coordinates, or null when it isn't near the stream. */
export function worldToStream(path: RiverPath, lookup: PathLookup, x: number, z: number): StreamCoords | null {
  const cx = Math.floor((x - lookup.originX) / lookup.cell);
  const cz = Math.floor((z - lookup.originZ) / lookup.cell);
  if (cx < 0 || cz < 0 || cx >= lookup.width || cz >= lookup.height) return null;
  let i = lookup.nearest[cz * lookup.width + cx] as number;
  if (i < 0) return null;
  // Refine: walk to the section whose cross-line passes closest to the point.
  for (let iter = 0; iter < 4; iter++) {
    const along =
      (x - (path.points[i * 2] as number)) * (path.tangents[i * 2] as number) +
      (z - (path.points[i * 2 + 1] as number)) * (path.tangents[i * 2 + 1] as number);
    const step = Math.round(along / path.spacing);
    if (step === 0) break;
    i = Math.min(path.count - 1, Math.max(0, i + step));
  }
  const dx = x - (path.points[i * 2] as number);
  const dz = z - (path.points[i * 2 + 1] as number);
  const along = dx * (path.tangents[i * 2] as number) + dz * (path.tangents[i * 2 + 1] as number);
  const offset = dx * (path.normals[i * 2] as number) + dz * (path.normals[i * 2 + 1] as number);
  const section = Math.min(path.count - 1, Math.max(0, i + along / path.spacing));
  return { section, offset };
}
