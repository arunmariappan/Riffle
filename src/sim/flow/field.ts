/**
 * The flow-field solver (plan 6.2): friction-dominated depth-averaged flow on a stream function ψ,
 * weighted by conveyance K = h^(5/3) / n. Water runs fast in the deep channel and slow at the edges, and routes
 * around stones (raised stream bed) and shallows.
 *
 * Grid: cross-sections along the river path (index i, spacing ds) × cells across the stream (index j, spacing dn).
 * Order of work: water level per section → depths → ψ (initial estimate + SOR) → velocities → wakes and foam.
 */
import type { RiverPath } from './path';

export interface Stone {
  id: number;
  x: number;
  z: number;
  /** Footprint radius in meters. */
  radius: number;
  /** Height above the stream bed at its center, in meters. */
  height: number;
}

export interface SideInflow {
  /** Cross-section index where the side brook joins. */
  section: number;
  /** Which bank it joins from. */
  bank: 'left' | 'right';
  /** Added discharge in m³/s. */
  discharge: number;
}

export interface FlowConfig {
  /** Cells across the stream (odd, so there is a center cell). */
  cellsAcross: number;
  /** Cell size across the stream in meters. */
  dn: number;
  /** Manning roughness (0.03–0.05 for gravel and cobble streams). */
  manning: number;
  /** Minimum depth used for conveyance, so emerged stones act as almost-dry islands. */
  minDepth: number;
  /** Depth below which a cell counts as dry. */
  wetDepth: number;
  /** Smallest water-surface slope, so pools hold a level set by the next riffle downstream. */
  minSlope: number;
  /** Section indices where a new reach starts (below a waterfall). */
  reachStarts: readonly number[];
}

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  cellsAcross: 49,
  dn: 0.5,
  manning: 0.04,
  minDepth: 0.02,
  wetDepth: 0.01,
  minSlope: 0.0004,
  reachStarts: [],
};

export interface SolveStats {
  iterations: number;
  residual: number;
  milliseconds: number;
  sectionsSolved: number;
}

const GRAVITY = 9.81;

export class FlowField {
  readonly ns: number;
  readonly nn: number;
  readonly ds: number;
  readonly dn: number;
  readonly path: RiverPath;
  readonly config: FlowConfig;

  /** World position of each cell center (x, z interleaved). */
  readonly cellX: Float32Array;
  readonly cellZ: Float32Array;
  /** Terrain bed without stones. */
  readonly baseBed: Float32Array;
  /** Bed including stones. */
  readonly bed: Float32Array;
  /** Water surface height per cross-section. */
  readonly level: Float32Array;
  /** Discharge carried through each cross-section, including side brooks joined upstream of it. */
  readonly sectionDischarge: Float64Array;
  readonly depth: Float32Array;
  readonly psi: Float64Array;
  /** Velocity along / across the stream (m/s). */
  readonly velAlong: Float32Array;
  readonly velAcross: Float32Array;
  /** World-space velocity (m/s). */
  readonly velX: Float32Array;
  readonly velZ: Float32Array;
  /** 0..1 foam / turbulence. */
  readonly foam: Float32Array;
  /** 0..1 wake shelter strength (calm water behind obstacles). */
  readonly shelter: Float32Array;

  private readonly invK: Float64Array;
  private discharge = 4;
  private speedMultiplier = 1;
  private levelOffset = 0;
  private stones: Stone[] = [];
  private inflows: SideInflow[] = [];
  private readonly reachOf: Int32Array;

