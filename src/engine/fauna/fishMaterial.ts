import * as THREE from 'three/webgpu';
import {
  attribute,
  positionLocal,
  positionWorld,
  cameraPosition,
  vec3,
  float,
  sin,
  cos,
  mix,
  smoothstep,
  abs,
  floor,
  fract,
  max,
  dot,
  pow,
  normalize,
  mx_noise_float,
  mx_worley_noise_float,
} from 'three/tsl';
import { globals } from '../globals';
import type { FishDef } from '../../content/schema';
import type { FinShape } from '../../procgen/fish';

/** Pattern kinds (plan 6.5): stripes, pearl spots, leopard spots, koi patches, gold metallic scales, plain. */
export type PatternKind = 'stripes' | 'pearls' | 'leopard' | 'koi' | 'gold' | 'plain';

/** What the pattern shader paints on a body (colors from the species palette, plan 7). */
export interface FishLook {
  kind: PatternKind;
  back: number;
  flank: number;
  belly: number;
  /** Stripe, pearl spots, leopard spots, koi patches, scale edges or the lateral line. */
  accent: number;
  /** Second stripe, the danio's orange belly, koi sumi (black) or a thin dark line. */
  accent2: number;
  fin: number;
  finTip: number;
  /** Metallic sheen of the scales (golden mahseer high). */
  metal: number;
  /** Thin-film iridescence strength. */
  iridescence: number;
  finShape: FinShape;
}

const hex = (c: string) => new THREE.Color(c).getHex();

export function lookFromDef(def: FishDef): FishLook {
  const p = def.pattern;
  return {
    kind: p.kind,
    back: hex(p.back),
    flank: hex(p.flank),
    belly: hex(p.belly),
    accent: hex(p.accent),
    accent2: hex(p.accent2),
    fin: hex(p.fin),
    finTip: hex(p.finTip),
    metal: p.metal,
    iridescence: p.iridescence,
    finShape: def.body.fins,
  };
}

const c = (h: number) => {
  const col = new THREE.Color(h);
  return vec3(col.r, col.g, col.b);
};

/**
 * Fish material (plan 6.5). Motion: a travelling wave along the body (head steady, tail swinging) scaled by the tail
 * beat (koi glide between strokes), turns bend and bank the body, paired fins flutter, long fins ripple behind.
 * Per-instance `aSwim` = (phase, beat, turn, length) and `aGene` = (brightness, pattern seed, body depth scale, flags).
 * Pattern: painted from the body coordinates by kind, made more vivid or more muted by the brightness gene. Lighting:
 * metallic scales, thin-film iridescence on the flanks, and fins that glow when the sun shines through them.
 */
