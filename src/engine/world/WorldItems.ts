import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Catalog } from '../../content/catalog';
import type { BushDef, WaterPlantDef } from '../../content/schema';
import type { Valley } from '../../sim/terrain/valley';
import { cellInfo } from '../../sim/scatter/scatter';
import type { Stone } from '../../sim/flow/field';
import { waterTemperature } from '../../sim/ecology/temperature';
import type { SimClock } from '../../sim/time/clock';
import {
  addItem,
  cloneEditLayer,
  createEditLayer,
  moveItem,
  removeItem,
  type EditLayer,
  type GrassStroke,
  type ItemCategory,
  type ItemTransform,
  type PlacedItem,
  type Spring,
} from '../../builder/editLayer';
import type { PlacementProbe } from '../../builder/placement';
import { applyGrassStroke, type DensityGrid } from '../../builder/brush';
import { pickNearest, rayHeight, type PickShape, type Ray } from '../../builder/picking';
import type { RockSystem, PlacedStone } from './RockSystem';
import type { TreeSystem } from '../vegetation/TreeSystem';
import type { PlantSystem, PlacedPlant } from '../vegetation/PlantSystem';
import type { FishSystem } from '../fauna/FishSystem';
import type { FlowSystem } from '../water/FlowSystem';
import type { Physics } from '../physics/Physics';
import type { GrassSystem } from '../vegetation/GrassSystem';
import type { WaterEffects } from '../water/Spray';

export interface WorldParts {
  valley: Valley;
  catalog: Catalog;
  clock: SimClock;
  rocks: RockSystem;
  trees: TreeSystem;
  plants: PlantSystem;
  fish: FishSystem;
  flow: FlowSystem;
  physics: Physics;
  grass: GrassSystem;
  waterFx: WaterEffects;
  heightAt: (x: number, z: number) => number;
}

/** A stone falling after a builder drop. */
interface Falling {
  uid: string;
  body: RAPIER.RigidBody;
  calm: number;
  age: number;
  wet: boolean;
  resolve: (item: PlacedItem) => void;
}

/** What a gizmo drag or a brush stroke changes, recorded so it can be undone exactly. */
export interface GrassSnapshot {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  values: Float32Array;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

/** In-stream stones as flow obstacles (top height above the bed, sunk part excluded). */
export function stonesForFlow(stones: readonly PlacedStone[]): Stone[] {
  return stones
    .filter((s) => s.radius >= 0.25)
    .map((s) => ({ id: s.id, x: s.x, z: s.z, radius: s.radius, height: s.height * 0.8 }));
}

/**
 * Every placed thing in the valley behind one registry (plan 6.4, 6.8): stones, trees, ground plants, water plants
 * and fish schools, each with a stable uid. The builder adds, removes and moves items through here; each change also
 * updates your edit layer, re-solves the flow around stones, and keeps plants growing on a stone attached to it.
 */
export class WorldItems {
  edits: EditLayer = createEditLayer();
  private readonly p: WorldParts;
  private readonly schools = new Map<string, { id: number; item: PlacedItem }>();
  private nextSchool = 1;
  private readonly fixed = new Map<string, RAPIER.RigidBody>();
  private readonly falling: Falling[] = [];
  /** Revision bumped on every change (UI refreshes). */
  revision = 0;

  constructor(parts: WorldParts) {
    this.p = parts;
  }

  // --- Reading -------------------------------------------------------------------------------------------------

  get(uid: string): PlacedItem | null {
    const { rocks, trees, plants } = this.p;
    const stone = rocks.get(uid);
    if (stone) return this.fromStone(stone);
    const tree = trees.get(uid);
    if (tree)
      return {
        uid,
        category: 'trees',
        kind: tree.kind,
        variant: tree.variant,
        x: tree.x,
        y: tree.y,
        z: tree.z,
        yaw: tree.yaw,
        scale: tree.scale,
        height: tree.height,
      };
    const plant = plants.get(uid);
    if (plant) return this.fromPlant(plant);
    return this.schools.get(uid)?.item ?? null;
  }

