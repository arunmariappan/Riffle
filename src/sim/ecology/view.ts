/**
 * The two-level population hand-off (plan 6.6, D19). The cohorts are the truth; near the camera, some of their fish
 * are shown as individual fish. Stretches within `enter` meters of the camera get schools whose genes and ages are
 * drawn from their cohorts' statistics; stretches beyond `leave` meters fold theirs back (the schools are removed,
 * since the cohorts already count those fish). While a stretch is shown its schools follow the cohort counts, so a
 * growing population shows more fish. New fish only appear out of sight (far enough away, or behind the camera), so
 * nothing pops in where you are looking. Pure TypeScript.
 */
import type { Rng } from '../rng';
import type { FishGenes } from '../boids/school';
import { sampleGenes, type TraitStats } from './genetics';

export interface ViewConfig {
  /** A stretch is shown when its center comes within this distance of the camera, m. */
  enter: number;
  /** …and folded back when it is farther than this (hysteresis, so it doesn't flicker). */
  leave: number;
  /** Most individual fish shown at once. */
  budget: number;
  /** Most fish of one species shown in one stretch. */
  perStretch: number;
  /** New fish never appear closer than this to the camera, unless behind it, m. */
  minDistance: number;
}

export const VIEW_DEFAULTS: ViewConfig = { enter: 80, leave: 110, budget: 700, perStretch: 40, minDistance: 30 };

/** What the planner needs to know about a stretch. */
export interface ViewStretch {
  id: number;
  x: number;
  z: number;
  /** Juveniles + adults per species. */
  counts: readonly number[];
}

/** What it needs to know about a species. */
export interface ViewSpecies {
  /** Shown fish per real fish before the budget (big, rare fish are all shown; small schooling fish a share). */
  share: number;
  /** Fish per school. */
  school: number;
}

export interface ShownSchool {
  school: number;
  stretch: number;
  species: number;
  count: number;
}

export interface ViewOrders {
  add: ShownSchool[];
  remove: ShownSchool[];
}

/** Keeps track of which stretches are shown and which schools stand for them. */
export class FishView {
  readonly shown: ShownSchool[] = [];
  readonly active = new Set<number>();
  private nextSchool: number;

  constructor(firstSchool = 1_000_000) {
    this.nextSchool = firstSchool;
  }

  /** How many fish of each species each shown stretch should have right now. */
  targets(
    stretches: readonly ViewStretch[],
    species: readonly ViewSpecies[],
    config: ViewConfig = VIEW_DEFAULTS,
  ): Map<number, number[]> {
    const raw = new Map<number, number[]>();
    // Rare fish shown one for one (share 1) come first; the schooling fish share what is left of the budget.
    let rare = 0;
    let common = 0;
    for (const st of stretches) {
      if (!this.active.has(st.id)) continue;
      const row = species.map((sp, p) => Math.min(config.perStretch, (st.counts[p] ?? 0) * sp.share));
      raw.set(st.id, row);
      row.forEach((v, p) => {
        if ((species[p] as ViewSpecies).share >= 1) rare += v;
        else common += v;
      });
    }
    const left = Math.max(0, config.budget - rare);
    const kCommon = common > left ? left / common : 1;
    const kRare = rare > config.budget ? config.budget / rare : 1;
    const out = new Map<number, number[]>();
    for (const st of stretches) {
      const row = raw.get(st.id);
      if (!row) continue;
      out.set(
        st.id,
        row.map((v, p) => {
          const k = (species[p] as ViewSpecies).share >= 1 ? kRare : kCommon;
          const n = Math.round(v * k);
          // A species that lives here always shows at least one fish (a lone mahseer in its pool).
          return n === 0 && (st.counts[p] ?? 0) >= 1 && v * k > 0.25 ? 1 : n;
        }),
      );
    }
    return out;
  }

