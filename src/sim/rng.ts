/**
 * Seeded random numbers. The same seed always gives the same sequence, which keeps the valley,
 * the scatter layout and the ecology reproducible (plan principle 1).
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  range(min: number, max: number): number;
  /** Integer in [min, maxExclusive). */
  int(min: number, maxExclusive: number): number;
  /** Standard normal (mean 0, standard deviation 1). */
  normal(): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** An independent stream derived from this one and a label, so adding draws elsewhere doesn't shift it. */
  fork(label: string): Rng;
  /** Internal state, for saving and restoring a stream. */
  state(): [number, number, number, number];
}

/** FNV-1a 32-bit hash of a string. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Integer hash of up to three integers, for stateless per-cell randomness. */
export function hash3(x: number, y: number, z = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Stateless uniform value in [0, 1) for integer coordinates. */
export function hash01(x: number, y: number, z = 0): number {
  return hash3(x, y, z) / 4294967296;
}

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function fromState(a: number, b: number, c: number, d: number): Rng {
  let spareNormal: number | null = null;

  // sfc32: small, fast and statistically solid for simulation use.
  const nextU32 = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t;
  };

  const rng: Rng = {
    next: () => nextU32() / 4294967296,
    range: (min, max) => min + (max - min) * rng.next(),
    int: (min, maxExclusive) => min + Math.floor(rng.next() * (maxExclusive - min)),
    normal: () => {
      if (spareNormal !== null) {
        const value = spareNormal;
        spareNormal = null;
        return value;
      }
      let u = 0;
      while (u === 0) u = rng.next();
      const v = rng.next();
      const radius = Math.sqrt(-2 * Math.log(u));
      spareNormal = radius * Math.sin(2 * Math.PI * v);
      return radius * Math.cos(2 * Math.PI * v);
    },
    chance: (probability) => rng.next() < probability,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick() needs at least one item');
      return items[Math.floor(rng.next() * items.length)] as (typeof items)[number];
    },
    fork: (label) => createRng((nextU32() ^ hashString(label)) >>> 0),
    state: () => [a >>> 0, b >>> 0, c >>> 0, d >>> 0],
  };
  return rng;
}

export function createRng(seed: number | string): Rng {
  const numeric = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  const mix = splitmix32(numeric);
  const rng = fromState(mix(), mix(), mix(), mix());
  // Warm up so nearby seeds diverge quickly.
  for (let i = 0; i < 12; i++) rng.next();
  return rng;
}

export function restoreRng(state: readonly [number, number, number, number]): Rng {
  return fromState(state[0], state[1], state[2], state[3]);
}
