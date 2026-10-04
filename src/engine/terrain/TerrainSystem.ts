import * as THREE from 'three/webgpu';
import {
  positionWorld,
  normalWorld,
  vec3,
  mix,
  smoothstep,
  float,
  mx_noise_float,
  uniform,
  max,
  vec4,
} from 'three/tsl';
import type { Valley } from '../../sim/terrain/valley';
import { sampleHeight } from '../../sim/terrain/heightfield';
import { createSimplex2, ridged, fbm, smoothstep as smooth } from '../../sim/noise';
import { createMaskTexture, createTerrainLook, createTerrainMaterial, type TerrainLook } from './terrainMaterial';

const CHUNK = 128;
/** Vertex spacing per detail level, in meters. */
const LOD_STEPS = [1, 2, 4, 8];
/** Distance (from the camera to the chunk's nearest point) where each detail level ends. */
const LOD_RANGES = [90, 220, 450, Infinity];

interface Chunk {
  mesh: THREE.Mesh;
  minX: number;
  minZ: number;
  lod: number;
  geometries: (THREE.BufferGeometry | null)[];
}

/**
 * The valley terrain (plan 6.1): 128 m chunks over the height map with four detail levels and skirts that hide
 * the seams between levels (a change from the plan's CDLOD, see C6), plus a far ring of ridges out to the horizon.
 */
export class TerrainSystem {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly look: TerrainLook;
  readonly maskTexture: THREE.DataTexture;
  readonly far: THREE.Mesh;
  private readonly chunks: Chunk[] = [];
  private readonly valley: Valley;

