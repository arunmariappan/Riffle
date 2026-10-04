/**
 * Loads every JSON file in content/ and validates it (plan 7). Invalid files are reported, not fatal, so one bad
 * file never stops the valley from loading.
 */
import {
  bushSchema,
  fishSchema,
  stoneSchema,
  treeSchema,
  waterPlantSchema,
  type BushDef,
  type FishDef,
  type StoneDef,
  type TreeDef,
  type WaterPlantDef,
} from './schema';

export interface Catalog {
  trees: TreeDef[];
  stones: StoneDef[];
  bushes: BushDef[];
  plants: WaterPlantDef[];
  fish: FishDef[];
  errors: string[];
}

/** Any catalog item (what the builder's catalog panel lists). */
export type CatalogItem = TreeDef | StoneDef | BushDef | WaterPlantDef | FishDef;

const files = import.meta.glob('/content/**/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

const schemas = {
  trees: treeSchema,
  stones: stoneSchema,
  bushes: bushSchema,
  plants: waterPlantSchema,
  fish: fishSchema,
} as const;

let cached: Catalog | null = null;

/** Finds an item by id in any category. */
export function findItem(catalog: Catalog, id: string): CatalogItem | undefined {
  return (
    catalog.trees.find((i) => i.id === id) ??
    catalog.stones.find((i) => i.id === id) ??
    catalog.bushes.find((i) => i.id === id) ??
    catalog.plants.find((i) => i.id === id) ??
    catalog.fish.find((i) => i.id === id)
  );
}

export function loadCatalog(): Catalog {
  if (cached) return cached;
  const catalog: Catalog = { trees: [], stones: [], bushes: [], plants: [], fish: [], errors: [] };
  for (const [path, data] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const category = (data as { category?: string }).category;
    if (!category || !(category in schemas)) {
      catalog.errors.push(`${path}: unknown category "${String(category)}"`);
      continue;
    }
    const parsed = schemas[category as keyof typeof schemas].safeParse(data);
    if (!parsed.success) {
      catalog.errors.push(`${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      continue;
    }
    const item = parsed.data;
    if (item.category === 'trees') catalog.trees.push(item);
    else if (item.category === 'stones') catalog.stones.push(item);
    else if (item.category === 'bushes') catalog.bushes.push(item);
    else if (item.category === 'fish') catalog.fish.push(item);
    else catalog.plants.push(item);
  }
  cached = catalog;
  return catalog;
}
