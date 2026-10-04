import * as THREE from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { World } from '../world/World';
import { findItem, type CatalogItem } from '../../content/catalog';
import { useUi, type AppMode, type BuilderTool, type GizmoMode, type OverlayChoice } from '../../state/store';
import { UndoStack, SetValueCommand, BatchCommand, type Command } from '../../builder/undo';
import { checkPlacement, type PlacementResult } from '../../builder/placement';
import { newUid, type ItemCategory, type ItemTransform, type PlacedItem, type Spring } from '../../builder/editLayer';
import { scatterDab, itemsInCircle } from '../../builder/brush';
import type { Ray } from '../../builder/picking';
import { getSetting, withSetting, type ValleySettings } from '../../state/settings';
import { encodeSave } from '../../save/saveData';
import { previewFor } from './previews';
import type { GrassSnapshot } from '../world/WorldItems';
import { createRng } from '../../sim/rng';

/** Human labels for undo steps, by settings path prefix. */
const SETTING_LABELS: Record<string, string> = {
  'water.discharge': 'water flow',
  'water.speed': 'water speed',
  'water.level': 'water level',
  'water.clarity': 'water clarity',
  'wind.speed': 'wind speed',
  'wind.gustiness': 'gustiness',
  'wind.turbulence': 'turbulence',
  wind: 'wind',
  'trees.flexibility': 'tree flexibility',
  'trees.sway': 'sway strength',
  'trees.flutter': 'leaf flutter',
  'trees.delay': 'response delay',
  'time.timeScale': 'time speed',
  'time.paused': 'pause',
  'time.lockedDay': 'season lock',
  'weather.mode': 'weather',
};

function labelFor(path: string): string {
  if (SETTING_LABELS[path]) return SETTING_LABELS[path] as string;
  if (path.startsWith('trees.species.')) return `${path.slice('trees.species.'.length)} flexibility`;
  if (path.startsWith('wind.')) return 'wind direction';
  return path;
}

/** Selectable categories (fish are watched, not moved, in Phase 4). */
const SELECTABLE: ItemCategory[] = ['stones', 'trees', 'bushes', 'plants'];

interface DragSession {
  item: CatalogItem;
  ghost: THREE.Object3D;
  yaw: number;
  scale: number;
  last: PlacementResult | null;
  point: { x: number; y: number; z: number } | null;
  stoneUid: string | null;
  overCanvas: boolean;
}

interface Stroke {
  commands: Command[];
  lastX: number;
  lastZ: number;
  lastTime: number;
  label: string;
}

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

function ringGeometry(): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(0.92, 1, 64);
  g.rotateX(-Math.PI / 2);
  return g;
}

function ringMaterial(color: number): { material: THREE.MeshBasicNodeMaterial; color: { value: THREE.Color } } {
  const c = uniform(new THREE.Color(color));
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.colorNode = vec3(c as any);
  m.opacity = 0.85;
  return { material: m, color: c as any };
}

/**
 * The Builder (plan 6.8) on the engine side: drag sessions from the catalog with a ghost preview and the placement
 * rules, stones that fall with physics, brushes, selection with a gizmo, undo/redo, and the control panels' settings.
 * React only sends commands here and reads the store.
 */
export class Builder {
  readonly undo = new UndoStack(100);
  readonly world: World;
  private readonly canvas: HTMLCanvasElement;
  private readonly gizmo: TransformControls;
  private readonly proxy = new THREE.Object3D();
  private readonly rings: THREE.InstancedMesh;
  private readonly ghostRing: THREE.Mesh;
  private readonly ghostColor: { value: THREE.Color };
  private readonly brushRing: THREE.Mesh;
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  private drag: DragSession | null = null;
  private stroke: Stroke | null = null;
  private pointer = { x: 0, y: 0, inside: false, down: false, downX: 0, downY: 0, shift: false };
  private gizmoBefore: { uid: string; t: ItemTransform }[] = [];
  private gizmoPivot = new THREE.Vector3();
  private syncTimer = 0;
  private springTimer = 0;
  private readonly rng = createRng('builder');

