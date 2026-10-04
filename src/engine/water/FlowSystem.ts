import * as THREE from 'three/webgpu';
import * as Comlink from 'comlink';
import { uniform, uv, vec3, vec4, float, mx_noise_float, smoothstep, mix, texture, attribute } from 'three/tsl';
import type { Valley } from '../../sim/terrain/valley';
import { buildRiverPath, buildPathLookup, worldToStream, type RiverPath, type PathLookup } from '../../sim/flow/path';
import type { Stone, SolveStats, SideInflow } from '../../sim/flow/field';
import { DoubleBuffer } from '../../sim/shared/doubleBuffer';
import { SharedFlowSampler, type SharedFlowConfig } from '../../sim/flow/sharedSampler';
import type { FlowWorkerApi, FlowLayout } from '../../workers/flow.worker';
import { FLOW_STRIDE } from '../../sim/flow/layout';
import { createWaterMaterial, createWaterLook, createStillFlowTexture, type WaterLook } from './waterMaterial';
import { createWaterNormalMap } from './waterNormals';

export interface FlowSample {
  velocityX: number;
  velocityZ: number;
  depth: number;
  surface: number;
  foam: number;
  shelter: number;
  bed: number;
}

const CELLS_ACROSS = 49;
/** Render every second cross-section (1 m along the stream). */
const ROW_STEP = 2;

/**
 * The living stream on the main thread (plan 6.2): drives the flow worker, mirrors its results from shared memory,
 * and keeps the water meshes, the flow texture and the world water-level map in sync.
 */
export class FlowSystem {
  readonly group = new THREE.Group();
  readonly look: WaterLook;
  /** The pond: still, greener, siltier water. */
  readonly pondLook: WaterLook;
  readonly path: RiverPath;
  readonly lookup: PathLookup;
  /** Flow cells (FLOW_STRIDE floats each), the latest published copy. */
  cells: Float32Array<ArrayBufferLike> = new Float32Array(0);
  levels: Float32Array<ArrayBufferLike> = new Float32Array(0);
  layout: FlowLayout = { ns: 0, nn: 0, ds: 0.5, dn: 0.5 };
  /** World water-surface height per height-map cell (−1000 = dry), for caustics and wet bands. */
  readonly levelMap: THREE.DataTexture;
  readonly flowTexture: THREE.DataTexture;
  lastStats: SolveStats | null = null;
  /** Bumped whenever new flow results arrive. */
  revision = 0;
  discharge = 4;
  speedMultiplier = 1;
  levelOffset = 0;

  private readonly valley: Valley;
  private worker: Worker | null = null;
  private api: Comlink.Remote<FlowWorkerApi> | null = null;
  private flowBuffer: DoubleBuffer | null = null;
  private levelBuffer: DoubleBuffer | null = null;
  private seenVersion = -1;
  private sampler: SharedFlowSampler | null = null;
  private config: SharedFlowConfig | null = null;
  private readonly riverMeshes: { mesh: THREE.Mesh; first: number; last: number }[] = [];
  private pond: THREE.Mesh | null = null;
  private waterfall: THREE.Mesh | null = null;
  private readonly waterfallTop = uniform(0);
  private readonly waterfallDrop = uniform(7);
  private readonly levelMapData: Uint16Array;
  private flowTexData = new Uint16Array(0);
  private readonly normalMap: THREE.DataTexture;
  private material: THREE.MeshStandardNodeMaterial | null = null;

  constructor(valley: Valley) {
    this.valley = valley;
    this.look = createWaterLook();
    this.pondLook = createWaterLook();
    (this.pondLook.turbidity as any).value = 0.45;
    (this.pondLook.scatter as any).value.setRGB(0.012, 0.06, 0.035);
    (this.pondLook.silt as any).value.setRGB(0.07, 0.08, 0.04);
    (this.pondLook.chop as any).value = 0.12;
    this.path = buildRiverPath(valley.controls, 0.5);
    const hf = valley.heightfield;
    const half = ((hf.size - 1) * hf.cell) / 2;
    this.lookup = buildPathLookup(this.path, { minX: -half, minZ: -half, maxX: half, maxZ: half }, 1, 20);
    this.levelMapData = new Uint16Array(hf.size * hf.size).fill(THREE.DataUtils.toHalfFloat(-1000));
    this.levelMap = new THREE.DataTexture(this.levelMapData, hf.size, hf.size, THREE.RedFormat, THREE.HalfFloatType);
    this.levelMap.magFilter = THREE.LinearFilter;
    this.levelMap.minFilter = THREE.LinearFilter;
    this.levelMap.needsUpdate = true;
    this.flowTexture = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    this.normalMap = createWaterNormalMap();
  }

