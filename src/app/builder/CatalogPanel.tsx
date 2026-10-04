import { Tabs } from 'radix-ui';
import { useUi, type CatalogTab } from '../../state/store';
import type { Builder } from '../../engine/builder/Builder';
import type { CatalogItem } from '../../content/catalog';
import styles from '../ui.module.css';

const TABS: [CatalogTab, string][] = [
  ['fish', 'Fish'],
  ['plants', 'Water plants'],
  ['stones', 'Stones'],
  ['trees', 'Trees'],
  ['bushes', 'Bushes & ground'],
];

/** A colored stand-in while a thumbnail renders. */
const PLACEHOLDER: Record<CatalogTab, string> = {
  fish: '#d9a441',
  plants: '#4f9a5a',
  stones: '#8b8f92',
  trees: '#3f7a3a',
  bushes: '#6a9a3a',
};

function Card({ item, builder, tab }: { item: CatalogItem; builder: Builder; tab: CatalogTab }) {
  const thumb = useUi((s) => s.thumbnails[item.id]);
  const brushItem = useUi((s) => s.brushItem);
  const set = useUi((s) => s.set);
  return (
    <button
      className={brushItem === item.id ? styles.cardOn : styles.card}
      data-testid={`card-${item.id}`}
      title={item.description}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        set({ brushItem: item.id });
        builder.beginDrag(item.id);
      }}
      onDragStart={(e) => e.preventDefault()}
    >
      {thumb ? (
        <img className={styles.thumb} src={thumb} alt="" draggable={false} />
      ) : (
        <span className={styles.thumbPlaceholder} style={{ background: PLACEHOLDER[tab] }} />
      )}
      <span className={styles.cardName}>{item.name}</span>
    </button>
  );
}

/**
 * The catalog (plan 6.8): tabs for fish, water plants, stones, trees and bushes. Press on a card and drag it into the
 * valley; the card also becomes the scatter brush's item.
 */
export function CatalogPanel({ builder }: { builder: Builder }) {
  const tab = useUi((s) => s.catalogTab);
  const set = useUi((s) => s.set);
  const schoolSize = useUi((s) => s.schoolSize);
  const c = builder.world.catalog;
  const lists: Record<CatalogTab, CatalogItem[]> = {
    fish: c.fish,
    plants: c.plants,
    stones: c.stones,
    trees: c.trees,
    bushes: c.bushes,
  };
  return (
    <Tabs.Root
      className={styles.catalog}
      value={tab}
      onValueChange={(v) => set({ catalogTab: v as CatalogTab })}
      orientation="vertical"
    >
      <Tabs.List className={styles.tabs} aria-label="Catalog">
        {TABS.map(([id, label]) => (
          <Tabs.Trigger key={id} className={styles.tab} value={id}>
            {label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {TABS.map(([id]) => (
        <Tabs.Content key={id} className={styles.cardGrid} value={id}>
          {lists[id].map((item) => (
            <Card key={item.id} item={item} builder={builder} tab={id} />
          ))}
          {id === 'fish' && (
            <label className={styles.inline}>
              School size
              <input
                type="range"
                min={3}
                max={60}
                value={schoolSize}
                onChange={(e) => set({ schoolSize: Number(e.target.value) })}
              />
              <span>{schoolSize}</span>
            </label>
          )}
        </Tabs.Content>
      ))}
      <p className={styles.small}>Drag a card into the valley. Wheel turns it, Shift+wheel scales it, Esc cancels.</p>
    </Tabs.Root>
  );
}
