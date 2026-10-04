import * as THREE from 'three/webgpu';
import { createRng, type Rng } from '../sim/rng';
import { GeometryBuilder } from './geometry';
import { addLanceLeaf } from './bamboo';

/**
 * Generated plants (plan 6.4), no textures needed. Every vertex carries `aPlant` = (height fraction 0 base → 1 top,
 * part 0 stem / 1 leaf / 2 flower / 3 flower centre, color index, phase) and `aTint` (variation), which the plant
 * material uses for color, wind sway (land) or flow sway (water).
 */
export interface PlantGeometry {
  geometry: THREE.BufferGeometry;
  height: number;
  radius: number;
}

const PART = { stem: 0, leaf: 1, flower: 2, centre: 3 } as const;

/** Attributes for a lance leaf vertex: height fraction from its position, leaf part. */
function leafAttrs(height: number, tint: number): (q: THREE.Vector3) => Record<string, number | readonly number[]> {
  return (q) => ({ aPlant: [Math.max(0, q.y) / height, PART.leaf, 0, 0], aTint: tint });
}

function builder(): GeometryBuilder {
  const b = new GeometryBuilder();
  b.defineAttribute('aPlant', 4);
  b.defineAttribute('aTint', 1);
  return b;
}

function tube(
  b: GeometryBuilder,
  path: THREE.Vector3[],
  r0: number,
  r1: number,
  sides: number,
  height: number,
  tint: number,
  part = PART.stem,
): void {
  let prev: number[] = [];
  path.forEach((p, k) => {
    const t = k / (path.length - 1);
    const next = path[Math.min(path.length - 1, k + 1)] as THREE.Vector3;
    const before = path[Math.max(0, k - 1)] as THREE.Vector3;
    const dir = next.clone().sub(before).normalize();
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(1, 0, 0.3)).normalize();
    const side2 = new THREE.Vector3().crossVectors(dir, side).normalize();
    const r = r0 + (r1 - r0) * t;
    const ring: number[] = [];
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const n = side
        .clone()
        .multiplyScalar(Math.cos(a))
        .add(side2.clone().multiplyScalar(Math.sin(a)));
      ring.push(
        b.vertex(p.clone().add(n.clone().multiplyScalar(r)), n, s / sides, t, {
          aPlant: [p.y / height, part, 0, 0],
          aTint: tint,
        }),
      );
    }
    if (prev.length)
      for (let s = 0; s < sides; s++)
        b.quad(prev[s] as number, ring[s] as number, ring[s + 1] as number, prev[s + 1] as number);
    prev = ring;
  });
}

/** A frond: a curved rachis with paired leaflets, arching out and drooping (tree ferns and ground ferns). */
function frond(
  b: GeometryBuilder,
  rng: Rng,
  base: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  height: number,
  tint: number,
): void {
  const pinnae = 16;
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(dir, up).normalize();
  const points: THREE.Vector3[] = [];
  for (let k = 0; k <= pinnae; k++) {
    const t = k / pinnae;
    // Arch up then droop.
    const p = base
      .clone()
      .add(dir.clone().multiplyScalar(length * t))
      .add(new THREE.Vector3(0, Math.sin(t * Math.PI * 0.75) * length * 0.35 - t * t * length * 0.45, 0));
    points.push(p);
  }
  for (let k = 1; k < pinnae; k++) {
    const t = k / pinnae;
    const p = points[k] as THREE.Vector3;
    const along = (points[k + 1] as THREE.Vector3).clone().sub(p).normalize();
    const leafLen = length * 0.22 * Math.sin(Math.PI * (0.15 + 0.85 * t)) * rng.range(0.85, 1.1);
    for (const s of [-1, 1]) {
      const leafDir = side
        .clone()
        .multiplyScalar(s)
        .add(along.clone().multiplyScalar(0.6))
        .add(new THREE.Vector3(0, -0.15, 0))
        .normalize();
      const n = new THREE.Vector3().crossVectors(leafDir, along).normalize();
      const w = leafLen * 0.22;
      const tip = p.clone().add(leafDir.clone().multiplyScalar(leafLen));
      const sideV = along.clone().multiplyScalar(w);
      const h = (q: THREE.Vector3) => ({ aPlant: [q.y / height, PART.leaf, 0, 0], aTint: tint });
      const a = b.vertex(p, n, 0, 0, h(p));
      const m1 = p
        .clone()
        .add(leafDir.clone().multiplyScalar(leafLen * 0.45))
        .add(sideV);
      const m2 = p
        .clone()
        .add(leafDir.clone().multiplyScalar(leafLen * 0.45))
        .sub(sideV);
      const v1 = b.vertex(m1, n, 0, 0.5, h(m1));
      const v2 = b.vertex(m2, n, 1, 0.5, h(m2));
      const v3 = b.vertex(tip, n, 0.5, 1, h(tip));
      b.triangle(a, v1, v3);
      b.triangle(a, v3, v2);
    }
  }
  tube(b, points, length * 0.012, length * 0.004, 3, height, tint);
}