  async init(stones: Stone[]): Promise<void> {
    this.worker = new Worker(new URL('../../workers/flow.worker.ts', import.meta.url), { type: 'module' });
    this.api = Comlink.wrap<FlowWorkerApi>(this.worker);
    const ns = this.path.count;
    this.flowBuffer = new DoubleBuffer(ns * CELLS_ACROSS * FLOW_STRIDE);
    this.levelBuffer = new DoubleBuffer(ns);
    const hf = this.valley.heightfield;
    const result = await this.api.init(
      {
        controls: this.valley.controls,
        heightfield: { ...hf, heights: hf.heights.slice() },
        reachStarts: this.valley.profile.reachStarts,
        cellsAcross: CELLS_ACROSS,
        discharge: this.discharge,
      },
      this.flowBuffer.handle(),
      this.levelBuffer.handle(),
    );
    this.layout = { ns: result.ns, nn: result.nn, ds: result.ds, dn: result.dn };
    const half = ((hf.size - 1) * hf.cell) / 2;
    const pond = this.valley.pond;
    this.config = {
      flow: this.flowBuffer.handle(),
      levels: this.levelBuffer.handle(),
      layout: this.layout,
      controls: this.valley.controls,
      bounds: { minX: -half, minZ: -half, maxX: half, maxZ: half },
      pond: { x: pond.x, z: pond.z, radius: pond.radius, section: pond.section },
    };
    this.sampler = new SharedFlowSampler(this.config);
    this.lastStats = result.stats;
    this.cells = new Float32Array(this.flowBuffer.length);
    this.levels = new Float32Array(this.levelBuffer.length);
    this.flowTexData = new Uint16Array(result.ns * result.nn * 4);
    this.flowTexture.image = { data: this.flowTexData, width: result.nn, height: result.ns };
    this.flowTexture.magFilter = THREE.LinearFilter;
    this.flowTexture.minFilter = THREE.LinearFilter;
    this.material = createWaterMaterial(this.flowTexture, this.normalMap, this.look);
    this.buildMeshes();
    this.pull(true);
    if (stones.length) await this.setStones(stones);
  }

  /** Copies new results from shared memory into textures and meshes (call every frame; cheap when unchanged). */
  pull(force = false): boolean {
    if (!this.sampler) return false;
    const fresh = this.sampler.refresh();
    if (!force && !fresh && this.sampler.version === this.seenVersion) return false;
    this.seenVersion = this.sampler.version;
    this.cells = this.sampler.cells;
    this.levels = this.sampler.levels;
    const toHalf = THREE.DataUtils.toHalfFloat;
    const n = this.layout.ns * this.layout.nn;
    for (let k = 0; k < n; k++) {
      const o = k * FLOW_STRIDE;
      this.flowTexData[k * 4] = toHalf(this.cells[o + 6] as number);
      this.flowTexData[k * 4 + 1] = toHalf(this.cells[o + 7] as number);
      this.flowTexData[k * 4 + 2] = toHalf(this.cells[o + 2] as number);
      this.flowTexData[k * 4 + 3] = toHalf(this.cells[o + 3] as number);
    }
    this.flowTexture.needsUpdate = true;
    this.updateMeshHeights();
    this.updateLevelMap();
    this.revision++;
    return true;
  }

