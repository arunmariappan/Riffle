import * as THREE from 'three/webgpu';
import { createRng } from '../sim/rng';
import { GeometryBuilder } from './geometry';

export interface BambooOptions {
  seed: number;
  culms: number;
  minHeight: number;
  maxHeight: number;
  radius: number;
  clumpRadius: number;
  /** Leaves per twig. */
  leavesPerTwig: number;
}

export const DEFAULT_BAMBOO: BambooOptions = {
  seed: 1,
  culms: 14,
  minHeight: 7,
  maxHeight: 12,
  radius: 0.045,
  clumpRadius: 0.9,
  leavesPerTwig: 5,
};

export interface BambooResult {
  culms: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
  height: number;
  radius: number;
}

/**
 * A bamboo clump (plan 6.4): jointed culms that arch outward, swollen nodes, and twigs of narrow leaves
 * on the upper part. Vertex attribute `aTint` varies color per culm; `aPhase` desynchronizes their sway.
 */
export function generateBamboo(options: Partial<BambooOptions> = {}): BambooResult {
  const o = { ...DEFAULT_BAMBOO, ...options };
  const rng = createRng(o.seed);
  const culms = new GeometryBuilder();
  culms.defineAttribute('aTint', 1);
  culms.defineAttribute('aPhase', 1);
  const leaves = new GeometryBuilder();
  leaves.defineAttribute('aTint', 1);
  leaves.defineAttribute('aPhase', 1);

  const up = new THREE.Vector3(0, 1, 0);
  let maxHeight = 0;
  const radial = 8;

  for (let c = 0; c < o.culms; c++) {
    const angle = rng.range(0, Math.PI * 2);
    const dist = Math.sqrt(rng.next()) * o.clumpRadius;
    const base = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
    const height = rng.range(o.minHeight, o.maxHeight) * (1 - 0.25 * (dist / o.clumpRadius));
    maxHeight = Math.max(maxHeight, height);
    const lean = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(
      rng.range(0.08, 0.22) + 0.15 * (dist / o.clumpRadius),
    );
    const radius = o.radius * rng.range(0.75, 1.25);
    const tint = rng.range(0, 1);
    const phase = rng.range(0, Math.PI * 2);
    const nodeSpacing = rng.range(0.28, 0.38);
    const segments = Math.ceil(height / 0.12);

    // Center line: rises, then arches outward as height grows.
    const centerAt = (t: number): THREE.Vector3 => {
      const y = t * height;
      const arch = lean.clone().multiplyScalar(height * t * t);
      return base.clone().add(new THREE.Vector3(arch.x, y, arch.z));
    };

    let prevRing: number[] = [];
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const center = centerAt(t);
      const next = centerAt(Math.min(1, t + 0.01));
      const tangent = next.sub(center).normalize();
      if (tangent.lengthSq() < 1e-6) tangent.copy(up);
      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(1, 0, 0)).normalize();
      const side2 = new THREE.Vector3().crossVectors(tangent, side).normalize();
      const y = t * height;
      const nodePhase = (y % nodeSpacing) / nodeSpacing;
      const nodeBulge = Math.exp(-((nodePhase - 0.0) ** 2) / 0.002) + Math.exp(-((nodePhase - 1) ** 2) / 0.002);
      const r = radius * (1 - 0.55 * t) * (1 + 0.12 * nodeBulge);
      const ring: number[] = [];
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2;
        const n = side
          .clone()
          .multiplyScalar(Math.cos(a))
          .add(side2.clone().multiplyScalar(Math.sin(a)));
        const p = center.clone().add(n.clone().multiplyScalar(r));
        ring.push(culms.vertex(p, n, k / radial, y / 0.6, { aTint: tint, aPhase: phase }));
      }
      if (prevRing.length) {
        for (let k = 0; k < radial; k++) {
          culms.quad(prevRing[k] as number, ring[k] as number, ring[k + 1] as number, prevRing[k + 1] as number);
        }
      }
      prevRing = ring;
    }

    // Twigs with leaf sprays on the upper 55% of the culm, one per node, alternating sides.
    const firstNode = Math.ceil((height * 0.45) / nodeSpacing);
    const lastNode = Math.floor((height * 0.97) / nodeSpacing);
    for (let n = firstNode; n <= lastNode; n++) {
      const t = (n * nodeSpacing) / height;
      const anchor = centerAt(t);
      const twigAngle = angle + (n % 2 === 0 ? 1 : -1) * rng.range(0.6, 1.6) + rng.range(-0.4, 0.4);
      const twigDir = new THREE.Vector3(Math.cos(twigAngle), rng.range(0.1, 0.5), Math.sin(twigAngle)).normalize();
      const twigLength = rng.range(0.25, 0.6) * (1 - 0.4 * t);
      for (let l = 0; l < o.leavesPerTwig; l++) {
        const along = twigLength * (0.35 + 0.65 * (l / Math.max(1, o.leavesPerTwig - 1)));
        const leafBase = anchor.clone().add(twigDir.clone().multiplyScalar(along));
        const spread = rng.range(-0.9, 0.9);
        const leafDir = new THREE.Vector3(
          Math.cos(twigAngle + spread),
          rng.range(-0.75, -0.25), // bamboo leaves droop
          Math.sin(twigAngle + spread),
        ).normalize();
        addLanceLeaf(leaves, leafBase, leafDir, rng.range(0.16, 0.26), rng.range(0.022, 0.032), tint, phase + l * 0.7);
      }
    }
  }

  return { culms: culms.build(), leaves: leaves.build(), height: maxHeight, radius: o.clumpRadius + maxHeight * 0.2 };
}

/** A narrow lance-shaped leaf as a small polygon (no texture needed), folded along its midrib. */
export function addLanceLeaf(
  b: GeometryBuilder,
  base: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  width: number,
  tint: number,
  phase: number,
): void {
  const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  const normal = new THREE.Vector3().crossVectors(side, dir).normalize();
  const fold = normal.clone().multiplyScalar(width * 0.25);
  const at = (t: number, s: number): THREE.Vector3 =>
    base
      .clone()
      .add(dir.clone().multiplyScalar(length * t))
      .add(side.clone().multiplyScalar(s * width))
      .add(fold.clone().multiplyScalar(Math.abs(s) > 0 ? 0 : 1))
      .add(new THREE.Vector3(0, -length * 0.25 * t * t, 0));
  const extra = { aTint: tint, aPhase: phase };
  const v0 = b.vertex(at(0, 0), normal, 0.5, 0, extra);
  const v1 = b.vertex(at(0.3, -1), normal, 0, 0.3, extra);
  const v2 = b.vertex(at(0.3, 1), normal, 1, 0.3, extra);
  const v3 = b.vertex(at(0.35, 0), normal, 0.5, 0.35, extra);
  const v4 = b.vertex(at(0.7, -0.7), normal, 0.1, 0.7, extra);
  const v5 = b.vertex(at(0.7, 0.7), normal, 0.9, 0.7, extra);
  const v6 = b.vertex(at(1, 0), normal, 0.5, 1, extra);
  b.triangle(v0, v1, v3);
  b.triangle(v0, v3, v2);
  b.quad(v1, v4, v6, v3);
  b.quad(v3, v6, v5, v2);
}