  constructor(world: World) {
    this.world = world;
    const { engine } = world;
    this.canvas = engine.renderer.domElement;
    this.gizmo = new TransformControls(engine.camera, this.canvas);
    this.gizmo.setSize(0.9);
    this.gizmo.showY = false;
    this.gizmo.enabled = false;
    engine.scene.add(this.proxy);
    engine.scene.add(this.gizmo.getHelper());
    this.gizmo.getHelper().visible = false;
    this.gizmo.addEventListener('mouseDown', () => this.gizmoStart());
    this.gizmo.addEventListener('objectChange', () => this.gizmoChange());
    this.gizmo.addEventListener('mouseUp', () => void this.gizmoEnd());

    const selection = ringMaterial(0xffd34d);
    this.rings = new THREE.InstancedMesh(ringGeometry(), selection.material, 64);
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 7;
    const ghost = ringMaterial(0x4ade80);
    this.ghostRing = new THREE.Mesh(ringGeometry(), ghost.material);
    this.ghostColor = ghost.color;
    this.ghostRing.visible = false;
    this.ghostRing.renderOrder = 7;
    const brush = ringMaterial(0xe0f2fe);
    this.brushRing = new THREE.Mesh(ringGeometry(), brush.material);
    this.brushRing.visible = false;
    this.brushRing.renderOrder = 7;
    engine.scene.add(this.rings, this.ghostRing, this.brushRing);

    this.undo.subscribe((state) => useUi.getState().set({ undo: state }));
    this.on(this.canvas, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    // Catalog drags start over the UI panel, so the ghost follows window-level moves.
    this.on(window, 'pointermove', (e) => {
      if (this.drag) this.dragMove((e as PointerEvent).clientX, (e as PointerEvent).clientY);
    });
    this.on(this.canvas, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.on(window, 'pointerup', (e) => void this.onPointerUp(e as PointerEvent));
    this.on(this.canvas, 'pointerleave', () => {
      this.pointer.inside = false;
    });
    this.on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent));
    world.onModeChange((mode) => this.onMode(mode));
    useUi
      .getState()
      .set({ settings: structuredClone(world.settings), mode: world.mode === 'builder' ? 'builder' : 'explore' });
  }

  private on(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }

  /**
   * Compiles the builder's helpers (gizmo, rings) behind the loading screen, so the first selection or drag doesn't
   * stall on a shader compile.
   */
  async precompile(): Promise<void> {
    const helpers = [this.ghostRing, this.brushRing, this.gizmo.getHelper()];
    const shown = helpers.map((h) => h.visible);
    this.gizmo.attach(this.proxy);
    this.rings.count = 1;
    for (const h of helpers) h.visible = true;
    const { renderer, scene, camera } = this.world.engine;
    await renderer.compileAsync(scene, camera);
    helpers.forEach((h, i) => (h.visible = shown[i] as boolean));
    this.rings.count = 0;
    this.gizmo.detach();
  }

  // --- Modes, tools and settings -------------------------------------------------------------------------------

  setMode(mode: AppMode): void {
    if (mode === 'photo') return;
    this.world.setMode(mode);
  }

  private onMode(mode: string): void {
    const ui = useUi.getState();
    ui.set({ mode: mode === 'builder' ? 'builder' : 'explore', hint: null });
    if (mode !== 'builder') {
      this.cancelDrag();
      this.select([]);
    }
  }

  setTool(tool: BuilderTool): void {
    useUi.getState().set({ tool });
    if (tool !== 'select') this.select([]);
  }

  setGizmoMode(mode: GizmoMode): void {
    useUi.getState().set({ gizmo: mode });
    this.gizmo.setMode(mode);
    // Things stay on the ground: move across it, turn about the vertical, scale evenly.
    this.gizmo.showX = mode !== 'rotate';
    this.gizmo.showZ = mode !== 'rotate';
    this.gizmo.showY = mode !== 'translate';
    if (mode === 'scale') {
      this.gizmo.showX = false;
      this.gizmo.showZ = false;
    }
  }

  setOverlay(kind: OverlayChoice): void {
    this.world.overlays.setKind(kind);
    useUi.getState().set({ overlay: kind, legend: this.world.overlays.legend });
  }