  constructor(path: RiverPath, bedHeight: (x: number, z: number) => number, config: Partial<FlowConfig> = {}) {
    this.config = { ...DEFAULT_FLOW_CONFIG, ...config };
    if (this.config.cellsAcross % 2 === 0) throw new Error('cellsAcross must be odd');
    this.path = path;
    this.ns = path.count;
    this.nn = this.config.cellsAcross;
    this.ds = path.spacing;
    this.dn = this.config.dn;
    const cells = this.ns * this.nn;
    this.cellX = new Float32Array(cells);
    this.cellZ = new Float32Array(cells);
    this.baseBed = new Float32Array(cells);
    this.bed = new Float32Array(cells);
    this.level = new Float32Array(this.ns);
    this.sectionDischarge = new Float64Array(this.ns);
    this.depth = new Float32Array(cells);
    this.psi = new Float64Array(cells);
    this.velAlong = new Float32Array(cells);
    this.velAcross = new Float32Array(cells);
    this.velX = new Float32Array(cells);
    this.velZ = new Float32Array(cells);
    this.foam = new Float32Array(cells);
    this.shelter = new Float32Array(cells);
    this.invK = new Float64Array(cells);
    this.reachOf = new Int32Array(this.ns);

    const half = (this.nn - 1) / 2;
    for (let i = 0; i < this.ns; i++) {
      const px = path.points[i * 2] as number;
      const pz = path.points[i * 2 + 1] as number;
      const nx = path.normals[i * 2] as number;
      const nz = path.normals[i * 2 + 1] as number;
      for (let j = 0; j < this.nn; j++) {
        const offset = (j - half) * this.dn;
        const idx = i * this.nn + j;
        const x = px + nx * offset;
        const z = pz + nz * offset;
        this.cellX[idx] = x;
        this.cellZ[idx] = z;
        this.baseBed[idx] = bedHeight(x, z);
      }
    }
    const starts = [...this.config.reachStarts].sort((a, b) => a - b);
    let reach = 0;
    for (let i = 0; i < this.ns; i++) {
      while (reach < starts.length && i >= (starts[reach] as number)) reach++;
      this.reachOf[i] = reach;
    }
    this.applyStones();
  }

  index(i: number, j: number): number {
    return i * this.nn + j;
  }

  getDischarge(): number {
    return this.discharge;
  }

  setDischarge(discharge: number): void {
    this.discharge = Math.max(0.05, discharge);
  }

  /** Multiplies velocities after the solve (the "water speed" slider), without changing the water level. */
  setSpeedMultiplier(multiplier: number): void {
    this.speedMultiplier = Math.max(0, multiplier);
  }

  setLevelOffset(offset: number): void {
    this.levelOffset = offset;
  }

  getStones(): readonly Stone[] {
    return this.stones;
  }

  setStones(stones: readonly Stone[]): void {
    this.stones = stones.map((s) => ({ ...s }));
    this.applyStones();
  }

  setInflows(inflows: readonly SideInflow[]): void {
    this.inflows = inflows.map((f) => ({ ...f }));
  }

  /** Recomputes the bed with stones as domes on top of the terrain. Returns the affected section range. */
  private applyStones(): void {
    this.bed.set(this.baseBed);
    for (const stone of this.stones) this.stampStone(stone);
  }

  private stampStone(stone: Stone): void {
    const range = this.sectionRangeNear(stone.x, stone.z, stone.radius + 1);
    if (!range) return;
    for (let i = range[0]; i <= range[1]; i++) {
      for (let j = 0; j < this.nn; j++) {
        const idx = this.index(i, j);
        const dx = (this.cellX[idx] as number) - stone.x;
        const dz = (this.cellZ[idx] as number) - stone.z;
        const d = Math.hypot(dx, dz) / stone.radius;
        if (d >= 1) continue;
        // The stone sits on the bed under its center; its top is a dome.
        const top = this.baseBedAt(stone.x, stone.z, i) + stone.height * Math.sqrt(1 - d * d);
        if (top > (this.bed[idx] as number)) this.bed[idx] = top;
      }
    }
  }

  private baseBedAt(x: number, z: number, nearSection: number): number {
    let bestIdx = this.index(nearSection, (this.nn - 1) / 2);
    let best = Number.POSITIVE_INFINITY;
    const i0 = Math.max(0, nearSection - 3);
    const i1 = Math.min(this.ns - 1, nearSection + 3);
    for (let i = i0; i <= i1; i++) {
      for (let j = 0; j < this.nn; j++) {
        const idx = this.index(i, j);
        const d = ((this.cellX[idx] as number) - x) ** 2 + ((this.cellZ[idx] as number) - z) ** 2;
        if (d < best) {
          best = d;
          bestIdx = idx;
        }
      }
    }
    return this.baseBed[bestIdx] as number;
  }

