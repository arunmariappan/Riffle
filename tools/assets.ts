/**
 * `pnpm assets`: processes assets-src/ into public/assets/ (gitignored, plan D29).
 * Textures become WebP (KTX2 once KTX-Software is installed, plan open item P4).
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, parse } from 'node:path';
import sharp from 'sharp';
import { TEXTURES } from './asset-manifest';

const SRC = join(import.meta.dirname, '..', 'assets-src', 'textures');
const OUT = join(import.meta.dirname, '..', 'public', 'assets', 'textures');

async function newer(src: string, out: string): Promise<boolean> {
  try {
    return (await stat(src)).mtimeMs > (await stat(out)).mtimeMs;
  } catch {
    return true;
  }
}

let converted = 0;
for (const tex of TEXTURES) {
  const srcDir = join(SRC, tex.id);
  const outDir = join(OUT, tex.id);
  await mkdir(outDir, { recursive: true });
  const files = await readdir(srcDir).catch(() => null);
  if (!files) {
    console.warn(`missing ${srcDir}: run pnpm fetch-assets`);
    continue;
  }
  for (const file of files) {
    const { name } = parse(file);
    const src = join(srcDir, file);
    const out = join(outDir, `${name}.webp`);
    if (!(await newer(src, out))) continue;
    const isColor = name === 'diffuse';
    await sharp(src)
      .resize(1024, 1024, { fit: 'fill' })
      .webp({ quality: isColor ? 86 : 92, effort: 5 })
      .toFile(out);
    converted++;
  }
}
console.log(`textures: ${converted} converted into ${OUT}`);
