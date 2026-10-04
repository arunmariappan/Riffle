/**
 * Fish in moving water (plan 6.5). Pure TypeScript, seeded, runs in the fish worker and in Node tests.
 *
 * Each fish has a ground velocity = current + swimming effort. The effort is what it takes to move as it wants
 * (school rules, wander, habitat, shelter, food) against the current, limited by its swim strength. Because the
 * effort points upstream in moving water, fish face upstream and hold station on their own (rheotaxis), and when the
 * current is stronger than they like they drift into the calm water behind stones (shelter).
 *
 * On top of that (Phase 5): every fish has genes (size, swim strength, preferred flow, brightness, shyness); each
 * species seeks water of its depth, current and temperature; hillstream loaches cling to the bed in fast water and dart
 * between rocks; fish rise to drifting insects at dawn and dusk, gather at thrown food, come closer when you stand
 * still, flee sudden movement, and rest near the bottom at night; koi glide between tail strokes.
 */
import { createRng, type Rng } from '../rng';
import { waterTemperature } from '../ecology/temperature';

export interface FlowProbe {
  velocityX: number;
  velocityZ: number;
  depth: number;
  surface: number;
  bed: number;
  shelter: number;
  /** In the still backwater pond. */
  pond?: boolean;
}

export interface FlowSampler {
  sample(x: number, z: number): FlowProbe | null;
  /** A direction (x, z) back toward the middle of the stream from a point near the edge, or null. */
  towardChannel(x: number, z: number): [number, number] | null;
}

/** A heritable trait's mean and spread in a population (plan D20). */
export interface GeneDistribution {
  mean: number;
  sd: number;
}

/** A fish's five traits (plan 6.6), each 0..1. */
export interface FishGenes {
  bodySize: number;
  swimStrength: number;
  preferredFlow: number;
  brightness: number;
  shyness: number;
}

export const GENE_NAMES: readonly (keyof FishGenes)[] = [
  'bodySize',
  'swimStrength',
  'preferredFlow',
  'brightness',
  'shyness',
];