  private fromStone(s: PlacedStone): PlacedItem {
    const scale = s.scale ?? 1;
    const item: PlacedItem = {
      uid: s.uid,
      category: 'stones',
      kind: s.kind,
      variant: s.variant,
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.yaw,
      scale,
      radius: s.radius / scale,
      height: s.height / scale,
      moss: s.moss,
    };
    if (s.quat) item.quat = [...s.quat];
    return item;
  }

  private fromPlant(p: PlacedPlant): PlacedItem {
    const def = this.plantDef(p.kind);
    const item: PlacedItem = {
      uid: p.uid,
      category: def?.category ?? 'plants',
      kind: p.kind,
      variant: p.variant,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      scale: p.scale,
    };
    if (p.depth !== undefined) item.depth = p.depth;
    if (p.host) item.host = p.host;
    return item;
  }

  private plantDef(kind: string): BushDef | WaterPlantDef | undefined {
    return this.p.catalog.bushes.find((b) => b.id === kind) ?? this.p.catalog.plants.find((b) => b.id === kind);
  }

  /** Items whose base is within r of (x, z), optionally limited to some categories. */
  near(x: number, z: number, r: number, categories?: readonly ItemCategory[]): PlacedItem[] {
    const out: PlacedItem[] = [];
    const want = (c: ItemCategory) => !categories || categories.includes(c);
    const r2 = r * r;
    const inside = (ix: number, iz: number) => (ix - x) ** 2 + (iz - z) ** 2 <= r2;
    if (want('stones')) for (const s of this.p.rocks.stones) if (inside(s.x, s.z)) out.push(this.fromStone(s));
    if (want('trees'))
      for (const t of this.p.trees.all()) if (inside(t.x, t.z)) out.push(this.get(t.uid) as PlacedItem);
    if (want('bushes') || want('plants'))
      for (const p of this.p.plants.all()) if (want(p.category) && inside(p.x, p.z)) out.push(this.fromPlant(p));
    if (want('fish')) for (const s of this.schools.values()) if (inside(s.item.x, s.item.z)) out.push(s.item);
    return out;
  }

  /** Pick shapes for every selectable item (stones, trees, plants). */
  *pickShapes(categories?: readonly ItemCategory[]): Generator<PickShape> {
    const want = (c: ItemCategory) => !categories || categories.includes(c);
    if (want('stones'))
      for (const s of this.p.rocks.stones)
        yield {
          uid: s.uid,
          shape: 'ellipsoid',
          x: s.x,
          y: s.y + s.height * 0.3,
          z: s.z,
          rx: s.radius * 1.15,
          ry: s.height * 0.75,
          rz: s.radius * 1.15,
        };
    if (want('trees')) yield* this.p.trees.pickShapes();
    if (want('plants') || want('bushes')) yield* this.p.plants.pickShapes();
  }

  /** What the cursor ray hits: an item (if any is in front of the ground), and the ground or water point. */
  raycast(
    ray: Ray,
    categories?: readonly ItemCategory[],
  ): { item: string | null; point: { x: number; y: number; z: number } | null; onWater: boolean } {
    const ground = rayHeight(ray, (x, z) => this.p.heightAt(x, z));
    const water = rayHeight(ray, (x, z) => this.p.flow.surfaceAt(x, z));
    const hitT = Math.min(ground?.t ?? Infinity, water?.t ?? Infinity);
    const item = pickNearest(ray, this.pickShapes(categories), hitT + 0.5);
    const onWater = !!water && (!ground || water.t <= ground.t);
    const point = onWater ? water : ground;
    return { item: item?.uid ?? null, point: point ? { x: point.x, y: point.y, z: point.z } : null, onWater };
  }

