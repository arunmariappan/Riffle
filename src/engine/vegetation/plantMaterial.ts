import * as THREE from 'three/webgpu';
import {
  attribute,
  positionLocal,
  vec2,
  vec3,
  float,
  mix,
  sin,
  cos,
  hash,
  floor,
  smoothstep,
  uniform,
} from 'three/tsl';
import type { WindUniforms } from './wind';
import { grassSway } from './wind';
import type { FoliageLook } from './materials';
import { globals } from '../globals';

export interface PlantMaterialOptions {
  wind: WindUniforms;
  look: FoliageLook;
  /** Up to four flower colors (picked by the generator's color index). */
  flowers: THREE.Color[];
  /** Leaves blend toward this color at the top (red Rotala). */
  tip?: THREE.Color;
  /** Underwater plants bend with the current instead of the wind. */
  aquatic: boolean;
  /** Floating leaves bob on the surface (lilies, lotus pads). */
  floating?: boolean;
}

/**
 * Plants (plan 6.4): color by part (stem, leaf, flower, flower centre), seasonal leaf drop, and motion — land plants
 * sway with the wind, water plants bend downstream with the local current (per-instance `aFlow` = (vx, vz, depth,
 * surface) in world space) and floating leaves bob.
 */
export function createPlantMaterial(o: PlantMaterialOptions): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.6, metalness: 0 });
  const plant = attribute('aPlant', 'vec4');
  const tint = attribute('aTint', 'float');
  const inst = attribute('aInst', 'vec4');
  const instB = attribute('aInstB', 'vec4');
  const h = plant.x.clamp(0, 1.2);
  const part = plant.y;
  const l: any = o.look;

  // Colors.
  const flowers = [0, 1, 2, 3].map((k) => uniform((o.flowers[k] ?? o.flowers[0] ?? new THREE.Color(0xffffff)).clone()));
  const idx = plant.z;
  let flower: any = vec3(flowers[0] as any);
  flower = idx.greaterThan(0.5).select(vec3(flowers[1] as any), flower);
  flower = idx.greaterThan(1.5).select(vec3(flowers[2] as any), flower);
  flower = idx.greaterThan(2.5).select(vec3(flowers[3] as any), flower);
  const cell = floor(positionLocal.mul(4));
  const seasonPick = hash(cell.x.add(cell.y.mul(31)).add(cell.z.mul(71)).add(inst.z.mul(13))).lessThan(l.seasonMix);
  let leaf: any = seasonPick.select(vec3(l.seasonColor), vec3(l.leafColor)).mul(tint.mul(0.3).add(0.82));
  if (o.tip) leaf = mix(leaf, vec3(o.tip.r, o.tip.g, o.tip.b), smoothstep(0.45, 1, h));
  const stem = vec3(l.leafColor).mul(0.75);
  const centre = vec3(0.95, 0.78, 0.2);
  let color: any = stem;
  color = part.greaterThan(0.5).select(leaf, color);
  color = part.greaterThan(1.5).select(flower.mul(tint.mul(0.2).add(0.9)), color);
  color = part.greaterThan(2.5).select(centre, color);
  m.colorNode = color;
  // Leaf drop and flowering follow the season (leafAmount); flowers fade out with the leaves.
  const keep = hash(cell.x.mul(1.7).add(cell.z.mul(5.1)).add(inst.z)).lessThan(l.leafAmount);
  m.opacityNode = keep.select(float(1), float(0));
  m.alphaTest = 0.5;

  // Motion.
  const height = instB.z;
  const yaw = inst.x;
  const c = cos(yaw);
  const s = sin(yaw);
  const toLocal = (v: any) => vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));
  if (o.aquatic) {
    const flow = attribute('aFlow', 'vec4');
    const local = toLocal(vec2(flow.x, flow.y));
    const speed = local.length();
    const g: any = globals.time;
    const sway = sin(g.mul(2.2).add(inst.z).add(h.mul(3))).mul(speed.mul(0.25).add(0.05));
    const bend = h.mul(h).mul(height).mul(speed.mul(0.55).add(0.08));
    const dir = speed.greaterThan(0.01).select(local.div(speed.max(0.01)), vec2(1, 0));
    let offset: any = vec3(
      dir.x.mul(bend.add(sway.mul(height).mul(h))),
      bend.mul(bend).mul(-0.4),
      dir.y.mul(bend.add(sway.mul(height).mul(h))),
    );
    if (o.floating) {
      // Floating leaves ride the ripples instead of bending.
      const bob = sin(g.mul(1.4).add(inst.z).add(positionLocal.x.mul(3))).mul(0.008);
      offset = h.greaterThan(0.95).select(vec3(sway.mul(0.02), bob, sway.mul(0.015)), offset);
    }
    m.positionNode = positionLocal.add(offset);
  } else {
    const sway = grassSway(h, vec2(instB.x, instB.y), inst.z, o.wind) as any;
    const local = toLocal(vec2(sway.x, sway.z));
    m.positionNode = positionLocal.add(
      vec3(local.x, sway.y, local.y)
        .mul(height.mul(0.8).add(0.2))
        .mul(float(1).div(inst.w.max(0.3))),
    );
  }
  return m;
}
