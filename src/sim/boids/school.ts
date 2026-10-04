/**
 * Fish schooling in moving water (plan 6.5). Pure TypeScript, seeded, runs in the fish worker and in Node tests.
 *
 * Each fish has a ground velocity = current + swimming effort. The effort is what it takes to move as it wants
 * (school rules, wander, shelter, depth) against the current, limited by its swim strength. Because the effort points
 * upstream in moving water, fish face upstream and hold station on their own (rheotaxis), and when the current is
 * stronger than they like they drift into the calm water behind stones (shelter).
 */
import { createRng, type Rng } from '../rng';

export interface FlowProbe {
  velocityX: number;
  velocityZ: number;
  depth: number;
  surface: number;
  bed: number;
  shelter: number;
}

export interface FlowSampler {
  sample(x: number, z: number): FlowProbe | null;
  /** A direction (x, z) back toward the middle of the stream from a point near the edge, or null. */
  towardChannel(x: number, z: number): [number, number] | null;
}

export interface SpeciesBehavior {
  id: string;
  /** Body length range, meters. */
  length: [number, number];
  /** Cruise and burst speed relative to the water, m/s. */
  cruise: number;
  burst: number;
  /** Preferred current speed; above it they look for shelter. */
  comfortCurrent: number;
  /** Preferred depth fraction of the water column (0 bottom .. 1 surface). */
  depthPreference: number;
  minDepth: number;
  schooling: { separation: number; alignment: number; cohesion: number; radius: number };
  /** 0 bold .. 1 shy. */
  shyness: number;
}

export const DENISON_BARB: SpeciesBehavior = {
  id: 'denison-barb',
  length: [0.1, 0.15],
  cruise: 0.6,
  burst: 1.6,
  comfortCurrent: 0.45,
  depthPreference: 0.45,
  minDepth: 0.22,
  schooling: { separation: 0.25, alignment: 0.9, cohesion: 0.55, radius: 1.6 },
  shyness: 0.5,
};

export interface Fish {
  species: number;
  x: number;
  y: number;
  z: number;
  /** Ground velocity. */
  vx: number;
  vy: number;
  vz: number;
  /** Heading (unit, where the fish faces = its swimming effort direction). */
  hx: number;
  hz: number;
  length: number;
  /** Swim cycle phase (radians) and current tail-beat rate. */
  phase: number;
  beat: number;
  wanderAngle: number;
  /** Seconds left of a flee burst. */
  fleeing: number;
}

export interface SchoolOptions {
  seed: string;
}

export interface Threat {
  x: number;
  z: number;
  /** Seconds since it last moved quickly (bigger = calmer). */
  calm: number;
}

/** Fixed-step school simulation. */
export class School {
  readonly fish: Fish[] = [];
  readonly species: SpeciesBehavior[];
  private readonly rng: Rng;
  private readonly flow: FlowSampler;
  private readonly cell = 2;
  private readonly grid = new Map<number, number[]>();
  /** A food source fish swim toward (thrown food), or null. */
  food: { x: number; y: number; z: number; until: number } | null = null;
  time = 0;

  constructor(flow: FlowSampler, species: SpeciesBehavior[], options: SchoolOptions) {
    this.flow = flow;
    this.species = species;
    this.rng = createRng(`school:${options.seed}`);
  }

  /** Releases `count` fish of a species around a point (in water). Returns how many were placed. */
  release(speciesIndex: number, x: number, z: number, count: number, spread = 2): number {
    const sp = this.species[speciesIndex] as SpeciesBehavior;
    let placed = 0;
    for (let k = 0; k < count * 6 && placed < count; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = Math.sqrt(this.rng.next()) * spread;
      const fx = x + Math.cos(a) * r;
      const fz = z + Math.sin(a) * r;
      const s = this.flow.sample(fx, fz);
      if (!s || s.depth < sp.minDepth) continue;
      const heading = this.rng.range(0, Math.PI * 2);
      this.fish.push({
        species: speciesIndex,
        x: fx,
        y: s.bed + s.depth * sp.depthPreference,
        z: fz,
        vx: 0,
        vy: 0,
        vz: 0,
        hx: Math.cos(heading),
        hz: Math.sin(heading),
        length: this.rng.range(sp.length[0], sp.length[1]),
        phase: this.rng.range(0, Math.PI * 2),
        beat: 6,
        wanderAngle: this.rng.range(0, Math.PI * 2),
        fleeing: 0,
      });
      placed++;
    }
    return placed;
  }

