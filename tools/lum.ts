/** Dev helper: mean RGB of the lower half of screenshots (exposure tuning). Usage: tsx tools/lum.ts <png>... */
import { basename } from 'node:path';
import sharp from 'sharp';

for (const file of process.argv.slice(2)) {
  const s = await sharp(file).extract({ left: 0, top: 300, width: 1280, height: 360 }).stats();
  const mean = s.channels.slice(0, 3).map((c) => c.mean.toFixed(1));
  console.log(basename(file), 'mean RGB', mean.join(','));
}
