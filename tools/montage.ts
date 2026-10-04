/** Dev helper: tiles the PNGs in a folder into one image. Usage: tsx tools/montage.ts <dir> <out.png> [columns] */
import { readdirSync } from 'node:fs';
import sharp from 'sharp';

const [, , dir = '.', out = 'montage.png', colsArg = '4'] = process.argv;
const cols = Number(colsArg);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.png'))
  .sort();
const W = 480;
const H = 270;
const images = await Promise.all(files.map((f) => sharp(`${dir}/${f}`).resize(W, H).toBuffer()));
const rows = Math.ceil(images.length / cols);
await sharp({ create: { width: W * cols, height: H * rows, channels: 3, background: '#000' } })
  .composite(images.map((input, i) => ({ input, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
  .png()
  .toFile(out);
console.log(files.join(' '));
