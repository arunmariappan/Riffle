import * as THREE from 'three/webgpu';
import * as Comlink from 'comlink';
import type { World } from '../world/World';
import type { EcologyReport, EcologyWorkerApi } from '../../workers/ecology.worker';
import type { EcologyPoint, EcologySettings } from '../../sim/ecology/ecology';
import { buildStretches, flowStretchSource, stretchOfSection, type Stretch } from '../../sim/ecology/stretches';
import { speciesLife, type SpeciesLife } from '../../sim/ecology/cohorts';
import { canopyGrid, shadeAt, type CanopyGrid } from '../../sim/ecology/canopy';
import {
  FishView,
  VIEW_DEFAULTS,
  outOfSight,
  schoolGenes,
  type ViewConfig,
  type ViewSpecies,
} from '../../sim/ecology/view';
import { PlantEcology, type PlantSpecies, type PlantWorld, type PlantSite } from '../../sim/ecology/plants';
import { dayLength } from '../../sim/ecology/environment';
import { airTemperature, waterTemperature } from '../../sim/ecology/temperature';
import { seasonWeights } from '../../sim/time/clock';
import { createRng } from '../../sim/rng';
import { checkPlacement } from '../../builder/placement';
import { cellInfo } from '../../sim/scatter/scatter';
import { findItem } from '../../content/catalog';
import type { PlacedItem } from '../../builder/editLayer';
import type { BushDef, WaterPlantDef } from '../../content/schema';
import type { OverlayField, OverlayKind } from '../overlays/Overlays';
import type { WeatherKind } from '../../sim/weather/weather';
import type { EcosystemSettings } from '../../state/settings';
import { QUALITY } from '../../state/quality';

/** Simulated seconds between catching the ecosystem up to the clock (at least every half a real second). */
const SYNC_EVERY = 0.5;
const VIEW_EVERY = 2;
const OVERLAY_EVERY = 3;
const HISTORY_EVERY = 4;
/** The stream follows the catchment only for changes bigger than this, and not more often than every few seconds. */
const DISCHARGE_STEP = 0.08;
const DISCHARGE_EVERY = 6;

export function ecologySettingsFrom(s: EcosystemSettings): Partial<EcologySettings> {
  return {
    evolution: s.evolution,
    mutation: s.mutation,
    predators: s.predators,
    caps: s.caps,
    kingfisher: s.kingfisher,
    restock: s.restock,
  };
}

/**
 * The ecosystem on the main thread (plan 6.6): builds the stretches from the solved stream, runs the ecology worker
 * against the clock, shows the fish near the camera from the stretches' cohorts (the two-level hand-off), lets the
 * plants grow, spread and die back, follows the weather and the catchment (rain raises the stream and clouds the
 * water) and supplies the oxygen, light, temperature and fish-density overlays.
 */
export class EcologySystem {
  report: EcologyReport | null = null;
  /** Graph points (populations, biodiversity, water quality, brightness) since the start. */
  history: EcologyPoint[] = [];
  /** Bumped when new graph points arrive. */
  historyRevision = 0;
  stretches: Stretch[] = [];
  readonly species: SpeciesLife[];
  readonly plants: PlantEcology;
  /** Discharge multiplier from the catchment (1 until the clock first runs). */
  dischargeFactor = 1;
  /** Extra cloudiness of the water from rain-washed silt, 0..1. */
  silt = 0;
  private readonly world: World;
  private worker: Worker | null = null;
  private api: Comlink.Remote<EcologyWorkerApi> | null = null;
  private syncing = false;
  private syncTimer = 0;
  private viewTimer = 0;
  private overlayTimer = 0;
  private historyTimer = 0;
  private dischargeTimer = 0;
  private lastOverlay: OverlayKind = 'none';
  private readonly view = new FishView();
  private viewConfig: ViewConfig;
  private readonly viewSpecies: ViewSpecies[];
  private viewQueue: Promise<void> = Promise.resolve();
  private canopy: CanopyGrid;
  private readonly startSeconds: number;
  private readonly rng = createRng('fish-view');
  private readonly plantDefs = new Map<string, BushDef | WaterPlantDef>();
  private plantsStepping = false;
  private readonly dir = new THREE.Vector3();

