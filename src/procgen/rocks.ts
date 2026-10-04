import * as THREE from 'three/webgpu';
import { createSimplex2 } from '../sim/noise';
import { createRng } from '../sim/rng';

/**
 * A rock of radius 1 (scaled per instance): a noise-displaced icosphere, flattened by `flatness`
 * (height / radius) and sunk flat at the bottom so it sits on the ground or the stream bed.
 */
export function generateRock(seed: number, flatness: number, roughness: number, detail = 3): THREE.BufferGeometry {
  const rng = createRng(seed);
  const noise = createSimplex2(seed + 17);
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const stretchX = rng.range(0.85, 1.2);
  const stretchZ = rng.range(0.85, 1.2);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n1 = noise(v.x * 1.3 + v.y * 0.7, v.z * 1.3 - v.y * 0.4);
    const n2 = noise(v.x * 3.1 + 7, v.z * 3.1 + v.y * 2.3) * 0.5;
    // Faceted, chunky granite: quantize the low-frequency noise a little.
    const facet = Math.round(n1 * 3) / 3;
    const r = 1 + roughness * (0.25 * facet + 0.75 * n1 + 0.35 * n2);
    v.multiplyScalar(r);
    v.x *= stretchX;
    v.z *= stretchZ;
    if (v.y < 0) v.y *= 0.35; // flat-ish base
    v.y *= flatness;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export interface LiteTree {
  trunk: THREE.BufferGeometry;
  canopy: THREE.BufferGeometry;
}

/**
 * Cheap far-distance tree (plan 6.4 LOD): a tapered trunk plus a few canopy blobs matching the species silhouette.
 * About 300 triangles, so thousands of distant trees stay affordable.
 */
export function generateLiteTree(
  seed: number,
  height: number,
  radius: number,
  shape: 'round' | 'cone' | 'spreading',
): LiteTree {
  const rng = createRng(seed);
  const trunkHeight = shape === 'cone' ? height * 0.85 : height * 0.55;
  const trunk = new THREE.CylinderGeometry(
    Math.max(0.08, height * 0.012),
    Math.max(0.14, height * 0.022),
    trunkHeight,
    6,
    1,
    true,
  );
  trunk.translate(0, trunkHeight / 2, 0);
  const parts: THREE.BufferGeometry[] = [];
  if (shape === 'cone') {
    const tiers = 4;
    for (let t = 0; t < tiers; t++) {
      const f = t / tiers;
      const tierH = height * 0.32;
      const r = radius * (1 - f * 0.75) * rng.range(0.85, 1.05);
      const cone = new THREE.ConeGeometry(r, tierH, 9, 1, true);
      cone.translate(0, height * 0.25 + f * height * 0.62 + tierH / 2, 0);
      parts.push(cone);
    }
  } else {
    const blobs = shape === 'spreading' ? 5 : 4;
    for (let b = 0; b < blobs; b++) {
      const s = new THREE.IcosahedronGeometry(1, 0);
      const r = radius * rng.range(0.45, 0.65);
      const flat = shape === 'spreading' ? 0.55 : 0.8;
      s.scale(r, r * flat, r);
      const a = rng.range(0, Math.PI * 2);
      const d = radius * rng.range(0.15, 0.45);
      const y = height * rng.range(shape === 'spreading' ? 0.55 : 0.5, 0.82);
      s.translate(Math.cos(a) * d, y, Math.sin(a) * d);
      parts.push(s);
    }
  }
  const canopy = mergeGeometries(parts);
  canopy.computeVertexNormals();
  return { trunk, canopy };
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const p of parts) {
    const g = p.index ? p : p;
    const pos = g.attributes.position as THREE.BufferAttribute;
    if (!g.attributes.normal) g.computeVertexNormals();
    const nor = g.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) indices.push(g.index.getX(i) + offset);
    else for (let i = 0; i < pos.count; i++) indices.push(i + offset);
    offset += pos.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setIndex(indices);
  out.computeBoundingSphere();
  return out;
}