export function createFishMaterial(look: FishLook): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.32, metalness: look.metal });
  const fish = attribute('aFish', 'vec4');
  const finK = attribute('aFin', 'float');
  const swim = attribute('aSwim', 'vec4');
  const gene = attribute('aGene', 'vec4');
  const u = fish.x;
  const part = fish.y;
  const vy = fish.z;
  const side = fish.w;
  const isFin = part.greaterThan(0.5).and(part.lessThan(5.5));
  const isBarbel = part.greaterThan(5.5);
  const isPaired = part.greaterThan(2.5).and(part.lessThan(4.5));
  const phase = swim.x;
  const beat = swim.y;
  const turn = swim.z;
  const brightness = gene.x;
  const seed = gene.y;
  const depthScale = gene.z;
  const t: any = globals.time;
  const flowing = look.finShape === 'flowing';
  const sucker = look.finShape === 'sucker';

  // --- Motion ----------------------------------------------------------------------------------------------------
  // Travelling wave: amplitude grows toward the tail and with the tail beat (gliding koi barely move).
  const stroke = smoothstep(0.8, 5, beat).mul(0.85).add(0.15);
  const wave = sin(u.mul(Math.PI * 2 * 0.9).sub(phase));
  const amp = u
    .mul(u)
    .mul(sucker ? 0.05 : 0.11)
    .add(0.004)
    .mul(stroke);
  const bend = wave.mul(amp).add(turn.mul(u.mul(u)).mul(0.25));
  // Paired fins flutter on their own; loach suction fins hardly move.
  const flutter = isPaired.select(
    sin(t.mul(9).add(phase.mul(0.5)).add(finK.mul(2)))
      .mul(sucker ? 0.03 : 0.25)
      .mul(finK),
    float(0),
  );
  // Median fins ripple behind the body and trail out of turns; long koi fins most of all.
  const ripple = isFin.and(isPaired.not()).select(
    sin(phase.sub(finK.mul(2.6)).sub(u.mul(3)))
      .mul(finK)
      .mul(flowing ? 0.06 : 0.015)
      .sub(turn.mul(finK).mul(flowing ? 0.12 : 0.05)),
    float(0),
  );
  const p = positionLocal;
  const lateral = p.x
    .add(bend)
    .add(ripple)
    .add(flutter.mul(abs(p.y)));
  const y = p.y.mul(depthScale).add(flutter.mul(isPaired.select(abs(p.x), float(0))).mul(0.6));
  // Banked turns: roll the cross-section into the turn.
  const roll = turn.mul(0.9).clamp(-0.45, 0.45);
  const cr = cos(roll);
  const sr = sin(roll);
  m.positionNode = vec3(lateral.mul(cr).sub(y.mul(sr)), lateral.mul(sr).add(y.mul(cr)), p.z.add(abs(bend).mul(-0.15)));

  // --- Pattern -------------------------------------------------------------------------------------------------------
  let body: any = mix(c(look.belly), c(look.flank), smoothstep(-0.7, -0.1, vy));
  body = mix(body, c(look.back), smoothstep(0.25, 0.85, vy));
  // Fine scale shimmer everywhere.
  body = body.mul(
    mx_noise_float(vec3(u.mul(60), vy.mul(12), 0.3))
      .mul(0.08)
      .add(1),
  );
  let metalMask: any = smoothstep(-0.9, -0.2, vy).mul(smoothstep(0.95, 0.6, vy));
  let glint: any = float(0);
  let fins: any = mix(c(look.fin), c(look.finTip), smoothstep(0.65, 1, finK));

  switch (look.kind) {
    case 'stripes': {
      // Denison barb: black lateral stripe from snout to tail, a red line above it on the front half.
      const stripe = smoothstep(0.2, 0.08, abs(vy.add(0.02)))
        .mul(smoothstep(0.0, 0.05, u))
        .mul(smoothstep(0.98, 0.9, u));
      body = mix(body, c(look.accent), stripe);
      const red = smoothstep(0.12, 0.2, vy)
        .mul(smoothstep(0.38, 0.28, vy))
        .mul(smoothstep(0.04, 0.1, u))
        .mul(smoothstep(0.55, 0.42, u));
      body = mix(body, c(look.accent2), red);
      // Tail: a yellow band with a black tip on each lobe.
      const isTail = part.greaterThan(0.5).and(part.lessThan(1.5));
      const lobe = smoothstep(0.35, 0.95, abs(vy).mul(2.4));
      fins = isTail.select(
        mix(mix(c(look.fin), c(look.finTip), lobe), c(0x111111), smoothstep(0.8, 0.98, finK).mul(lobe)),
        fins,
      );
      break;
    }
    case 'pearls': {
      // Celestial pearl danio: pearl spots over a blue-grey body, orange belly; orange fins with black bars.
      const cell = mx_worley_noise_float(vec3(u.mul(15), vy.mul(4.5), side.mul(3.1).add(seed.mul(7))));
      const spots = smoothstep(0.34, 0.2, cell)
        .mul(smoothstep(0.9, 0.55, abs(vy)))
        .mul(smoothstep(0.08, 0.16, u));
      body = mix(body, c(look.accent), spots.mul(0.95));
      body = mix(
        body,
        c(look.accent2),
        smoothstep(-0.15, -0.6, vy)
          .mul(smoothstep(0.75, 0.3, u))
          .mul(0.8),
      );
      glint = spots.mul(0.12);
      const bars = smoothstep(0.55, 0.75, sin(finK.mul(16).add(u.mul(4))));
      fins = mix(c(look.fin), c(look.finTip), bars.mul(0.85).max(smoothstep(0.85, 1, finK)));
      break;
    }
    case 'leopard': {
      // Hillstream loach: dark irregular blotches and saddle bands over tan, pale belly; mottled fins.
      const blot = mx_worley_noise_float(vec3(u.mul(11), vy.mul(3.2), side.add(seed.mul(5)))).add(
        mx_noise_float(vec3(u.mul(30), vy.mul(8), seed)).mul(0.12),
      );
      const dark = smoothstep(0.36, 0.2, blot).mul(smoothstep(-0.5, 0.0, vy));
      const bands = smoothstep(0.55, 0.9, sin(u.mul(26))).mul(smoothstep(0.2, 0.7, vy));
      body = mix(body, c(look.accent), dark.max(bands.mul(0.6)));
      const finSpots = smoothstep(0.4, 0.25, mx_worley_noise_float(vec3(u.mul(18), finK.mul(6), side.add(seed))));
      fins = mix(fins, c(look.accent2), finSpots.mul(0.7));
      metalMask = metalMask.mul(0.3);
      break;
    }
    case 'koi': {
      // Koi: patches inherited between generations (the pattern seed). Kohaku (red on white), Sanke (with small black
      // sumi), Showa (more black), or a metallic gold Ogon.
      const n = mx_noise_float(vec3(u.mul(3.4), vy.mul(1.7), seed.mul(13)))
        .add(mx_noise_float(vec3(u.mul(7), vy.mul(3.4), seed.mul(29))).mul(0.35))
        .add(vy.mul(0.35));
      const red = smoothstep(0.02, 0.12, n.sub(0.1)).mul(smoothstep(-0.75, -0.35, vy));
      const sumiAmount = smoothstep(0.55, 0.6, seed).mul(smoothstep(0.88, 0.84, seed).mul(0.6).add(0.4));
      const sumi = smoothstep(0.42, 0.55, mx_noise_float(vec3(u.mul(7.5), vy.mul(3.2), seed.mul(41)))).mul(sumiAmount);
      const showa = smoothstep(0.8, 0.85, seed).mul(smoothstep(0.9, 0.86, seed));
      let koi: any = mix(c(look.flank), c(look.accent), red);
      koi = mix(
        koi,
        c(look.accent2),
        sumi.max(showa.mul(smoothstep(0.1, 0.3, mx_noise_float(vec3(u.mul(4), vy.mul(2), seed.mul(5)))))),
      );
      const ogon = smoothstep(0.9, 0.93, seed);
      body = mix(koi, c(0xe0a838), ogon).mul(
        mx_noise_float(vec3(u.mul(60), vy.mul(12), 0.3))
          .mul(0.05)
          .add(1),
      );
      metalMask = metalMask.mul(ogon.mul(0.8).add(0.2));
      // Long white fins, sometimes red at the base.
      fins = mix(
        c(look.fin),
        c(look.finTip),
        smoothstep(0.35, 0.0, finK)
          .mul(smoothstep(0.3, 0.6, seed))
          .mul(0.7),
      );
      break;
    }
    case 'gold': {
      // Golden mahseer: big scales with darker edges over metallic gold flanks; reddish-orange fins.
      const su = u.mul(30);
      const row = floor(su);
      const sv = vy.mul(6).add(row.mod(2).mul(0.5));
      const fu = abs(fract(su).sub(0.5));
      const fv = abs(fract(sv).sub(0.5));
      const edge = smoothstep(0.32, 0.5, max(fu, fv));
      body = mix(body, c(look.accent), edge.mul(0.35));
      metalMask = metalMask.mul(float(1).sub(edge.mul(0.45)));
      glint = float(1)
        .sub(edge)
        .mul(smoothstep(-0.6, 0.3, vy))
        .mul(0.04);
      break;
    }
    case 'plain': {
      // White cloud minnow: a shining gold line along the side over a thin dark one; red fins with white tips.
      const line = smoothstep(0.11, 0.03, abs(vy.sub(0.06)))
        .mul(smoothstep(0.05, 0.15, u))
        .mul(smoothstep(0.92, 0.75, u));
      const dark = smoothstep(0.06, 0.02, abs(vy.add(0.06)))
        .mul(smoothstep(0.1, 0.2, u))
        .mul(smoothstep(0.92, 0.8, u));
      body = mix(body, c(look.accent2), dark.mul(0.7));
      body = mix(body, c(look.accent), line);
      glint = line.mul(0.25);
      break;
    }
  }

  // Brightness gene: vivid fish keep their colors; drab ones fade toward an olive grey (plan D20: predators favor
  // camouflage, mates favor brightness).
  const vivid = (col: any) => {
    const luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(luma).mul(vec3(0.95, 0.93, 0.82)), col, brightness.mul(0.75).add(0.45)).max(0);
  };
  const bodyCol = vivid(body);
  const finCol = vivid(fins);
  const barbelCol = c(look.flank).mul(0.75);
  m.colorNode = isBarbel.select(barbelCol, isFin.select(finCol, bodyCol));
  m.metalnessNode = isFin.or(isBarbel).select(float(0), metalMask.mul(look.metal));
  m.roughnessNode = isFin.select(float(0.55), float(look.kind === 'gold' ? 0.24 : 0.32));
  if (look.iridescence > 0.02) {
    m.iridescenceNode = isFin.or(isBarbel).select(float(0), smoothstep(-0.8, 0.0, vy).mul(look.iridescence));
    m.iridescenceIORNode = float(1.33);
    m.iridescenceThicknessNode = mix(
      float(260),
      float(520),
      mx_noise_float(vec3(u.mul(8), vy.mul(3), seed.mul(3)))
        .mul(0.5)
        .add(0.5),
    );
  }

  // Fins glow when the sun shines through them toward you; scales glint a little.
  const viewDir = normalize(positionWorld.sub(cameraPosition));
  const sunDir: any = globals.sunDirection;
  const through = pow(max(dot(viewDir, sunDir), 0), float(4));
  const sun = vec3(globals.sunColor as any).mul(globals.sunLight as any);
  m.emissiveNode = isFin.select(finCol.mul(sun).mul(through).mul(0.7), bodyCol.mul(sun).mul(glint));

  // Fins are see-through, more at the edges (dithered alpha, smoothed by TRAA); long koi fins most of all.
  const finAlpha = mix(float(flowing ? 0.75 : 0.85), float(flowing ? 0.3 : 0.45), finK);
  m.opacityNode = isFin.select(finAlpha, float(1));
  m.alphaHash = true;
  return m;
}
