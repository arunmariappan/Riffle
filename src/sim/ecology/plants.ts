/**
 * Plant ecology (plan 6.6): every ground plant and water plant has a fitness from its species' tolerance curves
 * (light, moisture, temperature, and depth and current for water plants). Fit plants grow toward full size and
 * spread: wind-borne seeds go downwind, drifting fragments and plantlets go downstream, runners creep close by. Unfit
 * plants shrink and die back. Each plant carries one gene, growth versus spread, which its offspring inherit with a
 * little mutation, so the balance shifts with the conditions. Pure TypeScript; one step per simulated day.
 */
import { createRng, restoreRng, type Rng } from '../rng';

export interface Tolerance {
  /** Fitness falls to 0 at these values… */
  limits: [number, number];
  /** …and is full between these. */
  ideal: [number, number];
}

export type SpreadKind = 'wind-seeds' | 'runners' | 'drift' | 'plantlets' | 'none';

export interface PlantSpecies {
  id: string;
  aquatic: boolean;
  tolerance: { light?: Tolerance; moisture?: Tolerance; temperature?: Tolerance; flow?: Tolerance; depth?: Tolerance };
  yearsToMature: number;
  lifespanYears: number;
  spread: SpreadKind;
  /** New plants per mature plant per year at full fitness. */
  spreadRate: number;
  spreadDistance: number;
}

/** The conditions a plant lives in. */
export interface PlantSite {
  /** 0..1 light reaching it. */
  light: number;
  /** 0..1 soil moisture (land plants). */
  moisture: number;
  /** °C (air for land plants, water for water plants). */
  temperature: number;
  /** Water depth and current (water plants). */
  depth?: number;
  flow?: number;
}

export interface PlantRecord {
  uid: string;
  kind: string;
  x: number;
  z: number;
  /** The scale it was placed at; it shows at `baseScale × (0.35 + 0.65 × size)`. */
  baseScale: number;
  /** 0..1 of its full size. */
  size: number;
  /** 0..1; it dies at 0. */
  health: number;
  /** Years. */
  age: number;
  /** 0 = puts everything into growing .. 1 = into spreading. */
  gene: number;
}

export interface PlantWorld {
  /** The conditions where a plant stands today, or null when it can't live there any more (dry water plant). */
  site(r: PlantRecord): PlantSite | null;
  /**
   * A free spot for a new plant of a kind at or near (x, z) (placement rules and spacing), or null. Returns the spot
   * actually used.
   */
  place(kind: string, x: number, z: number): { x: number; z: number } | null;
  /** Where the wind blows (seeds go downwind). */
  wind: [number, number];
  /** Downstream direction at a point (drifting plants), or null away from the stream. */
  downstream(x: number, z: number): [number, number] | null;
}

export interface PlantEvents {
  resized: PlantRecord[];
  born: PlantRecord[];
  died: PlantRecord[];
}

/** Fitness on one tolerance curve: 1 inside the ideal range, falling linearly to 0 at the limits. */
export function toleranceFit(v: number, t: Tolerance | undefined): number {
  if (!t) return 1;
  const [l0, l1] = t.limits;
  const [i0, i1] = t.ideal;
  if (v < i0) return v <= l0 ? 0 : (v - l0) / Math.max(1e-6, i0 - l0);
  if (v > i1) return v >= l1 ? 0 : (l1 - v) / Math.max(1e-6, l1 - i1);
  return 1;
}

/** A plant's fitness at a site, 0..1 (the product of its tolerance curves). */
export function plantFitness(sp: PlantSpecies, site: PlantSite): number {
  const t = sp.tolerance;
  let f = toleranceFit(site.light, t.light) * toleranceFit(site.temperature, t.temperature);
  if (sp.aquatic) f *= toleranceFit(site.depth ?? 0, t.depth) * toleranceFit(site.flow ?? 0, t.flow);
  else f *= toleranceFit(site.moisture, t.moisture);
  return f;
}

/** Most plants the ecology lets one species grow to (the renderer's budget). */
const MAX_PER_KIND = 900;

export class PlantEcology {
  readonly species = new Map<string, PlantSpecies>();
  readonly records = new Map<string, PlantRecord>();
  /** Plants from the starting layout or the builder that died (a restored save removes them again). */
  readonly removed = new Set<string>();
  private nextId = 1;
  private rng: Rng;
  /** How many plants each kind may grow to (a few times its starting count, capped). */
  private readonly limits = new Map<string, number>();

  constructor(species: readonly PlantSpecies[], seed: string) {
    for (const s of species) this.species.set(s.id, s);
    this.rng = createRng(`plants:${seed}`);
  }

