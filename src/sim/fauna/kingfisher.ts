/**
 * The kingfisher (plan 6.6: the optional predator from above): it perches on stones and the banks near you, flies low
 * and fast along the stream, hovers over the shallows and plunges in after small fish. Pure TypeScript; the engine
 * supplies the perches and the water, and draws the bird.
 */
import type { Rng } from '../rng';

export type KingfisherState = 'away' | 'perch' | 'fly' | 'hover' | 'dive' | 'under' | 'rise';

export interface KingfisherWorld {
  /** A perch between `minR` and `maxR` from (x, z): a stone top above the water or the bank at the water's edge. */
  perchNear(x: number, z: number, minR: number, maxR: number): { x: number; y: number; z: number } | null;
  /** A spot in the shallows near (x, z) to dive at, with its water surface height. */
  shallowsNear(x: number, z: number): { x: number; z: number; surface: number } | null;
  /** The bird is about: daytime, no downpour, and it is switched on. */
  active: boolean;
}

export interface KingfisherEvents {
  /** It hit the water here (a splash, a sound). */
  splash?: { x: number; y: number; z: number };
  /** It called (its sharp whistle as it flies off). */
  call?: boolean;
}

const FLY_SPEED = 9;
const DIVE_SPEED = 7;

export class KingfisherBrain {
  state: KingfisherState = 'away';
  x = 0;
  y = -1000;
  z = 0;
  /** Heading (radians, atan2(dx, dz)) and body pitch (dive). */
  yaw = 0;
  pitch = 0;
  /** Wing beat phase and how hard it flaps (0 perched .. 1 flying). */
  wingPhase = 0;
  flap = 0;
  private timer = 0;
  private from = { x: 0, y: 0, z: 0 };
  private to = { x: 0, y: 0, z: 0 };
  private s = 0;
  private length = 1;
  private perch: { x: number; y: number; z: number } | null = null;
  private target: { x: number; z: number; surface: number } | null = null;
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  get visible(): boolean {
    return this.state !== 'away' && this.state !== 'under';
  }

  private flyTo(p: { x: number; y: number; z: number }, next: KingfisherState = 'perch'): void {
    this.from = { x: this.x, y: this.y, z: this.z };
    this.to = { ...p };
    this.s = 0;
    this.length = Math.max(1, Math.hypot(p.x - this.x, p.z - this.z, p.y - this.y));
    this.state = 'fly';
    this.after = next;
  }

  private after: KingfisherState = 'perch';

  step(dt: number, world: KingfisherWorld, camera: { x: number; z: number }): KingfisherEvents {
    const ev: KingfisherEvents = {};
    this.wingPhase += dt * (this.state === 'hover' ? 26 : 16) * Math.max(0.2, this.flap);
    const far = Math.hypot(this.x - camera.x, this.z - camera.z) > 90;
    if (this.state === 'away') {
      this.timer -= dt;
      if (this.timer > 0 || !world.active) return ev;
      // It arrives from upstream or downstream, out of sight, and flies in to a perch near you.
      const perch = world.perchNear(camera.x, camera.z, 12, 40);
      const start = world.perchNear(camera.x, camera.z, 55, 80);
      if (!perch || !start) {
        this.timer = 5;
        return ev;
      }
      this.x = start.x;
      this.y = start.y + 1.5;
      this.z = start.z;
      this.perch = perch;
      this.flyTo(perch);
      ev.call = true;
      return ev;
    }
    if (!world.active && this.state === 'perch') {
      // Leaves for the night, or when the rain sets in.
      const off = world.perchNear(camera.x, camera.z, 60, 90);
      if (off) this.flyTo(off, 'away');
      else this.state = 'away';
      return ev;
    }
    switch (this.state) {
      case 'perch': {
        this.flap = Math.max(0, this.flap - dt * 4);
        this.pitch *= 0.9;
        this.timer -= dt;
        if (far) {
          this.state = 'away';
          this.y = -1000;
          this.timer = 4;
          break;
        }
        if (this.timer > 0) break;
        const shallows = this.rng.next() < 0.55 ? world.shallowsNear(this.x, this.z) : null;
        if (shallows) {
          this.target = shallows;
          this.flyTo({ x: shallows.x, y: shallows.surface + 2.2, z: shallows.z }, 'hover');
        } else {
          const next = world.perchNear(camera.x, camera.z, 10, 45);
          if (next) {
            this.perch = next;
            this.flyTo(next);
            ev.call = this.rng.next() < 0.5;
          } else this.timer = 3;
        }
        break;
      }
      case 'fly': {
        this.flap = Math.min(1, this.flap + dt * 6);
        this.s = Math.min(1, this.s + (dt * FLY_SPEED) / this.length);
        const k = this.s;
        const nx = this.from.x + (this.to.x - this.from.x) * k;
        const nz = this.from.z + (this.to.z - this.from.z) * k;
        // Low over the water, with a little rise in the middle of a longer flight.
        const ny =
          this.from.y + (this.to.y - this.from.y) * k + Math.sin(Math.PI * k) * Math.min(1.5, this.length * 0.05);
        if (Math.hypot(nx - this.x, nz - this.z) > 1e-4) this.yaw = Math.atan2(nx - this.x, nz - this.z);
        this.x = nx;
        this.y = ny;
        this.z = nz;
        if (this.s >= 1) {
          this.state = this.after;
          this.timer =
            this.after === 'perch' ? this.rng.range(5, 16) : this.after === 'hover' ? this.rng.range(1, 2.5) : 6;
          if (this.after === 'away') this.y = -1000;
        }
        break;
      }
      case 'hover': {
        this.flap = 1;
        this.y += Math.sin(this.wingPhase * 0.2) * dt * 0.1;
        this.timer -= dt;
        if (this.timer <= 0 && this.target) {
          this.state = 'dive';
          this.pitch = -1.2;
        }
        break;
      }
      case 'dive': {
        this.flap = 0.1;
        const surface = this.target?.surface ?? this.y - 2;
        this.y -= dt * DIVE_SPEED;
        if (this.y <= surface) {
          this.y = surface - 0.15;
          ev.splash = { x: this.x, y: surface, z: this.z };
          this.state = 'under';
          this.timer = 0.35;
        }
        break;
      }
      case 'under': {
        this.timer -= dt;
        if (this.timer <= 0) {
          const surface = this.target?.surface ?? this.y;
          this.y = surface + 0.05;
          ev.splash = { x: this.x, y: surface, z: this.z };
          this.state = 'rise';
          this.pitch = 0.6;
        }
        break;
      }
      case 'rise': {
        this.flap = 1;
        this.y += dt * 3;
        this.pitch *= 0.95;
        if (this.y >= (this.target?.surface ?? 0) + 1.2) {
          const back = this.perch ?? world.perchNear(camera.x, camera.z, 10, 45);
          if (back) this.flyTo(back);
          else this.state = 'away';
        }
        break;
      }
    }
    return ev;
  }
}
