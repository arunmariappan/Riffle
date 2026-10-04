import * as THREE from 'three/webgpu';
import { GeometryBuilder } from './geometry';

/** Body shapes (plan 6.5): torpedo (barbs, minnows, danios), deep (mahseer), long (koi), flat (loach). */
export type BodyTemplate = 'torpedo' | 'deep' | 'long' | 'flat';
/** Fin shapes: forked tails, long flowing koi fins, rounded fins, and a loach's flat suction fins. */
export type FinShape = 'forked' | 'flowing' | 'rounded' | 'sucker';

export interface FishShape {
  template: BodyTemplate;
  /** Max body height / length. */
  depth: number;
  /** Width / height (lateral compression). */
  width: number;
  /** Fin size multiplier. */
  fins: number;
  /** Tail fork depth 0 (round) .. 1 (deep fork). */
  fork: number;
  finShape: FinShape;
  /** Barbels at the mouth (koi, mahseer). */
  barbels: boolean;
  /** Where the body is deepest (fraction from the snout). */
  peak: number;
}

export const SHAPES: Record<BodyTemplate, FishShape> = {
  torpedo: {
    template: 'torpedo',
    depth: 0.2,
    width: 0.55,
    fins: 1,
    fork: 0.7,
    finShape: 'forked',
    barbels: false,
    peak: 0.38,
  },
  deep: {
    template: 'deep',
    depth: 0.27,
    width: 0.5,
    fins: 1.05,
    fork: 0.6,
    finShape: 'forked',
    barbels: false,
    peak: 0.36,
  },
  long: {
    template: 'long',
    depth: 0.2,
    width: 0.66,
    fins: 1.4,
    fork: 0.25,
    finShape: 'flowing',
    barbels: false,
    peak: 0.34,
  },
  flat: {
    template: 'flat',
    depth: 0.12,
    width: 1.6,
    fins: 1.4,
    fork: 0.15,
    finShape: 'sucker',
    barbels: false,
    peak: 0.3,
  },
};

/** A shape for a species from its template, fin shape and barbels. */
export function shapeFor(template: BodyTemplate, finShape: FinShape, barbels: boolean): FishShape {
  const base = SHAPES[template];
  const fork = finShape === 'forked' ? base.fork : finShape === 'rounded' ? 0 : finShape === 'flowing' ? 0.3 : 0.1;
  const fins = finShape === 'flowing' ? Math.max(1.5, base.fins) : finShape === 'rounded' ? base.fins * 0.9 : base.fins;
  return { ...base, finShape, fork, fins, barbels };
}

const PART = { body: 0, tail: 1, dorsal: 2, pectoral: 3, pelvic: 4, anal: 5, barbel: 6 } as const;

/**
 * A fish one unit long, head toward +z, tail toward −z (plan 6.5). Vertex attributes:
 * - `aFish` = (u along the body 0 head → 1 tail, part 0 body / 1 tail / 2 dorsal / 3 pectoral / 4 pelvic / 5 anal /
 *   6 barbel, vertical position −1..1 on the body, side −1 left / +1 right);
 * - `aFin` = 0 on the body, 0 at a fin's base → 1 at its edge (flutter, rays and tips).
 * The swim and pattern shaders use them.
 */