  /** The terrain, water and stone at a point, for the placement rules. */
  probe(x: number, z: number, stoneUid: string | null): PlacementProbe {
    const { valley, flow, clock } = this.p;
    const info = cellInfo(valley, x, z);
    const s = flow.sample(x, z);
    let water: PlacementProbe['water'] = null;
    const hour = clock.hour;
    const day = clock.dayOfYear;
    if (s && s.depth > 0.01) {
      const speed = Math.hypot(s.velocityX, s.velocityZ);
      water = {
        depth: s.depth,
        speed,
        surface: s.surface,
        bed: s.bed,
        temperature: waterTemperature({ dayOfYear: day, hour, speed, depth: s.depth }),
        pond: false,
      };
    } else {
      const pond = valley.pond;
      const level = flow.pondLevel();
      const bed = this.p.heightAt(x, z);
      if ((x - pond.x) ** 2 + (z - pond.z) ** 2 < (pond.radius + 2) ** 2 && level > bed + 0.01) {
        const depth = level - bed;
        water = {
          depth,
          speed: 0,
          surface: level,
          bed,
          temperature: waterTemperature({ dayOfYear: day, hour, speed: 0, depth, pond: true }),
          pond: true,
        };
      }
    }
    let stone: PlacementProbe['stone'] = null;
    if (stoneUid) {
      const st = this.p.rocks.get(stoneUid);
      if (st) stone = { uid: st.uid, top: st.y + st.height * 0.92, radius: st.radius };
    }
    return {
      ground: { height: info.height, slope: info.slope, riverDistance: info.riverDistance, wetness: info.wetness },
      water,
      stone,
    };
  }

  // --- Changing ------------------------------------------------------------------------------------------------

  /** Adds an item where it is (no physics). Stones re-solve the flow around them unless `resolve` is false. */
  async add(item: PlacedItem, options: { record?: boolean; resolve?: boolean } = {}): Promise<void> {
    const { rocks, trees, plants, fish } = this.p;
    switch (item.category) {
      case 'stones': {
        const scale = item.scale || 1;
        const radius = (item.radius ?? 0.8) * scale;
        const height = (item.height ?? radius * 0.7) * scale;
        const stone: Omit<PlacedStone, 'id'> = {
          uid: item.uid,
          kind: item.kind,
          x: item.x,
          y: item.y,
          z: item.z,
          radius,
          height,
          yaw: item.yaw,
          variant: item.variant,
          moss: item.moss ?? 0.15,
          scale,
        };
        if (item.quat) stone.quat = [...item.quat];
        rocks.add(stone);
        if (options.resolve !== false) await this.resolveAround([item]);
        break;
      }
      case 'trees':
        trees.add({ ...item, phase: hashPhase(item.uid), uid: item.uid, height: item.height });
        break;
      case 'bushes':
      case 'plants': {
        const def = this.plantDef(item.kind);
        if (!def) return;
        const inst: PlacedPlant = { ...item, phase: hashPhase(item.uid) };
        plants.add(def, inst);
        break;
      }
      case 'fish': {
        const index = fish.speciesIndex(item.kind);
        if (index < 0) return;
        const id = this.nextSchool++;
        this.schools.set(item.uid, { id, item: { ...item } });
        await fish.release(index, item.x, item.z, item.count ?? 12, 1.5 + Math.sqrt(item.count ?? 12) * 0.35, id);
        break;
      }
    }
    if (options.record !== false) addItem(this.edits, item);
    this.revision++;
  }

  /**
   * Removes an item, and any plants growing on it. Returns everything removed (the item first), for undo.
   */
  async remove(uid: string, options: { record?: boolean; resolve?: boolean } = {}): Promise<PlacedItem[]> {
    const item = this.get(uid);
    if (!item) return [];
    const removed: PlacedItem[] = [item];
    switch (item.category) {
      case 'stones': {
        this.p.rocks.remove(uid);
        const body = this.fixed.get(uid);
        if (body) {
          this.p.physics.removeBody(body);
          this.fixed.delete(uid);
        }
        for (const p of [...this.p.plants.all()])
          if (p.host === uid) {
            removed.push(this.fromPlant(p));
            this.p.plants.remove(p.uid);
            if (options.record !== false) removeItem(this.edits, p.uid);
          }
        if (options.resolve !== false) await this.resolveAround([item]);
        break;
      }
      case 'trees':
        this.p.trees.remove(uid);
        break;
      case 'bushes':
      case 'plants':
        this.p.plants.remove(uid);
        break;
      case 'fish': {
        const school = this.schools.get(uid);
        if (school) await this.p.fish.removeSchool(school.id);
        this.schools.delete(uid);
        break;
      }
    }
    if (options.record !== false) removeItem(this.edits, uid);
    this.revision++;
    return removed;
  }

