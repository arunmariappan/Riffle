/**
 * Loads every JSON file in content/ and validates it (plan 7). Invalid files are reported, not fatal, so one bad
 * file never stops the valley from loading.
 */
import {
  bushSchema,
  stoneSchema,
  treeSchema,
  waterPlantSchema,
  type BushDef,
  type StoneDef,
  type TreeDef,
  type WaterPlantDef,
} from './schema';

export interface Catalog {
  trees: TreeDef[];
  stones: StoneDef[];
  bushes: BushDef[];
  plants: WaterPlantDef[];
  errors: string[];
}

const files = import.meta.glob('/content/**/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

const schemas = { trees: treeSchema, stones: stoneSchema, bushes: bushSchema, plants: waterPlantSchema } as const;

let cached: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (cached) return cached;
  const catalog: Catalog = { trees: [], stones: [], bushes: [], plants: [], errors: [] };
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
    else catalog.plants.push(item);
  }
  cached = catalog;
  return catalog;
}
