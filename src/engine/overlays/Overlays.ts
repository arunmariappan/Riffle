import * as THREE from 'three/webgpu';
import { texture, uv, vec3, float, mix, smoothstep } from 'three/tsl';
import type { FlowSystem } from '../water/FlowSystem';

export type OverlayKind = 'none' | 'flow' | 'depth' | 'speed' | 'oxygen' | 'light' | 'temperature' | 'fish';

export interface OverlayLegend {
  label: string;
  unit: string;
  min: number;
  max: number;
}

/** A scalar field over the valley for the heat-map drape. NaN = no data (drawn clear). */
export interface OverlayField {
  data: Float32Array;
  /** Cells per side. */
  size: number;
  cell: number;
  originX: number;
  originZ: number;
  legend: OverlayLegend;
}

/** Five-stop perceptual color map (dark blue → teal → green → yellow), shared by the drape and the arrows. */
const STOPS = [0x440154, 0x3b528b, 0x21918c, 0x5ec962, 0xfde725].map((h) => new THREE.Color(h));

export function colormap(t: number, out = new THREE.Color()): THREE.Color {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  return out.copy(STOPS[i] as THREE.Color).lerp(STOPS[i + 1] as THREE.Color, x - i);
}

function colormapNode(t: any): any {
  const c = (k: number) => vec3((STOPS[k] as THREE.Color).r, (STOPS[k] as THREE.Color).g, (STOPS[k] as THREE.Color).b);
  let col: any = mix(c(0), c(1), smoothstep(0, 0.25, t));
  col = mix(col, c(2), smoothstep(0.25, 0.5, t));
  col = mix(col, c(3), smoothstep(0.5, 0.75, t));
  col = mix(col, c(4), smoothstep(0.75, 1, t));
  return col;
}

/** A flat arrow pointing along +z, one unit long, lying in the xz plane. */
function arrowGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.12, -0.5);
  s.lineTo(0.12, -0.5);
  s.lineTo(0.12, 0.1);
  s.lineTo(0.3, 0.1);
  s.lineTo(0, 0.5);
  s.lineTo(-0.3, 0.1);
  s.lineTo(-0.12, 0.1);
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  // Shape is in xy; lay it down so +y becomes +z (downstream).
  g.rotateX(Math.PI / 2);
  return g;
}

