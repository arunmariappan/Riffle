import * as THREE from 'three/webgpu';
import {
  attribute,
  positionLocal,
  vec3,
  float,
  sin,
  cos,
  mix,
  smoothstep,
  abs,
  uniform,
  normalView,
  positionViewDirection,
  dot,
  pow,
  max,
  mx_noise_float,
} from 'three/tsl';
import { globals } from '../globals';

/** Pattern presets (plan 6.5): what the pattern shader paints on a body template. */
export interface FishPattern {
  /** Back, flank and belly colors. */
  back: number;
  flank: number;
  belly: number;
  /** Lateral stripe (Denison barb black line), 0 = none. */
  stripe: number;
  stripeColor: number;
  /** Second stripe above it on the front half (the barb's red line), 0 = none. */
  stripe2: number;
  stripe2Color: number;
  /** Fin color and tail tips. */
  fin: number;
  finTip: number;
  /** Metallic sheen of the scales (gold mahseer high). */
  metal: number;
  /** Thin-film iridescence strength. */
  iridescence: number;
}

export const DENISON_PATTERN: FishPattern = {
  back: 0x6f7a52,
  flank: 0xc8ccc0,
  belly: 0xe8e6dc,
  stripe: 1,
  stripeColor: 0x141414,
  stripe2: 1,
  stripe2Color: 0xd42a1c,
  fin: 0xd8d0b8,
  finTip: 0xe8c43a,
  metal: 0.35,
  iridescence: 0.25,
};

/**
 * Fish material (plan 6.5): the swim motion is a travelling wave along the body (head steady, tail swinging), fins
 * flutter on their own, and the pattern is painted from the body coordinates. Per-instance `aSwim` = (phase, beat,
 * turn, length) drives the motion. Fins are see-through (dithered alpha, smoothed by TRAA).
 */
export function createFishMaterial(pattern: FishPattern): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.32, metalness: pattern.metal });
  const fish = attribute('aFish', 'vec4');
  const swim = attribute('aSwim', 'vec4');
  const u = fish.x;
  const part = fish.y;
  const vy = fish.z;
  const isFin = part.greaterThan(0.5);
  const phase = swim.x;
  const turn = swim.z;

  // Travelling wave: amplitude grows toward the tail; turning bends the whole body.
  const wave = sin(u.mul(Math.PI * 2 * 0.9).sub(phase));
  const amp = u.mul(u).mul(0.11).add(0.004);
  const bend = wave.mul(amp).add(turn.mul(u.mul(u)).mul(0.25));
  // Pectoral and pelvic fins flutter; the tail fin lags a little behind the body wave.
  const flutter = sin((globals.time as any).mul(9).add(phase.mul(0.5)))
    .mul(0.25)
    .mul(part.greaterThan(2.5).select(float(1), float(0)));
  const p = positionLocal;
  const lateral = p.x.add(bend).add(flutter.mul(p.y.abs()));
  m.positionNode = vec3(lateral, p.y, p.z.add(abs(bend).mul(-0.15)));

  // Pattern.
  const c = (hex: number) => vec3(new THREE.Color(hex).r, new THREE.Color(hex).g, new THREE.Color(hex).b);
  const backToBelly = smoothstep(-0.6, 0.6, vy);
  let body: any = mix(c(pattern.belly), c(pattern.flank), smoothstep(-0.7, -0.1, vy));
  body = mix(body, c(pattern.back), smoothstep(0.25, 0.85, vy));
  // Fine scale shimmer.
  const scales = mx_noise_float(vec3(u.mul(60), vy.mul(12), 0.3))
    .mul(0.08)
    .add(1);
  body = body.mul(scales);
  // Lateral black stripe from snout to tail.
  const stripe = smoothstep(0.2, 0.08, abs(vy.add(0.02)))
    .mul(smoothstep(0.0, 0.05, u))
    .mul(smoothstep(0.98, 0.9, u))
    .mul(pattern.stripe);
  body = mix(body, c(pattern.stripeColor), stripe);
  // Red stripe above it on the front half.
  const stripe2 = smoothstep(0.12, 0.2, vy)
    .mul(smoothstep(0.38, 0.28, vy))
    .mul(smoothstep(0.04, 0.1, u))
    .mul(smoothstep(0.55, 0.42, u))
    .mul(pattern.stripe2);
  body = mix(body, c(pattern.stripe2Color), stripe2);
  void backToBelly;
  // Fins: pale with colored tips; the tail has a yellow band and a black tip on each lobe.
  const tipAmount = smoothstep(0.35, 0.95, abs(vy).mul(2.4)).mul(part.lessThan(1.5).select(float(1), float(0.5)));
  const finCol = mix(c(pattern.fin), c(pattern.finTip), tipAmount);
  const finCol2 = mix(
    finCol,
    c(0x111111),
    smoothstep(0.9, 1.15, abs(vy).mul(2.6)).mul(part.lessThan(1.5).select(float(1), float(0))),
  );
  m.colorNode = isFin.select(finCol2, body);

  // Iridescent sheen: color shifts with viewing angle on the flanks.
  const facing = max(dot(normalView, positionViewDirection), 0);
  const film = vec3(sin(facing.mul(9).add(1)), sin(facing.mul(9).add(3)), sin(facing.mul(9).add(5)))
    .mul(0.5)
    .add(0.5);
  m.emissiveNode = isFin.select(
    vec3(0),
    film
      .mul(pow(float(1).sub(facing), float(3)))
      .mul(pattern.iridescence)
      .mul(0.25),
  );
  m.opacityNode = isFin.select(float(0.62), float(1));
  m.alphaHash = true;
  void cos;
  void uniform;
  return m;
}
