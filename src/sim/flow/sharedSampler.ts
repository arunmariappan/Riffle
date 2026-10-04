/**
 * Reads the flow worker's results from shared memory and samples them at world positions (plan principle 2).
 * Used by the main thread (water, player, debris) and the fish worker, so they all see the same water.
 */
import { DoubleBuffer, type DoubleBufferHandle } from '../shared/doubleBuffer';
import { buildPathLookup, buildRiverPath, worldToStream, type PathLookup, type RiverPath, type Vec2 } from './path';
import { FLOW, FLOW_STRIDE } from './layout';

export interface FlowLayoutInfo {
  ns: number;
  nn: number;
  ds: number;
  dn: number;
}

export interface SharedFlowConfig {
  flow: DoubleBufferHandle;
  levels: DoubleBufferHandle;
  layout: FlowLayoutInfo;
  controls: Vec2[];
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  pond: { x: number; z: number; radius: number; section: number };
}

export interface SharedFlowSample {
  velocityX: number;
  velocityZ: number;
  depth: number;
  surface: number;
  foam: number;
  shelter: number;
  bed: number;
}

export class SharedFlowSampler {
  readonly path: RiverPath;
  readonly lookup: PathLookup;
  readonly layout: FlowLayoutInfo;
  cells: Float32Array;
  levels: Float32Array;
  private readonly flow: DoubleBuffer;
  private readonly levelBuffer: DoubleBuffer;
  private seen = -1;
  private readonly pond: SharedFlowConfig['pond'];

  constructor(config: SharedFlowConfig) {
    this.layout = config.layout;
    this.path = buildRiverPath(config.controls, 0.5);
    this.lookup = buildPathLookup(this.path, config.bounds, 1, 20);
    this.flow = new DoubleBuffer(config.flow);
    this.levelBuffer = new DoubleBuffer(config.levels);
    this.cells = new Float32Array(this.flow.length);
    this.levels = new Float32Array(this.levelBuffer.length);
    this.pond = config.pond;
    this.refresh();
  }

  get version(): number {
    return this.flow.version;
  }

  /** Copies the latest published results if they changed. Returns true when new data arrived. */
  refresh(): boolean {
    const v = this.flow.version;
    if (v === this.seen) return false;
    this.seen = v;
    this.flow.copyTo(this.cells);
    this.levelBuffer.copyTo(this.levels);
    return true;
  }

  pondLevel(): number {
    return (this.levels[this.pond.section] as number) ?? 0;
  }

  sample(x: number, z: number): SharedFlowSample | null {
    const sc = worldToStream(this.path, this.lookup, x, z);
    const { ns, nn, dn } = this.layout;
    if (sc && ns > 0) {
      const fj = sc.offset / dn + (nn - 1) / 2;
      if (fj >= 0 && fj <= nn - 1) {
        const i0 = Math.min(ns - 2, Math.floor(sc.section));
        const j0 = Math.min(nn - 2, Math.floor(fj));
        const ti = sc.section - i0;
        const tj = fj - j0;
        const c = this.cells;
        const read = (field: number): number => {
          const a = c[(i0 * nn + j0) * FLOW_STRIDE + field] as number;
          const b = c[((i0 + 1) * nn + j0) * FLOW_STRIDE + field] as number;
          const cc = c[(i0 * nn + j0 + 1) * FLOW_STRIDE + field] as number;
          const d = c[((i0 + 1) * nn + j0 + 1) * FLOW_STRIDE + field] as number;
          return (a * (1 - ti) + b * ti) * (1 - tj) + (cc * (1 - ti) + d * ti) * tj;
        };
        const depth = read(FLOW.depth);
        if (depth > 0.005) {
          return {
            velocityX: read(FLOW.velX),
            velocityZ: read(FLOW.velZ),
            foam: read(FLOW.foam),
            depth,
            shelter: read(FLOW.shelter),
            bed: read(FLOW.bed),
            surface: (this.levels[i0] as number) * (1 - ti) + (this.levels[i0 + 1] as number) * ti,
          };
        }
      }
    }
    return null;
  }

  /** Direction back toward the middle of the stream (for fish near the edge), or null away from the stream. */
  towardChannel(x: number, z: number): [number, number] | null {
    const sc = worldToStream(this.path, this.lookup, x, z);
    if (!sc) return null;
    const i = Math.round(sc.section);
    const s = -Math.sign(sc.offset) || 1;
    return [(this.path.normals[i * 2] as number) * s, (this.path.normals[i * 2 + 1] as number) * s];
  }
}