  private rebuildGrid(): void {
    this.grid.clear();
    this.fish.forEach((f, i) => {
      const key = (Math.floor(f.x / this.cell) * 73856093) ^ (Math.floor(f.z / this.cell) * 19349663);
      const list = this.grid.get(key);
      if (list) list.push(i);
      else this.grid.set(key, [i]);
    });
  }

  private neighbors(f: Fish, radius: number, out: number[]): void {
    out.length = 0;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(f.x / this.cell);
    const cz = Math.floor(f.z / this.cell);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const list = this.grid.get(((cx + dx) * 73856093) ^ ((cz + dz) * 19349663));
        if (list) for (const i of list) out.push(i);
      }
    }
  }

  /** Advances the school by dt seconds (call at a fixed rate, e.g. 30 Hz). */
  step(dt: number, threat: Threat | null = null): void {
    this.time += dt;
    this.rebuildGrid();
    const near: number[] = [];
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i] as Fish;
      const sp = this.species[f.species] as SpeciesBehavior;
      const water = this.flow.sample(f.x, f.z);
      const cvx = water?.velocityX ?? 0;
      const cvz = water?.velocityZ ?? 0;
      const current = Math.hypot(cvx, cvz);

      // Desired ground velocity from the school rules.
      let dx = 0;
      let dz = 0;
      let sepX = 0;
      let sepZ = 0;
      let aliX = 0;
      let aliZ = 0;
      let cohX = 0;
      let cohZ = 0;
      let n = 0;
      this.neighbors(f, sp.schooling.radius, near);
      for (const j of near) {
        if (j === i) continue;
        const o = this.fish[j] as Fish;
        if (o.species !== f.species) continue;
        const ox = o.x - f.x;
        const oz = o.z - f.z;
        const d2 = ox * ox + oz * oz;
        if (d2 > sp.schooling.radius * sp.schooling.radius || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        if (d < sp.schooling.separation) {
          sepX -= (ox / d) * (sp.schooling.separation - d);
          sepZ -= (oz / d) * (sp.schooling.separation - d);
        }
        // Align with where neighbours actually travel (not where they face: in a current they face upstream).
        aliX += o.vx;
        aliZ += o.vz;
        cohX += ox;
        cohZ += oz;
        n++;
      }
      if (n > 0) {
        dx += sepX * 6 + (aliX / n) * sp.schooling.alignment * 0.5 + (cohX / n) * sp.schooling.cohesion * 0.6;
        dz += sepZ * 6 + (aliZ / n) * sp.schooling.alignment * 0.5 + (cohZ / n) * sp.schooling.cohesion * 0.6;
      }
      // Wander.
      f.wanderAngle += this.rng.range(-1, 1) * dt * 1.4;
      dx += Math.cos(f.wanderAngle) * 0.12;
      dz += Math.sin(f.wanderAngle) * 0.12;

      // Feeding beats comfort: shelter-seeking pauses while food is close.
      const feeding =
        this.food !== null && this.time < this.food.until && Math.hypot(this.food.x - f.x, this.food.z - f.z) < 14;
      // Shelter: in strong current, move toward the calmest nearby water (behind stones, at the edges).
      if (water && current > sp.comfortCurrent && !feeding) {
        let best = current - water.shelter * 0.3;
        let bx = 0;
        let bz = 0;
        for (let k = 0; k < 12; k++) {
          const a = (k / 6) * Math.PI * 2 + this.time * 0.37;
          const reach = k < 6 ? 1.0 : 2.2;
          const px = f.x + Math.cos(a) * reach;
          const pz = f.z + Math.sin(a) * reach;
          const ps = this.flow.sample(px, pz);
          if (!ps || ps.depth < sp.minDepth) continue;
          const score = Math.hypot(ps.velocityX, ps.velocityZ) - ps.shelter * 0.6;
          if (score < best) {
            best = score;
            bx = Math.cos(a);
            bz = Math.sin(a);
          }
        }
        const urge = Math.min(1, (current - sp.comfortCurrent) * 2);
        dx += bx * urge * 1.1;
        dz += bz * urge * 1.1;
      }

      // Stay in water deep enough to swim.
      if (!water || water.depth < sp.minDepth * 1.3) {
        const back = this.flow.towardChannel(f.x, f.z);
        if (back) {
          dx += back[0] * 1.2;
          dz += back[1] * 1.2;
        }
      }

      // Food: gather at thrown food while it lasts.
      if (this.food && this.time < this.food.until) {
        const ox = this.food.x - f.x;
        const oz = this.food.z - f.z;
        const d = Math.hypot(ox, oz);
        if (d < 14 && d > 0.05) {
          dx += (ox / d) * Math.min(1, d) * 2;
          dz += (oz / d) * Math.min(1, d) * 2;
        }
      }

      // Flee from sudden movement nearby (shy fish flee sooner and come back later).
      if (threat) {
        const ox = f.x - threat.x;
        const oz = f.z - threat.z;
        const d = Math.hypot(ox, oz);
        const scareRadius = 2 + sp.shyness * 4;
        if (d < scareRadius && threat.calm < 0.5 + sp.shyness * 2) f.fleeing = 1.2 + sp.shyness;
        if (f.fleeing > 0 && d > 0.01) {
          dx += (ox / d) * 2;
          dz += (oz / d) * 2;
        }
      }
      f.fleeing = Math.max(0, f.fleeing - dt);

      // Desired ground speed limit.
      const desired = Math.hypot(dx, dz);
      const maxGround = f.fleeing > 0 ? sp.burst : sp.cruise;
      if (desired > maxGround) {
        dx = (dx / desired) * maxGround;
        dz = (dz / desired) * maxGround;
      }
      // Swimming effort = desired ground velocity − current, limited by swim strength.
      let ex = dx - cvx;
      let ez = dz - cvz;
      const effort = Math.hypot(ex, ez);
      const strength = f.fleeing > 0 ? sp.burst : sp.burst * 0.8;
      if (effort > strength) {
        ex = (ex / effort) * strength;
        ez = (ez / effort) * strength;
      }
      const gvx = cvx + ex;
      const gvz = cvz + ez;
      // Smooth acceleration (inertia).
      const blend = Math.min(1, dt * 3);
      f.vx += (gvx - f.vx) * blend;
      f.vz += (gvz - f.vz) * blend;
      const px = f.x;
      const pz = f.z;
      f.x += f.vx * dt;
      f.z += f.vz * dt;
      // Never swim onto dry ground: bounce back off the shallows.
      const landing = this.flow.sample(f.x, f.z);
      if (!landing || landing.depth < 0.06) {
        f.x = px;
        f.z = pz;
        f.vx *= -0.3;
        f.vz *= -0.3;
      }

      // Heading follows the swimming effort (faces upstream in a current), turning smoothly.
      const effortLen = Math.hypot(ex, ez);
      if (effortLen > 0.02) {
        const tx = ex / effortLen;
        const tz = ez / effortLen;
        const turn = Math.min(1, dt * 4);
        f.hx += (tx - f.hx) * turn;
        f.hz += (tz - f.hz) * turn;
        const hl = Math.hypot(f.hx, f.hz) || 1;
        f.hx /= hl;
        f.hz /= hl;
      }

      // Depth: keep to the preferred layer, never above the surface or into the bed.
      const now = this.flow.sample(f.x, f.z) ?? water;
      if (now) {
        const targetY = now.bed + Math.max(0.08, now.depth * sp.depthPreference);
        f.vy += ((targetY - f.y) * 1.5 - f.vy) * Math.min(1, dt * 2);
        f.y += f.vy * dt;
        f.y = Math.min(now.surface - 0.05, Math.max(now.bed + 0.04, f.y));
      }

      // Tail beat: faster with more effort.
      f.beat = 5 + effortLen * 9 + (f.fleeing > 0 ? 8 : 0);
      f.phase += f.beat * dt;
    }
    if (this.food && this.time >= this.food.until) this.food = null;
  }
}