  /**
   * Changes a panel setting as an undoable step (a slider drag merges into one step). Water settings re-solve the
   * flow, so the panels send them when the slider is released.
   */
  async setSetting(path: string, value: unknown): Promise<void> {
    const before = getSetting(this.world.settings, path);
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    const apply = async (v: unknown) => {
      const next: ValleySettings = withSetting(this.world.settings, path, v);
      useUi.getState().set({ settings: structuredClone(next) });
      await this.world.applySettings(next);
      useUi.getState().set({ settings: structuredClone(this.world.settings) });
    };
    await this.undo.execute(
      new SetValueCommand({ key: path, label: `change ${labelFor(path)}`, before, after: value, apply }),
    );
  }

  async undoStep(): Promise<void> {
    if (!(await this.undo.undo())) return;
    this.refreshSelection();
  }

  async redoStep(): Promise<void> {
    if (!(await this.undo.redo())) return;
    this.refreshSelection();
  }

  // --- Picking ---------------------------------------------------------------------------------------------------

  private rayAt(clientX: number, clientY: number): Ray {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    const cam = this.world.engine.camera;
    const origin = cam.position.clone();
    _v.set(x, y, 0.5).unproject(cam).sub(origin).normalize();
    return { ox: origin.x, oy: origin.y, oz: origin.z, dx: _v.x, dy: _v.y, dz: _v.z };
  }

  private overCanvas(clientX: number, clientY: number): boolean {
    return document.elementFromPoint(clientX, clientY) === this.canvas;
  }

  // --- Drag and drop from the catalog ----------------------------------------------------------------------------

  /** Starts dragging a catalog item (pointer down on its card). */
  beginDrag(itemId: string): void {
    const item = findItem(this.world.catalog, itemId);
    if (!item || this.world.mode !== 'builder') return;
    this.cancelDrag();
    const ghost = previewFor(this.world, item) ?? new THREE.Group();
    ghost.visible = false;
    this.world.engine.scene.add(ghost);
    this.drag = {
      item,
      ghost,
      yaw: this.rng.range(0, Math.PI * 2),
      scale: 1,
      last: null,
      point: null,
      stoneUid: null,
      overCanvas: false,
    };
    this.world.wheelCaptured = true;
    this.select([]);
  }

  /** Follows the pointer during a drag (also called from window pointer moves while over the UI). */
  dragMove(clientX: number, clientY: number): void {
    const d = this.drag;
    if (!d) return;
    const ui = useUi.getState();
    d.overCanvas = this.overCanvas(clientX, clientY);
    const rect = this.canvas.getBoundingClientRect();
    if (!d.overCanvas) {
      d.ghost.visible = false;
      this.ghostRing.visible = false;
      ui.set({ hint: { ok: false, text: 'Drop it in the valley', x: clientX - rect.left, y: clientY - rect.top } });
      return;
    }
    const ray = this.rayAt(clientX, clientY);
    const wantsStone = d.item.category === 'plants' && d.item.placement.surface === 'stone';
    const hit = this.world.items.raycast(ray, wantsStone ? ['stones'] : []);
    if (!hit.point) {
      d.ghost.visible = false;
      this.ghostRing.visible = false;
      ui.set({ hint: { ok: false, text: 'Point at the valley', x: clientX - rect.left, y: clientY - rect.top } });
      return;
    }
    d.point = hit.point;
    d.stoneUid = wantsStone ? hit.item : null;
    const probe = this.world.items.probe(hit.point.x, hit.point.z, d.stoneUid);
    const result = checkPlacement(d.item, probe);
    d.last = result;
    // Fish hang in the water column; everything else sits on its surface.
    const y = d.item.category === 'fish' && probe.water ? probe.water.surface - probe.water.depth * 0.5 : result.y;
    d.ghost.position.set(hit.point.x, y, hit.point.z);
    d.ghost.rotation.set(0, d.yaw, 0);
    d.ghost.scale.setScalar(d.scale);
    d.ghost.visible = true;
    const size = ((d.ghost.userData.radius as number | undefined) ?? 1) * d.scale;
    this.ghostRing.position.set(hit.point.x, Math.max(result.y, probe.water?.surface ?? -Infinity) + 0.06, hit.point.z);
    this.ghostRing.scale.setScalar(Math.max(0.3, size * 1.1));
    this.ghostRing.visible = true;
    this.ghostColor.value.set(result.ok ? 0x4ade80 : 0xf87171);
    ui.set({ hint: { ok: result.ok, text: result.reason, x: clientX - rect.left, y: clientY - rect.top } });
  }