export function generateTreeFern(
  seed: number,
  height: number,
): { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; height: number; radius: number } {
  const rng = createRng(seed);
  const trunkB = builder();
  const crownB = builder();
  const trunkH = height * 0.78;
  const lean = new THREE.Vector3(rng.range(-0.15, 0.15), 0, rng.range(-0.15, 0.15));
  const path: THREE.Vector3[] = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    path.push(new THREE.Vector3(lean.x * t * t * trunkH, t * trunkH, lean.z * t * t * trunkH));
  }
  tube(trunkB, path, 0.14, 0.11, 8, height, rng.next());
  const top = path[path.length - 1] as THREE.Vector3;
  const fronds = rng.int(11, 15);
  const frondLen = height * rng.range(0.55, 0.7);
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const rise = rng.range(0.15, 0.55);
    const dir = new THREE.Vector3(Math.cos(a), rise, Math.sin(a)).normalize();
    frond(
      crownB,
      rng,
      top.clone().add(new THREE.Vector3(0, 0.05, 0)),
      dir,
      frondLen * rng.range(0.85, 1.1),
      height,
      rng.next(),
    );
  }
  return { trunk: trunkB.build(), crown: crownB.build(), height, radius: frondLen };
}

export function generateGroundFern(seed: number, height: number): PlantGeometry {
  const rng = createRng(seed);
  const b = builder();
  const fronds = rng.int(7, 11);
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const dir = new THREE.Vector3(Math.cos(a), rng.range(0.9, 1.6), Math.sin(a)).normalize();
    frond(b, rng, new THREE.Vector3(0, 0, 0), dir, height * rng.range(1.0, 1.3), height, rng.next());
  }
  return { geometry: b.build(), height, radius: height };
}

/** A tuft of wildflowers: thin stems with small five-petal heads in the given colors (color index per flower). */
export function generateWildflowers(seed: number, height: number, colors: number): PlantGeometry {
  const rng = createRng(seed);
  const b = builder();
  const stems = rng.int(5, 9);
  for (let s = 0; s < stems; s++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0, 0.12);
    const h = height * rng.range(0.6, 1);
    const base = new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d);
    const topP = base.clone().add(new THREE.Vector3(rng.range(-0.06, 0.06), h, rng.range(-0.06, 0.06)));
    tube(b, [base, base.clone().lerp(topP, 0.5), topP], 0.006, 0.004, 3, height, rng.next());
    // A couple of narrow leaves on the stem.
    const lt = rng.next();
    addLanceLeaf(
      b,
      base.clone().lerp(topP, 0.3),
      new THREE.Vector3(Math.cos(a + 1), 0.4, Math.sin(a + 1)).normalize(),
      h * 0.35,
      0.012,
      lt,
      0,
      leafAttrs(height, lt),
    );
    const colorIndex = rng.int(0, colors);
    const petals = 5;
    const r = rng.range(0.025, 0.045);
    const centre = b.vertex(topP.clone().add(new THREE.Vector3(0, 0.004, 0)), new THREE.Vector3(0, 1, 0), 0.5, 0.5, {
      aPlant: [1, PART.centre, colorIndex, 0],
      aTint: 0.5,
    });
    const ring: number[] = [];
    for (let k = 0; k <= petals * 2; k++) {
      const ang = (k / (petals * 2)) * Math.PI * 2;
      const rr = k % 2 === 0 ? r : r * 0.55;
      const p = topP.clone().add(new THREE.Vector3(Math.cos(ang) * rr, rr * 0.15, Math.sin(ang) * rr));
      ring.push(
        b.vertex(p, new THREE.Vector3(0, 1, 0), 0, 0, { aPlant: [1, PART.flower, colorIndex, 0], aTint: rng.next() }),
      );
    }
    for (let k = 0; k < ring.length - 1; k++) b.triangle(centre, ring[k + 1] as number, ring[k] as number);
  }
  return { geometry: b.build(), height, radius: 0.2 };
}

