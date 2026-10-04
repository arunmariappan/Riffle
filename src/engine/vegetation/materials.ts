import * as THREE from 'three/webgpu';
import {
  attribute,
  positionLocal,
  texture,
  uv,
  vec2,
  vec3,
  float,
  mix,
  uniform,
  color,
  smoothstep,
  hash,
  floor,
} from 'three/tsl';
import { plantSway, type WindUniforms } from './wind';

/** Per-species look that can change with the seasons (plan 6.7) and the tree dynamics panel (plan 6.3). */
export interface FoliageLook {
  /** Leaf base color (linear). */
  leafColor: { value: THREE.Color };
  /** Seasonal color the leaves blend toward (autumn red, blossom pink, …). */
  seasonColor: { value: THREE.Color };
  /** 0 = leafColor, 1 = seasonColor. */
  seasonMix: { value: number };
  /** 0..1 how much foliage is present (bare winter branches = 0). */
  leafAmount: { value: number };
  /** Per-species stiffness multiplier (Trees panel override). */
  stiffness: { value: number };
}

export function createFoliageLook(leaf: number, season: number): FoliageLook {
  return {
    leafColor: uniform(new THREE.Color(leaf)) as any,
    seasonColor: uniform(new THREE.Color(season)) as any,
    seasonMix: uniform(0) as any,
    leafAmount: uniform(1) as any,
    stiffness: uniform(1) as any,
  };
}

/**
 * Seasonal leaf color: a share of leaf clusters (about 45 cm) take the season color (blossom, autumn red), the rest
 * keep the leaf color, so flowers read as clusters among green leaves instead of tinting the whole canopy.
 */
function seasonalLeafColor(look: FoliageLook, phase: any): any {
  const l: any = look;
  const cell = floor(positionLocal.mul(2.2));
  const pick = hash(cell.x.add(cell.y.mul(57)).add(cell.z.mul(113)).add(phase.mul(17.3)));
  const isSeason = pick.lessThan(l.seasonMix);
  const variation = hash(cell.x.mul(3.1).add(cell.z.mul(7.7)).add(phase))
    .mul(0.22)
    .add(0.88);
  return isSeason.select(vec3(l.seasonColor), vec3(l.leafColor)).mul(variation);
}

function swayNode(wind: WindUniforms, isLeaf: number, stiffness: any): any {
  const a = attribute('aInst', 'vec4');
  const b = attribute('aInstB', 'vec4');
  return positionLocal.add(
    plantSway(positionLocal, vec2(b.x, b.y), a.x, b.z, b.w, a.w.mul(stiffness), a.z, float(isLeaf), wind),
  );
}

export function createBarkMaterial(
  wind: WindUniforms,
  look: FoliageLook,
  barkMap: THREE.Texture | null,
  barkNormal: THREE.Texture | null,
  barkTint: number,
): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  const tint = color(barkTint);
  m.colorNode = barkMap ? texture(barkMap, uv()).rgb.mul(tint) : tint;
  if (barkNormal) m.normalMap = barkNormal;
  m.positionNode = swayNode(wind, 0, (look as any).stiffness);
  return m;
}

/** Textured leaf cards (EZ-Tree) with seasonal color and leaf drop. */
export function createLeafCardMaterial(
  wind: WindUniforms,
  look: FoliageLook,
  leafMap: THREE.Texture | null,
): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  const l: any = look;
  const base = seasonalLeafColor(look, attribute('aInst', 'vec4').z);
  const sample = leafMap ? texture(leafMap, uv()) : null;
  // The leaf texture provides shape (alpha) and detail; its luminance modulates our seasonal color.
  const detail = sample
    ? sample.rgb
        .dot(vec3(0.33, 0.33, 0.33))
        .mul(1.6)
        .clamp(0.4, 1.3)
    : float(1);
  m.colorNode = base.mul(detail);
  // Leaf drop: hide a growing share of leaves as leafAmount falls (stable per leaf via a hash of its position).
  const keep = hash(positionLocal.mul(13.7)).lessThan(l.leafAmount).select(float(1), float(0));
  m.opacityNode = (sample ? sample.a : float(1)).mul(keep);
  m.alphaTest = 0.45;
  m.positionNode = swayNode(wind, 1, l.stiffness);
  return m;
}

/** Bamboo culms: green to yellow-green, darker at the nodes. */
export function createBambooCulmMaterial(wind: WindUniforms, look: FoliageLook): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0 });
  const tint = attribute('aTint', 'float');
  const young = color(0x6f8f2e);
  const old = color(0x9a9a45);
  const band = smoothstep(0.92, 1.0, uv().y.mul(0.6).div(0.32).fract()).mul(0.35);
  m.colorNode = mix(young, old, tint).mul(float(1).sub(band));
  m.positionNode = swayNode(wind, 0, (look as any).stiffness);
  return m;
}

/** Polygon leaves (bamboo, generated plants): no texture, color from look + per-vertex tint. */
export function createPolyLeafMaterial(wind: WindUniforms, look: FoliageLook): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0, side: THREE.DoubleSide });
  const l: any = look;
  const tint = attribute('aTint', 'float');
  const base = seasonalLeafColor(look, attribute('aInst', 'vec4').z);
  const midrib = smoothstep(0.0, 0.12, uv().x.sub(0.5).abs());
  m.colorNode = base.mul(tint.mul(0.3).add(0.8)).mul(midrib.mul(0.15).add(0.85));
  const keep = hash(positionLocal.mul(11.3)).lessThan(l.leafAmount).select(float(1), float(0));
  m.opacityNode = keep;
  m.alphaTest = 0.5;
  m.positionNode = swayNode(wind, 1, l.stiffness);
  return m;
}