  /** Section index range whose cross-lines pass within `radius` of a point, or null if none do. */
  sectionRangeNear(x: number, z: number, radius: number): [number, number] | null {
    let lo = -1;
    let hi = -1;
    const halfWidth = ((this.nn - 1) / 2) * this.dn;
    for (let i = 0; i < this.ns; i++) {
      const px = this.path.points[i * 2] as number;
      const pz = this.path.points[i * 2 + 1] as number;
      const dx = x - px;
      const dz = z - pz;
      const along = dx * (this.path.tangents[i * 2] as number) + dz * (this.path.tangents[i * 2 + 1] as number);
      const across = dx * (this.path.normals[i * 2] as number) + dz * (this.path.normals[i * 2 + 1] as number);
      if (Math.abs(along) <= radius + this.ds && Math.abs(across) <= halfWidth + radius) {
        if (lo < 0) lo = i;
        hi = i;
      }
    }
    return lo < 0 ? null : [lo, hi];
  }

  /** Full solve: levels, depths, ψ, velocities, wakes, foam. */
  solve(maxIterations = 4000, tolerance = 1e-6): SolveStats {
    return this.solveRange(0, this.ns - 1, maxIterations, tolerance, true);
  }

  /**
   * Re-solves only the sections around an edit (a stone placed or moved), keeping the rest fixed.
   * Levels are recomputed everywhere (cheap); ψ is relaxed only inside the window.
   */
  solveLocal(x: number, z: number, radius: number, maxIterations = 3000, tolerance = 1e-6): SolveStats {
    const range = this.sectionRangeNear(x, z, radius);
    if (!range) return { iterations: 0, residual: 0, milliseconds: 0, sectionsSolved: 0 };
    const margin = Math.ceil(30 / this.ds);
    return this.solveRange(
      Math.max(0, range[0] - margin),
      Math.min(this.ns - 1, range[1] + margin),
      maxIterations,
      tolerance,
      false,
    );
  }

  private solveRange(i0: number, i1: number, maxIterations: number, tolerance: number, fresh: boolean): SolveStats {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.computeDischarge();
    this.computeLevels();
    this.computeDepthAndConveyance();
    if (fresh) {
      this.initialEstimate(0, this.ns - 1);
    } else {
      // Keep the converged solution outside the window; refresh the estimate inside it.
      this.initialEstimate(i0, i1);
    }
    const { iterations, residual } = this.relax(i0, i1, maxIterations, tolerance);
    this.computeVelocities(fresh ? 0 : Math.max(0, i0 - 1), fresh ? this.ns - 1 : Math.min(this.ns - 1, i1 + 1));
    this.computeWakesAndFoam();
    const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { iterations, residual, milliseconds: end - start, sectionsSolved: i1 - i0 + 1 };
  }

  private computeDischarge(): void {
    for (let i = 0; i < this.ns; i++) {
      let q = this.discharge;
      for (const inflow of this.inflows) if (i >= inflow.section) q += inflow.discharge;
      this.sectionDischarge[i] = q;
    }
  }

  /** Thalweg (lowest bed) per section, smoothed, for slopes. */
  private thalweg(): Float64Array {
    const t = new Float64Array(this.ns);
    for (let i = 0; i < this.ns; i++) {
      let min = Number.POSITIVE_INFINITY;
      for (let j = 0; j < this.nn; j++) min = Math.min(min, this.baseBed[this.index(i, j)] as number);
      t[i] = min;
    }
    return t;
  }