/** A wild orchid spray: an arching stem with several open flowers (sepals and a lip). */
export function generateOrchid(seed: number, height: number): PlantGeometry {
  const rng = createRng(seed);
  const b = builder();
  // Strap leaves at the base.
  for (let l = 0; l < 4; l++) {
    const a = rng.range(0, Math.PI * 2);
    const lt = rng.next();
    addLanceLeaf(
      b,
      new THREE.Vector3(0, 0.02, 0),
      new THREE.Vector3(Math.cos(a), 0.5, Math.sin(a)).normalize(),
      height * 0.6,
      0.03,
      lt,
      0,
      leafAttrs(height, lt),
    );
  }
  const stem: THREE.Vector3[] = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    stem.push(new THREE.Vector3(t * height * 0.4, Math.sin(t * Math.PI * 0.6) * height, 0));
  }
  tube(b, stem, 0.006, 0.004, 3, height, 0.5);
  const flowers = rng.int(3, 6);
  for (let f = 0; f < flowers; f++) {
    const p = stem[3 + Math.min(5, f)] as THREE.Vector3;
    const size = rng.range(0.03, 0.045);
    const centre = b.vertex(p, new THREE.Vector3(0, 0, 1), 0.5, 0.5, {
      aPlant: [p.y / height, PART.centre, 0, 0],
      aTint: 0.5,
    });
    const ring: number[] = [];
    for (let k = 0; k <= 10; k++) {
      const ang = (k / 10) * Math.PI * 2;
      const rr = k % 2 === 0 ? size : size * 0.35;
      ring.push(
        b.vertex(
          p.clone().add(new THREE.Vector3(Math.cos(ang) * rr, Math.sin(ang) * rr - size * 0.2, 0.01)),
          new THREE.Vector3(0, 0, 1),
          0,
          0,
          {
            aPlant: [p.y / height, PART.flower, 0, 0],
            aTint: rng.next(),
          },
        ),
      );
    }
    for (let k = 0; k < ring.length - 1; k++) b.triangle(centre, ring[k] as number, ring[k + 1] as number);
  }
  return { geometry: b.build(), height, radius: height * 0.5 };
}

