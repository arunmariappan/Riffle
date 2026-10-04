import * as THREE from 'three/webgpu';
import { positionWorld, normalWorld, vec3, mix, smoothstep, float, color, mx_noise_float } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Engine } from './Engine';
import { SkySystem } from './sky/SkySystem';
import { createPipeline, createPostControls, type QualityPreset } from './post/pipeline';
import { createWindUniforms } from './vegetation/wind';
import {
  createBarkMaterial,
  createLeafCardMaterial,
  createBambooCulmMaterial,
  createPolyLeafMaterial,
  createFoliageLook,
} from './vegetation/materials';
import { createGrassMesh, createGrassLook, createGrassMaterial, scatterBlades } from './vegetation/grass';
import { generateTree, type TreeSpecies } from '../procgen/trees';
import { generateBamboo } from '../procgen/bamboo';
import { setPlantInstanceAttributes } from '../procgen/geometry';
import { createSimplex2, fbm } from '../sim/noise';

export interface TestSceneHandle {
  setQuality(q: QualityPreset): void;
  dispose(): void;
}

const TEST_SPECIES: TreeSpecies[] = [
  { id: 'ash', preset: 'Ash Medium', height: 14, barkTint: 0xb8b0a4, leafTint: 0xffffff },
  { id: 'oak', preset: 'Oak Medium', height: 12, barkTint: 0xa89c90, leafTint: 0xffffff },
  { id: 'pine', preset: 'Pine Medium', height: 18, barkTint: 0x9a8a7c, leafTint: 0xffffff },
];

/**
 * Phase 0 rendering test scene (plan Phase 0, task 4): a 200 m patch with noise terrain, a water plane,
 * 3 EZ-Tree trees with wind, a bamboo clump, grass, cascaded shadows and the GTAO / SSGI / TRAA chain.
 */
