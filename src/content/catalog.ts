/**
 * Loads every JSON file in content/ and validates it (plan 7). Invalid files are reported, not fatal, so one bad
 * file never stops the valley from loading.
 */
import { stoneSchema, treeSchema, type StoneDef, type TreeDef } from './schema';

export interface Catalog {
  trees: TreeDef[];
  stones: StoneDef[];
  errors: string[];
}

const files = import.meta.glob('/content/**/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

let cached: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (cached) return cached;
  const catalog: Catalog = { trees: [], stones: [], errors: [] };
  for (const [path, data] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const category = (data as { category?: string }).category;
    const schema = category === 'trees' ? treeSchema : category === 'stones' ? stoneSchema : null;
    if (!schema) {
      catalog.errors.push(`${path}: unknown category "${String(category)}"`);
      continue;
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      catalog.errors.push(`${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      continue;
    }
    if (parsed.data.category === 'trees') catalog.trees.push(parsed.data);
    else catalog.stones.push(parsed.data as StoneDef);
  }
  cached = catalog;
  return catalog;
}
