import * as THREE from 'three/webgpu';
import { globals } from '../globals';
import {
  texture,
  uniform,
  positionWorld,
  normalWorld,
  vec2,
  vec3,
  vec4,
  float,
  mix,
  smoothstep,
  clamp,
  max,
  triplanarTexture,
  mx_noise_float,
  normalMap,
  cameraPosition,
  normalView,
} from 'three/tsl';
import type { Valley } from '../../sim/terrain/valley';
import { causticLight, waterLevelAt } from '../water/caustics';

/** Texture set for one ground layer. */
interface Layer {
  diffuse: THREE.Texture;
  normal: THREE.Texture | null;
}

const loader = new THREE.TextureLoader();

function loadTexture(url: string, srgb: boolean, fallback: number): THREE.Texture {
  // A 1×1 fallback keeps the material valid if `pnpm assets` hasn't been run.
  const data = new Uint8Array([(fallback >> 16) & 255, (fallback >> 8) & 255, fallback & 255, 255]);
  const placeholder = new THREE.DataTexture(data, 1, 1);
  placeholder.needsUpdate = true;
  const tex = loader.load(
    url,
    (loaded) => {
      loaded.needsUpdate = true;
    },
    undefined,
    () => console.warn(`Missing texture ${url} — run pnpm fetch-assets && pnpm assets`),
  );
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  void placeholder;
  return tex;
}

export function loadLayer(id: string, color: number, withNormal = true): Layer {
  return {
    diffuse: loadTexture(`/assets/textures/${id}/diffuse.webp`, true, color),
    normal: withNormal ? loadTexture(`/assets/textures/${id}/nor_gl.webp`, false, 0x8080ff) : null,
  };
}

/** Packs wetness, flow, sediment and distance-to-water into one RGBA texture over the height map. */
export function createMaskTexture(valley: Valley): THREE.DataTexture {
  const { size } = valley.heightfield;
  const data = new Uint8Array(size * size * 4);
  const m = valley.masks;
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round((m.wetness[i] as number) * 255);
    data[i * 4 + 1] = Math.round(Math.min(1, m.flow[i] as number) * 255);
    data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, 0.5 + (m.sediment[i] as number) * 0.25)) * 255);
    // Distance to the water edge, −10 m .. +50 m.
    data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, ((m.riverDistance[i] as number) + 10) / 60)) * 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export interface TerrainLook {
  /** 0..1 how lush the meadows are (monsoon green vs pre-monsoon dry). */
  lushness: { value: number };
  /** 0..1 extra wetness after rain (darker, glossier ground). */
  rainWetness: { value: number };
  /** Snow line in meters (distant ridges only reach it in winter). */
  snowLine: { value: number };
  /** Water level offset near the stream (wet band follows the level). */
  autumnLeaves: { value: number };
}

export function createTerrainLook(): TerrainLook {
  return {
    lushness: uniform(0.8) as any,
    rainWetness: uniform(0) as any,
    snowLine: uniform(1600) as any,
    autumnLeaves: uniform(0) as any,
  };
}

/**
 * Terrain material (plan 6.1, 8): meadow, forest floor, red laterite soil, granite (triplanar), mossy rock,
 * stream-bed pebbles and sand, blended by slope, wetness, erosion and distance to the water.
 */
