/**
 * Hand-picked CC0 source assets (plan D29). `pnpm fetch-assets` downloads them from Poly Haven into assets-src/
 * (Git LFS); `pnpm assets` processes them into public/assets/.
 */
export interface TextureSource {
  /** Poly Haven asset id. */
  id: string;
  /** What Riffle uses it for. */
  use: string;
  /** Maps to fetch: Diffuse, nor_gl (normal, OpenGL convention), Rough, AO. */
  maps: ('Diffuse' | 'nor_gl' | 'Rough' | 'AO')[];
  resolution: '1k' | '2k';
}

export const TEXTURES: TextureSource[] = [
  { id: 'leafy_grass', use: 'meadow ground', maps: ['Diffuse', 'nor_gl', 'Rough'], resolution: '1k' },
  { id: 'forest_leaves_02', use: 'forest floor, leaf litter', maps: ['Diffuse', 'nor_gl', 'Rough'], resolution: '1k' },
  {
    id: 'red_laterite_soil_stones',
    use: 'red-brown monsoon soil',
    maps: ['Diffuse', 'nor_gl', 'Rough'],
    resolution: '1k',
  },
  { id: 'rock_face_03', use: 'granite cliffs (triplanar)', maps: ['Diffuse', 'nor_gl', 'Rough'], resolution: '1k' },
  {
    id: 'mossy_rock',
    use: 'granite boulders with lichen and moss',
    maps: ['Diffuse', 'nor_gl', 'Rough'],
    resolution: '1k',
  },
  { id: 'moss_wood', use: 'moss overlay on rocks and damp ground', maps: ['Diffuse'], resolution: '1k' },
  { id: 'gray_rocks', use: 'scree and gravel fans', maps: ['Diffuse', 'nor_gl'], resolution: '1k' },
  { id: 'ganges_river_pebbles', use: 'stream bed', maps: ['Diffuse', 'nor_gl', 'Rough'], resolution: '1k' },
  { id: 'forrest_sand_01', use: 'sand and gravel bars', maps: ['Diffuse', 'nor_gl', 'Rough'], resolution: '1k' },
  { id: 'sakura_bark', use: 'wild cherry bark', maps: ['Diffuse', 'nor_gl'], resolution: '1k' },
  { id: 'trident_maple_bark', use: 'Japanese maple bark', maps: ['Diffuse', 'nor_gl'], resolution: '1k' },
  { id: 'pine_bark', use: 'Himalayan pine bark', maps: ['Diffuse', 'nor_gl'], resolution: '1k' },
  { id: 'japanese_zelkova_bark', use: 'rhododendron bark (stand-in)', maps: ['Diffuse', 'nor_gl'], resolution: '1k' },
];