  /** Water level per section: Manning normal depth, then backwater from downstream so pools hold their level. */
  private computeLevels(): void {
    const thalweg = this.thalweg();
    const n = this.config.manning;
    const window = Math.max(2, Math.round(10 / this.ds));
    const normal = new Float64Array(this.ns);
    for (let i = 0; i < this.ns; i++) {
      const reach = this.reachOf[i] as number;
      let a = i;
      let b = i;
      for (let k = 1; k <= window; k++) {
        if (i - k >= 0 && this.reachOf[i - k] === reach) a = i - k;
        if (i + k < this.ns && this.reachOf[i + k] === reach) b = i + k;
      }
      const slope =
        b > a
          ? Math.max(this.config.minSlope * 5, ((thalweg[a] as number) - (thalweg[b] as number)) / ((b - a) * this.ds))
          : 0.002;
      const q = this.sectionDischarge[i] as number;
      // Bisection on the level so Σ (1/n) h^(5/3) √S dn = Q.
      let lo = thalweg[i] as number;
      let hi = lo + 12;
      for (let it = 0; it < 48; it++) {
        const mid = 0.5 * (lo + hi);
        let carried = 0;
        for (let j = 0; j < this.nn; j++) {
          const h = mid - (this.bed[this.index(i, j)] as number);
          if (h > 0) carried += (Math.pow(h, 5 / 3) / n) * Math.sqrt(slope) * this.dn;
        }
        if (carried < q) lo = mid;
        else hi = mid;
      }
      normal[i] = 0.5 * (lo + hi);
    }
    // Backwater: walking upstream, the surface can't drop below the next section's level plus a tiny slope.
    for (let i = this.ns - 1; i >= 0; i--) {
      let level = normal[i] as number;
      const next = i + 1;
      if (next < this.ns && this.reachOf[next] === this.reachOf[i]) {
        level = Math.max(level, (this.level[next] as number) + this.config.minSlope * this.ds);
      }
      this.level[i] = level;
    }
    // Light smoothing inside each reach.
    const smoothed = new Float32Array(this.level);
    for (let i = 1; i < this.ns - 1; i++) {
      if (this.reachOf[i - 1] === this.reachOf[i] && this.reachOf[i + 1] === this.reachOf[i]) {
        smoothed[i] =
          0.25 * (this.level[i - 1] as number) + 0.5 * (this.level[i] as number) + 0.25 * (this.level[i + 1] as number);
      }
    }
    for (let i = 0; i < this.ns; i++) this.level[i] = (smoothed[i] as number) + this.levelOffset;
  }

  private computeDepthAndConveyance(): void {
    const n = this.config.manning;
    for (let i = 0; i < this.ns; i++) {
      const level = this.level[i] as number;
      for (let j = 0; j < this.nn; j++) {
        const idx = this.index(i, j);
        const h = Math.max(0, level - (this.bed[idx] as number));
        this.depth[idx] = h;
        const hk = Math.max(h, this.config.minDepth);
        this.invK[idx] = n / Math.pow(hk, 5 / 3);
      }
    }
  }

  /** Per-section estimate: ψ = Q × cumulative conveyance share across the section (exact for uniform channels). */
  private initialEstimate(i0: number, i1: number): void {
    for (let i = i0; i <= i1; i++) {
      let total = 0;
      for (let j = 0; j < this.nn; j++) total += 1 / (this.invK[this.index(i, j)] as number);
      const q = this.sectionDischarge[i] as number;
      let running = 0;
      for (let j = 0; j < this.nn; j++) {
        const k = 1 / (this.invK[this.index(i, j)] as number);
        // Cell-centered: half of this cell's conveyance lies left of its center.
        this.psi[this.index(i, j)] = (q * (running + 0.5 * k)) / total;
        running += k;
      }
      // Banks are exact boundary values.
      this.psi[this.index(i, 0)] = 0;
      this.psi[this.index(i, this.nn - 1)] = q;
    }
  }

  /** Red-black SOR on ∇·(1/K ∇ψ) = 0. Banks and the first/last section of each reach are fixed. */
  private relax(
    i0: number,
    i1: number,
    maxIterations: number,
    tolerance: number,
  ): { iterations: number; residual: number } {
    const nn = this.nn;
    const cs = 1 / (this.ds * this.ds);
    const cn = 1 / (this.dn * this.dn);
    const omega = 1.85;
    const psi = this.psi;
    const invK = this.invK;
    const fixedSection = (i: number): boolean =>
      i === 0 ||
      i === this.ns - 1 ||
      this.reachOf[i - 1] !== this.reachOf[i] ||
      this.reachOf[i + 1] !== this.reachOf[i];
    let residual = 0;
    let iterations = 0;
    for (let iter = 0; iter < maxIterations; iter++) {
      residual = 0;
      for (let color = 0; color < 2; color++) {
        for (let i = Math.max(1, i0); i <= Math.min(this.ns - 2, i1); i++) {
          if (fixedSection(i)) continue;
          const q = this.sectionDischarge[i] as number;
          const jStart = 1 + ((i + 1 + color) & 1);
          for (let j = jStart; j < nn - 1; j += 2) {
            const c = i * nn + j;
            const kc = invK[c] as number;
            const aE = cs * 0.5 * (kc + (invK[c + nn] as number));
            const aW = cs * 0.5 * (kc + (invK[c - nn] as number));
            const aN = cn * 0.5 * (kc + (invK[c + 1] as number));
            const aS = cn * 0.5 * (kc + (invK[c - 1] as number));
            const target =
              (aE * (psi[c + nn] as number) +
                aW * (psi[c - nn] as number) +
                aN * (psi[c + 1] as number) +
                aS * (psi[c - 1] as number)) /
              (aE + aW + aN + aS);
            const delta = target - (psi[c] as number);
            psi[c] = (psi[c] as number) + omega * delta;
            const rel = Math.abs(delta) / q;
            if (rel > residual) residual = rel;
          }
        }
      }
      iterations = iter + 1;
      if (residual < tolerance) break;
    }
    return { iterations, residual };
  }