/** A disc leaf (lotus or lily pad) with a notch, slightly cupped. */
function discLeaf(
  b: GeometryBuilder,
  centre: THREE.Vector3,
  radius: number,
  notch: boolean,
  cup: number,
  heightFrac: number,
  tint: number,
): void {
  const n = new THREE.Vector3(0, 1, 0);
  const c = b.vertex(centre.clone().add(new THREE.Vector3(0, cup * radius, 0)), n, 0.5, 0.5, {
    aPlant: [heightFrac, PART.leaf, 0, 0],
    aTint: tint,
  });
  const seg = 20;
  const ring: number[] = [];
  const start = notch ? 0.18 : 0;
  for (let k = 0; k <= seg; k++) {
    const a = start + (k / seg) * (Math.PI * 2 - start * 2);
    const p = centre.clone().add(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    ring.push(b.vertex(p, n, 0, 0, { aPlant: [heightFrac, PART.leaf, 0, 0], aTint: tint }));
  }
  for (let k = 0; k < seg; k++) b.triangle(c, ring[k + 1] as number, ring[k] as number);
}

/** A lotus clump: a few large leaves held above the water and pink flowers (pond). Height is above the bed. */
export function generateLotus(seed: number, depth: number): PlantGeometry {
  const rng = createRng(seed);
  const b = builder();
  const leaves = rng.int(4, 7);
  const top = depth + 0.5;
  for (let l = 0; l < leaves; l++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0.1, 0.7);
    const h = depth + rng.range(-0.02, 0.6);
    const head = new THREE.Vector3(Math.cos(a) * d, h, Math.sin(a) * d);
    tube(
      b,
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(head.x * 0.5, h * 0.5, head.z * 0.5), head],
      0.012,
      0.01,
      4,
      top,
      rng.next(),
    );
    discLeaf(b, head, rng.range(0.22, 0.32), false, h > depth + 0.05 ? 0.25 : 0.04, head.y / top, rng.next());
  }
  const flowers = rng.int(1, 3);
  for (let f = 0; f < flowers; f++) {
    const a = rng.range(0, Math.PI * 2);
    const head = new THREE.Vector3(Math.cos(a) * 0.25, depth + rng.range(0.4, 0.7), Math.sin(a) * 0.25);
    tube(b, [new THREE.Vector3(0, 0, 0), head], 0.01, 0.009, 4, top, 0.5);
    // A cup of overlapping petals.
    for (let p = 0; p < 10; p++) {
      const pa = (p / 10) * Math.PI * 2;
      const tilt = p % 2 === 0 ? 0.55 : 0.85;
      addPetal(b, head, pa, 0.09, tilt, head.y / top);
    }
  }
  return { geometry: b.build(), height: top, radius: 0.9 };
}

function addPetal(
  b: GeometryBuilder,
  base: THREE.Vector3,
  angle: number,
  length: number,
  tilt: number,
  heightFrac: number,
): void {
  const out = new THREE.Vector3(Math.cos(angle) * Math.sin(tilt), Math.cos(tilt), Math.sin(angle) * Math.sin(tilt));
  const side = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
  const n = new THREE.Vector3().crossVectors(side, out).normalize();
  const attr = { aPlant: [heightFrac, PART.flower, 0, 0], aTint: 0.5 };
  const a = b.vertex(base, n, 0.5, 0, attr);
  const l = b.vertex(
    base
      .clone()
      .add(out.clone().multiplyScalar(length * 0.55))
      .add(side.clone().multiplyScalar(length * 0.3)),
    n,
    0,
    0.5,
    attr,
  );
  const r = b.vertex(
    base
      .clone()
      .add(out.clone().multiplyScalar(length * 0.55))
      .sub(side.clone().multiplyScalar(length * 0.3)),
    n,
    1,
    0.5,
    attr,
  );
  const t = b.vertex(base.clone().add(out.clone().multiplyScalar(length)), n, 0.5, 1, attr);
  b.triangle(a, l, t);
  b.triangle(a, t, r);
}

/** Water lilies: floating notched pads and a white or pink flower on the surface. Height is above the bed. */
export function generateLily(seed: number, depth: number): PlantGeometry {
  const rng = createRng(seed);
  const b = builder();
  const pads = rng.int(3, 6);
  for (let l = 0; l < pads; l++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0.1, 0.5);
    const head = new THREE.Vector3(Math.cos(a) * d, depth + 0.012, Math.sin(a) * d);
    tube(b, [new THREE.Vector3(0, 0, 0), head], 0.006, 0.005, 3, depth, rng.next());
    discLeaf(b, head, rng.range(0.12, 0.2), true, 0.02, 1, rng.next());
  }
  if (rng.chance(0.75)) {
    const head = new THREE.Vector3(rng.range(-0.15, 0.15), depth + 0.03, rng.range(-0.15, 0.15));
    for (let p = 0; p < 12; p++) addPetal(b, head, (p / 12) * Math.PI * 2 + (p % 2) * 0.2, 0.06, p % 2 ? 1.0 : 1.25, 1);
  }
  return { geometry: b.build(), height: depth, radius: 0.6 };
}