export interface SpeciesBehavior {
  id: string;
  /** Adult body length range, meters. */
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
  /** 0 bold .. 1 shy (the species' starting average; each fish has its own gene). */
  shyness: number;
  /** How strongly it faces upstream and holds station, 0..1. */
  rheotaxis?: number;
  /** Clings to rocks on the bed in fast water (hillstream loach). */
  clings?: boolean;
  /** Glides between tail strokes (koi). */
  glides?: boolean;
  /** Comes closer when you stand still, 0..1. */
  curiosity?: number;
  /** The water it lives in: depth (m), current (m/s), temperature (°C). */
  habitat?: { depth: [number, number]; flow: [number, number]; temperature: [number, number] };
  /** Lives only in the pond (koi). */
  pondOnly?: boolean;
  /** Rises to drifting insects. */
  eatsInsects?: boolean;
  /** How far away thrown food draws it, meters. */
  foodRange?: number;
  /** Starting gene distributions. */
  genes?: Partial<Record<keyof FishGenes, GeneDistribution>>;
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
  /** Stable id (inspect and follow). */
  id: number;
  species: number;
  /** The school it was released with (the builder removes a school on undo). */
  school: number;
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
  genes: FishGenes;
  /** Years. */
  age: number;
  /** 0..1, picks the koi patches and other per-fish pattern details. */
  pattern: number;
  /** Seconds left rising to an insect at the surface; `rose` marks the moment it takes it (one step). */
  rising: number;
  rose: boolean;
  /** Holding on to the bed (loaches). */
  clinging: boolean;
  /** Seconds left of a dart between rocks (loaches). */
  dart: number;
  dartX: number;
  dartZ: number;
  /** Where its habitat search last pointed (unit), and how long until it looks again. */
  goalX: number;
  goalZ: number;
  goalWeight: number;
  lookTimer: number;
  /** Koi: seconds into the glide/stroke cycle. */
  glideClock: number;
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

/** What the fish can tell about the time: daylight, insect activity, the date for water temperature. */
export interface FishEnvironment {
  dayOfYear: number;
  hour: number;
  /** 0 night .. 1 full day. */
  daylight: number;
  /** 0..1 drifting insects (peaks at dawn and dusk, more in the warm seasons). */
  insects: number;
}

/** Daylight and insect activity for a time (dawn and dusk rises, plan 6.5). */
export function fishEnvironment(dayOfYear: number, hour: number): FishEnvironment {
  const daylight = Math.min(1, Math.max(0, (Math.min(hour - 5.5, 19 - hour) + 0.5) / 1.5));
  const dawn = Math.exp(-(((hour - 6.8) / 1.2) ** 2));
  const dusk = Math.exp(-(((hour - 18.2) / 1.2) ** 2));
  const warm = 0.35 + 0.65 * Math.max(0, Math.sin(((dayOfYear - 60) / 365) * Math.PI * 2 * 0.5 + 0.2));
  return { dayOfYear, hour, daylight, insects: Math.min(1, (dawn + dusk) * warm + 0.08 * daylight) };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Soft membership of a value in a range: 1 inside, falling to 0 over `soft` beyond each end. */
function fit(v: number, lo: number, hi: number, soft: number): number {
  if (v < lo) return clamp01(1 - (lo - v) / soft);
  if (v > hi) return clamp01(1 - (v - hi) / soft);
  return 1;
}

/** Fixed-step school simulation. */
export class School {
  readonly fish: Fish[] = [];
  readonly species: SpeciesBehavior[];
  private readonly rng: Rng;
  private readonly flow: FlowSampler;
  private readonly cell = 2;
  private readonly grid = new Map<number, number[]>();
  private nextId = 1;
  /** A food source fish swim toward (thrown food), or null. */
  food: { x: number; y: number; z: number; until: number } | null = null;
  /** Time of day and season (the main thread updates it). */
  env: FishEnvironment = fishEnvironment(95, 11);
  time = 0;

  constructor(flow: FlowSampler, species: SpeciesBehavior[], options: SchoolOptions) {
    this.flow = flow;
    this.species = species;
    this.rng = createRng(`school:${options.seed}`);
  }

  /** Draws a fish's genes from its species' starting distributions. */
  drawGenes(sp: SpeciesBehavior): FishGenes {
    const g = (k: keyof FishGenes, fallback: number): number => {
      const d = sp.genes?.[k];
      return clamp01((d?.mean ?? fallback) + this.rng.normal() * (d?.sd ?? 0.1));
    };
    return {
      bodySize: g('bodySize', 0.5),
      swimStrength: g('swimStrength', 0.5),
      preferredFlow: g('preferredFlow', 0.5),
      brightness: g('brightness', 0.6),
      shyness: g('shyness', sp.shyness),
    };
  }

  /**
   * Releases `count` fish of a species around a point (in water). Returns how many were placed. `genes` gives each
   * new fish its traits (cohorts from the ecology); by default they come from the species' distributions.
   */
  release(
    speciesIndex: number,
    x: number,
    z: number,
    count: number,
    spread = 2,
    school = 0,
    genes?: (k: number) => { genes: FishGenes; age?: number },
  ): number {
    const sp = this.species[speciesIndex] as SpeciesBehavior;
    let placed = 0;
    for (let k = 0; k < count * 6 && placed < count; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = Math.sqrt(this.rng.next()) * spread;
      const fx = x + Math.cos(a) * r;
      const fz = z + Math.sin(a) * r;
      const s = this.flow.sample(fx, fz);
      if (!s || s.depth < sp.minDepth) continue;
      if (sp.pondOnly && !s.pond) continue;
      const heading = this.rng.range(0, Math.PI * 2);
      const given = genes?.(placed);
      const g = given?.genes ?? this.drawGenes(sp);
      this.fish.push({
        id: this.nextId++,
        species: speciesIndex,
        school,
        x: fx,
        y: s.bed + s.depth * sp.depthPreference,
        z: fz,
        vx: 0,
        vy: 0,
        vz: 0,
        hx: Math.cos(heading),
        hz: Math.sin(heading),
        length: sp.length[0] + (sp.length[1] - sp.length[0]) * g.bodySize,
        phase: this.rng.range(0, Math.PI * 2),
        beat: 6,
        wanderAngle: this.rng.range(0, Math.PI * 2),
        fleeing: 0,
        genes: g,
        age: given?.age ?? this.rng.range(1, 3),
        pattern: this.rng.next(),
        rising: 0,
        rose: false,
        clinging: false,
        dart: 0,
        dartX: 0,
        dartZ: 0,
        goalX: 0,
        goalZ: 0,
        goalWeight: 0,
        lookTimer: this.rng.range(0, 0.5),
        glideClock: this.rng.range(0, 3),
      });
      placed++;
    }
    return placed;
  }

  /** Removes every fish of a school; returns how many went. */
  removeSchool(school: number): number {
    const before = this.fish.length;
    for (let i = this.fish.length - 1; i >= 0; i--)
      if ((this.fish[i] as Fish).school === school) this.fish.splice(i, 1);
    return before - this.fish.length;
  }

  find(id: number): Fish | undefined {
    return this.fish.find((f) => f.id === id);
  }

  /** How well a spot suits a species (0..1): depth, current and water temperature (plan 6.5). */
  habitatScore(sp: SpeciesBehavior, s: FlowProbe | null, f?: Fish): number {
    if (!s || s.depth < sp.minDepth) return 0;
    if (sp.pondOnly && !s.pond) return 0;
    const h = sp.habitat;
    if (!h) return 1;
    const speed = Math.hypot(s.velocityX, s.velocityZ);
    // A fish's preferred-flow gene shifts the current it likes (plan D20).
    const shift = f ? (f.genes.preferredFlow - 0.5) * 0.6 * Math.max(0.2, h.flow[1] - h.flow[0]) : 0;
    const t = waterTemperature({
      dayOfYear: this.env.dayOfYear,
      hour: this.env.hour,
      speed,
      depth: s.depth,
      pond: s.pond === true,
    });
    return (
      fit(s.depth, h.depth[0], h.depth[1], 0.4) *
      fit(speed, h.flow[0] + shift, h.flow[1] + shift, 0.35) *
      fit(t, h.temperature[0], h.temperature[1], 3)
    );
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

  /** Looks around for water that suits the fish better; remembers the best direction for a while. */
  private lookAround(f: Fish, sp: SpeciesBehavior, here: FlowProbe | null): void {
    const score = this.habitatScore(sp, here, f);
    f.lookTimer = 0.6 + this.rng.next() * 0.4;
    if (score > 0.85) {
      f.goalWeight = 0;
      return;
    }
    let best = score;
    let bx = 0;
    let bz = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 8) * Math.PI * 2 + this.time * 0.61;
      const reach = k < 8 ? 2 : 5;
      const s = this.flow.sample(f.x + Math.cos(a) * reach, f.z + Math.sin(a) * reach);
      const sc = this.habitatScore(sp, s, f) - (k < 8 ? 0 : 0.05);
      if (sc > best + 0.02) {
        best = sc;
        bx = Math.cos(a);
        bz = Math.sin(a);
      }
    }
    f.goalX = bx;
    f.goalZ = bz;
    f.goalWeight = bx || bz ? (1 - score) * 0.9 : 0;
  }

  /** Advances the school by dt seconds (call at a fixed rate, e.g. 30 Hz). */
  step(dt: number, threat: Threat | null = null): void {
    this.time += dt;
    this.rebuildGrid();
    const near: number[] = [];
    const night = 1 - this.env.daylight;
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i] as Fish;
      const sp = this.species[f.species] as SpeciesBehavior;
      f.rose = false;
      const water = this.flow.sample(f.x, f.z);
      const cvx = water?.velocityX ?? 0;
      const cvz = water?.velocityZ ?? 0;
      const current = Math.hypot(cvx, cvz);
      const strengthGene = 0.75 + f.genes.swimStrength * 0.5;
      const shy = f.genes.shyness;
      const comfort = sp.comfortCurrent * (0.6 + f.genes.preferredFlow * 0.8);

      // Desired ground velocity from the school rules (looser at night, when fish rest).
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
      const social = 1 - night * 0.6;
      if (n > 0) {
        dx +=
          (sepX * 6 + (aliX / n) * sp.schooling.alignment * 0.5 + (cohX / n) * sp.schooling.cohesion * 0.6) * social;
        dz +=
          (sepZ * 6 + (aliZ / n) * sp.schooling.alignment * 0.5 + (cohZ / n) * sp.schooling.cohesion * 0.6) * social;
      }
      // Wander.
      f.wanderAngle += this.rng.range(-1, 1) * dt * 1.4;
      const wander = sp.clings ? 0.04 : 0.12 * (1 - night * 0.7);
      dx += Math.cos(f.wanderAngle) * wander;
      dz += Math.sin(f.wanderAngle) * wander;

      // Habitat: drift toward water of the right depth, current and temperature.
      f.lookTimer -= dt;
      if (f.lookTimer <= 0) this.lookAround(f, sp, water);
      dx += f.goalX * f.goalWeight;
      dz += f.goalZ * f.goalWeight;

      // Feeding beats comfort: shelter-seeking pauses while food is close.
      const foodRange = sp.foodRange ?? 14;
      const feeding =
        this.food !== null &&
        this.time < this.food.until &&
        Math.hypot(this.food.x - f.x, this.food.z - f.z) < foodRange;
      // Shelter: in strong current, move toward the calmest nearby water (behind stones, at the edges).
      if (water && current > comfort && !feeding && !sp.clings) {
        let best = current - water.shelter * 0.3;
        let bx = 0;
        let bz = 0;
        for (let k = 0; k < 12; k++) {
          const a = (k / 6) * Math.PI * 2 + this.time * 0.37;
          const reach = k < 6 ? 1.0 : 2.2;
          const ps = this.flow.sample(f.x + Math.cos(a) * reach, f.z + Math.sin(a) * reach);
          if (!ps || ps.depth < sp.minDepth) continue;
          const score = Math.hypot(ps.velocityX, ps.velocityZ) - ps.shelter * 0.6;
          if (score < best) {
            best = score;
            bx = Math.cos(a);
            bz = Math.sin(a);
          }
        }
        const urge = Math.min(1, (current - comfort) * 2);
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
      if (feeding && this.food) {
        const ox = this.food.x - f.x;
        const oz = this.food.z - f.z;
        const d = Math.hypot(ox, oz);
        if (d > 0.05) {
          dx += (ox / d) * Math.min(1, d) * 2;
          dz += (oz / d) * Math.min(1, d) * 2;
        }
      }

      // Curious fish come closer when you stand still (and keep a little distance).
      if (threat && (sp.curiosity ?? 0) > 0 && threat.calm > 3 && f.fleeing <= 0) {
        const ox = threat.x - f.x;
        const oz = threat.z - f.z;
        const d = Math.hypot(ox, oz);
        if (d < 8 && d > 1.4) {
          const pull = (sp.curiosity ?? 0) * (1 - shy) * Math.min(1, (d - 1.4) / 2) * 0.7;
          dx += (ox / d) * pull;
          dz += (oz / d) * pull;
        }
      }

      // Flee from sudden movement nearby (shy fish flee sooner and come back later).
      if (threat) {
        const ox = f.x - threat.x;
        const oz = f.z - threat.z;
        const d = Math.hypot(ox, oz);
        const scareRadius = 2 + shy * 4;
        if (d < scareRadius && threat.calm < 0.5 + shy * 2) f.fleeing = 1.2 + shy;
        if (f.fleeing > 0 && d > 0.01) {
          dx += (ox / d) * 2;
          dz += (oz / d) * 2;
        }
      }
      f.fleeing = Math.max(0, f.fleeing - dt);

      // Loaches: cling to the bed in fast water, now and then darting to another rock.
      if (sp.clings && water) {
        const onBed = f.y - water.bed < 0.08;
        f.dart = Math.max(0, f.dart - dt);
        if (f.dart <= 0 && f.fleeing <= 0 && this.rng.chance(dt / 6)) {
          const a = this.rng.range(0, Math.PI * 2);
          f.dart = this.rng.range(0.3, 0.7);
          f.dartX = Math.cos(a);
          f.dartZ = Math.sin(a);
        }
        if (f.dart > 0) {
          dx += f.dartX * sp.cruise * 1.5;
          dz += f.dartZ * sp.cruise * 1.5;
        }
        f.clinging = onBed && f.dart <= 0 && f.fleeing <= 0 && current > 0.12;
      } else f.clinging = false;

      // Desired ground speed limit (slower at night).
      const desired = Math.hypot(dx, dz);
      const maxGround = f.fleeing > 0 ? sp.burst * strengthGene : sp.cruise * strengthGene * (1 - night * 0.6);
      if (desired > maxGround) {
        dx = (dx / desired) * maxGround;
        dz = (dz / desired) * maxGround;
      }
      // Swimming effort = desired ground velocity − current, limited by swim strength. A clinging loach holds the
      // rock instead, so the current can't move it.
      let ex = dx - cvx;
      let ez = dz - cvz;
      const effort = Math.hypot(ex, ez);
      const strength = f.clinging ? Infinity : (f.fleeing > 0 ? sp.burst : sp.burst * 0.8) * strengthGene;
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
      // Never swim onto dry ground (or out of the pond, for pond fish): bounce back off the shallows.
      const landing = this.flow.sample(f.x, f.z);
      if (!landing || landing.depth < 0.06 || (sp.pondOnly && !landing.pond)) {
        f.x = px;
        f.z = pz;
        f.vx *= -0.3;
        f.vz *= -0.3;
      }

      // Heading follows the swimming effort (faces upstream in a current), turning smoothly. A clinging loach faces
      // straight into the current.
      const effortLen = Math.hypot(ex, ez);
      const faceX = f.clinging && current > 0.01 ? -cvx / current : effortLen > 0.02 ? ex / effortLen : f.hx;
      const faceZ = f.clinging && current > 0.01 ? -cvz / current : effortLen > 0.02 ? ez / effortLen : f.hz;
      const turn = Math.min(1, dt * 4 * (0.5 + (sp.rheotaxis ?? 0.8) * 0.5));
      f.hx += (faceX - f.hx) * turn;
      f.hz += (faceZ - f.hz) * turn;
      const hl = Math.hypot(f.hx, f.hz) || 1;
      f.hx /= hl;
      f.hz /= hl;

      // Rising: take a drifting insect at the surface (dawn and dusk), or thrown food.
      if (f.rising > 0) {
        f.rising -= dt;
        if (f.rising <= 0) f.rose = true;
      } else if (sp.eatsInsects && !sp.clings && f.fleeing <= 0 && this.rng.chance(dt * 0.025 * this.env.insects)) {
        f.rising = this.rng.range(0.8, 1.6);
      }

      // Depth: keep to the preferred layer (near the bottom at night, at the surface when rising), never above the
      // surface or into the bed.
      const now = this.flow.sample(f.x, f.z) ?? water;
      if (now) {
        const atFood = feeding && this.food && Math.hypot(this.food.x - f.x, this.food.z - f.z) < 2.5;
        let pref = sp.depthPreference * (1 - night * 0.75) + 0.06 * night;
        if (f.rising > 0 || atFood) pref = 0.97;
        if (sp.clings && !(f.rising > 0)) pref = 0;
        // Resting fish settle close to the bed; awake ones keep a little clear of it.
        const floor = sp.clings ? 0.03 : 0.04 + 0.04 * (1 - night);
        const targetY = now.bed + Math.max(floor, now.depth * pref);
        f.vy += ((targetY - f.y) * 1.5 - f.vy) * Math.min(1, dt * 2);
        f.y += f.vy * dt;
        f.y = Math.min(now.surface - 0.04, Math.max(now.bed + 0.03, f.y));
      }

      // Tail beat: faster with more effort; koi glide between strokes; resting fish barely move.
      let beat = 5 + effortLen * 9 + (f.fleeing > 0 ? 8 : 0);
      if (sp.glides && f.fleeing <= 0) {
        f.glideClock = (f.glideClock + dt) % 3.2;
        beat *= f.glideClock < 1.1 ? 1 : 0.25;
      }
      if (f.clinging) beat = 1.2;
      beat *= 1 - night * 0.5;
      f.beat += (beat - f.beat) * Math.min(1, dt * 4);
      f.phase += f.beat * dt;
    }
    if (this.food && this.time >= this.food.until) this.food = null;
  }
}