  private computeVelocities(i0: number, i1: number): void {
    const nn = this.nn;
    for (let i = i0; i <= i1; i++) {
      const tx = this.path.tangents[i * 2] as number;
      const tz = this.path.tangents[i * 2 + 1] as number;
      const nx = this.path.normals[i * 2] as number;
      const nz = this.path.normals[i * 2 + 1] as number;
      const sameReachPrev = i > 0 && this.reachOf[i - 1] === this.reachOf[i];
      const sameReachNext = i < this.ns - 1 && this.reachOf[i + 1] === this.reachOf[i];
      for (let j = 0; j < nn; j++) {
        const idx = i * nn + j;
        const h = this.depth[idx] as number;
        if (h < this.config.wetDepth) {
          this.velAlong[idx] = 0;
          this.velAcross[idx] = 0;
          this.velX[idx] = 0;
          this.velZ[idx] = 0;
          continue;
        }
        const jl = Math.max(0, j - 1);
        const jr = Math.min(nn - 1, j + 1);
        const qAlong = ((this.psi[i * nn + jr] as number) - (this.psi[i * nn + jl] as number)) / ((jr - jl) * this.dn);
        const ip = sameReachNext ? i + 1 : i;
        const im = sameReachPrev ? i - 1 : i;
        const qAcross =
          ip > im
            ? -((this.psi[ip * nn + j] as number) - (this.psi[im * nn + j] as number)) / ((ip - im) * this.ds)
            : 0;
        const hEff = Math.max(h, 0.05);
        const ua = (qAlong / hEff) * this.speedMultiplier;
        const un = (qAcross / hEff) * this.speedMultiplier;
        this.velAlong[idx] = ua;
        this.velAcross[idx] = un;
        this.velX[idx] = ua * tx + un * nx;
        this.velZ[idx] = ua * tz + un * nz;
      }
    }
  }