  /**
   * Brings the records in line with the plants that are in the world now: new ones (placed by you) join, missing ones
   * (removed by you) are forgotten.
   */
  sync(current: Iterable<{ uid: string; kind: string; x: number; z: number; scale: number }>): void {
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const p of current) {
      if (!this.species.has(p.kind)) continue;
      seen.add(p.uid);
      counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
      const r = this.records.get(p.uid);
      if (r) {
        r.x = p.x;
        r.z = p.z;
        continue;
      }
      this.records.set(p.uid, {
        uid: p.uid,
        kind: p.kind,
        x: p.x,
        z: p.z,
        baseScale: p.scale,
        size: 1,
        health: 0.85,
        age: 2,
        gene: 0.5,
      });
    }
    for (const uid of [...this.records.keys()]) if (!seen.has(uid)) this.records.delete(uid);
    for (const [kind, n] of counts)
      if (!this.limits.has(kind)) this.limits.set(kind, Math.min(MAX_PER_KIND, Math.max(40, n * 3)));
  }

  /** The scale a plant shows at. */
  static scaleOf(r: PlantRecord): number {
    return r.baseScale * (0.35 + 0.65 * r.size);
  }

  count(kind: string): number {
    let n = 0;
    for (const r of this.records.values()) if (r.kind === kind) n++;
    return n;
  }

  /** One day (or `dt` years). */
  step(world: PlantWorld, dt = 1 / 365): PlantEvents {
    const events: PlantEvents = { resized: [], born: [], died: [] };
    const counts = new Map<string, number>();
    for (const r of this.records.values()) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    // Sorted ids keep the order (and the random draws) the same in every run.
    const ids = [...this.records.keys()].sort();
    for (const uid of ids) {
      const r = this.records.get(uid) as PlantRecord;
      const sp = this.species.get(r.kind);
      if (!sp) continue;
      const site = world.site(r);
      const fit = site ? plantFitness(sp, site) : 0;
      r.age += dt;
      // Health follows fitness; old age wears it down.
      const old = Math.max(0, r.age - sp.lifespanYears) / Math.max(1, sp.lifespanYears * 0.25);
      r.health = Math.min(1, Math.max(0, r.health + (fit - 0.3) * 2.5 * dt - old * dt * 4 - (site ? 0 : 6 * dt)));
      if (r.health <= 0) {
        this.records.delete(uid);
        if (!uid.startsWith('e')) this.removed.add(uid);
        events.died.push(r);
        counts.set(r.kind, (counts.get(r.kind) ?? 1) - 1);
        continue;
      }
      // Growth (faster for growers), or shrinking back when the place doesn't suit it.
      const before = r.size;
      if (fit > 0.3) r.size += (fit * (1.3 - 0.6 * r.gene) * dt) / Math.max(0.2, sp.yearsToMature);
      else r.size -= (0.3 - fit) * 1.5 * dt;
      r.size = Math.min(1, Math.max(0.15, r.size));
      if (Math.abs(r.size - before) > 1e-9) events.resized.push(r);
      // Spreading (more for spreaders), once grown and healthy.
      if (sp.spread === 'none' || r.size < 0.6 || r.health < 0.5) continue;
      const limit = this.limits.get(r.kind) ?? MAX_PER_KIND;
      if ((counts.get(r.kind) ?? 0) >= limit) continue;
      const rate = sp.spreadRate * fit * (0.4 + 1.2 * r.gene);
      if (this.rng.next() >= rate * dt) continue;
      const child = this.offspring(r, sp, world);
      if (!child) continue;
      this.records.set(child.uid, child);
      events.born.push(child);
      counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    }
    return events;
  }

  private offspring(parent: PlantRecord, sp: PlantSpecies, world: PlantWorld): PlantRecord | null {
    const rng = this.rng;
    let dist = sp.spreadDistance * (0.3 + 0.7 * rng.next());
    let angle = rng.range(0, Math.PI * 2);
    const dir = (v: [number, number], spread: number) => {
      angle = Math.atan2(v[1], v[0]) + rng.normal() * spread;
    };
    if (sp.spread === 'wind-seeds' && Math.hypot(world.wind[0], world.wind[1]) > 0.1) dir(world.wind, 0.7);
    else if (sp.spread === 'drift' || sp.spread === 'plantlets') {
      const down = world.downstream(parent.x, parent.z);
      if (down) dir(down, 0.5);
      if (sp.spread === 'plantlets') dist *= 0.6;
    } else if (sp.spread === 'runners') dist *= 0.3;
    const spot = world.place(parent.kind, parent.x + Math.cos(angle) * dist, parent.z + Math.sin(angle) * dist);
    if (!spot) return null;
    return {
      uid: `e${this.nextId++}`,
      kind: parent.kind,
      x: spot.x,
      z: spot.z,
      baseScale: parent.baseScale * (0.85 + 0.3 * rng.next()),
      size: 0.15,
      health: 0.7,
      age: 0,
      gene: Math.min(1, Math.max(0, parent.gene + rng.normal() * 0.05)),
    };
  }

  /** Mean growth-versus-spread gene of a kind (the Ecosystem panel). */
  meanGene(kind?: string): number {
    let n = 0;
    let sum = 0;
    for (const r of this.records.values()) {
      if (kind && r.kind !== kind) continue;
      n++;
      sum += r.gene;
    }
    return n ? sum / n : 0.5;
  }

  toJSON(): unknown {
    return {
      nextId: this.nextId,
      rng: this.rng.state(),
      removed: [...this.removed].sort(),
      limits: [...this.limits.entries()],
      records: [...this.records.values()].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)),
    };
  }

  restore(data: unknown): void {
    const d = data as {
      nextId: number;
      rng: [number, number, number, number];
      removed: string[];
      limits: [string, number][];
      records: PlantRecord[];
    };
    this.nextId = d.nextId;
    this.rng = restoreRng(d.rng);
    this.removed.clear();
    for (const uid of d.removed) this.removed.add(uid);
    this.limits.clear();
    for (const [k, v] of d.limits) this.limits.set(k, v);
    this.records.clear();
    for (const r of d.records) this.records.set(r.uid, { ...r });
  }
}