export async function buildTestScene(engine: Engine, quality: QualityPreset): Promise<TestSceneHandle> {
  const { scene, renderer } = engine;
  const camera = engine.camera;
  camera.position.set(-34, 9, 46);
  camera.near = 0.1;
  camera.far = 25000;
  camera.updateProjectionMatrix();
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 3, 0);
  controls.enableDamping = true;
  controls.update();

  const noise = createSimplex2('test-patch');
  const heightAt = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    const bowl = r < 14 ? -1.6 * (1 - (r / 14) ** 2) : 0;
    return fbm(noise, x, z, { octaves: 5, frequency: 0.012 }) * 7 + bowl + Math.max(0, r - 60) * 0.25;
  };

  // Terrain.
  const terrainGeo = new THREE.PlaneGeometry(200, 200, 256, 256);
  terrainGeo.rotateX(-Math.PI / 2);
  const pos = terrainGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  terrainGeo.computeVertexNormals();
  const terrainMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const slope = float(1).sub(normalWorld.y);
  const n = mx_noise_float(positionWorld.mul(0.35)).mul(0.5).add(0.5);
  const grass = mix(color(0x2f4a1c), color(0x4d6a2a), n);
  const rock = mix(color(0x5a5650), color(0x7a746a), n);
  const mud = color(0x3b3226);
  let ground: any = mix(grass, rock, smoothstep(0.18, 0.35, slope));
  ground = mix(mud, ground, smoothstep(-0.9, 0.2, positionWorld.y));
  terrainMat.colorNode = ground;
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.receiveShadow = true;
  terrain.castShadow = true;
  scene.add(terrain);

  // Water plane in the bowl.
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(15, 48).rotateX(-Math.PI / 2),
    new THREE.MeshPhysicalNodeMaterial({
      color: 0x1f5a5a,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      opacity: 0.78,
      ior: 1.33,
    }),
  );
  water.position.y = -0.55;
  scene.add(water);
  void vec3;

  // Wind shared by all plants.
  const wind = createWindUniforms();

  // Three trees.
  const positions: [number, number][] = [
    [-18, -10],
    [20, -16],
    [-4, -32],
  ];
  TEST_SPECIES.forEach((species, k) => {
    const geo = generateTree(species, 100 + k);
    const [x, z] = positions[k] as [number, number];
    const inst = [{ x, z, yaw: k * 1.7, scale: 1, phase: k * 2.1, stiffness: species.id === 'pine' ? 1.4 : 1 }];
    setPlantInstanceAttributes(geo.branches, inst, geo.height, geo.radius);
    setPlantInstanceAttributes(geo.leaves, inst, geo.height, geo.radius);
    const look = createFoliageLook(species.id === 'pine' ? 0x2c4a22 : 0x3f6a26, 0xb8401e);
    const bark = new THREE.InstancedMesh(
      geo.branches,
      createBarkMaterial(wind, look, geo.barkMap, geo.barkNormal, species.barkTint),
      1,
    );
    const leaves = new THREE.InstancedMesh(geo.leaves, createLeafCardMaterial(wind, look, geo.leafMap), 1);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, heightAt(x, z) - 0.1, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), k * 1.7),
      new THREE.Vector3(1, 1, 1),
    );
    for (const mesh of [bark, leaves]) {
      mesh.setMatrixAt(0, matrix);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
  });

  // Bamboo clump.
  const bamboo = generateBamboo({ seed: 7 });
  const bx = 12;
  const bz = 8;
  const bambooInst = [{ x: bx, z: bz, yaw: 0, scale: 1, phase: 0.4, stiffness: 0.7 }];
  setPlantInstanceAttributes(bamboo.culms, bambooInst, bamboo.height, bamboo.radius);
  setPlantInstanceAttributes(bamboo.leaves, bambooInst, bamboo.height, bamboo.radius);
  const bambooLook = createFoliageLook(0x4f7a22, 0x8a8a30);
  const culmMesh = new THREE.InstancedMesh(bamboo.culms, createBambooCulmMaterial(wind, bambooLook), 1);
  const bambooLeafMesh = new THREE.InstancedMesh(bamboo.leaves, createPolyLeafMaterial(wind, bambooLook), 1);
  const bm = new THREE.Matrix4().makeTranslation(bx, heightAt(bx, bz) - 0.05, bz);
  for (const mesh of [culmMesh, bambooLeafMesh]) {
    mesh.setMatrixAt(0, bm);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  // Grass around the bowl, thinning on slopes and near the water.
  const blades = scatterBlades(11, { minX: -60, minZ: -60, maxX: 60, maxZ: 60 }, 60000, heightAt, (x, z) => {
    const r = Math.hypot(x, z);
    return r < 15.5 ? 0 : r > 58 ? 0 : 1;
  });
  scene.add(createGrassMesh(blades, createGrassMaterial(wind, createGrassLook())));

  // Sky, sun and shadows.
  const sky = new SkySystem(renderer, scene, camera, 220);
  const params = new URLSearchParams(window.location.search);
  if (params.has('sun')) sky.sunStrength = Number(params.get('sun'));
  if (params.has('env')) sky.skyLightStrength = Number(params.get('env'));
  if (params.has('hemi')) sky.hemiStrength = Number(params.get('hemi'));
  const sunDir = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - 32),
    THREE.MathUtils.degToRad(215),
  );
  const sunState = { direction: sunDir, moonDirection: new THREE.Vector3(0, -1, 0), cloudCover: 0.25, haze: 0.25 };

  // Post-processing.
  const post = createPostControls();
  let handle = createPipeline(renderer, scene, camera, quality, post);
  engine.pipeline = handle.pipeline;

  const unsubscribe = engine.onFrame((info) => {
    (wind.time as any).value = info.time;
    controls.update();
    sky.update(sunState, controls.target);
  });

  return {
    setQuality(q) {
      handle.dispose();
      handle = createPipeline(renderer, scene, camera, q, post);
      engine.pipeline = handle.pipeline;
    },
    dispose() {
      unsubscribe();
      controls.dispose();
      sky.dispose();
      handle.dispose();
    },
  };
}
