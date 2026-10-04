/** Floats per flow cell in shared memory: velX, velZ, foam, depth, shelter, bed, velAlong, velAcross. */
export const FLOW_STRIDE = 8;

export const FLOW = {
  velX: 0,
  velZ: 1,
  foam: 2,
  depth: 3,
  shelter: 4,
  bed: 5,
  velAlong: 6,
  velAcross: 7,
} as const;
