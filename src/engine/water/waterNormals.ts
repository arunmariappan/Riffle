import * as THREE from 'three/webgpu';
import { createRng } from '../../sim/rng';

/**
 * A tileable water ripple normal map, generated (no download): a sum of directional waves whose frequencies are
 * whole numbers of cycles per tile, so the texture repeats seamlessly. Slopes are computed analytically.
 */
export function createWaterNormalMap(size = 512, seed = 7): THREE.DataTexture {
  const rng = createRng(seed);
  const waves: { kx: number; ky: number; amp: number; phase: number }[] = [];
  for (let k = 0; k < 90; k++) {
    // Many waves in random directions (too few looks like a grid); integer wave numbers keep it tileable.
    const len = k < 10 ? rng.range(2, 6) : rng.range(6, 40);
    const angle = rng.range(0, Math.PI * 2);
    const kx = Math.round(Math.cos(angle) * len);
    const ky = Math.round(Math.sin(angle) * len);
    if (kx === 0 && ky === 0) continue;
    waves.push({ kx, ky, amp: 1 / Math.pow(Math.hypot(kx, ky), 1.25), phase: rng.range(0, Math.PI * 2) });
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0;
      let dy = 0;
      const u = x / size;
      const v = y / size;
      for (const w of waves) {
        const arg = 2 * Math.PI * (w.kx * u + w.ky * v) + w.phase;
        const c = Math.cos(arg) * w.amp * 2 * Math.PI;
        dx += c * w.kx;
        dy += c * w.ky;
      }
      // Scale slopes to a pleasant strength, then encode.
      const s = 0.0075;
      const nx = -dx * s;
      const ny = -dy * s;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
