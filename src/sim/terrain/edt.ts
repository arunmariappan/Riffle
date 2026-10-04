/**
 * Exact 2D Euclidean distance transform with nearest-seed lookup (Felzenszwalb & Huttenlocher).
 * Used to give every terrain cell its distance to the stream and the nearest stream cross-section.
 */

const INF = 1e20;

export interface DistanceField {
  width: number;
  height: number;
  /** Distance in cells to the nearest seed. */
  distance: Float32Array;
  /** Index (y * width + x) of the nearest seed cell, or -1. */
  nearest: Int32Array;
}

/** `seeds[i]` is true for seed cells. */
export function distanceTransform(seeds: Uint8Array, width: number, height: number): DistanceField {
  const n = width * height;
  // Pass 1: per column, distance (in rows) to the nearest seed and that seed's row.
  const colDist = new Float64Array(n);
  const colSeedRow = new Int32Array(n);
  for (let x = 0; x < width; x++) {
    let last = -1;
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      if (seeds[idx]) last = y;
      colDist[idx] = last < 0 ? INF : y - last;
      colSeedRow[idx] = last;
    }
    last = -1;
    for (let y = height - 1; y >= 0; y--) {
      const idx = y * width + x;
      if (seeds[idx]) last = y;
      if (last >= 0 && last - y < (colDist[idx] as number)) {
        colDist[idx] = last - y;
        colSeedRow[idx] = last;
      }
    }
  }

  // Pass 2: per row, lower envelope of parabolas f(q) = colDist(q)².
  const distance = new Float32Array(n);
  const nearest = new Int32Array(n).fill(-1);
  const f = new Float64Array(width);
  const v = new Int32Array(width);
  const z = new Float64Array(width + 1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let q = 0; q < width; q++) {
      const d = colDist[row + q] as number;
      f[q] = d >= INF ? INF : d * d;
    }
    let k = -1;
    for (let q = 0; q < width; q++) {
      if ((f[q] as number) >= INF) continue;
      count++;
      if (k < 0) {
        k = 0;
        v[0] = q;
        z[0] = -INF;
        z[1] = INF;
        continue;
      }
      const fq = (f[q] as number) + q * q;
      let vk = v[k] as number;
      let s = (fq - ((f[vk] as number) + vk * vk)) / (2 * q - 2 * vk);
      // z[0] is -INF, so k never drops below 0.
      while (s <= (z[k] as number)) {
        k--;
        vk = v[k] as number;
        s = (fq - ((f[vk] as number) + vk * vk)) / (2 * q - 2 * vk);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    if (count === 0) {
      for (let x = 0; x < width; x++) distance[row + x] = INF;
      continue;
    }
    let kk = 0;
    for (let x = 0; x < width; x++) {
      while ((z[kk + 1] as number) < x) kk++;
      const q = v[kk] as number;
      const d2 = (x - q) * (x - q) + (f[q] as number);
      distance[row + x] = Math.sqrt(d2);
      const seedRow = colSeedRow[row + q] as number;
      nearest[row + x] = seedRow < 0 ? -1 : seedRow * width + q;
    }
  }
  return { width, height, distance, nearest };
}