/** Java fern: dark lance leaves from a creeping rhizome (grows on stones and wood). */
export function generateJavaFern(seed: number, height: number): PlantGeometry {
  const rng = createRng(seed);
  const b = builder();
  const leaves = rng.int(6, 11);
  for (let l = 0; l < leaves; l++) {
    const a = rng.range(0, Math.PI * 2);
    const dir = new THREE.Vector3(Math.cos(a) * 0.5, rng.range(0.7, 1.2), Math.sin(a) * 0.5).normalize();
    const lt = rng.next();
    addLanceLeaf(
      b,
      new THREE.Vector3(rng.range(-0.04, 0.04), 0, rng.range(-0.04, 0.04)),
      dir,
      height * rng.range(0.7, 1),
      height * 0.1,
      lt,
      0,
      leafAttrs(height, lt),
    );
  }
  return { geometry: b.build(), height, radius: height * 0.5 };
}

/** Cryptocoryne: a low rosette of wavy, bronze-green leaves on the bed. */
export function generateCryptocoryne(seed: number, height: number): PlantGeometry {
  const rng = createRng(seed);
  const b = builder();
  const leaves = rng.int(7, 12);
  for (let l = 0; l < leaves; l++) {
    const a = (l / leaves) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const dir = new THREE.Vector3(Math.cos(a), rng.range(0.8, 1.4), Math.sin(a)).normalize();
    const lt = rng.next();
    addLanceLeaf(
      b,
      new THREE.Vector3(0, 0, 0),
      dir,
      height * rng.range(0.7, 1.05),
      height * 0.18,
      lt,
      0,
      leafAttrs(height, lt),
    );
  }
  return { geometry: b.build(), height, radius: height * 0.6 };
}

/** Red Rotala: a bunch of upright stems with small paired round leaves, redder toward the tips. */
export function generateRotala(seed: number, height: number): PlantGeometry {
  const rng = createRng(seed);
  const b = builder();
  const stems = rng.int(6, 11);
  for (let s = 0; s < stems; s++) {
    const base = new THREE.Vector3(rng.range(-0.08, 0.08), 0, rng.range(-0.08, 0.08));
    const h = height * rng.range(0.7, 1);
    const topP = base.clone().add(new THREE.Vector3(rng.range(-0.05, 0.05), h, rng.range(-0.05, 0.05)));
    tube(b, [base, topP], 0.004, 0.003, 3, height, rng.next());
    const pairs = Math.floor(h / 0.03);
    for (let k = 1; k < pairs; k++) {
      const t = k / pairs;
      const p = base.clone().lerp(topP, t);
      const a = k * 1.3;
      for (const s2 of [0, Math.PI]) {
        const dir = new THREE.Vector3(Math.cos(a + s2), 0.3, Math.sin(a + s2)).normalize();
        const lt = rng.next();
        addLanceLeaf(b, p, dir, 0.022, 0.012, lt, 0, leafAttrs(height, lt));
      }
    }
  }
  return { geometry: b.build(), height, radius: 0.15 };
}

/** Aquatic moss: a low fuzzy cushion (on rocks in fast water). */
export function generateMoss(seed: number, size: number): PlantGeometry {
  const rng = createRng(seed);
  const b = builder();
  for (let k = 0; k < 40; k++) {
    const a = rng.range(0, Math.PI * 2);
    const d = Math.sqrt(rng.next()) * size;
    const p = new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d);
    const dir = new THREE.Vector3(rng.range(-0.4, 0.4), 1, rng.range(-0.4, 0.4)).normalize();
    const lt = rng.next();
    addLanceLeaf(b, p, dir, size * rng.range(0.25, 0.45), size * 0.12, lt, 0, leafAttrs(size * 0.4, lt));
  }
  return { geometry: b.build(), height: size * 0.4, radius: size };
}