  constructor(world: World, options: { allFish?: boolean } = {}) {
    this.world = world;
    this.species = world.catalog.fish.map(speciesLife);
    this.viewConfig = options.allFish
      ? { ...VIEW_DEFAULTS, enter: 1e6, leave: 2e6, budget: 1400 }
      : { ...VIEW_DEFAULTS, budget: QUALITY[world.quality].fishBudget };
    this.viewSpecies = world.catalog.fish.map((d) => ({
      // Big rare fish (mahseer, koi) are all shown; small schooling fish a share of them.
      share: d.body.length[1] > 0.3 ? 1 : 0.3,
      school: Math.max(3, Math.min(20, d.school.size)),
    }));
    this.startSeconds = world.clock.seconds;
    const plantSpecies: PlantSpecies[] = [];
    for (const def of [...world.catalog.bushes, ...world.catalog.plants]) {
      this.plantDefs.set(def.id, def);
      plantSpecies.push({
        id: def.id,
        aquatic: def.category === 'plants',
        tolerance: def.tolerance,
        yearsToMature: def.growth.yearsToMature,
        lifespanYears: def.growth.lifespanYears,
        spread: def.growth.spread,
        spreadRate: def.growth.spreadRate,
        spreadDistance: def.growth.spreadDistance,
      });
    }
    this.plants = new PlantEcology(plantSpecies, world.valley.seed);
    this.canopy = this.buildCanopy();
  }

  private buildCanopy(): CanopyGrid {
    const hf = this.world.valley.heightfield;
    const extent = (hf.size - 1) * hf.cell;
    const crowns = [...this.world.trees.all()].map((t) => ({ x: t.x, z: t.z, radius: Math.max(1.5, t.height * 0.3) }));
    return canopyGrid(crowns, extent, hf.originX, 4);
  }

  /** The stream as stretches, from the latest flow solve. */
  buildStretches(): Stretch[] {
    const { flow, valley } = this.world;
    const pond = valley.pond;
    const level = flow.pondLevel();
    let area = 0;
    let depthSum = 0;
    let maxDepth = 0;
    for (let z = pond.z - pond.radius; z <= pond.z + pond.radius; z += 1)
      for (let x = pond.x - pond.radius; x <= pond.x + pond.radius; x += 1) {
        if ((x - pond.x) ** 2 + (z - pond.z) ** 2 > pond.radius ** 2) continue;
        const d = level - this.world.heightAt(x, z);
        if (d < 0.03) continue;
        area += 1;
        depthSum += d;
        maxDepth = Math.max(maxDepth, d);
      }
    const points = flow.path.points;
    return buildStretches(
      flowStretchSource({
        layout: flow.layout,
        cells: flow.cells as Float32Array,
        points,
        zones: valley.profile.zones,
        reachStarts: valley.profile.reachStarts,
        shade: (i) => shadeAt(this.canopy, points[i * 2] as number, points[i * 2 + 1] as number),
        pond:
          area > 4 ? { area, meanDepth: depthSum / area, maxDepth, section: pond.section, x: pond.x, z: pond.z } : null,
      }),
      this.world.catalog.fish.map((d) => ({ depth: d.habitat.depth, flow: d.habitat.flow })),
    );
  }