  /** Ends a drag: places the item when the spot is valid, otherwise cancels. */
  async endDrag(clientX: number, clientY: number): Promise<void> {
    const d = this.drag;
    if (!d) return;
    this.dragMove(clientX, clientY);
    const result = d.last;
    const point = d.point;
    const placeable = d.overCanvas && result?.ok && point;
    this.cancelDrag();
    if (!placeable || !result || !point) return;
    await this.place(d.item, point, result, d.yaw, d.scale, d.stoneUid);
  }

  cancelDrag(): void {
    if (!this.drag) return;
    this.world.engine.scene.remove(this.drag.ghost);
    this.drag = null;
    this.ghostRing.visible = false;
    this.world.wheelCaptured = false;
    useUi.getState().set({ hint: null });
  }

  /** Builds the placed item for a catalog entry at a spot that passed the placement rules. */
  private makeItem(
    item: CatalogItem,
    point: { x: number; z: number },
    result: PlacementResult,
    yaw: number,
    scale: number,
    host: string | null,
  ): PlacedItem {
    const uid = newUid(this.world.items.edits);
    const base: PlacedItem = {
      uid,
      category: item.category,
      kind: item.id,
      variant: 0,
      x: point.x,
      y: result.y,
      z: point.z,
      yaw,
      scale,
    };
    switch (item.category) {
      case 'stones': {
        const g = item.generator;
        const radius = g.radius[0] + (g.radius[1] - g.radius[0]) * this.rng.next();
        const flat = g.flatness[0] + (g.flatness[1] - g.flatness[0]) * this.rng.next();
        return {
          ...base,
          variant: this.rng.int(0, g.variants),
          radius,
          height: radius * flat,
          y: result.y - radius * flat * 0.25,
          moss: 0.1,
        };
      }
      case 'trees':
        return { ...base, variant: this.rng.int(0, item.generator.variants) };
      case 'bushes':
        return { ...base, variant: this.rng.int(0, item.generator.variants) };
      case 'plants': {
        const placed: PlacedItem = { ...base, variant: this.rng.int(0, item.generator.variants) };
        if (result.depth !== undefined) placed.depth = result.depth;
        if (host) placed.host = host;
        return placed;
      }
      case 'fish':
        return { ...base, count: useUi.getState().schoolSize };
    }
  }

  private async place(
    item: CatalogItem,
    point: { x: number; z: number },
    result: PlacementResult,
    yaw: number,
    scale: number,
    host: string | null,
  ): Promise<void> {
    const placed = this.makeItem(item, point, result, yaw, scale, host);
    const items = this.world.items;
    if (item.category === 'stones') {
      // The stone falls, splashes and settles; redo puts it straight back where it settled.
      let settled: PlacedItem | null = null;
      useUi.getState().set({ busy: 'Settling the stone' });
      await this.undo.execute({
        label: `place ${item.name.toLowerCase()}`,
        do: async () => {
          if (settled) await items.add(settled);
          else settled = await items.drop(placed);
        },
        undo: async () => {
          await items.remove(placed.uid);
        },
      });
      useUi.getState().set({ busy: null });
    } else {
      await this.undo.execute({
        label: `place ${item.category === 'fish' ? `${item.plural.toLowerCase()}` : item.name.toLowerCase()}`,
        do: () => items.add(placed),
        undo: async () => {
          await items.remove(placed.uid);
        },
      });
    }
  }

  /** The placement rules' verdict for an item at a point (tests and tools). */
  check(itemId: string, x: number, z: number, stoneUid: string | null = null): PlacementResult | null {
    const item = findItem(this.world.catalog, itemId);
    if (!item) return null;
    return checkPlacement(item, this.world.items.probe(x, z, stoneUid));
  }

