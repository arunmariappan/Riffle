/**
 * Your edits as a separate layer on top of the generated valley (plan 6.4): additions, removals of generated items,
 * moved generated items, grass painting and springs. The valley is rebuilt from its seed and this layer is applied
 * on top, so regenerating never loses an edit, and a save file only needs the seed plus this layer.
 * Pure TypeScript and plain JSON.
 */

export type ItemCategory = 'stones' | 'trees' | 'bushes' | 'plants' | 'fish';

export interface ItemTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** Full rotation (stones that tumbled and settled), x y z w. */
  quat?: [number, number, number, number];
}

export interface PlacedItem extends ItemTransform {
  /** `u<n>` for your items, `g:<category>:<n>` for generated ones. */
  uid: string;
  category: ItemCategory;
  /** Content id (`boulder-medium`, `lotus`, `denison-barb`). */
  kind: string;
  variant: number;
  /** Stones: footprint radius and height (meters). */
  radius?: number;
  height?: number;
  /** Stones: moss cover 0..1. */
  moss?: number;
  /** Water plants: water depth at the plant, for stem length. */
  depth?: number;
  /** Fish: school size. */
  count?: number;
  /** The item it grows on (Java fern on a stone). */
  host?: string;
}

/** A dab of the grass brush: amount > 0 grows grass, < 0 clears it. */
export interface GrassStroke {
  x: number;
  z: number;
  radius: number;
  amount: number;
}

/** A side brook from the spring tool (plan 6.2). */
export interface Spring {
  uid: string;
  section: number;
  bank: 'left' | 'right';
  discharge: number;
  x: number;
  z: number;
}

export interface EditLayer {
  version: 1;
  nextId: number;
  added: PlacedItem[];
  /** Generated items you removed. */
  removed: string[];
  /** Generated items you moved, rotated or scaled. */
  moved: Record<string, ItemTransform>;
  grass: GrassStroke[];
  springs: Spring[];
}

export function createEditLayer(): EditLayer {
  return { version: 1, nextId: 1, added: [], removed: [], moved: {}, grass: [], springs: [] };
}

export function isGenerated(uid: string): boolean {
  return uid.startsWith('g:');
}

export function generatedUid(category: ItemCategory, index: number): string {
  return `g:${category}:${index}`;
}

export function newUid(layer: EditLayer): string {
  return `u${layer.nextId++}`;
}

/** Records an added item (yours, or a generated one coming back on undo). */
export function addItem(layer: EditLayer, item: PlacedItem): void {
  if (isGenerated(item.uid)) {
    layer.removed = layer.removed.filter((u) => u !== item.uid);
    return;
  }
  if (!layer.added.some((a) => a.uid === item.uid)) layer.added.push({ ...item });
}

/** Records a removal. Returns the removed record of your own items (for undo), or null for generated ones. */
export function removeItem(layer: EditLayer, uid: string): PlacedItem | null {
  if (isGenerated(uid)) {
    if (!layer.removed.includes(uid)) layer.removed.push(uid);
    return null;
  }
  const i = layer.added.findIndex((a) => a.uid === uid);
  if (i < 0) return null;
  const [item] = layer.added.splice(i, 1);
  return item ?? null;
}

export function moveItem(layer: EditLayer, uid: string, t: ItemTransform): void {
  const copy: ItemTransform = { x: t.x, y: t.y, z: t.z, yaw: t.yaw, scale: t.scale };
  if (t.quat) copy.quat = [...t.quat];
  if (isGenerated(uid)) {
    layer.moved[uid] = copy;
    return;
  }
  const item = layer.added.find((a) => a.uid === uid);
  if (item) Object.assign(item, copy);
}

/**
 * The generated items after your removals and moves, followed by your own additions: the valley as you left it.
 */
export function applyEdits(generated: readonly PlacedItem[], layer: EditLayer): PlacedItem[] {
  const removed = new Set(layer.removed);
  const out: PlacedItem[] = [];
  for (const g of generated) {
    if (removed.has(g.uid)) continue;
    const m = layer.moved[g.uid];
    out.push(m ? { ...g, ...m } : g);
  }
  for (const a of layer.added) out.push({ ...a });
  return out;
}

/** A deep copy (for save files and tests). */
export function cloneEditLayer(layer: EditLayer): EditLayer {
  return JSON.parse(JSON.stringify(layer)) as EditLayer;
}

/** Checks the shape of an edit layer read from a file; throws with a readable reason when it is broken. */
export function validateEditLayer(data: unknown): EditLayer {
  const l = data as Partial<EditLayer> | null;
  if (!l || typeof l !== 'object') throw new Error('The edit layer is missing');
  if (l.version !== 1) throw new Error(`Unknown edit layer version ${String(l.version)}`);
  if (!Array.isArray(l.added) || !Array.isArray(l.removed) || typeof l.moved !== 'object' || l.moved === null)
    throw new Error('The edit layer is incomplete');
  return {
    version: 1,
    nextId: typeof l.nextId === 'number' ? l.nextId : l.added.length + 1,
    added: l.added,
    removed: l.removed,
    moved: l.moved,
    grass: Array.isArray(l.grass) ? l.grass : [],
    springs: Array.isArray(l.springs) ? l.springs : [],
  };
}
