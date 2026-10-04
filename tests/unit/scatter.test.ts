import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../../src/content/catalog';
import { cellInfo, scatterItems } from '../../src/sim/scatter/scatter';
import { generateValley } from '../../src/sim/terrain/valley';

describe('content catalog', () => {
  it('loads every JSON file without errors', () => {
    const catalog = loadCatalog();
    expect(catalog.errors).toEqual([]);
    expect(catalog.trees.map((t) => t.id)).toContain('tree-rhododendron');
    expect(catalog.stones.length).toBeGreaterThanOrEqual(7);
  });
});

describe('scatter', () => {
  const valley = generateValley({ seed: 'riffle', size: 513, cell: 2, droplets: 8000 });
  const catalog = loadCatalog();
  const items = catalog.trees.map((t) => ({ id: t.id, placement: t.placement, variants: 3 }));

  it('gives the same layout for the same seed', () => {
    const a = scatterItems(valley, items, { seed: 's1' });
    const b = scatterItems(valley, items, { seed: 's1' });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(200);
  });

  it('follows each species placement rules', () => {
    const out = scatterItems(valley, items, { seed: 's1' });
    for (const inst of out) {
      const def = catalog.trees.find((t) => t.id === inst.kind)!;
      const info = cellInfo(valley, inst.x, inst.z);
      expect(info.slope).toBeLessThanOrEqual(def.placement.maxSlope + 1e-6);
      const [lo, hi] = def.placement.riverDistance ?? [-Infinity, Infinity];
      const margin = (hi - lo) * 0.15 + 2.5;
      expect(info.riverDistance).toBeGreaterThan(lo - margin);
      expect(info.riverDistance).toBeLessThan(hi + margin);
    }
    // Nothing grows in the stream.
    expect(out.every((i) => cellInfo(valley, i.x, i.z).riverDistance > 0.5)).toBe(true);
  });

  it('keeps the minimum spacing', () => {
    const out = scatterItems(valley, items, { seed: 's2' });
    const byKind = new Map(catalog.trees.map((t) => [t.id, t.placement.spacing]));
    for (let i = 0; i < out.length; i += 7) {
      const a = out[i]!;
      for (let j = i + 1; j < out.length; j++) {
        const b = out[j]!;
        const min = Math.max(byKind.get(a.kind)!, byKind.get(b.kind)!) * 0.5;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(min - 1e-6);
      }
    }
  });
});