export function generateFish(shape: FishShape, along = 34, around = 16): THREE.BufferGeometry {
  const b = new GeometryBuilder();
  b.defineAttribute('aFish', 4);
  b.defineAttribute('aFin', 1);
  const peak = shape.peak;
  const profile = (u: number): number => {
    // Height profile: rounded snout, deepest near `peak`, narrowing to the tail stalk.
    const nose = Math.pow(
      Math.sin(Math.min(1, u / (peak + 0.04)) * Math.PI * 0.5),
      shape.template === 'long' ? 0.6 : 0.75,
    );
    const tail = 1 - Math.pow(Math.max(0, (u - peak) / (1 - peak)), 1.4) * 0.86;
    return shape.depth * 0.5 * nose * tail;
  };
  const z = (u: number): number => 0.5 - u;
  const bodyEnd = 0.86;
  const halfWidth = (u: number, h: number) => h * shape.width * (shape.template === 'flat' ? 1 : 1 - 0.3 * u);
  // Body rings.
  const rings: number[][] = [];
  for (let a = 0; a <= along; a++) {
    const u = (a / along) * bodyEnd;
    const h = Math.max(0.004, profile(u));
    const w = halfWidth(u, h);
    const ring: number[] = [];
    for (let r = 0; r <= around; r++) {
      const t = (r / around) * Math.PI * 2;
      // Flat-bellied loach: squash the lower half.
      const yy = Math.sin(t) * h * (shape.template === 'flat' && Math.sin(t) < 0 ? 0.45 : 1);
      const xx = Math.cos(t) * w;
      const p = new THREE.Vector3(xx, yy, z(u));
      const n = new THREE.Vector3(Math.cos(t) / Math.max(w, 1e-4), Math.sin(t) / Math.max(h, 1e-4), 0).normalize();
      ring.push(
        b.vertex(p, n, r / around, u, { aFish: [u, PART.body, Math.sin(t), Math.sign(Math.cos(t)) || 1], aFin: 0 }),
      );
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
    aFish: [0, PART.body, 0, 1],
    aFin: 0,
  });
  const first = rings[0] as number[];
  for (let r = 0; r < around; r++) b.triangle(tip, first[r + 1] as number, first[r] as number);

  /**
   * A fin membrane between a base line (on the body) and an edge line, `steps` rows outward, so long fins can bend
   * smoothly. Both lines must have the same number of points. Double-sided (the material renders both sides).
   */
  const fin = (part: number, base: THREE.Vector3[], edge: THREE.Vector3[], steps: number, side = 0) => {
    const grid: number[][] = [];
    for (let s = 0; s <= steps; s++) {
      const k = s / steps;
      const row: number[] = [];
      base.forEach((p0, i) => {
        const p = p0.clone().lerp(edge[i] as THREE.Vector3, k);
        const u = 0.5 - p.z;
        const n = side ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(1, 0, 0);
        row.push(
          b.vertex(p, n, i / (base.length - 1), k, {
            aFish: [u, part, p.y / Math.max(1e-3, shape.depth * 0.5), side || 1],
            aFin: k,
          }),
        );
      });
      grid.push(row);
    }
    for (let s = 0; s < steps; s++)
      for (let i = 0; i < base.length - 1; i++) {
        const r0 = grid[s] as number[];
        const r1 = grid[s + 1] as number[];
        b.quad(r0[i] as number, r1[i] as number, r1[i + 1] as number, r0[i + 1] as number);
      }
  };
  const v = (x: number, y: number, u: number) => new THREE.Vector3(x, y, z(u));
  const f = shape.fins;
  const flowing = shape.finShape === 'flowing';
  const steps = flowing ? 6 : 3;

  // Caudal (tail) fin: a fan from the tail stalk out to its edge.
  const hTail = profile(bodyEnd) * 0.95;
  const tailLen = (flowing ? 0.3 : 0.2) * f;
  const spread = shape.depth * (flowing ? 0.95 : 0.75) * f;
  const tailBase: THREE.Vector3[] = [];
  const tailEdge: THREE.Vector3[] = [];
  const fan = 9;
  for (let i = 0; i <= fan; i++) {
    const t = i / fan; // 0 top → 1 bottom
    const y = hTail * (1 - 2 * t);
    tailBase.push(v(0, y, bodyEnd - 0.01));
    const s = 1 - 2 * t;
    // Forked tails dip in the middle; rounded tails bulge; flowing koi tails are long and soft.
    const notch = shape.fork * (1 - Math.abs(s)) ** 1.5;
    const reach =
      tailLen *
      (shape.finShape === 'rounded' || shape.finShape === 'sucker' ? 0.8 + 0.2 * (1 - s * s) : 1 - notch * 0.55);
    tailEdge.push(v(0, s * spread * (shape.finShape === 'rounded' ? 0.75 : 1), bodyEnd + reach));
  }
  fin(PART.tail, tailBase, tailEdge, steps);

  // Dorsal fin along the back.
  const d0 = 0.3;
  const d1 = flowing ? 0.66 : 0.56;
  const dorsalBase: THREE.Vector3[] = [];
  const dorsalEdge: THREE.Vector3[] = [];
  const dn = 6;
  for (let i = 0; i <= dn; i++) {
    const t = i / dn;
    const u = d0 + (d1 - d0) * t;
    const top = profile(u) * 0.96;
    dorsalBase.push(v(0, top, u));
    // Tallest at the front, sloping back (a long sail for koi).
    const height = shape.depth * (flowing ? 0.5 : 0.42) * f * (1 - 0.55 * t) * (shape.template === 'flat' ? 0.6 : 1);
    dorsalEdge.push(v(0, top + height, u + 0.06 * f * (0.4 + t)));
  }
  fin(PART.dorsal, dorsalBase, dorsalEdge, steps);

  // Anal fin under the tail.
  const analBase: THREE.Vector3[] = [];
  const analEdge: THREE.Vector3[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const u = 0.62 + 0.16 * t;
    const bottom = -profile(u) * (shape.template === 'flat' ? 0.45 : 0.95);
    analBase.push(v(0, bottom, u));
    analEdge.push(v(0, bottom - shape.depth * 0.32 * f * (1 - 0.5 * t), u + 0.05 * f));
  }
  fin(PART.anal, analBase, analEdge, steps);

  // Paired fins. Loaches spread theirs flat to the sides (a suction disc); others angle down and back.
  const sucker = shape.finShape === 'sucker';
  for (const side of [-1, 1]) {
    const pair = (part: number, u0: number, u1: number, size: number) => {
      const base: THREE.Vector3[] = [];
      const edge: THREE.Vector3[] = [];
      for (let i = 0; i <= 3; i++) {
        const t = i / 3;
        const u = u0 + (u1 - u0) * t;
        const h = profile(u);
        const w = halfWidth(u, h);
        const y = sucker ? -h * 0.4 : -h * 0.55;
        base.push(v(side * w * 0.85, y, u));
        const out = (sucker ? 0.16 : 0.1) * size * f * (1 - 0.35 * t);
        edge.push(
          sucker
            ? v(side * (w + out), y - 0.004, u + 0.04 * size)
            : v(side * (w * 0.9 + out * 0.6), y - out * 0.7, u + out * 0.8),
        );
      }
      fin(part, base, edge, steps, side);
    };
    pair(PART.pectoral, 0.18, 0.27, flowing ? 1.4 : 1);
    pair(PART.pelvic, 0.46, 0.53, sucker ? 1.1 : 0.8);
  }

  // Barbels: two thin whiskers either side of the mouth.
  if (shape.barbels) {
    for (const side of [-1, 1]) {
      for (const k of [0, 1]) {
        const start = new THREE.Vector3(side * shape.depth * 0.06, -shape.depth * 0.08 - k * 0.006, 0.47 - k * 0.012);
        const len = shape.depth * (k === 0 ? 0.32 : 0.22);
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= 4; i++) {
          const t = i / 4;
          points.push(start.clone().add(new THREE.Vector3(side * len * 0.45 * t, -len * 0.55 * t * t, len * 0.3 * t)));
        }
        let prev: number[] = [];
        points.forEach((p, i) => {
          const r = 0.0035 * (1 - (i / points.length) * 0.7);
          const ring: number[] = [];
          for (let s = 0; s <= 3; s++) {
            const a = (s / 3) * Math.PI * 2;
            const n = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
            ring.push(
              b.vertex(p.clone().addScaledVector(n, r), n, s / 3, i / 4, {
                aFish: [0.03, PART.barbel, -0.4, side],
                aFin: i / 4,
              }),
            );
          }
          if (prev.length)
            for (let s = 0; s < 3; s++)
              b.quad(prev[s] as number, ring[s] as number, ring[s + 1] as number, prev[s + 1] as number);
          prev = ring;
        });
      }
    }
  }
  const g = b.build();
  g.computeBoundingSphere();
  return g;
}