  private buildMeshes(): void {
    const { ns, nn, dn } = this.layout;
    const p = this.path;
    const starts = [0, ...this.valley.profile.reachStarts, ns];
    for (let r = 0; r < starts.length - 1; r++) {
      const first = starts[r] as number;
      const last = (starts[r + 1] as number) - 1;
      const rows: number[] = [];
      for (let i = first; i <= last; i += ROW_STEP) rows.push(i);
      if (rows[rows.length - 1] !== last) rows.push(last);
      const positions = new Float32Array(rows.length * nn * 3);
      const uvs = new Float32Array(rows.length * nn * 2);
      const meters = new Float32Array(rows.length * nn * 2);
      const frames = new Float32Array(rows.length * nn * 2);
      const half = (nn - 1) / 2;
      rows.forEach((i, ri) => {
        for (let j = 0; j < nn; j++) {
          const v = ri * nn + j;
          const off = (j - half) * dn;
          positions[v * 3] = (p.points[i * 2] as number) + (p.normals[i * 2] as number) * off;
          positions[v * 3 + 2] = (p.points[i * 2 + 1] as number) + (p.normals[i * 2 + 1] as number) * off;
          uvs[v * 2] = (j + 0.5) / nn;
          uvs[v * 2 + 1] = (i + 0.5) / ns;
          meters[v * 2] = off;
          meters[v * 2 + 1] = i * p.spacing;
          frames[v * 2] = p.tangents[i * 2] as number;
          frames[v * 2 + 1] = p.tangents[i * 2 + 1] as number;
        }
      });
      const indices: number[] = [];
      for (let ri = 0; ri < rows.length - 1; ri++) {
        for (let j = 0; j < nn - 1; j++) {
          const a = ri * nn + j;
          const b = a + nn;
          indices.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      g.setAttribute(
        'normal',
        new THREE.BufferAttribute(
          new Float32Array(rows.length * nn * 3).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)),
          3,
        ),
      );
      g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      g.setAttribute('aMeters', new THREE.BufferAttribute(meters, 2));
      g.setAttribute('aFrame', new THREE.BufferAttribute(frames, 2));
      g.setIndex(indices);
      g.userData.rows = rows;
      const mesh = new THREE.Mesh(g, this.material!);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.riverMeshes.push({ mesh, first, last });
    }

    // Pond: still water at the stream's level where it joins.
    const pond = this.valley.pond;
    const pg = new THREE.CircleGeometry(pond.radius + 9, 72);
    pg.rotateX(-Math.PI / 2);
    const count = pg.attributes.position!.count;
    const pm = new Float32Array(count * 2);
    const pf = new Float32Array(count * 2);
    for (let v = 0; v < count; v++) {
      pm[v * 2] = (pg.attributes.position as THREE.BufferAttribute).getX(v) + pond.x;
      pm[v * 2 + 1] = (pg.attributes.position as THREE.BufferAttribute).getZ(v) + pond.z;
      pf[v * 2] = 1;
      pf[v * 2 + 1] = 0;
    }
    pg.setAttribute('aMeters', new THREE.BufferAttribute(pm, 2));
    pg.setAttribute('aFrame', new THREE.BufferAttribute(pf, 2));
    const pondMaterial = createWaterMaterial(createStillFlowTexture(), this.normalMap, this.pondLook);
    this.pond = new THREE.Mesh(pg, pondMaterial);
    this.pond.position.set(pond.x, 0, pond.z);
    this.pond.frustumCulled = false;
    this.pond.renderOrder = 1;
    this.group.add(this.pond);

    // Waterfall curtain at the reach break.
    const w = this.valley.profile.waterfall.section;
    this.waterfall = this.buildWaterfall(w);
    this.group.add(this.waterfall);
  }

