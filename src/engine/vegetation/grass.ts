import * as THREE from 'three/webgpu';
import { attribute, positionLocal, uv, vec2, vec3, float, mix, sin, cos, uniform } from 'three/tsl';
import { createRng } from '../../sim/rng';
import { grassSway, type WindUniforms } from './wind';

export interface GrassBlade {
  x: number;
  y: number;
  z: number;
  height: number;
  yaw: number;
  phase: number;
  tint: number;
  width: number;
}

/** One blade: a tapered strip with 4 segments, in a unit frame (height 1, width 1). */
export function bladeGeometry(): THREE.BufferGeometry {
  const segments = 4;
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    const w = 0.5 * (1 - t * 0.85);
    const curve = t * t * 0.15;
    positions.push(-w, t, curve, w, t, curve);
    uvs.push(0, t, 1, t);
    normals.push(0, 0.5, -1, 0, 0.5, -1);
  }
  for (let s = 0; s < segments; s++) {
    const a = s * 2;
    indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

export interface GrassLook {
  baseColor: { value: THREE.Color };
  tipColor: { value: THREE.Color };
  dryColor: { value: THREE.Color };
  /** 0 = lush, 1 = dry (pre-monsoon). */
  dryness: { value: number };
}

export function createGrassLook(): GrassLook {
  return {
    baseColor: uniform(new THREE.Color(0x2a4a14)) as any,
    tipColor: uniform(new THREE.Color(0x7aa836)) as any,
    dryColor: uniform(new THREE.Color(0x9a8a4a)) as any,
    dryness: uniform(0.1) as any,
  };
}

/**
 * A field of instanced grass blades (plan 6.4). Blade placement comes from the caller (density from the
 * ecology grid); positions live in instance attributes so the instance matrices stay identity.
 */
export function createGrassMesh(blades: readonly GrassBlade[], material: THREE.Material): THREE.InstancedMesh {
  const geometry = bladeGeometry();
  const a = new Float32Array(blades.length * 4);
  const b = new Float32Array(blades.length * 4);
  blades.forEach((blade, i) => {
    a.set([blade.x, blade.y, blade.z, blade.height], i * 4);
    b.set([blade.yaw, blade.phase, blade.tint, blade.width], i * 4);
  });
  geometry.setAttribute('aBlade', new THREE.InstancedBufferAttribute(a, 4));
  geometry.setAttribute('aBladeB', new THREE.InstancedBufferAttribute(b, 4));

  const mesh = new THREE.InstancedMesh(geometry, material, blades.length);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/** Grass material: blade rotation, height, wind and seasonal color from per-instance attributes. Create once, reuse. */
export function createGrassMaterial(wind: WindUniforms, look: GrassLook): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  const ia = attribute('aBlade', 'vec4');
  const ib = attribute('aBladeB', 'vec4');
  const t = uv().y;
  const local = vec3(positionLocal.x.mul(ib.w), positionLocal.y.mul(ia.w), positionLocal.z.mul(ia.w));
  const c = cos(ib.x);
  const s = sin(ib.x);
  const rotated = vec3(local.x.mul(c).sub(local.z.mul(s)), local.y, local.x.mul(s).add(local.z.mul(c)));
  const worldXZ = vec2(ia.x, ia.z);
  const sway = grassSway(t, worldXZ, ib.y, wind).mul(ia.w);
  // Each blade leans its own way and curves more toward the tip, so the meadow reads soft, not spiky.
  const lean = t.mul(t).mul(ia.w).mul(ib.z.mul(0.5).add(0.25));
  const leanVec = vec3(cos(ib.y).mul(lean), lean.mul(lean).mul(-0.5), sin(ib.y).mul(lean));
  m.positionNode = rotated
    .add(vec3(ia.x, ia.y, ia.z))
    .add(sway)
    .add(leanVec);
  const l: any = look;
  const lush = mix(vec3(l.baseColor), vec3(l.tipColor), t.mul(t));
  const tinted = mix(lush, vec3(l.dryColor), float(l.dryness).mul(ib.z.mul(0.6).add(0.4)));
  m.colorNode = tinted.mul(ib.z.mul(0.35).add(0.8));

  return m;
}

/** Scatters blades over a rectangle using a height function and an optional density (0..1) function. */
export function scatterBlades(
  seed: number,
  area: { minX: number; minZ: number; maxX: number; maxZ: number },
  count: number,
  heightAt: (x: number, z: number) => number,
  density: (x: number, z: number) => number = () => 1,
): GrassBlade[] {
  const rng = createRng(seed);
  const blades: GrassBlade[] = [];
  let attempts = 0;
  while (blades.length < count && attempts < count * 4) {
    attempts++;
    const x = rng.range(area.minX, area.maxX);
    const z = rng.range(area.minZ, area.maxZ);
    if (rng.next() > density(x, z)) continue;
    blades.push({
      x,
      y: heightAt(x, z),
      z,
      height: rng.range(0.25, 0.7),
      yaw: rng.range(0, Math.PI * 2),
      phase: rng.range(0, Math.PI * 2),
      tint: rng.next(),
      width: rng.range(0.025, 0.05),
    });
  }
  return blades;
}
