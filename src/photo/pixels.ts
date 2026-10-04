/** Pixel buffer helpers for stills and video frames. Pure TypeScript. */

/** GPU readbacks pad each row to 256 bytes; this packs the rows tightly. */
export function unpadRows(data: Uint8Array, width: number, height: number, bytesPerPixel: number): Uint8Array {
  const row = width * bytesPerPixel;
  if (data.length === row * height) return data;
  const stride = Math.floor(data.length / height);
  const out = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) out.set(data.subarray(y * stride, y * stride + row), y * row);
  return out;
}

/** A file name for a capture: riffle-photo-2026-10-04-1530.png. */
export function captureName(kind: 'photo' | 'timelapse', date: Date, ext: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `riffle-${kind}-${stamp}.${ext}`;
}