  /** Places an item at a point exactly as a drop there would (tests and tools). Returns the verdict. */
  async placeAt(itemId: string, x: number, z: number, stoneUid: string | null = null): Promise<PlacementResult | null> {
    const item = findItem(this.world.catalog, itemId);
    const result = this.check(itemId, x, z, stoneUid);
    if (!item || !result?.ok) return result;
    await this.place(item, { x, z }, result, this.rng.range(0, Math.PI * 2), 1, result.host ?? null);
    return result;
  }

  // --- Selection and the gizmo ---------------------------------------------------------------------------------

  select(uids: string[]): void {
    const items = this.world.items;
    const selection = uids
      .map((uid) => items.get(uid))
      .filter((i): i is PlacedItem => i !== null)
      .map((i) => ({
        uid: i.uid,
        category: i.category,
        kind: i.kind,
        name: findItem(this.world.catalog, i.kind)?.name ?? i.kind,
      }));
    useUi.getState().set({ selection });
    this.placeGizmo();
  }

  /** Drops uids that no longer exist (after undo) and moves the gizmo. */
  private refreshSelection(): void {
    this.select(useUi.getState().selection.map((s) => s.uid));
  }

  private selected(): PlacedItem[] {
    return useUi
      .getState()
      .selection.map((s) => this.world.items.get(s.uid))
      .filter((i): i is PlacedItem => i !== null);
  }

  private placeGizmo(): void {
    const sel = this.selected();
    if (sel.length === 0 || this.world.mode !== 'builder') {
      this.gizmo.detach();
      this.gizmo.enabled = false;
      this.gizmo.getHelper().visible = false;
      return;
    }
    let x = 0;
    let y = 0;
    let z = 0;
    for (const i of sel) {
      x += i.x;
      y += i.y;
      z += i.z;
    }
    this.proxy.position.set(x / sel.length, y / sel.length, z / sel.length);
    this.proxy.rotation.set(0, 0, 0);
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrixWorld();
    this.gizmo.attach(this.proxy);
    this.gizmo.enabled = true;
    this.gizmo.getHelper().visible = true;
  }

  private gizmoStart(): void {
    this.gizmoBefore = this.selected().map((i) => ({
      uid: i.uid,
      t: { x: i.x, y: i.y, z: i.z, yaw: i.yaw, scale: i.scale, ...(i.quat ? { quat: i.quat } : {}) },
    }));
    this.gizmoPivot.copy(this.proxy.position);
  }

  /** The transform an item gets from the gizmo's current offset, turn and scale. */
  private gizmoTransform(before: ItemTransform, category: ItemCategory): ItemTransform {
    const dx = this.proxy.position.x - this.gizmoPivot.x;
    const dz = this.proxy.position.z - this.gizmoPivot.z;
    const turn = this.proxy.rotation.y;
    const s = Math.max(0.2, this.proxy.scale.y);
    const ox = before.x - this.gizmoPivot.x;
    const oz = before.z - this.gizmoPivot.z;
    const c = Math.cos(turn);
    const sn = Math.sin(turn);
    const x = this.gizmoPivot.x + ox * c + oz * sn + dx;
    const z = this.gizmoPivot.z - ox * sn + oz * c + dz;
    // Back onto the ground (or the stream bed) wherever it ends up.
    const bed = this.world.flow.sample(x, z)?.bed;
    const ground =
      category === 'stones' || category === 'plants' ? (bed ?? this.world.heightAt(x, z)) : this.world.heightAt(x, z);
    const lift =
      before.y -
      (category === 'stones' || category === 'plants'
        ? (this.world.flow.sample(before.x, before.z)?.bed ?? this.world.heightAt(before.x, before.z))
        : this.world.heightAt(before.x, before.z));
    const t: ItemTransform = {
      x,
      y: ground + lift,
      z,
      yaw: before.yaw + turn,
      scale: Math.min(4, Math.max(0.25, before.scale * s)),
    };
    if (before.quat) {
      _q.set(before.quat[0], before.quat[1], before.quat[2], before.quat[3]).premultiply(
        new THREE.Quaternion().setFromAxisAngle(UP, turn),
      );
      t.quat = [_q.x, _q.y, _q.z, _q.w];
    }
    return t;
  }