  constructor(valley: Valley) {
    this.valley = valley;
    this.look = createTerrainLook();
    this.maskTexture = createMaskTexture(valley);
    this.material = createTerrainMaterial(valley, this.maskTexture, this.look);
    const hf = valley.heightfield;
    const extent = (hf.size - 1) * hf.cell;
    const n = Math.round(extent / CHUNK);
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        const minX = hf.originX + cx * CHUNK;
        const minZ = hf.originZ + cz * CHUNK;
        const mesh = new THREE.Mesh(undefined, this.material);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        const chunk: Chunk = { mesh, minX, minZ, lod: -1, geometries: [null, null, null, null] };
        this.setLod(chunk, LOD_STEPS.length - 1);
        this.chunks.push(chunk);
        this.group.add(mesh);
      }
    }
    this.far = this.buildFarRing();
    this.group.add(this.far);
  }

  heightAt(x: number, z: number): number {
    return sampleHeight(this.valley.heightfield, x, z);
  }

  /** Picks detail levels by distance from the camera (with a little hysteresis). */
  update(camera: THREE.Vector3): void {
    for (const chunk of this.chunks) {
      const dx = Math.max(chunk.minX - camera.x, 0, camera.x - (chunk.minX + CHUNK));
      const dz = Math.max(chunk.minZ - camera.z, 0, camera.z - (chunk.minZ + CHUNK));
      const dist = Math.hypot(dx, dz, Math.max(0, camera.y - 400) * 0.5);
      let lod = LOD_RANGES.findIndex((r) => dist < r);
      if (lod < 0) lod = LOD_STEPS.length - 1;
      if (lod !== chunk.lod) {
        // Hysteresis: only coarsen when clearly past the range.
        if (lod > chunk.lod && chunk.lod >= 0 && dist < (LOD_RANGES[chunk.lod] as number) + 12) continue;
        this.setLod(chunk, lod);
      }
    }
  }

  private setLod(chunk: Chunk, lod: number): void {
    let geometry = chunk.geometries[lod];
    if (!geometry) {
      geometry = this.buildChunkGeometry(chunk.minX, chunk.minZ, LOD_STEPS[lod] as number);
      chunk.geometries[lod] = geometry;
    }
    chunk.mesh.geometry = geometry;
    chunk.lod = lod;
  }

  private buildChunkGeometry(minX: number, minZ: number, step: number): THREE.BufferGeometry {
    const hf = this.valley.heightfield;
    const verts = CHUNK / step + 1;
    const skirt = verts * 4;
    const positions = new Float32Array((verts * verts + skirt) * 3);
    const normals = new Float32Array((verts * verts + skirt) * 3);
    const indices: number[] = [];
    const sampleIndexHeight = (x: number, z: number): number => {
      const ix = Math.round((x - hf.originX) / hf.cell);
      const iz = Math.round((z - hf.originZ) / hf.cell);
      const cx = Math.min(hf.size - 1, Math.max(0, ix));
      const cz = Math.min(hf.size - 1, Math.max(0, iz));
      return hf.heights[cz * hf.size + cx] as number;
    };
    const normalAt = (x: number, z: number, out: Float32Array, o: number): void => {
      const e = Math.max(hf.cell, step * 0.5);
      const dx = sampleHeight(hf, x + e, z) - sampleHeight(hf, x - e, z);
      const dz = sampleHeight(hf, x, z + e) - sampleHeight(hf, x, z - e);
      const nx = -dx / (2 * e);
      const nz = -dz / (2 * e);
      const len = Math.hypot(nx, 1, nz);
      out[o] = nx / len;
      out[o + 1] = 1 / len;
      out[o + 2] = nz / len;
    };
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const x = minX + i * step;
        const z = minZ + j * step;
        const k = (j * verts + i) * 3;
        positions[k] = x;
        positions[k + 1] = sampleIndexHeight(x, z);
        positions[k + 2] = z;
        normalAt(x, z, normals, k);
      }
    }
    for (let j = 0; j < verts - 1; j++) {
      for (let i = 0; i < verts - 1; i++) {
        const a = j * verts + i;
        const b = a + 1;
        const c = a + verts;
        const d = c + 1;
        // Alternate the diagonal for a less regular look.
        if ((i + j) % 2 === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, c, d, a, d, b);
      }
    }
    // Skirts: a strip hanging down from each edge.
    let next = verts * verts;
    const depth = step * 2 + 1;
    const edge = (indicesAlong: number[], flip: boolean): void => {
      const start = next;
      for (const vi of indicesAlong) {
        positions[next * 3] = positions[vi * 3] as number;
        positions[next * 3 + 1] = (positions[vi * 3 + 1] as number) - depth;
        positions[next * 3 + 2] = positions[vi * 3 + 2] as number;
        normals[next * 3] = normals[vi * 3] as number;
        normals[next * 3 + 1] = normals[vi * 3 + 1] as number;
        normals[next * 3 + 2] = normals[vi * 3 + 2] as number;
        next++;
      }
      for (let k = 0; k < indicesAlong.length - 1; k++) {
        const a = indicesAlong[k] as number;
        const b = indicesAlong[k + 1] as number;
        const c = start + k;
        const d = start + k + 1;
        if (flip) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    };
    const row = (j: number) => Array.from({ length: verts }, (_, i) => j * verts + i);
    const col = (i: number) => Array.from({ length: verts }, (_, j) => j * verts + i);
    edge(row(0), false);
    edge(row(verts - 1), true);
    edge(col(0), true);
    edge(col(verts - 1), false);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, next * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals.subarray(0, next * 3), 3));
    // UVs (world xz / 4) give normal maps a tangent frame.
    const uvs = new Float32Array(next * 2);
    for (let v = 0; v < next; v++) {
      uvs[v * 2] = (positions[v * 3] as number) * 0.25;
      uvs[v * 2 + 1] = (positions[v * 3 + 2] as number) * 0.25;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(
      next > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1),
    );
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /**
   * Distant ridges: a radial mesh from inside the valley square out to 12 km. Inside the square it sits just below
   * the detailed terrain; outside it continues the valley north and south between rising, layered ridges.
   */
  private buildFarRing(): THREE.Mesh {
    const hf = this.valley.heightfield;
    const half = ((hf.size - 1) * hf.cell) / 2;
    const ridge = createSimplex2(`${this.valley.seed}:far`);
    const rings = 72;
    const segments = 256;
    const r0 = 300;
    const r1 = 12000;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const edgeHeight = (x: number, z: number): number =>
      sampleHeight(hf, Math.max(-half, Math.min(half, x)), Math.max(-half, Math.min(half, z)));
    const valleyAxis = (z: number): number => {
      // Extend the stream's direction beyond the map edges.
      const c = this.valley.controls;
      const first = c[0]!;
      const last = c[c.length - 1]!;
      return z < 0 ? first.x : last.x;
    };
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const radius = r0 * Math.pow(r1 / r0, t);
      for (let s = 0; s < segments; s++) {
        const a = (s / segments) * Math.PI * 2;
        const x = Math.cos(a) * radius;
        const z = Math.sin(a) * radius;
        const inside = Math.abs(x) < half - 1 && Math.abs(z) < half - 1;
        let y: number;
        if (inside) {
          y = sampleHeight(hf, x, z) - 3;
        } else {
          const outside = Math.max(Math.abs(x) - half, Math.abs(z) - half, 0);
          const base = edgeHeight(x, z);
          // A corridor continues the valley floor along the stream direction.
          const corridor =
            Math.exp(-(((x - valleyAxis(z)) / (220 + outside * 0.25)) ** 2)) * smooth(0, 400, Math.abs(z) - half);
          const rise = (1 - Math.exp(-outside / 1800)) * 1300 + outside * 0.04;
          const ridges = ridged(ridge, x, z, { octaves: 6, frequency: 0.00032 }) * 900 * smooth(0, 1500, outside);
          const bumps = fbm(ridge, x * 1.7, z * 1.7, { octaves: 4, frequency: 0.002 }) * 60;
          y = base + (rise + ridges + bumps) * (1 - corridor * 0.85) * smooth(0, 120, outside);
        }
        positions.push(x, y, z);
        colors.push(inside ? 0 : 1, 0, 0);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segments; s++) {
        const a = r * segments + s;
        const b = r * segments + ((s + 1) % segments);
        const c = a + segments;
        const d = b + segments;
        indices.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
    const slope = float(1).sub(normalWorld.y);
    const n = mx_noise_float(positionWorld.xz.mul(0.0015)).mul(0.5).add(0.5);
    const forestCol = mix(vec3(0.07, 0.12, 0.05), vec3(0.11, 0.16, 0.07), n);
    const rockCol = vec3(0.28, 0.27, 0.25);
    let col: any = mix(forestCol, rockCol, smoothstep(0.25, 0.5, slope).max(smoothstep(1200, 1700, positionWorld.y)));
    const snowLine = (this.look as any).snowLine;
    col = mix(
      col,
      vec3(0.9, 0.92, 0.96),
      smoothstep(snowLine, snowLine.add(150), positionWorld.y).mul(smoothstep(0.55, 0.3, slope)),
    );
    m.colorNode = vec4(col, 1);
    void max;
    void uniform;
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    return mesh;
  }
}