const MAX_ARROWS = 2400;
const FIELD_SIZE = 512;
const DRAPE_SEGMENTS = 256;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Builder overlays (plan 6.8): flow arrows on the water, and a heat-map drape over the terrain for water depth and
 * current speed (and, from Phase 6, the ecology's oxygen, light, temperature and fish density grids). They let you see
 * why plants and fish settle where they do.
 */
export class OverlaySystem {
  readonly group = new THREE.Group();
  kind: OverlayKind = 'none';
  legend: OverlayLegend | null = null;
  private readonly arrows: THREE.InstancedMesh;
  private readonly drape: THREE.Mesh;
  private readonly fieldData = new Uint16Array(FIELD_SIZE * FIELD_SIZE);
  private readonly fieldTexture: THREE.DataTexture;
  private readonly flow: FlowSystem;
  private readonly heightAt: (x: number, z: number) => number;
  private readonly extent: number;
  private readonly origin: number;
  private flowRevision = -1;
  private arrowCenter = new THREE.Vector3(Infinity, 0, 0);
  /** Fields supplied from outside (the ecology grids), by kind. */
  private readonly external = new Map<OverlayKind, OverlayField>();

  constructor(flow: FlowSystem, heightAt: (x: number, z: number) => number, extent: number) {
    this.flow = flow;
    this.heightAt = heightAt;
    this.extent = extent;
    this.origin = -extent / 2;
    const arrowMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, depthWrite: false, transparent: true });
    arrowMat.opacity = 0.9;
    this.arrows = new THREE.InstancedMesh(arrowGeometry(), arrowMat, MAX_ARROWS);
    this.arrows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ARROWS * 3), 3);
    this.arrows.count = 0;
    this.arrows.frustumCulled = false;
    this.arrows.renderOrder = 6;

    this.fieldTexture = new THREE.DataTexture(
      this.fieldData,
      FIELD_SIZE,
      FIELD_SIZE,
      THREE.RedFormat,
      THREE.HalfFloatType,
    );
    this.fieldTexture.magFilter = THREE.LinearFilter;
    this.fieldTexture.minFilter = THREE.LinearFilter;
    this.fieldTexture.needsUpdate = true;
    const g = new THREE.PlaneGeometry(extent, extent, DRAPE_SEGMENTS, DRAPE_SEGMENTS);
    g.rotateX(-Math.PI / 2);
    const drapeMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const t: any = texture(this.fieldTexture, uv()).r;
    drapeMat.colorNode = colormapNode(t.clamp(0, 1));
    drapeMat.opacityNode = t.greaterThanEqual(0).select(float(0.62), float(0));
    drapeMat.polygonOffset = true;
    drapeMat.polygonOffsetFactor = -2;
    drapeMat.polygonOffsetUnits = -2;
    this.drape = new THREE.Mesh(g, drapeMat);
    this.drape.frustumCulled = false;
    this.drape.renderOrder = 5;
    this.drape.visible = false;
    this.group.add(this.arrows, this.drape);
  }

  /** Objects to make visible while materials compile at load (so the first toggle doesn't hitch). */
  compileTargets(): THREE.Object3D[] {
    return [this.drape];
  }

  /** Supplies a field for a kind (the ecology grids). */
  setField(kind: OverlayKind, field: OverlayField): void {
    this.external.set(kind, field);
    if (this.kind === kind) this.showField(field);
  }

  setKind(kind: OverlayKind): void {
    this.kind = kind;
    this.flowRevision = -1;
    this.arrowCenter.set(Infinity, 0, 0);
    this.arrows.count = 0;
    this.drape.visible = false;
    this.legend = null;
    if (kind === 'flow') this.legend = { label: 'Current', unit: 'm/s', min: 0, max: 2 };
    const ext = this.external.get(kind);
    if (ext) this.showField(ext);
  }

  private drapeHeights(): void {
    const pos = this.drape.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const surface = this.flow.surfaceAt(x, z);
      pos.setY(i, Math.max(this.heightAt(x, z), surface ?? -Infinity) + 0.15);
    }
    pos.needsUpdate = true;
  }

  /** Fills the drape texture from a field (resampled to the texture grid). */
  private showField(field: OverlayField): void {
    const toHalf = THREE.DataUtils.toHalfFloat;
    const { min, max } = field.legend;
    const span = Math.max(1e-6, max - min);
    const cell = this.extent / FIELD_SIZE;
    for (let j = 0; j < FIELD_SIZE; j++) {
      // Texture rows run from v = 0 (bottom of the plane after rotation = +z) upward; PlaneGeometry uv.y = 1 at −z.
      const z = this.origin + this.extent - (j + 0.5) * cell;
      const fz = Math.round((z - field.originZ) / field.cell);
      for (let i = 0; i < FIELD_SIZE; i++) {
        const x = this.origin + (i + 0.5) * cell;
        const fx = Math.round((x - field.originX) / field.cell);
        let v = Number.NaN;
        if (fx >= 0 && fz >= 0 && fx < field.size && fz < field.size) v = field.data[fz * field.size + fx] as number;
        this.fieldData[j * FIELD_SIZE + i] = toHalf(Number.isNaN(v) ? -1 : Math.min(1, Math.max(0, (v - min) / span)));
      }
    }
    this.fieldTexture.needsUpdate = true;
    this.legend = field.legend;
    this.drapeHeights();
    this.drape.visible = true;
  }

  /** Water depth or current speed sampled from the solved flow on a 2 m grid. */
  private waterField(kind: 'depth' | 'speed'): OverlayField {
    const size = FIELD_SIZE;
    const cell = this.extent / size;
    const data = new Float32Array(size * size).fill(Number.NaN);
    const pondLevel = this.flow.pondLevel();
    for (let j = 0; j < size; j++) {
      const z = this.origin + (j + 0.5) * cell;
      for (let i = 0; i < size; i++) {
        const x = this.origin + (i + 0.5) * cell;
        const s = this.flow.sample(x, z);
        if (s && s.depth > 0.02) {
          data[j * size + i] = kind === 'depth' ? s.depth : Math.hypot(s.velocityX, s.velocityZ);
          continue;
        }
        const surface = this.flow.surfaceAt(x, z);
        if (surface !== null) {
          const depth = pondLevel - this.heightAt(x, z);
          if (depth > 0.02) data[j * size + i] = kind === 'depth' ? depth : 0;
        }
      }
    }
    return {
      data,
      size,
      cell,
      originX: this.origin + cell / 2,
      originZ: this.origin + cell / 2,
      legend:
        kind === 'depth'
          ? { label: 'Water depth', unit: 'm', min: 0, max: 3 }
          : { label: 'Current', unit: 'm/s', min: 0, max: 2 },
    };
  }

  private placeArrows(center: THREE.Vector3): void {
    const p = this.flow.path;
    const step = 6;
    let n = 0;
    const r2 = 170 * 170;
    for (let i = 0; i < p.count && n < MAX_ARROWS; i += step) {
      const cx = p.points[i * 2] as number;
      const cz = p.points[i * 2 + 1] as number;
      if ((cx - center.x) ** 2 + (cz - center.z) ** 2 > r2) continue;
      const nx = p.normals[i * 2] as number;
      const nz = p.normals[i * 2 + 1] as number;
      for (const k of [-6, -3, 0, 3, 6]) {
        const x = cx + nx * k;
        const z = cz + nz * k;
        const s = this.flow.sample(x, z);
        if (!s || s.depth < 0.06) continue;
        const speed = Math.hypot(s.velocityX, s.velocityZ);
        if (speed < 0.02) continue;
        const len = 0.5 + Math.min(2, speed) * 1.1;
        _q.setFromAxisAngle(UP, Math.atan2(s.velocityX, s.velocityZ));
        this.arrows.setMatrixAt(n, _m.compose(_p.set(x, s.surface + 0.06, z), _q, _s.set(len * 0.7, 1, len)));
        this.arrows.setColorAt(n, colormap(speed / 2, _c));
        n++;
        if (n >= MAX_ARROWS) break;
      }
    }
    this.arrows.count = n;
    this.arrows.instanceMatrix.needsUpdate = true;
    if (this.arrows.instanceColor) this.arrows.instanceColor.needsUpdate = true;
  }

  /** Keeps the active overlay current (call every frame; cheap when nothing changed). */
  update(focus: THREE.Vector3): void {
    if (this.kind === 'none') return;
    const flowChanged = this.flow.revision !== this.flowRevision;
    if (this.kind === 'flow') {
      if (flowChanged || focus.distanceToSquared(this.arrowCenter) > 30 * 30) {
        this.flowRevision = this.flow.revision;
        this.arrowCenter.copy(focus);
        this.placeArrows(focus);
      }
    } else if ((this.kind === 'depth' || this.kind === 'speed') && flowChanged) {
      this.flowRevision = this.flow.revision;
      this.showField(this.waterField(this.kind));
    }
  }
}