  /**
   * Moves, turns or scales an item. `live` skips the flow re-solve (a gizmo drag in progress); call `commitMoves`
   * when the drag ends. Plants on a stone move with it.
   */
  async move(uid: string, t: ItemTransform, options: { record?: boolean; live?: boolean } = {}): Promise<void> {
    const before = this.get(uid);
    if (!before) return;
    switch (before.category) {
      case 'stones': {
        const s = this.p.rocks.get(uid);
        if (!s) return;
        const k = (t.scale || 1) / (s.scale ?? 1);
        s.radius *= k;
        s.height *= k;
        s.scale = t.scale || 1;
        s.x = t.x;
        s.y = t.y;
        s.z = t.z;
        s.yaw = t.yaw;
        if (t.quat) s.quat = [...t.quat];
        else delete s.quat;
        this.p.rocks.updateOne(uid);
        // Hosted plants ride along.
        for (const p of [...this.p.plants.all()]) {
          if (p.host !== uid) continue;
          const moved = {
            x: p.x + t.x - before.x,
            y: p.y + t.y - before.y,
            z: p.z + t.z - before.z,
            yaw: p.yaw,
            scale: p.scale,
          };
          this.p.plants.move(p.uid, moved);
          if (options.record !== false) moveItem(this.edits, p.uid, moved);
        }
        const body = this.fixed.get(uid);
        if (body) {
          this.p.physics.removeBody(body);
          this.fixed.delete(uid);
        }
        if (!options.live) {
          this.p.rocks.refresh();
          await this.resolveAround([before, { ...before, ...t }]);
        }
        break;
      }
      case 'trees':
        this.p.trees.move(uid, t);
        break;
      case 'bushes':
      case 'plants':
        this.p.plants.move(uid, t);
        break;
      case 'fish':
        return;
    }
    if (options.record !== false) moveItem(this.edits, uid, t);
    this.revision++;
  }

  /** After a live gizmo drag: one flow re-solve around everything that moved. */
  async commitMoves(items: readonly { x: number; z: number; radius?: number }[]): Promise<void> {
    this.p.rocks.refresh();
    await this.resolveAround(items);
  }