  async init(saved?: { ecology?: Uint8Array; plants?: Uint8Array }): Promise<void> {
    this.stretches = this.buildStretches();
    this.worker = new Worker(new URL('../../workers/ecology.worker.ts', import.meta.url), { type: 'module' });
    this.api = Comlink.wrap<EcologyWorkerApi>(this.worker);
    const s = this.world.settings;
    this.report = await this.api.init({
      seed: this.world.valley.seed,
      stretches: this.stretches,
      species: this.species,
      startSeconds: this.world.clock.seconds,
      settings: ecologySettingsFrom(s.ecosystem),
      weather: s.weather.mode,
      saved: saved?.ecology,
    });
    this.history = await this.api.history(0);
    this.historyRevision++;
    this.plants.sync(this.currentPlants());
    if (saved?.plants) {
      try {
        this.plants.restore(JSON.parse(new TextDecoder().decode(saved.plants)));
        this.applyPlantState();
      } catch (err) {
        console.warn('The saved plant ecology could not be restored', err);
      }
    }
    // The first fish come in at once, wherever the camera is (behind the loading screen).
    await this.planView(true);
  }

  private *currentPlants(): Generator<{ uid: string; kind: string; x: number; z: number; scale: number }> {
    for (const p of this.world.plants.all()) yield { uid: p.uid, kind: p.kind, x: p.x, z: p.z, scale: p.scale };
  }

  /** Puts a restored plant state into the world: died plants removed, offspring added, sizes applied. */
  private applyPlantState(): void {
    const ps = this.world.plants;
    for (const uid of this.plants.removed) ps.remove(uid);
    for (const r of this.plants.records.values()) {
      const existing = ps.get(r.uid);
      if (existing) {
        ps.move(r.uid, {
          x: existing.x,
          y: existing.y,
          z: existing.z,
          yaw: existing.yaw,
          scale: PlantEcology.scaleOf(r),
        });
        continue;
      }
      if (!r.uid.startsWith('e')) continue;
      this.addPlant(r.uid, r.kind, r.x, r.z, PlantEcology.scaleOf(r));
    }
    this.plants.sync(this.currentPlants());
  }

  private addPlant(uid: string, kind: string, x: number, z: number, scale: number): boolean {
    const def = this.plantDefs.get(kind);
    const item = findItem(this.world.catalog, kind);
    if (!def || !item) return false;
    const stone = def.placement.surface === 'stone' ? this.stoneNear(x, z) : null;
    const probe = this.world.items.probe(x, z, stone);
    const r = checkPlacement(item, probe);
    if (!r.ok) return false;
    let h = 0;
    for (let i = 0; i < uid.length; i++) h = (Math.imul(h, 31) + uid.charCodeAt(i)) | 0;
    const u = (h >>> 0) / 4294967296;
    this.world.plants.add(def, {
      uid,
      kind,
      variant: Math.floor(u * def.generator.variants),
      x,
      y: r.y,
      z,
      yaw: u * Math.PI * 2,
      scale,
      phase: u * 6.28,
      depth: r.depth,
      host: r.host,
    });
    return true;
  }

