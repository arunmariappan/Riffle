import * as THREE from 'three/webgpu';
import {
  pass,
  mrt,
  output,
  diffuseColor,
  normalView,
  packNormalToRGB,
  unpackRGBToNormal,
  velocity,
  sample,
  vec3,
  vec4,
  uniform,
  float,
  mix,
  dot,
  screenUV,
  length,
  smoothstep,
  exp,
} from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export const QUALITY_PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

/** Shared grading / underwater controls that survive pipeline rebuilds. */
export interface PostControls {
  saturation: { value: number };
  contrast: { value: number };
  tint: { value: THREE.Color };
  /** 0 above water, 1 fully underwater. */
  underwater: { value: number };
  underwaterColor: { value: THREE.Color };
  /** Visibility distance underwater in meters (turbidity). */
  underwaterVisibility: { value: number };
  bloomStrength: { value: number };
  vignette: { value: number };
}

export function createPostControls(): PostControls {
  return {
    saturation: uniform(1.06) as any,
    contrast: uniform(1.04) as any,
    tint: uniform(new THREE.Color(1, 1, 1)) as any,
    underwater: uniform(0) as any,
    underwaterColor: uniform(new THREE.Color(0.06, 0.32, 0.3)) as any,
    underwaterVisibility: uniform(14) as any,
    bloomStrength: uniform(0.12) as any,
    vignette: uniform(0.12) as any,
  };
}

export interface PipelineHandle {
  pipeline: THREE.RenderPipeline;
  quality: QualityPreset;
  dispose(): void;
}

/**
 * Builds the post-processing chain for a quality preset (plan D13):
 * scene pass with MRT → GTAO (medium) or SSGI (high/ultra) → TRAA → bloom → grading/underwater.
 */
export function createPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  quality: QualityPreset,
  controls: PostControls,
  options: { temporal?: boolean } = {},
): PipelineHandle {
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass: any = pass(scene, camera);
  const c: any = controls;

  let color: any;

  if (quality === 'low') {
    color = scenePass.getTextureNode('output');
  } else {
    scenePass.setMRT(
      mrt({
        output,
        diffuseColor,
        normal: packNormalToRGB(normalView),
        velocity,
      }),
    );
    const diffuseTexture = scenePass.getTexture('diffuseColor');
    diffuseTexture.type = THREE.UnsignedByteType;
    const normalTexture = scenePass.getTexture('normal');
    normalTexture.type = THREE.UnsignedByteType;

    const sceneColor = scenePass.getTextureNode('output');
    const sceneDiffuse = scenePass.getTextureNode('diffuseColor');
    const depth = scenePass.getTextureNode('depth');
    const sceneNormal = scenePass.getTextureNode('normal');
    const vel = scenePass.getTextureNode('velocity');
    const decodedNormal = sample((uv: any) => unpackRGBToNormal(sceneNormal.sample(uv)));

    if (quality === 'medium') {
      const aoPass: any = ao(depth, decodedNormal, camera);
      aoPass.resolutionScale = 0.5;
      const occlusion = aoPass.getTextureNode().r;
      color = vec4(sceneColor.rgb.mul(occlusion), sceneColor.a);
    } else {
      const giPass: any = ssgi(sceneColor, depth, decodedNormal, camera as THREE.PerspectiveCamera);
      giPass.sliceCount.value = quality === 'ultra' ? 3 : 2;
      giPass.stepCount.value = quality === 'ultra' ? 16 : 8;
      giPass.giIntensity.value = 0.4;
      // three 0.186: AO and GI live in separate textures (the node itself returns the AO texture).
      const gi = giPass.getGINode().rgb;
      const occlusion = giPass.getAONode().r;
      color = vec4(sceneColor.rgb.mul(occlusion).add(sceneDiffuse.rgb.mul(gi)), sceneColor.a);
    }
    // Photo accumulation does its own anti-aliasing (and moves the camera between frames), so it skips TRAA.
    if (options.temporal !== false) color = traa(color, depth, vel, camera);
  }

  // Bloom on bright highlights only (sun glints, foam in sunlight).
  const bloomPass: any = bloom(color, 0.12, 0.35, 0.92);
  bloomPass.strength = c.bloomStrength;
  let graded: any = color.add(bloomPass);

  // Underwater: distance fog toward the water color, plus a slight blue-green shift.
  const distance = scenePass.getViewZNode().negate();
  const fogAmount = float(1).sub(exp(distance.negate().div(c.underwaterVisibility)));
  // Underwater the light also loses red quickly; fog takes over within a few meters.
  const underwaterColor = mix(
    graded.rgb.mul(vec3(0.45, 0.85, 0.8)),
    vec3(c.underwaterColor),
    fogAmount.mul(1.15).min(1),
  );
  graded = vec4(mix(graded.rgb, underwaterColor, c.underwater), graded.a);

  // Grading: contrast around mid grey, saturation, tint, gentle vignette (plan 8: "grading stays real").
  const luma = dot(graded.rgb, vec3(0.2126, 0.7152, 0.0722));
  let rgb: any = mix(vec3(luma), graded.rgb, c.saturation);
  rgb = rgb.sub(0.18).mul(c.contrast).add(0.18).max(0);
  rgb = rgb.mul(vec3(c.tint));
  const vignette = float(1).sub(smoothstep(0.45, 1.1, length(screenUV.sub(0.5)).mul(1.6)).mul(c.vignette));
  rgb = rgb.mul(vignette);

  pipeline.outputNode = vec4(rgb, 1);
  return {
    pipeline,
    quality,
    dispose: () => pipeline.dispose(),
  };
}