export function createTerrainMaterial(
  valley: Valley,
  masks: THREE.Texture,
  look: TerrainLook,
  levelMap: THREE.Texture,
): THREE.MeshStandardNodeMaterial {
  const hf = valley.heightfield;
  const extent = (hf.size - 1) * hf.cell;
  // Samplers are limited (16 per stage on D3D12): only the rock layer keeps a normal map.
  const meadow = loadLayer('leafy_grass', 0x3f5a22, false);
  const forest = loadLayer('forest_leaves_02', 0x4a3a26, false);
  const soil = loadLayer('red_laterite_soil_stones', 0x7a4a30, false);
  const rock = loadLayer('rock_face_03', 0x6a6660);
  const mossRock = loadLayer('mossy_rock', 0x6a6a58, false);
  const pebbles = loadLayer('ganges_river_pebbles', 0x7a7262, false);
  const sand = loadLayer('forrest_sand_01', 0x8a7a60, false);

  const l: any = look;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });

  const maskUv = vec2(
    positionWorld.x.sub(hf.originX).div(hf.cell).add(0.5).div(hf.size),
    positionWorld.z.sub(hf.originZ).div(hf.cell).add(0.5).div(hf.size),
  );
  const mask = texture(masks, maskUv);
  const wet = max(mask.r, l.rainWetness.mul(0.6));
  const flow = mask.g;
  const sediment = mask.b.sub(0.5).mul(4); // meters, + deposited / − eroded
  const riverDist = mask.a.mul(60).sub(10); // meters from the water edge
  const slope = float(1).sub(normalWorld.y);

  // Tiling with large-scale variation to hide repeats.
  const uvGround = positionWorld.xz.mul(0.22);
  const uvFine = positionWorld.xz.mul(0.45);
  const macro = mx_noise_float(vec3(positionWorld.xz.mul(0.012), 1.7))
    .mul(0.5)
    .add(0.5);
  const macro2 = mx_noise_float(vec3(positionWorld.xz.mul(0.05), 4.1))
    .mul(0.5)
    .add(0.5);

  const meadowC = texture(meadow.diffuse, uvGround).rgb;
  const forestC = texture(forest.diffuse, uvGround.mul(0.9)).rgb;
  const soilC = texture(soil.diffuse, uvGround.mul(0.8)).rgb;
  const pebbleC = texture(pebbles.diffuse, uvFine).rgb;
  const sandC = texture(sand.diffuse, uvFine.mul(0.8)).rgb;
  const rockC = triplanarTexture(texture(rock.diffuse), null, null, float(0.11), positionWorld, normalWorld).rgb;
  const mossC = triplanarTexture(texture(mossRock.diffuse), null, null, float(0.16), positionWorld, normalWorld).rgb;

  // Lush monsoon meadow: push the grass texture toward a saturated green that follows the season.
  // The grass texture is tan; monsoon meadows are vivid green, so tint it strongly toward fresh green.
  const meadowLum = meadowC.dot(vec3(0.3, 0.55, 0.15));
  const lushGreen = mix(meadowC.mul(vec3(0.7, 1.05, 0.45)), vec3(0.16, 0.3, 0.06).mul(meadowLum.mul(2.6)), 0.55).mul(
    mix(float(0.88), float(1.12), macro),
  );
  const dryGreen = meadowC.mul(vec3(1.1, 1.0, 0.7));
  const meadowFinal = mix(dryGreen, lushGreen, l.lushness);

  // Forest floor on the slopes and higher ground; meadow on the floodplain.
  const forestMask = smoothstep(14, 40, riverDist).mul(smoothstep(0.35, 0.65, macro.add(slope.mul(1.4))));
  // Monsoon forest floor: leaf litter under a damp, mossy understory.
  const understory = mix(forestC, forestC.mul(vec3(0.55, 0.85, 0.4)), macro2.mul(0.6).add(0.25));
  let ground: any = mix(meadowFinal, understory, forestMask);
  // Red laterite soil where water eroded the slopes and on steep-ish bare ground.
  const soilMask = clamp(sediment.negate().mul(0.8), 0, 1)
    .max(smoothstep(0.18, 0.3, slope).mul(macro2))
    .mul(smoothstep(4, 12, riverDist));
  ground = mix(ground, soilC.mul(1.05), soilMask.mul(0.45));
  // Scree and gravel fans where sediment was deposited.
  const screeMask = clamp(sediment.mul(1.2), 0, 1).mul(smoothstep(0.08, 0.2, slope));
  ground = mix(ground, mix(pebbleC, rockC, 0.5), screeMask.mul(0.7));
  // Granite cliffs, mossy near water and in drainage lines.
  // Monsoon forest clings to slopes up to ~55°; only steeper faces show bare granite.
  const rockMask = smoothstep(0.44, 0.58, slope);
  const mossy = clamp(wet.mul(1.3).add(flow.mul(0.6)), 0, 1);
  ground = mix(ground, mix(rockC, mossC, mossy), rockMask);
  // Sand and pebble bars at the water's edge, pebbles on the stream bed.
  const beach = smoothstep(4, 0.5, riverDist).mul(float(1).sub(rockMask));
  ground = mix(ground, mix(sandC, pebbleC, macro2), beach);
  const bed = smoothstep(0.5, -0.8, riverDist);
  ground = mix(ground, pebbleC.mul(vec3(0.9, 0.95, 0.9)), bed);
  // Wet band near the water: darker and glossier (plan 8).
  const wetBand = smoothstep(3, -0.2, riverDist).max(wet.mul(0.4));
  ground = ground.mul(float(1).sub(wetBand.mul(0.35)));
  // Moss carpets in damp shaded places on the valley floor.
  ground = mix(ground, ground.mul(vec3(0.75, 1.0, 0.6)), wet.mul(0.3).mul(float(1).sub(bed)));
  // From a distance, forested slopes read as a mottled canopy (between the instanced trees).
  const camDist = positionWorld.distance(cameraPosition);
  const crowns = mx_noise_float(vec3(positionWorld.xz.mul(0.16), 3.3))
    .mul(0.5)
    .add(0.5);
  const canopy = mix(vec3(0.035, 0.07, 0.025), vec3(0.075, 0.13, 0.04), crowns).mul(
    mix(float(0.85), float(1.15), macro),
  );
  const canopyMask = forestMask
    .max(smoothstep(25, 55, riverDist))
    .mul(smoothstep(60, 180, camDist))
    .mul(float(1).sub(rockMask.mul(0.8)));
  ground = mix(ground, canopy, canopyMask.mul(0.92));
  // Snow on the high ridges (only reached in winter on the distant mountains).
  const snow = smoothstep(l.snowLine, l.snowLine.add(120), positionWorld.y).mul(smoothstep(0.45, 0.25, slope));
  ground = mix(ground, vec3(0.92, 0.94, 0.97), snow);

  // The solved water surface: wet line just above it, darker and glossier below it, caustics on the bed.
  const waterLevel = waterLevelAt(levelMap, positionWorld, hf);
  const below = waterLevel.sub(positionWorld.y);
  const under = smoothstep(-0.02, 0.06, below);
  const wetLine = smoothstep(-0.4, 0.0, below).mul(float(1).sub(under));
  ground = ground.mul(float(1).sub(wetLine.mul(0.35)).sub(under.mul(0.12)));
  // Rain darkens the ground and gives it a sheen (plan 6.7), less under the forest canopy.
  const rainWet = globals.wetness.mul(float(1).sub(under)).mul(float(1).sub(canopyMask.mul(0.5)));
  ground = ground.mul(float(1).sub(rainWet.mul(0.3)));
  m.colorNode = vec4(ground, 1);
  m.roughnessNode = mix(
    float(0.92),
    float(0.3),
    wetBand.max(bed).max(wetLine).max(under).max(rainWet.mul(0.7)).mul(0.9),
  );
  m.emissiveNode = ground.mul(causticLight(positionWorld, waterLevel));

  // Normal detail on the cliffs (triplanar rock normal map).
  const nRock: any = normalMap(
    triplanarTexture(texture(rock.normal!), null, null, float(0.11), positionWorld, normalWorld),
    vec2(1, 1),
  );
  m.normalNode = mix(normalView, nRock, rockMask).normalize();
  void extent;
  return m;
}