  private stoneNear(x: number, z: number): string | null {
    let best: string | null = null;
    let bestD = 2.5 * 2.5;
    for (const s of this.world.rocks.stones) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bestD && d < (s.radius + 0.5) ** 2) {
        bestD = d;
        best = s.uid;
      }
    }
    return best;
  }

  /** Most individual fish shown near the camera (the quality preset). */
  setFishBudget(budget: number): void {
    if (this.viewConfig.enter < 1e5) this.viewConfig = { ...this.viewConfig, budget };
  }

  /** Canopy shade 0..1 over a point (audio: rain on leaves, leaf litter underfoot). */
  shadeAt(x: number, z: number): number {
    return shadeAt(this.canopy, x, z);
  }

  // --- Per frame ----------------------------------------------------------------------------------------------

  update(dt: number): void {
    if (!this.api) return;
    this.syncTimer -= dt;
    if (this.syncTimer <= 0 && !this.syncing) {
      this.syncTimer = SYNC_EVERY;
      void this.sync();
    }
    this.viewTimer -= dt;
    if (this.viewTimer <= 0) {
      this.viewTimer = VIEW_EVERY;
      void this.planView(false);
    }
    this.overlayTimer -= dt;
    const kind = this.world.overlays.kind;
    if (kind !== this.lastOverlay) {
      this.lastOverlay = kind;
      this.overlayTimer = 0;
    }
    if (
      this.overlayTimer <= 0 &&
      (kind === 'oxygen' || kind === 'light' || kind === 'temperature' || kind === 'fish')
    ) {
      this.overlayTimer = OVERLAY_EVERY;
      const field = this.overlayField(kind);
      if (field) this.world.overlays.setField(kind, field);
    }
    this.historyTimer -= dt;
    if (this.historyTimer <= 0 && this.report && this.report.historyLength > this.history.length) {
      this.historyTimer = HISTORY_EVERY;
      void this.api.history(this.history.length).then((points) => {
        this.history.push(...points);
        this.historyRevision++;
      });
    }
    // During a time-lapse each frame is hours or days apart: let the stream follow the rain much sooner.
    this.dischargeTimer -= this.world.capturing ? dt * 15 : dt;
  }

  /** Catches the ecosystem up to the clock now and waits for it (time-lapse frames). */
  async syncNow(): Promise<void> {
    while (this.syncing) await new Promise((resolve) => setTimeout(resolve, 2));
    for (let k = 0; k < 12; k++) {
      await this.sync();
      if (!this.report || this.report.seconds >= this.world.clock.seconds - 1) break;
    }
  }

  private async sync(): Promise<void> {
    if (!this.api) return;
    this.syncing = true;
    try {
      const r = await this.api.sync(this.world.clock.seconds);
      if (r) this.applyReport(r);
    } finally {
      this.syncing = false;
    }
  }

  private applyReport(r: EcologyReport): void {
    this.report = r;
    const eco = this.world.settings.ecosystem;
    // Rain raises the stream after a delay and clouds it (plan 6.7), once time is running.
    const running = Math.abs(this.world.clock.seconds - this.startSeconds) > 60;
    if (eco.rainRaisesStream && running) {
      const factor = Math.min(3, Math.max(0.4, r.dischargeRatio));
      const flow = this.world.flow;
      const want = this.world.settings.water.discharge * factor;
      if (
        Math.abs(want - flow.discharge) / Math.max(0.1, flow.discharge) > DISCHARGE_STEP &&
        this.dischargeTimer <= 0
      ) {
        this.dischargeTimer = DISCHARGE_EVERY;
        this.dischargeFactor = factor;
        void this.world.applyDischarge();
      }
      this.silt = Math.min(1, Math.max(0, r.turbidity - 0.08) * 1.2);
    } else if (!eco.rainRaisesStream && this.dischargeFactor !== 1) {
      this.dischargeFactor = 1;
      this.silt = 0;
      void this.world.applyDischarge();
    }
    if (r.days > 0) void this.stepPlants(r.days);
  }

  // --- Fish: the two-level hand-off ----------------------------------------------------------------------------

  private planView(immediate: boolean): Promise<void> {
    const r = this.report;
    if (!r) return Promise.resolve();
    const cam = this.world.engine.camera;
    const camera = { x: cam.position.x, z: cam.position.z };
    const orders = this.view.plan(camera, r.stretches, this.viewSpecies, this.viewConfig);
    if (!orders.add.length && !orders.remove.length) return this.viewQueue;
    cam.getWorldDirection(this.dir);
    const look = { x: camera.x, z: camera.z, dirX: this.dir.x, dirZ: this.dir.z };
    this.viewQueue = this.viewQueue.then(async () => {
      for (const s of orders.remove) await this.world.fish.removeSchool(s.school);
      for (const s of orders.add) {
        const spot = this.findSpot(s.stretch, s.species, look, immediate ? 0 : this.viewConfig.minDistance);
        if (!spot) {
          this.view.failed(s.school);
          continue;
        }
        const st = r.stretches[s.stretch];
        const c = st?.cohorts[s.species];
        const life = this.species[s.species] as SpeciesLife;
        const genes = c
          ? schoolGenes({ ...c, maturity: life.maturity, lifespan: life.lifespan }, s.count, this.rng).map((g, k) => ({
              ...g,
              pattern: c.patterns.length ? c.patterns[k % c.patterns.length] : undefined,
            }))
          : undefined;
        const placed = await this.world.fish.release(
          s.species,
          spot.x,
          spot.z,
          s.count,
          1.5 + Math.sqrt(s.count) * 0.35,
          s.school,
          genes,
        );
        this.view.placed(s.school, placed);
      }
    });
    return this.viewQueue;
  }

  /** A spot in a stretch whose water suits a species, out of the camera's sight. */
  private findSpot(
    stretch: number,
    species: number,
    camera: { x: number; z: number; dirX: number; dirZ: number },
    minDistance: number,
  ): { x: number; z: number } | null {
    const st = this.stretches[stretch];
    const b = this.world.fish.behaviors[species];
    if (!st || !b) return null;
    const flow = this.world.flow;
    const ok = (x: number, z: number) => {
      const s = flow.sample(x, z);
      if (!s || s.depth < b.minDepth) return false;
      // Pond fish stay in the pond; a stretch's fish appear in its own water (the pond is a stretch of its own).
      if (st.pond !== (s.pond === true)) return false;
      const h = b.habitat;
      if (h) {
        const speed = Math.hypot(s.velocityX, s.velocityZ);
        if (s.depth < h.depth[0] * 0.8 || speed > h.flow[1] * 1.2 || speed < h.flow[0] * 0.7) return false;
      }
      return minDistance <= 0 || outOfSight(x, z, camera, minDistance);
    };
    for (let k = 0; k < 60; k++) {
      let x: number;
      let z: number;
      if (st.pond) {
        const p = this.world.valley.pond;
        const a = this.rng.range(0, Math.PI * 2);
        const rr = Math.sqrt(this.rng.next()) * p.radius;
        x = p.x + Math.cos(a) * rr;
        z = p.z + Math.sin(a) * rr;
      } else {
        const i = this.rng.int(st.first, st.last + 1);
        const path = flow.path;
        const hw = (this.world.valley.profile.halfWidth[i] as number) ?? 5;
        const off = this.rng.range(-hw, hw) * 0.85;
        x = (path.points[i * 2] as number) + (path.normals[i * 2] as number) * off;
        z = (path.points[i * 2 + 1] as number) + (path.normals[i * 2 + 1] as number) * off;
      }
      if (ok(x, z)) return { x, z };
    }
    return null;
  }

  /** Fish you released join the cohort where they went in (and leave it again on undo). */
  fishChanged(item: PlacedItem, added: boolean): void {
    const p = this.world.fish.speciesIndex(item.kind);
    if (p < 0 || !this.api) return;
    const n = item.count ?? 12;
    void (added ? this.api.addFish(item.x, item.z, p, n) : this.api.removeFish(item.x, item.z, p, n));
  }

  /** Every fish shown now goes back (a new view after loading). */
  async resetView(): Promise<void> {
    const all = this.view.reset();
    for (const s of all) await this.world.fish.removeSchool(s.school);
  }

  // --- Plants --------------------------------------------------------------------------------------------------

  private plantWorld(): PlantWorld {
    const world = this.world;
    const clock = world.clock;
    const day = clock.dayOfYear;
    const w = seasonWeights(day);
    const sun = Math.min(1, Math.max(0, (dayLength(day) - 10) / 4));
    const air = airTemperature(day, 8.5);
    const rainMoisture = w.monsoon * 0.35 + w.spring * 0.1 + w.autumn * 0.15 + w.winter * 0.05;
    const env = this.report?.env;
    const wind = world.windState;
    const site = (r: { uid: string; kind: string; x: number; z: number }): PlantSite | null => {
      const sp = this.plantDefs.get(r.kind);
      if (!sp) return null;
      const shade = shadeAt(this.canopy, r.x, r.z);
      const open = (0.6 + sun * 0.35) * (1 - shade * 0.8);
      if (sp.category === 'bushes') {
        const info = world.items.probe(r.x, r.z, null);
        if (info.water && info.water.depth > 0.1) return null;
        return { light: open, moisture: Math.min(1, info.ground.wetness * 0.75 + rainMoisture), temperature: air };
      }
      const s = world.flow.sample(r.x, r.z);
      const pond = world.valley.pond;
      const inPond = (r.x - pond.x) ** 2 + (r.z - pond.z) ** 2 < (pond.radius + 2) ** 2;
      let depth = s?.depth ?? 0;
      let speed = s ? Math.hypot(s.velocityX, s.velocityZ) : 0;
      if (depth < 0.02 && inPond) {
        depth = world.flow.pondLevel() - world.heightAt(r.x, r.z);
        speed = 0;
      }
      if (depth < 0.02) return null;
      const st = inPond
        ? this.stretches.findIndex((x) => x.pond)
        : stretchOfSection(this.stretches, cellInfo(world.valley, r.x, r.z).section);
      const e = st >= 0 ? env?.[st] : undefined;
      const turbidity = e?.turbidity ?? 0.1;
      const stone = this.world.plants.get(r.uid)?.host;
      // Plants on stones sit higher than the bed: less water above them.
      const over = stone ? Math.max(0.02, depth * 0.5) : depth;
      return {
        light: open * Math.exp(-over * (0.35 + turbidity * 2)),
        moisture: 1,
        temperature: e?.waterTemp ?? waterTemperature({ dayOfYear: day, hour: 10, speed, depth, pond: inPond }),
        depth: over,
        flow: speed,
      };
    };
    return {
      site,
      wind: [wind.dirX * Math.min(1, wind.speed / 3), wind.dirZ * Math.min(1, wind.speed / 3)],
      downstream: (x, z) => {
        const s = world.flow.sample(x, z);
        if (!s) return null;
        const v = Math.hypot(s.velocityX, s.velocityZ);
        return v > 0.02 ? [s.velocityX / v, s.velocityZ / v] : null;
      },
      place: (kind, x, z) => {
        const def = this.plantDefs.get(kind);
        if (!def) return null;
        const spacing = def.placement.spacing * 0.8;
        for (const p of world.plants.all()) if ((p.x - x) ** 2 + (p.z - z) ** 2 < spacing * spacing) return null;
        const item = findItem(world.catalog, kind);
        if (!item) return null;
        const stone = def.placement.surface === 'stone' ? this.stoneNear(x, z) : null;
        return checkPlacement(item, world.items.probe(x, z, stone)).ok ? { x, z } : null;
      },
    };
  }

  private async stepPlants(days: number): Promise<void> {
    if (this.plantsStepping) return;
    this.plantsStepping = true;
    try {
      this.plants.sync(this.currentPlants());
      const steps = Math.min(Math.ceil(days), 8);
      const dt = days / steps / 365;
      const world = this.plantWorld();
      const ps = this.world.plants;
      for (let k = 0; k < steps; k++) {
        const ev = this.plants.step(world, dt);
        for (const r of ev.died) ps.remove(r.uid);
        for (const r of ev.born)
          if (!this.addPlant(r.uid, r.kind, r.x, r.z, PlantEcology.scaleOf(r))) this.plants.records.delete(r.uid);
        for (const r of ev.resized) {
          const p = ps.get(r.uid);
          if (p) ps.move(r.uid, { x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: PlantEcology.scaleOf(r) });
        }
        // Give the frame a breath between days.
        if (steps > 1) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.plantsStepping = false;
    }
  }

  // --- Overlays -----------------------------------------------------------------------------------------------

  /** The ecology's grids for the heat-map drape (plan 6.8): oxygen, light, temperature, fish density. */
  overlayField(kind: OverlayKind): OverlayField | null {
    const r = this.report;
    if (!r) return null;
    const { valley } = this.world;
    const hf = valley.heightfield;
    const cell = 4;
    const extent = (hf.size - 1) * hf.cell;
    const size = Math.ceil(extent / cell);
    const data = new Float32Array(size * size).fill(Number.NaN);
    const pondIndex = this.stretches.findIndex((s) => s.pond);
    const day = this.world.clock.dayOfYear;
    const air = airTemperature(day, this.world.clock.hour);
    const sun = Math.min(1, Math.max(0, (dayLength(day) - 10) / 4));
    for (let j = 0; j < size; j++) {
      const z = hf.originZ + (j + 0.5) * cell;
      const cz = Math.min(hf.size - 1, Math.round((z - hf.originZ) / hf.cell));
      for (let i = 0; i < size; i++) {
        const x = hf.originX + (i + 0.5) * cell;
        const cx = Math.min(hf.size - 1, Math.round((x - hf.originX) / hf.cell));
        const idx = cz * hf.size + cx;
        const inPond = (x - valley.pond.x) ** 2 + (z - valley.pond.z) ** 2 < valley.pond.radius ** 2;
        const wet = (valley.masks.riverDistance[idx] as number) < 0 || inPond;
        const st = inPond
          ? pondIndex
          : wet
            ? stretchOfSection(this.stretches, valley.masks.riverSection[idx] as number)
            : -1;
        const env = st >= 0 ? r.env[st] : undefined;
        let v = Number.NaN;
        if (kind === 'light') v = env ? env.light : (0.6 + sun * 0.35) * (1 - shadeAt(this.canopy, x, z) * 0.8);
        else if (kind === 'temperature') v = env ? env.waterTemp : air;
        else if (kind === 'oxygen') v = env ? env.oxygenMin : Number.NaN;
        else if (kind === 'fish' && st >= 0) {
          const s = r.stretches[st];
          const area = Math.max(1, this.stretches[st]?.area ?? 1);
          v = s ? s.counts.reduce((a, b) => a + b, 0) / area : Number.NaN;
        }
        data[j * size + i] = v;
      }
    }
    const legends: Record<string, OverlayField['legend']> = {
      oxygen: { label: 'Oxygen at dawn', unit: 'mg/L', min: 3, max: 11 },
      light: { label: 'Light', unit: '', min: 0, max: 1 },
      temperature: { label: 'Temperature', unit: '°C', min: 0, max: 30 },
      fish: { label: 'Fish', unit: 'per m²', min: 0, max: 3 },
    };
    return {
      data,
      size,
      cell,
      originX: hf.originX + cell / 2,
      originZ: hf.originZ + cell / 2,
      legend: legends[kind] as OverlayField['legend'],
    };
  }

  // --- Controls and saving ------------------------------------------------------------------------------------

  setSettings(s: EcosystemSettings): void {
    void this.api?.setSettings(ecologySettingsFrom(s));
  }

  setWeather(mode: 'auto' | WeatherKind): void {
    void this.api?.setWeather(mode);
  }

  /** The new water after an edit (a stone, a spring, the sliders): the stretches follow it. */
  refreshStretches(): void {
    if (!this.api) return;
    const next = this.buildStretches();
    if (next.length !== this.stretches.length) return;
    this.stretches = next;
    void this.api.setStretches(next);
  }

  /** A fingerprint of the ecosystem's state (tests: recording doesn't change the simulation). */
  async hash(): Promise<string> {
    return (await this.api?.hash()) ?? '';
  }

  /** The ecology's state as binary save sections. */
  async saveSections(): Promise<Record<string, Uint8Array>> {
    const out: Record<string, Uint8Array> = {};
    const bytes = await this.api?.serialize();
    if (bytes) out.ecology = bytes;
    this.plants.sync(this.currentPlants());
    out.plants = new TextEncoder().encode(JSON.stringify(this.plants.toJSON()));
    return out;
  }

  dispose(): void {
    this.worker?.terminate();
  }
}
