import * as THREE from 'three/webgpu';
import { GeometryBuilder } from './geometry';

/** Body shapes (plan 6.5): torpedo (barbs, minnows, danios), deep (mahseer), long (koi), flat (loach). */
export type BodyTemplate = 'torpedo' | 'deep' | 'long' | 'flat';

export interface FishShape {
  template: BodyTemplate;
  /** Max body height / length. */
  depth: number;
  /** Width / height (lateral compression). */
  width: number;
  /** Fin size multiplier (long flowing fins for koi). */
  fins: number;
  /** Tail fork depth 0 (round) .. 1 (deep fork). */
  fork: number;
}

export const SHAPES: Record<BodyTemplate, FishShape> = {
  torpedo: { template: 'torpedo', depth: 0.2, width: 0.55, fins: 1, fork: 0.7 },
  deep: { template: 'deep', depth: 0.27, width: 0.5, fins: 1.05, fork: 0.6 },
  long: { template: 'long', depth: 0.22, width: 0.62, fins: 1.5, fork: 0.25 },
  flat: { template: 'flat', depth: 0.12, width: 1.6, fins: 1.4, fork: 0.15 },
};

/**
 * A fish one unit long, head toward +z, tail toward −z (plan 6.5). Vertex attribute `aFish` = (u along the body 0 head
 * → 1 tail, part 0 body / 1 tail / 2 dorsal / 3 pectoral / 4 pelvic / 5 anal, vertical position −1..1 on the body,
 * side −1 left / +1 right). The swim and pattern shaders use it.
 */
export function generateFish(shape: FishShape, along = 26, around = 14): THREE.BufferGeometry {
  const b = new GeometryBuilder();
  b.defineAttribute('aFish', 4);
  const profile = (u: number): number => {
    // Height profile: rounded snout, deepest at ~35%, narrowing to the tail stalk.
    const nose = Math.pow(Math.sin(Math.min(1, u / 0.42) * Math.PI * 0.5), 0.75);
    const tail = 1 - Math.pow(Math.max(0, (u - 0.35) / 0.65), 1.4) * 0.86;
    return shape.depth * 0.5 * nose * tail;
  };
  const z = (u: number): number => 0.5 - u;
  const bodyEnd = 0.86;
  // Body rings.
  const rings: number[][] = [];
  for (let a = 0; a <= along; a++) {
    const u = (a / along) * bodyEnd;
    const h = Math.max(0.004, profile(u));
    const w = h * shape.width * (shape.template === 'flat' ? 1 : 1 - 0.3 * u);
    const ring: number[] = [];
    for (let r = 0; r <= around; r++) {
      const t = (r / around) * Math.PI * 2;
      // Flat-bellied loach: squash the lower half.
      const yy = Math.sin(t) * h * (shape.template === 'flat' && Math.sin(t) < 0 ? 0.45 : 1);
      const xx = Math.cos(t) * w;
      const p = new THREE.Vector3(xx, yy, z(u));
      const n = new THREE.Vector3(Math.cos(t) / Math.max(w, 1e-4), Math.sin(t) / Math.max(h, 1e-4), 0).normalize();
      ring.push(b.vertex(p, n, r / around, u, { aFish: [u, 0, Math.sin(t), Math.sign(Math.cos(t)) || 1] }));
    }
    rings.push(ring);
  }
  for (let a = 0; a < along; a++) {
    for (let r = 0; r < around; r++) {
      const r0 = rings[a] as number[];
      const r1 = rings[a + 1] as number[];
      b.quad(r0[r] as number, r1[r] as number, r1[r + 1] as number, r0[r + 1] as number);
    }
  }
  // Snout cap.
  const tip = b.vertex(new THREE.Vector3(0, 0, 0.5 + 0.004), new THREE.Vector3(0, 0, 1), 0.5, 0, {
    aFish: [0, 0, 0, 1],
  });
  const first = rings[0] as number[];
  for (let r = 0; r < around; r++) b.triangle(tip, first[r + 1] as number, first[r] as number);

  // Fins: flat, double-sided membranes (the material renders both sides).
  const fin = (
    part: number,
    pts: [number, number, number][],
    side = 1,
    uOf: (p: [number, number, number]) => number = (p) => 0.5 - p[2],
  ) => {
    const n = new THREE.Vector3(side, 0, 0);
    const ids = pts.map((p) =>
      b.vertex(new THREE.Vector3(p[0], p[1], p[2]), n, 0, uOf(p), { aFish: [uOf(p), part, p[1], side] }),
    );
    for (let k = 1; k < ids.length - 1; k++) b.triangle(ids[0] as number, ids[k] as number, ids[k + 1] as number);
  };
  const f = shape.fins;
  const hTail = profile(bodyEnd);
  // Caudal (tail) fin: forked.
  const tailLen = 0.2 * f;
  const spread = shape.depth * 0.75 * f;
  const zt = z(bodyEnd);
  fin(1, [
    [0, hTail, zt + 0.01],
    [0, spread, zt - tailLen],
    [0, spread * (1 - shape.fork) * 0.25, zt - tailLen * (1 - shape.fork * 0.45)],
    [0, -spread * (1 - shape.fork) * 0.25, zt - tailLen * (1 - shape.fork * 0.45)],
    [0, -spread, zt - tailLen],
    [0, -hTail, zt + 0.01],
  ]);
  // Dorsal fin.
  const hd = profile(0.38);
  fin(2, [
    [0, hd * 0.95, z(0.3)],
    [0, hd + 0.12 * f * shape.depth * 3.2, z(0.4)],
    [0, hd + 0.05 * f * shape.depth * 3.2, z(0.52)],
    [0, profile(0.56) * 0.95, z(0.56)],
  ]);
  // Anal fin.
  const ha = -profile(0.68);
  fin(5, [
    [0, ha * 0.95, z(0.62)],
    [0, ha - 0.07 * f * shape.depth * 3, z(0.7)],
    [0, ha * 0.9, z(0.78)],
  ]);
  // Pectoral and pelvic fins, a pair each.
  for (const side of [-1, 1]) {
    const hp = profile(0.22);
    const wp = hp * shape.width;
    fin(
      3,
      [
        [side * wp * 0.8, -hp * 0.35, z(0.2)],
        [side * (wp + 0.09 * f), -hp * 0.9, z(0.32)],
        [side * wp * 0.85, -hp * 0.5, z(0.3)],
      ],
      side,
    );
    const hv = profile(0.48);
    const wv = hv * shape.width;
    fin(
      4,
      [
        [side * wv * 0.5, -hv * 0.85, z(0.45)],
        [side * (wv * 0.5 + 0.05 * f), -hv - 0.06 * f, z(0.56)],
        [side * wv * 0.4, -hv * 0.9, z(0.55)],
      ],
      side,
    );
  }
  const g = b.build();
  g.computeBoundingSphere();
  return g;
}
