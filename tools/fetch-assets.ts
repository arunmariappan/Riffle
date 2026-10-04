/**
 * Downloads the CC0 source textures listed in tools/asset-manifest.ts from Poly Haven into assets-src/textures/.
 * Existing files are skipped. Usage: pnpm fetch-assets
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEXTURES } from './asset-manifest';

const ROOT = join(import.meta.dirname, '..', 'assets-src', 'textures');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

for (const tex of TEXTURES) {
  const files = (await (await fetch(`https://api.polyhaven.com/files/${tex.id}`)).json()) as Record<
    string,
    Record<string, Record<string, { url: string }>>
  >;
  const dir = join(ROOT, tex.id);
  await mkdir(dir, { recursive: true });
  for (const map of tex.maps) {
    const entry = files[map]?.[tex.resolution]?.jpg ?? files[map]?.[tex.resolution]?.png;
    if (!entry) {
      console.warn(`${tex.id}: no ${map} at ${tex.resolution}`);
      continue;
    }
    const ext = entry.url.endsWith('.png') ? 'png' : 'jpg';
    const out = join(dir, `${map.toLowerCase()}.${ext}`);
    if (await exists(out)) continue;
    const data = Buffer.from(await (await fetch(entry.url)).arrayBuffer());
    await writeFile(out, data);
    console.log(`${tex.id}/${map} ${(data.length / 1024).toFixed(0)} KB`);
  }
}
console.log('done');