  private gizmoChange(): void {
    if (!this.gizmo.dragging) return;
    for (const b of this.gizmoBefore) {
      const item = this.world.items.get(b.uid);
      if (!item) continue;
      void this.world.items.move(b.uid, this.gizmoTransform(b.t, item.category), { record: false, live: true });
    }
  }

  private async gizmoEnd(): Promise<void> {
    const before = this.gizmoBefore;
    this.gizmoBefore = [];
    if (before.length === 0) return;
    const after: { uid: string; t: ItemTransform }[] = [];
    for (const b of before) {
      const item = this.world.items.get(b.uid);
      if (item)
        after.push({
          uid: b.uid,
          t: {
            x: item.x,
            y: item.y,
            z: item.z,
            yaw: item.yaw,
            scale: item.scale,
            ...(item.quat ? { quat: item.quat } : {}),
          },
        });
    }
    const items = this.world.items;
    const apply = async (list: { uid: string; t: ItemTransform }[]) => {
      for (const m of list) await items.move(m.uid, m.t, { live: true });
      await items.commitMoves([...before.map((b) => b.t), ...after.map((a) => a.t)]);
    };
    // Record the final positions in the edit layer and re-solve the water once.
    await apply(after);
    this.undo.record({
      label: before.length > 1 ? `move ${before.length} things` : 'move',
      do: () => apply(after),
      undo: () => apply(before),
    });
    this.placeGizmo();
  }

  /** Deletes the selection as one undo step (plants on a stone go with it). */
  async deleteSelection(): Promise<void> {
    const uids = useUi.getState().selection.map((s) => s.uid);
    if (uids.length === 0) return;
    this.select([]);
    await this.undo.execute(this.removeCommand(uids, uids.length > 1 ? `delete ${uids.length} things` : 'delete'));
  }

  private removeCommand(uids: string[], label: string): Command {
    const items = this.world.items;
    let removed: PlacedItem[] = [];
    return {
      label,
      do: async () => {
        removed = [];
        for (const uid of uids) removed.push(...(await items.remove(uid)));
      },
      undo: async () => {
        for (let i = removed.length - 1; i >= 0; i--) await items.add(removed[i] as PlacedItem);
      },
    };
  }

  // --- Brushes and the spring tool ---------------------------------------------------------------------------------

  private async brushDab(point: { x: number; z: number }): Promise<void> {
    const ui = useUi.getState();
    const s = this.stroke;
    if (!s) return;
    const items = this.world.items;
    if (ui.tool === 'scatter') {
      const item = ui.brushItem ? findItem(this.world.catalog, ui.brushItem) : undefined;
      if (!item || item.category === 'fish' || item.category === 'trees') return;
      const spacing =
        item.category === 'stones' ? Math.max(0.3, item.generator.radius[1] * 2.5) : item.placement.spacing;
      const existing = items.near(point.x, point.z, ui.brush.radius + spacing, [item.category]);
      const dabs = scatterDab(
        `dab:${this.rng.next()}`,
        point.x,
        point.z,
        ui.brush,
        spacing,
        item.generator.variants,
        existing,
      );
      for (const d of dabs) {
        const probe = items.probe(d.x, d.z, null);
        const result = checkPlacement(item, probe);
        if (!result.ok) continue;
        const placed = this.makeItem(item, d, result, d.yaw, d.scale, null);
        placed.variant = d.variant;
        await items.add(placed, {
          resolve: item.category !== 'stones' || placed.radius === undefined || placed.radius < 0.25,
        });
        s.commands.push({
          label: '',
          do: () => items.add(placed),
          undo: async () => void (await items.remove(placed.uid)),
        });
      }
    } else if (ui.tool === 'erase') {
      const near = items.near(point.x, point.z, ui.brush.radius, ui.eraseCategories);
      const uids = itemsInCircle(near, point.x, point.z, ui.brush.radius);
      if (uids.length === 0) return;
      const cmd = this.removeCommand(uids, '');
      await cmd.do();
      s.commands.push(cmd);
    } else if (ui.tool === 'grass') {
      const stroke = {
        x: point.x,
        z: point.z,
        radius: ui.brush.radius,
        amount: (this.pointer.shift ? -1 : 1) * (0.15 + ui.brush.density * 0.5),
      };
      let snap: GrassSnapshot | null = items.paintGrass(stroke);
      s.commands.push({
        label: '',
        do: () => {
          snap = items.paintGrass(stroke);
        },
        undo: () => {
          if (snap) items.restoreGrass(snap);
        },
      });
    }
  }