  /** Wake zones behind stones (calm, turbulent water) and foam from fast shallow water, wakes and waterfalls. */
  private computeWakesAndFoam(): void {
    this.shelter.fill(0);
    const half = (this.nn - 1) / 2;
    const turbulence = new Float32Array(this.ns * this.nn);
    for (const stone of this.stones) {
      const range = this.sectionRangeNear(stone.x, stone.z, stone.radius);
      if (!range) continue;
      const center = Math.round((range[0] + range[1]) / 2);
      const offset =
        (stone.x - (this.path.points[center * 2] as number)) * (this.path.normals[center * 2] as number) +
        (stone.z - (this.path.points[center * 2 + 1] as number)) * (this.path.normals[center * 2 + 1] as number);
      const jc = Math.round(offset / this.dn + half);
      if (jc < 0 || jc >= this.nn) continue;
      const localDepth = Math.max(
        0.05,
        (this.level[center] as number) - (this.baseBed[this.index(center, jc)] as number),
      );
      const strength = Math.min(1, stone.height / localDepth);
      if (strength <= 0.05) continue;
      const wakeLength = stone.radius * (3 + 3 * strength);
      const rows = Math.ceil((wakeLength + stone.radius) / this.ds);
      for (let di = 0; di <= rows; di++) {
        const i = center + di;
        if (i >= this.ns || this.reachOf[i] !== this.reachOf[center]) break;
        const behind = di * this.ds - stone.radius;
        if (behind < -stone.radius) continue;
        const along = Math.max(0, behind) / wakeLength;
        const halfWidth = stone.radius * (0.9 + 0.4 * along);
        const cells = Math.ceil(halfWidth / this.dn);
        for (let dj = -cells; dj <= cells; dj++) {
          const j = jc + dj;
          if (j < 0 || j >= this.nn) continue;
          const lateral = (dj * this.dn) / halfWidth;
          if (Math.abs(lateral) >= 1) continue;
          const f = strength * (1 - along) * (1 - lateral * lateral);
          if (f <= 0) continue;
          const idx = this.index(i, j);
          this.shelter[idx] = Math.max(this.shelter[idx] as number, f);
          turbulence[idx] = Math.max(turbulence[idx] as number, f * (behind < stone.radius * 1.5 ? 1 : 0.6));
        }
      }
    }
    for (let idx = 0; idx < this.shelter.length; idx++) {
      const s = this.shelter[idx] as number;
      if (s > 0) {
        const keep = 1 - 0.65 * s;
        this.velAlong[idx] = (this.velAlong[idx] as number) * keep;
        this.velAcross[idx] = (this.velAcross[idx] as number) * keep;
        this.velX[idx] = (this.velX[idx] as number) * keep;
        this.velZ[idx] = (this.velZ[idx] as number) * keep;
      }
    }
    // Waterfall plunge zones: the first 15 m of each reach after the first.
    const plunge = new Float32Array(this.ns);
    for (const startSection of this.config.reachStarts) {
      const rows = Math.round(15 / this.ds);
      for (let k = 0; k < rows && startSection + k < this.ns; k++) {
        plunge[startSection + k] = Math.max(plunge[startSection + k] as number, 1 - k / rows);
      }
    }
    for (let i = 0; i < this.ns; i++) {
      for (let j = 0; j < this.nn; j++) {
        const idx = this.index(i, j);
        const h = this.depth[idx] as number;
        if (h < this.config.wetDepth) {
          this.foam[idx] = 0;
          continue;
        }
        const u = Math.hypot(this.velX[idx] as number, this.velZ[idx] as number);
        const froude = u / Math.sqrt(GRAVITY * Math.max(h, 0.02));
        const riffle = Math.min(1, Math.max(0, (froude - 0.45) * 1.6));
        const edge = h < 0.08 && u > 0.3 ? 0.4 : 0;
        const value = Math.max(riffle, turbulence[idx] as number, plunge[i] as number, edge);
        this.foam[idx] = Math.min(1, value);
      }
    }
  }

  /** Bilinear sample at fractional stream coordinates. Returns null outside the grid. */
  sample(section: number, offset: number): FlowSample | null {
    const half = (this.nn - 1) / 2;
    const fj = offset / this.dn + half;
    if (section < 0 || section > this.ns - 1 || fj < 0 || fj > this.nn - 1) return null;
    const i0 = Math.min(this.ns - 2, Math.floor(section));
    const j0 = Math.min(this.nn - 2, Math.floor(fj));
    const ti = section - i0;
    const tj = fj - j0;
    const read = (arr: Float32Array): number => {
      const a = arr[this.index(i0, j0)] as number;
      const b = arr[this.index(i0 + 1, j0)] as number;
      const c = arr[this.index(i0, j0 + 1)] as number;
      const d = arr[this.index(i0 + 1, j0 + 1)] as number;
      return (a * (1 - ti) + b * ti) * (1 - tj) + (c * (1 - ti) + d * ti) * tj;
    };
    const level = (this.level[i0] as number) * (1 - ti) + (this.level[i0 + 1] as number) * ti;
    return {
      velocityX: read(this.velX),
      velocityZ: read(this.velZ),
      depth: read(this.depth),
      surface: level,
      bed: read(this.bed),
      foam: read(this.foam),
      shelter: read(this.shelter),
    };
  }

  /** Total discharge crossing section i, integrated from velocities (for tests). */
  measuredDischarge(i: number): number {
    let total = 0;
    for (let j = 0; j < this.nn; j++) {
      const idx = this.index(i, j);
      const h = this.depth[idx] as number;
      if (h < this.config.wetDepth) continue;
      total += (this.velAlong[idx] as number) * Math.max(h, 0.05) * this.dn;
    }
    return total / Math.max(1e-9, this.speedMultiplier);
  }
}

export interface FlowSample {
  velocityX: number;
  velocityZ: number;
  depth: number;
  surface: number;
  bed: number;
  foam: number;
  shelter: number;
}