  private buildWaterfall(w: number): THREE.Mesh {
    const p = this.path;
    const i = Math.max(0, w - 1);
    const hw = (this.valley.profile.halfWidth[i] as number) * 0.85;
    const across = 24;
    const down = 16;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const tx = p.tangents[i * 2] as number;
    const tz = p.tangents[i * 2 + 1] as number;
    for (let d = 0; d <= down; d++) {
      const f = d / down;
      for (let a = 0; a <= across; a++) {
        const off = (a / across - 0.5) * 2 * hw;
        // The sheet leaves the lip moving forward and curves down (a falling trajectory).
        const forward = 0.6 + 1.8 * Math.sqrt(f);
        positions.push(
          (p.points[i * 2] as number) + (p.normals[i * 2] as number) * off + tx * forward,
          -f,
          (p.points[i * 2 + 1] as number) + (p.normals[i * 2 + 1] as number) * off + tz * forward,
        );
        uvs.push(a / across, f);
      }
    }
    for (let d = 0; d < down; d++) {
      for (let a = 0; a < across; a++) {
        const k = d * (across + 1) + a;
        indices.push(k, k + 1, k + across + 1, k + 1, k + across + 2, k + across + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    const m = new THREE.MeshStandardNodeMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      roughness: 0.4,
      depthWrite: false,
    });
    const top: any = this.waterfallTop;
    const drop: any = this.waterfallDrop;
    // Unit-height sheet scaled to the real drop in the vertex shader (the drop follows the water levels).
    const pos = attribute('position', 'vec3');
    m.positionNode = vec3(pos.x, top.add(pos.y.mul(drop)), pos.z);
    const l: any = this.look;
    const streaks = mx_noise_float(vec3(uv().x.mul(26), uv().y.mul(3).sub(l.time.mul(1.6)), 0.5))
      .mul(0.5)
      .add(0.5);
    const fine = mx_noise_float(vec3(uv().x.mul(70), uv().y.mul(9).sub(l.time.mul(2.4)), 2.1))
      .mul(0.5)
      .add(0.5);
    const white = smoothstep(0.35, 0.8, streaks.mul(0.7).add(fine.mul(0.4))).add(uv().y.mul(0.35));
    m.colorNode = vec4(mix(vec3(0.55, 0.72, 0.7), vec3(0.95, 0.97, 0.97), white.clamp(0, 1)), 1);
    m.opacityNode = float(0.55)
      .add(white.mul(0.4))
      .mul(smoothstep(0, 0.06, uv().x).mul(smoothstep(1, 0.94, uv().x)));
    void texture;
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return mesh;
  }

  private updateMeshHeights(): void {
    const { nn } = this.layout;
    for (const { mesh } of this.riverMeshes) {
      const rows = mesh.geometry.userData.rows as number[];
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      rows.forEach((i, ri) => {
        const y = this.levels[i] as number;
        for (let j = 0; j < nn; j++) pos.setY(ri * nn + j, y);
      });
      pos.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
    }
    if (this.pond) this.pond.position.y = this.pondLevel();
    // The bed is smeared across the cliff in the last few cross-sections, so take the pool level a few meters
    // upstream of the lip for the top of the falling sheet, and the level just below the fall for its foot.
    const w = this.valley.profile.waterfall.section;
    const top = this.levels[Math.max(0, w - 8)] as number;
    const foot = this.levels[Math.min(this.levels.length - 1, w + 4)] as number;
    this.waterfallTop.value = top + 0.03;
    this.waterfallDrop.value = Math.max(0.5, top - foot + 0.3);
  }

  pondLevel(): number {
    return (this.levels[this.valley.pond.section] as number) ?? 0;
  }

  /** The waterfall's lip, direction, width and levels (spray and mist, audio). */
  waterfallInfo(): {
    x: number;
    z: number;
    tx: number;
    tz: number;
    nx: number;
    nz: number;
    halfWidth: number;
    top: number;
    foot: number;
    strength: number;
  } {
    const p = this.path;
    const w = this.valley.profile.waterfall.section;
    const i = Math.max(0, w - 1);
    return {
      x: p.points[i * 2] as number,
      z: p.points[i * 2 + 1] as number,
      tx: p.tangents[i * 2] as number,
      tz: p.tangents[i * 2 + 1] as number,
      nx: p.normals[i * 2] as number,
      nz: p.normals[i * 2 + 1] as number,
      halfWidth: (this.valley.profile.halfWidth[i] as number) * 0.85,
      top: this.waterfallTop.value as number,
      foot: (this.waterfallTop.value as number) - (this.waterfallDrop.value as number) + 0.3,
      strength: (this.discharge * this.speedMultiplier) / 4,
    };
  }

  private updateLevelMap(): void {
    const hf = this.valley.heightfield;
    const toHalf = THREE.DataUtils.toHalfFloat;
    const dry = toHalf(-1000);
    const pond = this.valley.pond;
    const pondLevel = this.pondLevel();
    const masks = this.valley.masks;
    for (let z = 0; z < hf.size; z++) {
      const wz = hf.originZ + z * hf.cell;
      for (let x = 0; x < hf.size; x++) {
        const idx = z * hf.size + x;
        const wx = hf.originX + x * hf.cell;
        let level = -1000;
        if ((masks.riverDistance[idx] as number) < 3) level = this.levels[masks.riverSection[idx] as number] as number;
        if ((wx - pond.x) ** 2 + (wz - pond.z) ** 2 < (pond.radius + 8) ** 2) level = Math.max(level, pondLevel);
        this.levelMapData[idx] = level === -1000 ? dry : toHalf(level);
      }
    }
    this.levelMap.needsUpdate = true;
  }

  /** Stream coordinates of a world point, or null when away from the stream. */
  private streamCoords(x: number, z: number): { section: number; offset: number } | null {
    return worldToStream(this.path, this.lookup, x, z);
  }

  /** Bilinear sample of the latest flow results at a world point (shared with the fish worker). */
  sample(x: number, z: number): FlowSample | null {
    return this.sampler?.sample(x, z) ?? null;
  }

  /** What another thread needs to read the same water (fish worker). */
  sharedConfig(): SharedFlowConfig | null {
    return this.config;
  }

  /** Water surface height at a point (stream or pond), or null on dry ground. */
  surfaceAt(x: number, z: number): number | null {
    const s = this.sample(x, z);
    if (s && s.depth > 0.02) return s.surface;
    const pond = this.valley.pond;
    if ((x - pond.x) ** 2 + (z - pond.z) ** 2 < (pond.radius + 4) ** 2) return this.pondLevel();
    return null;
  }

  currentAt(x: number, z: number): [number, number] {
    const s = this.sample(x, z);
    return s && s.depth > 0.02 ? [s.velocityX, s.velocityZ] : [0, 0];
  }

  /** Sends the stones in or near the stream to the solver; re-solves locally around `changed`. */
  async setStones(stones: Stone[], changed?: { x: number; z: number; radius: number }): Promise<SolveStats | null> {
    if (!this.api) return null;
    const near = stones.filter((s) => {
      const sc = this.streamCoords(s.x, s.z);
      return sc !== null && Math.abs(sc.offset) < ((CELLS_ACROSS - 1) / 2) * 0.5 + s.radius;
    });
    this.lastStats = await this.api.setStones(near, changed);
    this.pull();
    return this.lastStats;
  }

  /** Side brooks from the spring tool (plan 6.2). */
  async setInflows(inflows: SideInflow[]): Promise<void> {
    this.lastStats = (await this.api?.setInflows(inflows)) ?? null;
    this.pull();
  }

  /** Cross-section and bank nearest a world point (the spring tool), or null away from the stream. */
  bankAt(x: number, z: number): { section: number; bank: 'left' | 'right'; offset: number } | null {
    const sc = this.streamCoords(x, z);
    if (!sc) return null;
    return { section: Math.round(sc.section), bank: sc.offset < 0 ? 'left' : 'right', offset: sc.offset };
  }

  async setDischarge(q: number): Promise<void> {
    this.discharge = q;
    this.lastStats = (await this.api?.setDischarge(q)) ?? null;
    this.pull();
  }

  async setSpeedMultiplier(m: number): Promise<void> {
    this.speedMultiplier = m;
    this.lastStats = (await this.api?.setSpeedMultiplier(m)) ?? null;
    this.pull();
  }

  async setLevelOffset(o: number): Promise<void> {
    this.levelOffset = o;
    this.lastStats = (await this.api?.setLevelOffset(o)) ?? null;
    this.pull();
  }

  update(time: number): void {
    (this.look.time as any).value = time;
    (this.pondLook.time as any).value = time;
    (this.pondLook.light as any).value = (this.look.light as any).value;
    this.pull();
  }

  dispose(): void {
    this.worker?.terminate();
  }
}
