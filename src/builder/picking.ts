/**
 * Ray picking for the builder without three.js: rays against the terrain height map, the water surface and simple
 * shapes (stones as ellipsoids, trees as upright cylinders, fish as spheres). Instanced items are not Object3Ds, so
 * analytic shapes are both simpler and faster than mesh raycasts. Pure TypeScript.
 */

export interface Ray {
  ox: number;
  oy: number;
  oz: number;
  /** Unit direction. */
  dx: number;
  dy: number;
  dz: number;
}

export interface RayHit {
  t: number;
  x: number;
  y: number;
  z: number;
}

function at(ray: Ray, t: number): RayHit {
  return { t, x: ray.ox + ray.dx * t, y: ray.oy + ray.dy * t, z: ray.oz + ray.dz * t };
}

/**
 * First crossing of the ray below a height function (terrain, or a water surface that may be absent: null means no
 * surface at that point). Marches with steps that grow with the height above the surface, then bisects.
 */
export function rayHeight(
  ray: Ray,
  heightAt: (x: number, z: number) => number | null,
  maxDistance = 4000,
  minStep = 0.25,
): RayHit | null {
  let t = 0;
  let prevT = 0;
  let prevAbove = true;
  for (let k = 0; k < 4000 && t <= maxDistance; k++) {
    const x = ray.ox + ray.dx * t;
    const y = ray.oy + ray.dy * t;
    const z = ray.oz + ray.dz * t;
    const h = heightAt(x, z);
    const above = h === null || y > h;
    if (!above && prevAbove && k > 0) {
      // Bisect between the last point above and this one below.
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const hm = heightAt(ray.ox + ray.dx * mid, ray.oz + ray.dz * mid);
        if (hm === null || ray.oy + ray.dy * mid > hm) lo = mid;
        else hi = mid;
      }
      return at(ray, hi);
    }
    if (!above && k === 0) return at(ray, 0);
    prevAbove = above;
    prevT = t;
    // Far above the surface the step can be long; near it, short.
    const gap = h === null ? 2 : y - h;
    t += Math.max(minStep, Math.min(25, gap * 0.4));
  }
  return null;
}

/** Ray against an axis-aligned ellipsoid; returns the nearest t ≥ 0 or null. */
export function rayEllipsoid(
  ray: Ray,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
): number | null {
  // Scale space so the ellipsoid becomes a unit sphere.
  const ox = (ray.ox - cx) / rx;
  const oy = (ray.oy - cy) / ry;
  const oz = (ray.oz - cz) / rz;
  const dx = ray.dx / rx;
  const dy = ray.dy / ry;
  const dz = ray.dz / rz;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);
  if (t0 >= 0) return t0;
  if (t1 >= 0) return t1;
  return null;
}

export function raySphere(ray: Ray, cx: number, cy: number, cz: number, r: number): number | null {
  return rayEllipsoid(ray, cx, cy, cz, r, r, r);
}

/** Ray against an upright cylinder from (cx, y0, cz) to height y0 + h. */
export function rayCylinder(ray: Ray, cx: number, y0: number, cz: number, r: number, h: number): number | null {
  const ox = ray.ox - cx;
  const oz = ray.oz - cz;
  const a = ray.dx * ray.dx + ray.dz * ray.dz;
  let best: number | null = null;
  if (a > 1e-12) {
    const b = 2 * (ox * ray.dx + oz * ray.dz);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t < 0) continue;
        const y = ray.oy + ray.dy * t;
        if (y >= y0 && y <= y0 + h && (best === null || t < best)) best = t;
      }
    }
  }
  // Caps (looking straight down at a tree from the builder camera).
  if (Math.abs(ray.dy) > 1e-9) {
    for (const yc of [y0 + h, y0]) {
      const t = (yc - ray.oy) / ray.dy;
      if (t < 0) continue;
      const x = ray.ox + ray.dx * t - cx;
      const z = ray.oz + ray.dz * t - cz;
      if (x * x + z * z <= r * r && (best === null || t < best)) best = t;
    }
  }
  return best;
}

/** A pickable item for `pickNearest`. */
export interface PickShape {
  uid: string;
  shape: 'ellipsoid' | 'cylinder' | 'sphere';
  x: number;
  y: number;
  z: number;
  /** Ellipsoid radii, or cylinder radius + height in (rx, ry), or sphere radius in rx. */
  rx: number;
  ry: number;
  rz: number;
}

/** The nearest shape the ray hits before `maxT` (e.g. the terrain hit), or null. */
export function pickNearest(ray: Ray, shapes: Iterable<PickShape>, maxT = Infinity): { uid: string; t: number } | null {
  let best: { uid: string; t: number } | null = null;
  for (const s of shapes) {
    const t =
      s.shape === 'ellipsoid'
        ? rayEllipsoid(ray, s.x, s.y, s.z, s.rx, s.ry, s.rz)
        : s.shape === 'cylinder'
          ? rayCylinder(ray, s.x, s.y, s.z, s.rx, s.ry)
          : raySphere(ray, s.x, s.y, s.z, s.rx);
    if (t !== null && t <= maxT && (best === null || t < best.t)) best = { uid: s.uid, t };
  }
  return best;
}
