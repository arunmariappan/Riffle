/**
 * Spray and mist particles (plan 6.2: the waterfall's spray and mist, splashes from dropped stones). Pure
 * TypeScript: positions, velocities and lifetimes live in typed arrays and are stepped on the CPU (like the floating
 * debris, C14); the engine only draws them. Seeded, so the same emits give the same particles.
 */
import { createRng, type Rng } from '../rng';

export interface SprayConfig {
  capacity: number;
  /** Downward acceleration, m/s² (spray falls; mist barely sinks). */
  gravity: number;
  /** Air drag per second (velocity relative to the wind decays by this rate). */
  drag: number;
  /** How strongly the wind carries a particle (0..1). */
  windCarry: number;
  /** Seconds a particle lives (min, max). */
  life: [number, number];
  /** Size at birth and at death, meters. */
  size: [number, number];
  /** Peak opacity. */
  opacity: number;
}

export interface Emitter {
  /** Segment the particles start from (a line across the plunge pool, or a point when a = b). */
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  /** Particles per second for continuous emitters. */
  rate: number;
  /** Mean launch velocity and its random spread per axis, m/s. */
  vx: number;
  vy: number;
  vz: number;
  spread: number;
}

export class SprayField {
  readonly config: SprayConfig;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** Seconds lived and total life (age ≥ life = dead). */
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly seed: Float32Array;
  /** Continuous emitters (the waterfall); bursts go through `burst`. */
  emitters: Emitter[] = [];
  /** Scales the continuous emit rates (discharge: more water, more spray). */
  intensity = 1;
  private readonly rng: Rng;
  private carry = 0;
  private cursor = 0;

  constructor(config: SprayConfig, seed = 'spray') {
    this.config = config;
    const n = config.capacity;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.age = new Float32Array(n).fill(1);
    this.life = new Float32Array(n).fill(0);
    this.seed = new Float32Array(n);
    this.rng = createRng(seed);
  }

  /** Live particle count. */
  get alive(): number {
    let n = 0;
    for (let i = 0; i < this.config.capacity; i++) if ((this.age[i] as number) < (this.life[i] as number)) n++;
    return n;
  }

  private spawn(e: Emitter): void {
    // Reuse the oldest slot in a ring, so a busy emitter never starves bursts for long.
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.config.capacity;
    const t = this.rng.next();
    const r = this.rng;
    this.x[i] = e.ax + (e.bx - e.ax) * t + r.range(-0.15, 0.15);
    this.y[i] = e.ay + (e.by - e.ay) * t;
    this.z[i] = e.az + (e.bz - e.az) * t + r.range(-0.15, 0.15);
    this.vx[i] = e.vx + r.normal() * e.spread;
    this.vy[i] = e.vy + Math.abs(r.normal()) * e.spread;
    this.vz[i] = e.vz + r.normal() * e.spread;
    this.age[i] = 0;
    this.life[i] = r.range(this.config.life[0], this.config.life[1]);
    this.seed[i] = r.next();
  }

  /** Emits `count` particles at once (a splash). */
  burst(e: Emitter, count: number): void {
    for (let k = 0; k < count; k++) this.spawn(e);
  }

  /**
   * Advances every particle by dt. `windX/windZ` is the wind velocity (m/s). `floor(x, z)` returns the height below
   * which a particle dies (the water surface or the ground), or null to ignore it.
   */
  step(dt: number, windX: number, windZ: number, floor: ((x: number, z: number) => number | null) | null): void {
    const c = this.config;
    for (const e of this.emitters) {
      this.carry += e.rate * this.intensity * dt;
      while (this.carry >= 1) {
        this.carry -= 1;
        this.spawn(e);
      }
    }
    const keep = Math.exp(-c.drag * dt);
    for (let i = 0; i < c.capacity; i++) {
      const age = (this.age[i] as number) + dt;
      this.age[i] = age;
      if (age >= (this.life[i] as number)) continue;
      // Velocity relaxes toward the carried wind; gravity pulls down.
      const tx = windX * c.windCarry;
      const tz = windZ * c.windCarry;
      this.vx[i] = tx + ((this.vx[i] as number) - tx) * keep;
      this.vz[i] = tz + ((this.vz[i] as number) - tz) * keep;
      this.vy[i] = ((this.vy[i] as number) - c.gravity * dt) * keep;
      const x = (this.x[i] as number) + (this.vx[i] as number) * dt;
      const y = (this.y[i] as number) + (this.vy[i] as number) * dt;
      const z = (this.z[i] as number) + (this.vz[i] as number) * dt;
      this.x[i] = x;
      this.y[i] = y;
      this.z[i] = z;
      if (floor && (this.vy[i] as number) < 0) {
        const f = floor(x, z);
        if (f !== null && y < f) this.age[i] = this.life[i] as number;
      }
    }
  }

  /** 0..1 life fraction of particle i (≥ 1 when dead). */
  lifeFraction(i: number): number {
    const life = this.life[i] as number;
    return life > 0 ? (this.age[i] as number) / life : 1;
  }

  /** Opacity over a particle's life: a quick fade in, a long fade out. */
  opacityAt(i: number): number {
    const f = this.lifeFraction(i);
    if (f >= 1) return 0;
    const fadeIn = Math.min(1, f / 0.12);
    const fadeOut = 1 - f * f;
    return this.config.opacity * fadeIn * fadeOut;
  }

  sizeAt(i: number): number {
    const f = Math.min(1, this.lifeFraction(i));
    const [s0, s1] = this.config.size;
    return s0 + (s1 - s0) * Math.sqrt(f);
  }
}

/** Fine spray thrown up where the waterfall hits the pool. */
export const WATERFALL_SPRAY: SprayConfig = {
  capacity: 360,
  gravity: 6.5,
  drag: 1.6,
  windCarry: 0.5,
  life: [0.6, 1.6],
  size: [0.18, 0.7],
  opacity: 0.5,
};

/** Slow mist billowing off the plunge pool and drifting downwind. */
export const WATERFALL_MIST: SprayConfig = {
  capacity: 90,
  gravity: -0.05,
  drag: 0.5,
  windCarry: 0.7,
  life: [4, 9],
  size: [1.2, 4.5],
  opacity: 0.16,
};

/** A splash (a stone dropped into the water). */
export const SPLASH: SprayConfig = {
  capacity: 160,
  gravity: 9.8,
  drag: 0.8,
  windCarry: 0.2,
  life: [0.5, 1.1],
  size: [0.06, 0.22],
  opacity: 0.75,
};
