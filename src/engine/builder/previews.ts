import type * as THREE from 'three/webgpu';
import type { CatalogItem } from '../../content/catalog';
import type { World } from '../world/World';
import { contentVersion, type ThumbnailJob } from '../thumbnails';

/**
 * A preview of a catalog item with its real generated geometry and materials (drag ghosts and catalog thumbnails).
 * `userData.radius` and `userData.height` give its size for framing.
 */
export function previewFor(world: World, item: CatalogItem, depth = 0.8): THREE.Object3D | null {
  switch (item.category) {
    case 'trees':
      return world.trees.preview(item.id);
    case 'stones':
      return world.rocks.preview(item.id);
    case 'bushes':
    case 'plants':
      return world.plants.preview(item, depth);
    case 'fish': {
      const index = world.fish.speciesIndex(item.id);
      return index >= 0 ? world.fish.preview(index) : null;
    }
  }
}

/** Thumbnail jobs for every catalog item. */
export function thumbnailJobs(world: World): ThumbnailJob[] {
  const c = world.catalog;
  const all: CatalogItem[] = [...c.fish, ...c.plants, ...c.stones, ...c.trees, ...c.bushes];
  return all.map((item) => ({ id: item.id, version: contentVersion(item), make: () => previewFor(world, item) }));
}
