/** Floats per fish in the shared fish buffer (after a 2-float header: count, timestamp ms). */
export const FISH_STRIDE = 16;
/** Fish capacity of the shared buffer. */
export const MAX_FISH = 2000;

/** Field offsets within a fish's slot. */
export const FISH = {
  x: 0,
  y: 1,
  z: 2,
  vx: 3,
  vy: 4,
  vz: 5,
  yaw: 6,
  phase: 7,
  beat: 8,
  length: 9,
  species: 10,
  fleeing: 11,
  id: 12,
  brightness: 13,
  pattern: 14,
  /** Bit flags: FLAG_ROSE (just took an insect at the surface), FLAG_CLINGING. */
  flags: 15,
} as const;

export const FLAG_ROSE = 1;
export const FLAG_CLINGING = 2;
