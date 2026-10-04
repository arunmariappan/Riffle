/**
 * Placement of water plants (plan 6.4) using the solved water: depth and current speed at each candidate decide what
 * can grow there. Pond plants (lotus, lilies) need still water; bed plants follow their depth and flow limits;
 * Java fern grows on top of submerged stones. Pure TypeScript and seeded.
 */
import { createRng } from '../rng';
import type { Placement } from '../../content/schema';
import type { ScatterInstance } from './scatter';

export interface WaterProbe {
  depth: number;
  speed: number;
  bed: number;
  surface: number;
}

export interface AquaticWorld {
  /** Water at a point (stream or pond), or null on dry ground. */
  probe(x: number, z: number): WaterProbe | null;
  pond: { x: number; z: number; radius: number };
  /** Stream center line samples (x, z interleaved) and half widths. */
  path: { count: number; points: ArrayLike<number>; normals: ArrayLike<number> };
  halfWidth: ArrayLike<number>;
  /** Stones that can carry epiphytes (Java fern, moss). */
  stones: readonly { x: number; z: number; top: number; radius: number; uid?: string }[];
}

export interface AquaticItem {
  id: string;
  placement: Placement;
  variants: number;
}

export interface AquaticInstance extends ScatterInstance {
  /** Water depth at the plant (lotus and lily stems reach the surface). */
  depth: number;
  /** The stone it grows on (Java fern, moss). */
  host?: string;
}

export function scatterAquatic(world: AquaticWorld, items: readonly AquaticItem[], seed: string): AquaticInstance[] {
  const out: AquaticInstance[] = [];
  const taken: { x: number; z: number; r: number }[] = [];
  const free = (x: number, z: number, r: number) =>
    taken.every((t) => (t.x - x) ** 2 + (t.z - z) ** 2 >= Math.max(r, t.r) ** 2);
  for (const item of items) {
    const p = item.placement;
    if (p.density <= 0) continue;
    const rng = createRng(`${seed}:aquatic:${item.id}`);
    const [d0, d1] = p.depth ?? [0, 99];
    const maxFlow = p.maxFlow ?? 99;
    const accept = (x: number, z: number, y: number | null, w: WaterProbe, host?: string): boolean => {
      if (w.depth < d0 || w.depth > d1 || w.speed > maxFlow) return false;
      if (!free(x, z, p.spacing * 0.5)) return false;
      taken.push({ x, z, r: p.spacing * 0.5 });
      out.push({
        kind: item.id,
        variant: rng.int(0, Math.max(1, item.variants)),
        x,
        y: y ?? w.bed,
        z,
        yaw: rng.range(0, Math.PI * 2),
        scale: rng.range(0.8, 1.2),
        phase: rng.range(0, Math.PI * 2),
        depth: y === null ? w.depth : Math.max(0.05, w.surface - y),
        ...(host ? { host } : {}),
      });
      return true;
    };
    if (p.surface === 'pond') {
      const attempts = Math.round(world.pond.radius ** 2 * 1.2 * p.density);
      for (let k = 0; k < attempts; k++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.next()) * world.pond.radius;
        const x = world.pond.x + Math.cos(a) * r;
        const z = world.pond.z + Math.sin(a) * r;
        const w = world.probe(x, z);
        if (w && rng.chance(Math.min(1, p.density))) accept(x, z, null, w);
      }
    } else if (p.surface === 'bed') {
      const step = Math.max(2, Math.round(p.spacing * 2));
      for (let i = 0; i < world.path.count; i += step) {
        const hw = world.halfWidth[i] as number;
        for (let tries = 0; tries < 2; tries++) {
          if (!rng.chance(Math.min(1, p.density * 0.5))) continue;
          const off = rng.range(-hw, hw);
          const x = (world.path.points[i * 2] as number) + (world.path.normals[i * 2] as number) * off;
          const z = (world.path.points[i * 2 + 1] as number) + (world.path.normals[i * 2 + 1] as number) * off;
          const w = world.probe(x, z);
          if (w) accept(x, z, null, w);
        }
      }
    } else if (p.surface === 'stone') {
      for (const s of world.stones) {
        if (s.radius < 0.35 || !rng.chance(Math.min(1, p.density))) continue;
        const w = world.probe(s.x, s.z);
        if (!w || w.surface - s.top < 0.08) continue;
        accept(
          s.x + rng.range(-0.15, 0.15) * s.radius,
          s.z + rng.range(-0.15, 0.15) * s.radius,
          s.top - 0.02,
          w,
          s.uid,
        );
      }
    }
  }
  return out;
}