  private async resolveAround(
    items: readonly { x: number; z: number; radius?: number; scale?: number }[],
  ): Promise<void> {
    if (items.length === 0) return;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let r = 0;
    for (const i of items) {
      minX = Math.min(minX, i.x);
      maxX = Math.max(maxX, i.x);
      minZ = Math.min(minZ, i.z);
      maxZ = Math.max(maxZ, i.z);
      r = Math.max(r, (i.radius ?? 1) * (i.scale ?? 1));
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const radius = Math.hypot(maxX - minX, maxZ - minZ) / 2 + r + 2;
    await this.p.flow.setStones(stonesForFlow(this.p.rocks.stones), { x: cx, z: cz, radius });
    this.p.plants.invalidate();
  }

  /** One full flow solve with every stone (after loading a valley). */
  async resolveAll(): Promise<void> {
    await this.p.flow.setStones(stonesForFlow(this.p.rocks.stones));
    this.p.plants.invalidate();
  }

  // --- Dropping stones with physics ----------------------------------------------------------------------------

  /**
   * Drops a stone from above its spot (plan 6.8): it falls with Rapier physics, splashes, settles, then freezes into a
   * flow obstacle. Resolves with the settled item once the flow has been re-solved around it.
   */
  drop(item: PlacedItem, fromHeight = 2.5): Promise<PlacedItem> {
    const { rocks, physics } = this.p;
    return new Promise((resolve) => {
      const start = { ...item, y: item.y + fromHeight };
      _q.setFromAxisAngle(UP, item.yaw);
      start.quat = [_q.x, _q.y, _q.z, _q.w];
      void this.add(start, { record: false, resolve: false });
      const s = rocks.get(item.uid);
      const points = rocks.hullPoints(item.kind, item.variant);
      if (!s || !points) {
        resolve(item);
        return;
      }
      // Stones already near the spot get colliders so the new one lands on them, not through them.
      for (const other of rocks.stones) {
        if (other.uid === item.uid || this.fixed.has(other.uid)) continue;
        if ((other.x - item.x) ** 2 + (other.z - item.z) ** 2 > (other.radius + s.radius + 4) ** 2) continue;
        const otherPoints = rocks.hullPoints(other.kind, other.variant);
        if (!otherPoints) continue;
        const q = other.quat ?? quatFromYaw(other.yaw);
        const rotation = { x: q[0], y: q[1], z: q[2], w: q[3] };
        this.fixed.set(other.uid, physics.addFixedStone(otherPoints, other.radius, other.height, other, rotation));
      }
      const def = this.p.catalog.stones.find((d) => d.id === item.kind);
      const body = physics.dropStone(
        points,
        s.radius,
        s.height,
        s,
        { x: _q.x, y: _q.y, z: _q.z, w: _q.w },
        def?.density ?? 2.6,
      );
      // A little spin so it lands naturally.
      body.setAngvel(
        { x: (Math.random() - 0.5) * 1.5, y: (Math.random() - 0.5) * 1.5, z: (Math.random() - 0.5) * 1.5 },
        true,
      );
      this.falling.push({ uid: item.uid, body, calm: 0, age: 0, wet: false, resolve });
    });
  }

  /** Steps falling stones (call every frame after the physics step). */
  update(dt: number): void {
    for (let k = this.falling.length - 1; k >= 0; k--) {
      const f = this.falling[k] as Falling;
      const s = this.p.rocks.get(f.uid);
      if (!s) {
        this.p.physics.removeBody(f.body);
        this.falling.splice(k, 1);
        continue;
      }
      const t = f.body.translation();
      const r = f.body.rotation();
      s.x = t.x;
      s.y = t.y;
      s.z = t.z;
      s.quat = [r.x, r.y, r.z, r.w];
      _q.set(r.x, r.y, r.z, r.w);
      s.yaw = _e.setFromQuaternion(_q, 'YXZ').y;
      this.p.rocks.updateOne(f.uid);
      // Water: a splash on entry, then drag slows it down.
      const surface = this.p.flow.surfaceAt(t.x, t.z);
      const wet = surface !== null && t.y < surface;
      if (wet && !f.wet && surface !== null) {
        const v = f.body.linvel();
        this.p.waterFx.splash(t.x, surface, t.z, Math.min(2, s.radius * Math.abs(v.y) * 0.4 + 0.3));
        f.body.setLinearDamping(3);
        f.body.setAngularDamping(3);
      }
      f.wet = wet;
      f.age += dt;
      const lin = f.body.linvel();
      const ang = f.body.angvel();
      const still = Math.hypot(lin.x, lin.y, lin.z) < 0.08 && Math.hypot(ang.x, ang.y, ang.z) < 0.15;
      f.calm = still ? f.calm + dt : 0;
      if (f.calm > 0.35 || f.age > 6 || t.y < -500) {
        this.p.physics.freeze(f.body);
        this.fixed.set(f.uid, f.body);
        this.falling.splice(k, 1);
        const settled = this.fromStone(s);
        addItem(this.edits, settled);
        this.revision++;
        void this.resolveAround([settled]).then(() => f.resolve(settled));
      }
    }
  }

  get busy(): boolean {
    return this.falling.length > 0;
  }

  // --- Grass and springs ---------------------------------------------------------------------------------------

  private grassGrid(): DensityGrid | null {
    const { valley } = this.p;
    if (!valley.grassDensity) return null;
    const hf = valley.heightfield;
    return { data: valley.grassDensity, size: hf.size, cell: hf.cell, originX: hf.originX, originZ: hf.originZ };
  }

  /** Paints one grass dab; returns what it overwrote (for undo). */
  paintGrass(stroke: GrassStroke, record = true): GrassSnapshot | null {
    const grid = this.grassGrid();
    if (!grid) return null;
    const x0 = Math.max(0, Math.floor((stroke.x - stroke.radius - grid.originX) / grid.cell));
    const z0 = Math.max(0, Math.floor((stroke.z - stroke.radius - grid.originZ) / grid.cell));
    const x1 = Math.min(grid.size - 1, Math.ceil((stroke.x + stroke.radius - grid.originX) / grid.cell));
    const z1 = Math.min(grid.size - 1, Math.ceil((stroke.z + stroke.radius - grid.originZ) / grid.cell));
    const values = new Float32Array(Math.max(0, (x1 - x0 + 1) * (z1 - z0 + 1)));
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        values[(z - z0) * (x1 - x0 + 1) + (x - x0)] = grid.data[z * grid.size + x] as number;
    applyGrassStroke(grid, stroke);
    if (record) this.edits.grass.push({ ...stroke });
    this.p.grass.refresh();
    this.revision++;
    return { x0, z0, x1, z1, values };
  }

  /** Puts painted grass back (undo). */
  restoreGrass(snapshot: GrassSnapshot, record = true): void {
    const grid = this.grassGrid();
    if (!grid) return;
    const w = snapshot.x1 - snapshot.x0 + 1;
    for (let z = snapshot.z0; z <= snapshot.z1; z++)
      for (let x = snapshot.x0; x <= snapshot.x1; x++)
        grid.data[z * grid.size + x] = snapshot.values[(z - snapshot.z0) * w + (x - snapshot.x0)] as number;
    if (record) this.edits.grass.pop();
    this.p.grass.refresh();
    this.revision++;
  }

  async addSpring(spring: Spring, record = true): Promise<void> {
    if (record) this.edits.springs.push({ ...spring });
    await this.applySprings();
  }

  async removeSpring(uid: string, record = true): Promise<void> {
    if (record) this.edits.springs = this.edits.springs.filter((s) => s.uid !== uid);
    await this.applySprings();
  }

  private async applySprings(): Promise<void> {
    await this.p.flow.setInflows(
      this.edits.springs.map((s) => ({ section: s.section, bank: s.bank, discharge: s.discharge })),
    );
    this.p.plants.invalidate();
    this.revision++;
  }

  // --- Loading -------------------------------------------------------------------------------------------------

  /** Registers a fish school created at load (the first barbs), so it has a uid like everything else. */
  registerSchool(item: PlacedItem, id: number): void {
    this.schools.set(item.uid, { id, item: { ...item } });
    this.nextSchool = Math.max(this.nextSchool, id + 1);
  }

  /** Applies a saved edit layer on top of the freshly generated valley, with one flow solve at the end. */
  async applyEditLayer(layer: EditLayer): Promise<void> {
    this.edits = cloneEditLayer(layer);
    for (const uid of layer.removed) await this.remove(uid, { record: false, resolve: false });
    for (const [uid, t] of Object.entries(layer.moved)) await this.move(uid, t, { record: false, live: true });
    for (const item of layer.added) await this.add(item, { record: false, resolve: false });
    for (const stroke of layer.grass) this.paintGrass(stroke, false);
    if (layer.springs.length) await this.applySprings();
    this.p.rocks.refresh();
    await this.resolveAll();
  }
}

function quatFromYaw(yaw: number): [number, number, number, number] {
  _q.setFromAxisAngle(UP, yaw);
  return [_q.x, _q.y, _q.z, _q.w];
}

/** A stable sway phase for an item from its uid. */
function hashPhase(uid: string): number {
  let h = 2166136261;
  for (let i = 0; i < uid.length; i++) h = Math.imul(h ^ uid.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}