  private async addSpring(point: { x: number; z: number }): Promise<void> {
    const bank = this.world.flow.bankAt(point.x, point.z);
    if (!bank) {
      useUi.getState().toast('Click on the stream bank to add a spring');
      return;
    }
    const spring: Spring = {
      uid: newUid(this.world.items.edits),
      section: bank.section,
      bank: bank.bank,
      discharge: 0.4,
      x: point.x,
      z: point.z,
    };
    const items = this.world.items;
    await this.undo.execute({
      label: 'add a spring',
      do: () => items.addSpring(spring),
      undo: () => items.removeSpring(spring.uid),
    });
  }

  // --- Pointer and keys --------------------------------------------------------------------------------------------

  private onPointerMove(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = e.clientX - rect.left;
    this.pointer.y = e.clientY - rect.top;
    this.pointer.inside = true;
    this.pointer.shift = e.shiftKey;
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.world.mode !== 'builder' || e.button !== 0 || this.drag) return;
    // The gizmo handles its own handles.
    if (this.gizmo.enabled && this.gizmo.axis !== null) return;
    this.pointer.down = true;
    this.pointer.downX = e.clientX;
    this.pointer.downY = e.clientY;
    this.pointer.shift = e.shiftKey;
    const tool = useUi.getState().tool;
    if (tool === 'scatter' || tool === 'erase' || tool === 'grass') {
      const hit = this.world.items.raycast(this.rayAt(e.clientX, e.clientY), []);
      if (!hit.point) return;
      const label =
        tool === 'scatter'
          ? `scatter ${findItem(this.world.catalog, useUi.getState().brushItem ?? '')?.name.toLowerCase() ?? ''}`
          : tool === 'erase'
            ? 'erase'
            : 'paint grass';
      this.stroke = { commands: [], lastX: hit.point.x, lastZ: hit.point.z, lastTime: performance.now(), label };
      void this.brushDab(hit.point);
    }
  }

  private async onPointerUp(e: PointerEvent): Promise<void> {
    if (this.drag) {
      await this.endDrag(e.clientX, e.clientY);
      return;
    }
    if (!this.pointer.down) return;
    this.pointer.down = false;
    if (this.stroke) {
      const s = this.stroke;
      this.stroke = null;
      if (s.commands.length) this.undo.record(new BatchCommand(s.label, s.commands));
      return;
    }
    if (this.world.mode !== 'builder' || this.gizmo.dragging) return;
    const moved = Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY);
    if (moved > 5) return;
    const tool = useUi.getState().tool;
    const ray = this.rayAt(e.clientX, e.clientY);
    if (tool === 'select') {
      const hit = this.world.items.raycast(ray, SELECTABLE);
      const current = useUi.getState().selection.map((s) => s.uid);
      if (!hit.item) this.select(e.shiftKey ? current : []);
      else if (e.shiftKey)
        this.select(current.includes(hit.item) ? current.filter((u) => u !== hit.item) : [...current, hit.item]);
      else this.select([hit.item]);
    } else if (tool === 'spring') {
      const hit = this.world.items.raycast(ray, []);
      if (hit.point) await this.addSpring(hit.point);
    }
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))
      return;
    if (e.code === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.setMode(this.world.mode === 'builder' ? 'explore' : 'builder');
      return;
    }
    if (this.world.mode !== 'builder') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      void (e.shiftKey ? this.redoStep() : this.undoStep());
    } else if (mod && e.code === 'KeyY') {
      e.preventDefault();
      void this.redoStep();
    } else if (e.code === 'Escape') {
      if (this.drag) this.cancelDrag();
      else this.select([]);
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      void this.deleteSelection();
    } else if (e.code === 'Digit1') this.setGizmoMode('translate');
    else if (e.code === 'Digit2') this.setGizmoMode('rotate');
    else if (e.code === 'Digit3') this.setGizmoMode('scale');
  }

  // --- Saving ------------------------------------------------------------------------------------------------------

  /** The current valley as `.riffle` bytes. */
  async saveBytes(): Promise<Uint8Array> {
    await this.undo.idle();
    return encodeSave({ data: this.world.snapshot(), sections: {} });
  }

  // --- Per frame ---------------------------------------------------------------------------------------------------

  update(dt: number): void {
    const world = this.world;
    const ui = useUi.getState();
    // Mouse wheel during a drag turns the ghost (Shift: scales it).
    if (this.drag) {
      const w = world.input.takeWheel();
      if (w !== 0) {
        if (world.input.pressed('ShiftLeft', 'ShiftRight'))
          this.drag.scale = Math.min(2, Math.max(0.5, this.drag.scale * Math.pow(1.08, -w)));
        else this.drag.yaw += w * 0.26;
        this.drag.ghost.rotation.y = this.drag.yaw;
        this.drag.ghost.scale.setScalar(this.drag.scale);
      }
    }
    // Brush ring under the cursor, and dabs while painting.
    const brushTool = world.mode === 'builder' && (ui.tool === 'scatter' || ui.tool === 'erase' || ui.tool === 'grass');
    if (brushTool && this.pointer.inside && !this.drag) {
      const rect = this.canvas.getBoundingClientRect();
      const hit = world.items.raycast(this.rayAt(rect.left + this.pointer.x, rect.top + this.pointer.y), []);
      if (hit.point) {
        this.brushRing.position.set(hit.point.x, hit.point.y + 0.08, hit.point.z);
        this.brushRing.scale.setScalar(ui.brush.radius);
        this.brushRing.visible = true;
        const s = this.stroke;
        const now = performance.now();
        if (
          s &&
          (Math.hypot(hit.point.x - s.lastX, hit.point.z - s.lastZ) > ui.brush.radius * 0.5 || now - s.lastTime > 180)
        ) {
          s.lastX = hit.point.x;
          s.lastZ = hit.point.z;
          s.lastTime = now;
          void this.brushDab(hit.point);
        }
      } else this.brushRing.visible = false;
    } else this.brushRing.visible = false;

    // Rings under selected things.
    const sel = world.mode === 'builder' ? this.selected() : [];
    let n = 0;
    for (const item of sel) {
      if (n >= this.rings.instanceMatrix.count) break;
      const size =
        item.category === 'stones'
          ? (item.radius ?? 1) * item.scale * 1.3
          : item.category === 'trees'
            ? 1.6 * item.scale
            : 0.6 * item.scale;
      _m.compose(_v.set(item.x, item.y + 0.1, item.z), _q.identity(), new THREE.Vector3(size, 1, size));
      this.rings.setMatrixAt(n++, _m);
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;

    // Springs bubble where they join the stream.
    this.springTimer -= dt;
    if (this.springTimer <= 0) {
      this.springTimer = 0.45;
      for (const s of world.items.edits.springs) {
        const surface = world.flow.surfaceAt(s.x, s.z) ?? world.heightAt(s.x, s.z);
        world.waterFx.splash(s.x, surface, s.z, 0.08);
      }
    }

    // A few times a second: clock and legend for the panels.
    this.syncTimer -= dt;
    if (this.syncTimer <= 0) {
      this.syncTimer = 0.25;
      const c = world.clock;
      ui.set({
        clock: { hour: c.hour, day: c.dayOfYear, season: c.season(), year: c.year },
        legend: world.overlays.legend,
        busy: world.items.busy ? 'Settling the stone' : ui.busy === 'Settling the stone' ? null : ui.busy,
      });
    }
  }

  dispose(): void {
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.world.engine.scene.remove(this.gizmo.getHelper(), this.proxy, this.rings, this.ghostRing, this.brushRing);
  }
}
