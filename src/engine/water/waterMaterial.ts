import * as THREE from 'three/webgpu';
import {
  attribute,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  float,
  fract,
  abs,
  mix,
  exp,
  max,
  min,
  clamp,
  smoothstep,
  normalize,
  screenUV,
  viewportSharedTexture,
  viewportDepthTexture,
  perspectiveDepthToViewZ,
  cameraNear,
  cameraFar,
  positionView,
  positionWorld,
  transformNormalToView,
  mx_noise_float,
  frontFacing,
  length,
} from 'three/tsl';

/** Water look controls (plan 6.2): color by depth, clarity, foam, and the light level for in-scattering. */
export interface WaterLook {
  /** Absorption per meter (red is absorbed fastest, so deep water turns turquoise). */
  absorption: { value: THREE.Vector3 };
  /** Color of light scattered inside the water (deep pools). */
  scatter: { value: THREE.Color };
  /** 0 clear .. 1 cloudy (after monsoon rain). */
  turbidity: { value: number };
  /** Muddy tint mixed in with turbidity. */
  silt: { value: THREE.Color };
  /** Sun + sky brightness, scales in-scattering so water darkens at night. */
  light: { value: number };
  time: { value: number };
  /** Wind-driven chop strength (plan 6.3: wind adds small ripples). */
  chop: { value: number };
}

export function createWaterLook(): WaterLook {
  return {
    absorption: uniform(new THREE.Vector3(0.45, 0.085, 0.07)) as any,
    scatter: uniform(new THREE.Color(0.012, 0.11, 0.1)) as any,
    turbidity: uniform(0.08) as any,
    silt: uniform(new THREE.Color(0.16, 0.13, 0.08)) as any,
    light: uniform(1) as any,
    time: uniform(0) as any,
    chop: uniform(0.3) as any,
  };
}

/**
 * Stream and pond water (plan 6.2). Vertex attributes: `uv` addresses the flow texture (across, along),
 * `aMeters` = (across, along) position in meters for ripple tiling, `aFrame` = the stream's local tangent (x, z).
 * The flow texture holds (velocity along, velocity across, foam, depth) per cell.
 */
export function createWaterMaterial(
  flowTexture: THREE.Texture,
  normalMap: THREE.Texture,
  look: WaterLook,
): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({
    metalness: 0,
    roughness: 0.04,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const l: any = look;
  const flow = texture(flowTexture, uv());
  const velocity = vec2(flow.g, flow.r); // (across, along) m/s
  const speed = length(velocity);
  const meters = attribute('aMeters', 'vec2');
  const frame = attribute('aFrame', 'vec2');

  // Flow-map technique: two ripple layers sliding with the current, cross-faded so they never stretch too far.
  const period = float(3.2);
  const t = l.time.div(period);
  const p0 = fract(t);
  const p1 = fract(t.add(0.5));
  const weight = abs(p0.mul(2).sub(1));
  const tile = float(2.6);
  const baseUv = meters.div(tile);
  const drift = velocity.mul(period).div(tile);
  const sampleA = texture(normalMap, baseUv.sub(drift.mul(p0)))
    .xyz.mul(2)
    .sub(1);
  const sampleB = texture(normalMap, baseUv.sub(drift.mul(p1)).add(vec2(0.37, 0.61)))
    .xyz.mul(2)
    .sub(1);
  const flowNormal = mix(sampleA, sampleB, weight);
  // A finer, faster layer plus wind chop.
  const fine = texture(normalMap, baseUv.mul(3.1).sub(drift.mul(p0).mul(2.2)).add(vec2(0.13, 0.29)))
    .xyz.mul(2)
    .sub(1);
  const chop = texture(normalMap, positionWorld.xz.mul(0.9).add(vec2(l.time.mul(0.05), l.time.mul(0.031))))
    .xyz.mul(2)
    .sub(1);
  const foamSolver = clamp(flow.b, 0, 1);
  const strength = float(0.32).add(speed.mul(0.45)).add(foamSolver.mul(0.6));
  const n2 = flowNormal.xy.mul(strength).add(fine.xy.mul(0.25)).add(chop.xy.mul(l.chop));
  const localN = normalize(vec3(n2.x, 1, n2.y)); // (across, up, along)
  const T = vec3(frame.x, 0, frame.y);
  const N = vec3(frame.y.negate(), 0, frame.x);
  const worldN = normalize(
    N.mul(localN.x)
      .add(vec3(0, 1, 0).mul(localN.y))
      .add(T.mul(localN.z)),
  );
  m.normalNode = transformNormalToView(frontFacing.select(worldN, worldN.negate()));

  // Refraction and depth: how much water the view ray crosses before hitting the bed.
  const distortion = worldN.xz.mul(0.035).div(max(positionView.z.negate().mul(0.08), 1));
  const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(screenUV.add(distortion)).x, cameraNear, cameraFar);
  const sceneZStraight = perspectiveDepthToViewZ(viewportDepthTexture(screenUV).x, cameraNear, cameraFar);
  // If the distorted sample hits something in front of the water, fall back to the straight sample.
  const useDistorted = sceneZ.lessThan(positionView.z);
  const thickness = max(positionView.z.sub(useDistorted.select(sceneZ, sceneZStraight)), 0);
  const refractUv = useDistorted.select(screenUV.add(distortion), screenUV);
  const behind = viewportSharedTexture(refractUv).rgb;
  const absorb = vec3(l.absorption).mul(float(1).add(l.turbidity.mul(5)));
  const transmit = exp(absorb.negate().mul(thickness));
  const scatterColor = mix(vec3(l.scatter), vec3(l.silt), l.turbidity).mul(l.light);
  const throughFront = behind.mul(transmit).add(scatterColor.mul(vec3(1).sub(transmit)));
  // From below the surface (diving), you see the bright world above through the surface.
  const water = frontFacing.select(throughFront, behind.mul(0.85).add(scatterColor.mul(0.5)));

  // Foam: the solver's foam (riffles, wakes, waterfall) broken up by a pattern that drifts with the current,
  // plus a thin line where the water meets the shore.
  const foamNoiseA = mx_noise_float(vec3(baseUv.mul(5.5).sub(drift.mul(p0).mul(2)), l.time.mul(0.15)));
  const foamNoiseB = mx_noise_float(vec3(baseUv.mul(5.5).sub(drift.mul(p1).mul(2)).add(3.1), l.time.mul(0.15)));
  const foamPattern = smoothstep(-0.15, 0.55, mix(foamNoiseA, foamNoiseB, weight));
  const shore = smoothstep(0.12, 0.0, thickness).mul(smoothstep(0.1, 0.5, foamNoiseA.add(0.5)));
  const foam = min(foamSolver.mul(foamPattern).mul(1.25).add(shore.mul(0.5)), 0.95);
  m.colorNode = vec4(vec3(0.92, 0.95, 0.95), 1);
  m.backdropNode = water;
  m.backdropAlphaNode = float(1).sub(foam);
  m.roughnessNode = mix(float(0.035), float(0.55), foam);
  return m;
}

/** A 1×1 still-water flow texture (for the pond and waterfall pool). */
export function createStillFlowTexture(): THREE.DataTexture {
  const half = THREE.DataUtils.toHalfFloat;
  const tex = new THREE.DataTexture(
    new Uint16Array([half(0), half(0), half(0), half(2)]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );
  tex.needsUpdate = true;
  return tex;
}
