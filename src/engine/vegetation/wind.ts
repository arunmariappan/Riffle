import * as THREE from 'three/webgpu';
import { Fn, uniform, vec2, vec3, float, sin, cos, dot, max, pow, clamp, mx_noise_float, smoothstep } from 'three/tsl';

/**
 * One wind state for every shader (plan 6.3, D15): direction, speed, gustiness, turbulence, plus travelling
 * gust fronts. The CPU twin lives in src/sim/wind so audio, particles and the ecology read the same wind.
 */
export interface WindUniforms {
  /** Normalized world-space direction the wind blows toward (x, z). */
  direction: { value: THREE.Vector2 };
  /** m/s. */
  speed: { value: number };
  gustiness: { value: number };
  turbulence: { value: number };
  /** Simulation time in seconds (pauses with the simulation). */
  time: { value: number };
  /** Global tree dynamics multipliers (Builder → Trees panel). */
  flexibility: { value: number };
  swayStrength: { value: number };
  leafFlutter: { value: number };
  responseDelay: { value: number };
}

export function createWindUniforms(): WindUniforms {
  return {
    direction: uniform(new THREE.Vector2(0.8, 0.6).normalize()) as any,
    speed: uniform(4) as any,
    gustiness: uniform(0.5) as any,
    turbulence: uniform(0.4) as any,
    time: uniform(0) as any,
    flexibility: uniform(1) as any,
    swayStrength: uniform(1) as any,
    leafFlutter: uniform(1) as any,
    responseDelay: uniform(1) as any,
  };
}

/**
 * Wind strength (0.. ~2) at a world position: base speed plus gust fronts sweeping downwind and noise.
 * Matches src/sim/wind/windField.ts.
 */
export const windStrengthAt = Fn(([worldXZ, w]: [any, any]) => {
  const dir: any = vec2(w.direction);
  const along = dot(worldXZ, dir);
  const across = dot(worldXZ, vec2(dir.y.negate(), dir.x));
  const gustFront = sin(
    along
      .mul(0.045)
      .sub(w.time.mul(w.speed).mul(0.045).mul(0.8))
      .add(sin(across.mul(0.02)).mul(1.5)),
  );
  const gust = pow(max(gustFront, 0), float(3)).mul(w.gustiness);
  const noise = mx_noise_float(vec3(worldXZ.mul(0.03), w.time.mul(0.35)))
    .mul(w.turbulence)
    .mul(0.5);
  const base = clamp(w.speed.div(12), 0, 2);
  return max(base.mul(float(1).add(gust).add(noise)), 0);
});

/**
 * Sway offset (local space) for a plant vertex. Trunk bends slowly with height², branches with distance from the
 * trunk and a delay, leaves flutter quickly. `yaw` rotates the world wind into the instance's local frame.
 */
export const plantSway = Fn(
  ([localPos, worldBaseXZ, yaw, height, radius, stiffness, phase, isLeaf, w]: [
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
  ]) => {
    const strength: any = (windStrengthAt(worldBaseXZ, w) as any)
      .mul(w.swayStrength)
      .mul(w.flexibility)
      .div(max(stiffness, 0.05));
    // Rotate world wind direction into local space (instances rotate only about y).
    const c = cos(yaw);
    const s = sin(yaw);
    const dir: any = vec2(w.direction);
    const localDir: any = vec2(dir.x.mul(c).sub(dir.y.mul(s)), dir.x.mul(s).add(dir.y.mul(c)));
    const h = clamp(localPos.y.div(max(height, 0.1)), 0, 1.2);
    const t = w.time.div(max(w.responseDelay, 0.2));
    // Trunk: slow lean plus a slow oscillation around it.
    const trunk = h
      .mul(h)
      .mul(strength)
      .mul(height.mul(0.035))
      .mul(float(1).add(sin(t.mul(0.9).add(phase)).mul(0.35)));
    // Branches: further from the trunk sways more, with a short delay.
    const r = clamp(vec2(localPos.x, localPos.z).length().div(max(radius, 0.1)), 0, 1.5);
    const branchWave = sin(t.mul(2.1).add(phase).add(localPos.y.mul(0.4)).sub(r.mul(1.3)));
    const branch = r
      .mul(strength)
      .mul(radius.mul(0.03))
      .mul(branchWave)
      .mul(smoothstep(0.15, 0.6, h));
    // Leaves: fast flutter.
    const flutterNoise = mx_noise_float(localPos.mul(2.3).add(vec3(0, t.mul(6), phase)));
    const flutter = isLeaf.mul(w.leafFlutter).mul(strength.mul(0.6).add(0.05)).mul(flutterNoise).mul(0.06);
    const sway: any = trunk.add(branch);
    const offset = vec3(localDir.x.mul(sway), sway.mul(sway).mul(-0.04), localDir.y.mul(sway));
    return offset.add(vec3(flutter, flutter.mul(0.6), flutter.negate()));
  },
);

/** Grass and small plants: bend with height above the ground (0..1 along the blade). */
export const grassSway = Fn(([bladeT, worldXZ, phase, w]: [any, any, any, any]) => {
  const strength: any = (windStrengthAt(worldXZ, w) as any).mul(w.swayStrength);
  const dir: any = vec2(w.direction);
  const wave = sin(w.time.mul(2.4).add(phase).add(dot(worldXZ, dir).mul(0.35)));
  const bend: any = bladeT.mul(bladeT).mul(strength.mul(0.35).add(wave.mul(0.08).mul(strength.add(0.2))));
  return vec3(dir.x.mul(bend), bend.mul(bend).mul(-0.3), dir.y.mul(bend));
});