  /**
   * Plans the next changes for a camera position and returns them. The view's state assumes the orders are carried
   * out; report schools that couldn't be placed with `failed`.
   */
  plan(
    camera: { x: number; z: number },
    stretches: readonly ViewStretch[],
    species: readonly ViewSpecies[],
    config: ViewConfig = VIEW_DEFAULTS,
  ): ViewOrders {
    const orders: ViewOrders = { add: [], remove: [] };
    for (const st of stretches) {
      const d = Math.hypot(st.x - camera.x, st.z - camera.z);
      if (!this.active.has(st.id) && d < config.enter) this.active.add(st.id);
      else if (this.active.has(st.id) && d > config.leave) {
        this.active.delete(st.id);
        for (let i = this.shown.length - 1; i >= 0; i--) {
          const s = this.shown[i] as ShownSchool;
          if (s.stretch !== st.id) continue;
          orders.remove.push(s);
          this.shown.splice(i, 1);
        }
      }
    }
    const targets = this.targets(stretches, species, config);
    for (const [stretch, row] of targets) {
      row.forEach((target, p) => {
        const mine = this.shown.filter((s) => s.stretch === stretch && s.species === p);
        let current = mine.reduce((sum, s) => sum + s.count, 0);
        const slack = Math.max(2, target * 0.3);
        if (target - current >= slack || (current === 0 && target > 0)) {
          const size = Math.max(1, (species[p] as ViewSpecies).school);
          while (target - current > 0) {
            const n = Math.min(size, target - current);
            const school = { school: this.nextSchool++, stretch, species: p, count: n };
            this.shown.push(school);
            orders.add.push(school);
            current += n;
          }
        } else if (current - target >= slack) {
          // Newest schools go first; stop before falling well below the target.
          for (let i = mine.length - 1; i >= 0 && current - target >= slack; i--) {
            const s = mine[i] as ShownSchool;
            if (current - s.count < target * 0.7) break;
            orders.remove.push(s);
            this.shown.splice(this.shown.indexOf(s), 1);
            current -= s.count;
          }
        }
      });
    }
    return orders;
  }

  /** A school that couldn't be placed (no suitable water out of sight): forget it, it is tried again later. */
  failed(school: number): void {
    const i = this.shown.findIndex((s) => s.school === school);
    if (i >= 0) this.shown.splice(i, 1);
  }

  /** How many fish actually went in (the school may be smaller than asked). */
  placed(school: number, count: number): void {
    const s = this.shown.find((x) => x.school === school);
    if (!s) return;
    if (count <= 0) this.failed(school);
    else s.count = count;
  }

  /** Forgets everything (a new valley or a restored save). */
  reset(): ShownSchool[] {
    const all = this.shown.splice(0, this.shown.length);
    this.active.clear();
    return all;
  }
}

/** True when a point is out of sight: far enough away, or behind the camera (and not right at your feet). */
export function outOfSight(
  x: number,
  z: number,
  camera: { x: number; z: number; dirX: number; dirZ: number },
  minDistance: number,
): boolean {
  const dx = x - camera.x;
  const dz = z - camera.z;
  const d = Math.hypot(dx, dz);
  if (d >= minDistance) return true;
  const len = Math.hypot(camera.dirX, camera.dirZ) || 1;
  const facing = (dx * camera.dirX + dz * camera.dirZ) / (len * Math.max(d, 1e-6));
  return d > 8 && facing < -0.35;
}

/** One stretch's cohort for a species, as the view needs it. */
export interface CohortSample {
  juveniles: number;
  adults: number;
  juvenileTraits: TraitStats;
  adultTraits: TraitStats;
  /** Years to maturity and lifespan (ages). */
  maturity: number;
  lifespan: number;
}

/**
 * Genes and ages for `n` fish drawn from a cohort: juveniles and adults in proportion, each with traits from its
 * stage's statistics. Juveniles are smaller (their size gene scaled down) and younger.
 */
export function schoolGenes(c: CohortSample, n: number, rng: Rng): { genes: FishGenes; age: number }[] {
  const out: { genes: FishGenes; age: number }[] = [];
  const total = c.juveniles + c.adults;
  const pJuv = total > 0 ? c.juveniles / total : 0;
  for (let k = 0; k < n; k++) {
    if (rng.next() < pJuv) {
      const genes = sampleGenes(c.juvenileTraits, rng);
      const age = rng.range(0.25, Math.max(0.3, c.maturity));
      // A juvenile's size grows toward its gene as it nears maturity.
      genes.bodySize *= 0.35 + 0.5 * Math.min(1, age / Math.max(0.3, c.maturity));
      out.push({ genes, age });
    } else {
      out.push({
        genes: sampleGenes(c.adultTraits, rng),
        age: rng.range(c.maturity, Math.max(c.maturity + 0.5, c.lifespan * 0.8)),
      });
    }
  }
  return out;
}
