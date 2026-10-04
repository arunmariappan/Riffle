import { Fn, vec3, float, mx_worley_noise_float, pow, exp, smoothstep, max, texture, vec2 } from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { globals } from '../globals';

/**
 * Animated caustics on the stream bed and rocks under the water (plan 6.2): two drifting cell-noise layers,
 * sharpened, fading with depth. Returns light to add (emissive) for a surface at `worldPos` under `waterLevel`.
 */
export const causticLight = Fn(([worldPos, waterLevel]: [any, any]) => {
  const g: any = globals;
  const depth = max(waterLevel.sub(worldPos.y), 0);
  const p = worldPos.xz.mul(1.6);
  const t = g.time.mul(0.35);
  const a = mx_worley_noise_float(vec3(p, t));
  const b = mx_worley_noise_float(vec3(p.mul(1.37).add(vec2(5.2, 1.3)), t.mul(1.3)));
  const lines = pow(float(1).sub(a.mul(b).mul(2.6).clamp(0, 1)), float(6));
  const under = smoothstep(0.02, 0.12, depth);
  return vec3(g.sunColor).mul(
    lines
      .mul(g.sunLight)
      .mul(exp(depth.negate().mul(0.55)))
      .mul(under)
      .mul(1.8),
  );
});

/** Water level (or −1000) from the world level map at a world position. */
export function waterLevelAt(
  levelMap: THREE.Texture,
  worldPos: any,
  hf: { originX: number; originZ: number; cell: number; size: number },
): any {
  const uvNode = vec2(
    worldPos.x.sub(hf.originX).div(hf.cell).add(0.5).div(hf.size),
    worldPos.z.sub(hf.originZ).div(hf.cell).add(0.5).div(hf.size),
  );
  return texture(levelMap, uvNode).r;
}
