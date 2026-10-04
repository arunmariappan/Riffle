import * as THREE from 'three/webgpu';
import * as Comlink from 'comlink';
import type { Engine, FrameInfo } from '../Engine';
import type { TerrainWorkerApi } from '../../workers/terrain.worker';
import type { Valley, Spot } from '../../sim/terrain/valley';
import { sampleHeight } from '../../sim/terrain/heightfield';
import { SimClock } from '../../sim/time/clock';
import { scatterItems, cellInfo, type ScatterItem } from '../../sim/scatter/scatter';
import { loadCatalog } from '../../content/catalog';
import { TerrainSystem } from '../terrain/TerrainSystem';
import { SkySystem } from '../sky/SkySystem';
import { Atmosphere } from '../sky/Atmosphere';
import { createWindUniforms, type WindUniforms } from '../vegetation/wind';
import { TreeSystem } from '../vegetation/TreeSystem';
import { GrassSystem } from '../vegetation/GrassSystem';
import { RockSystem } from './RockSystem';
import { Physics } from '../physics/Physics';
import { ExplorePlayer } from '../player/ExplorePlayer';
import { Input } from '../player/Input';
import {
  createPipeline,
  createPostControls,
  type PipelineHandle,
  type PostControls,
  type QualityPreset,
} from '../post/pipeline';
import { grassDensityAt } from '../../sim/scatter/grassDensity';

export interface WorldOptions {
  seed: string;
  quality: QualityPreset;
  onProgress?: (label: string, fraction: number) => void;
  day?: number;
  hour?: number;
  spot?: string;
}

export type CameraMode = 'explore' | 'builder' | 'photo' | 'fixed';

const QUALITY_GRASS: Record<QualityPreset, number> = { low: 0.35, medium: 0.6, high: 1, ultra: 1.3 };
/** Render resolution per preset; TRAA upscales to the output (plan D9). */
export const QUALITY_RENDER_SCALE: Record<QualityPreset, number> = { low: 0.7, medium: 0.8, high: 0.85, ultra: 1 };

/**
 * Everything in the valley (plan 5): terrain, sky, atmosphere, plants, rocks, physics, the player and the clock.
 * Systems are plain classes; the World wires them together and runs them each frame.
 */
export class World {
  readonly engine: Engine;
  readonly valley: Valley;
  readonly clock: SimClock;
  readonly wind: WindUniforms;
  readonly terrain: TerrainSystem;
  readonly sky: SkySystem;
  readonly atmosphere: Atmosphere;
  readonly trees: TreeSystem;
  readonly grass: GrassSystem;
  readonly rocks: RockSystem;
  readonly physics: Physics;
  readonly player: ExplorePlayer;
  readonly input: Input;
  readonly post: PostControls;
  mode: CameraMode = 'explore';
  quality: QualityPreset;
  private pipeline: PipelineHandle;
  private seasonTimer = 0;
  private unsubscribe: (() => void) | null = null;

  private constructor(parts: {
    engine: Engine;
    valley: Valley;
    physics: Physics;
    terrain: TerrainSystem;
    trees: TreeSystem;
    grass: GrassSystem;
    rocks: RockSystem;
    wind: WindUniforms;
    quality: QualityPreset;
    clock: SimClock;
  }) {
    this.engine = parts.engine;
    this.valley = parts.valley;
    this.physics = parts.physics;
    this.terrain = parts.terrain;
    this.trees = parts.trees;
    this.grass = parts.grass;
    this.rocks = parts.rocks;
    this.wind = parts.wind;
    this.quality = parts.quality;
    this.clock = parts.clock;
    const { scene, renderer, camera } = this.engine;
    camera.near = 0.08;
    camera.far = 30000;
    camera.updateProjectionMatrix();
    scene.add(this.terrain.group, this.trees.group, this.grass.group, this.rocks.group);
    this.sky = new SkySystem(renderer, scene, camera, 260);
    this.sky.sky.material.fog = false;
    this.atmosphere = new Atmosphere(scene);
    this.post = createPostControls();
    this.pipeline = createPipeline(renderer, scene, camera, this.quality, this.post);
    this.engine.pipeline = this.pipeline.pipeline;
    this.engine.setRenderScale(QUALITY_RENDER_SCALE[this.quality]);
    this.input = new Input(renderer.domElement);
    const start = this.valley.spots.find((s) => s.name === 'riffles') ?? (this.valley.spots[0] as Spot);
    this.player = new ExplorePlayer(this.physics, new THREE.Vector3(start.x, this.heightAt(start.x, start.z), start.z));
    this.lookFrom(start);
  }

  static async create(engine: Engine, options: WorldOptions): Promise<World> {
    const progress = options.onProgress ?? (() => undefined);
    progress('Shaping the valley', 0.02);
    const worker = new Worker(new URL('../../workers/terrain.worker.ts', import.meta.url), { type: 'module' });
    const api = Comlink.wrap<TerrainWorkerApi>(worker);
    const stageLabels: Record<string, string> = {
      course: 'Tracing the stream',
      distance: 'Measuring the banks',
      shape: 'Raising the ridges',
      erosion: 'Letting rain carve the slopes',
      scree: 'Settling the scree',
      masks: 'Finding where water gathers',
      done: 'Valley ready',
    };
    const valley = await api.generate(
      options.seed,
      Comlink.proxy((stage: string, f: number) => progress(stageLabels[stage] ?? stage, 0.05 + f * 0.45)),
    );
    worker.terminate();

    progress('Laying the ground', 0.52);
    const physics = await Physics.create(valley.heightfield);
    const terrain = new TerrainSystem(valley);

    progress('Planting the valley', 0.6);
    const catalog = loadCatalog();
    if (catalog.errors.length) console.warn('Content errors:', catalog.errors);
    const treeItems: ScatterItem[] = catalog.trees.map((t) => ({
      id: t.id,
      placement: t.placement,
      variants: t.generator.variants,
    }));
    // Keep the viewpoints clear so golden shots and the starting view aren't inside a bush.
    const exclusions = valley.spots.map((s) => ({ x: s.x, z: s.z, radius: 8 }));
    const treeInstances = scatterItems(valley, treeItems, { seed: `${options.seed}:trees`, exclusions });
    const stoneItems: ScatterItem[] = catalog.stones.map((s) => ({
      id: s.id,
      placement: { ...s.placement, surface: 'bed' as const },
      variants: s.generator.variants,
    }));
    const stoneInstances = scatterItems(valley, stoneItems, { seed: `${options.seed}:stones`, densityScale: 0.6 });
    const wind = createWindUniforms();
    await nextFrame();
    progress('Growing the trees', 0.7);
    const trees = new TreeSystem(catalog.trees, treeInstances, wind);
    await nextFrame();
    progress('Placing the stones', 0.85);
    const heightAt = (x: number, z: number) => sampleHeight(valley.heightfield, x, z);
    const rocks = new RockSystem(catalog.stones, stoneInstances, heightAt, (x, z) => cellInfo(valley, x, z).wetness);
    const grassDensity = valley.grassDensity ?? new Float32Array(valley.heightfield.size ** 2);
    const grass = new GrassSystem({ heightAt, densityAt: (x, z) => grassDensityAt(valley, grassDensity, x, z) }, wind);
    grass.density = QUALITY_GRASS[options.quality];
    const clock = new SimClock(options.day ?? 95, options.hour ?? 8);
    const world = new World({
      engine,
      valley,
      physics,
      terrain,
      trees,
      grass,
      rocks,
      wind,
      quality: options.quality,
      clock,
    });
    if (options.spot) world.goToSpot(options.spot);
    world.update({ dt: 0, time: 0, frame: 0 });
    // Compile every material up front (asynchronously, behind the loading screen) instead of hitching later.
    progress('Preparing the light', 0.92);
    // Empty instanced meshes (e.g. near-detail trees nobody is close to yet) would otherwise compile mid-walk.
    const empty: THREE.InstancedMesh[] = [];
    engine.scene.traverse((o) => {
      const mesh = o as THREE.InstancedMesh;
      if (mesh.isInstancedMesh && mesh.count === 0) {
        mesh.count = 1;
        empty.push(mesh);
      }
    });
    await engine.renderer.compileAsync(engine.scene, engine.camera);
    // Render one frame so shadow and post-processing pipelines compile behind the loading screen too.
    engine.renderNow();
    for (const mesh of empty) mesh.count = 0;
    progress('Opening your eyes', 0.98);
    world.unsubscribe = engine.onFrame((info) => world.update(info));
    return world;
  }

  heightAt(x: number, z: number): number {
    return sampleHeight(this.valley.heightfield, x, z);
  }

  /** Places the player at a named viewpoint looking at its target (golden shots, plan 10). */
  goToSpot(name: string): boolean {
    const spot = this.valley.spots.find((s) => s.name === name);
    if (!spot) return false;
    this.lookFrom(spot);
    return true;
  }

  private lookFrom(spot: Spot): void {
    const yaw = Math.atan2(-(spot.lookX - spot.x), -(spot.lookZ - spot.z));
    this.player.teleport(spot.x, this.heightAt(spot.x, spot.z), spot.z, yaw);
    this.player.pitch = -0.08;
  }

  setQuality(quality: QualityPreset): void {
    this.quality = quality;
    this.pipeline.dispose();
    this.pipeline = createPipeline(this.engine.renderer, this.engine.scene, this.engine.camera, quality, this.post);
    this.engine.pipeline = this.pipeline.pipeline;
    this.grass.density = QUALITY_GRASS[quality];
    this.grass.update(this.engine.camera.position, true);
    this.engine.setRenderScale(QUALITY_RENDER_SCALE[quality]);
  }

  update(info: FrameInfo): void {
    const { camera } = this.engine;
    this.clock.advance(info.dt);
    (this.wind.time as any).value = info.time;
    if (this.mode === 'explore') this.player.update(info.dt, this.input, camera);
    this.physics.step(info.dt);

    const sky = this.clock.sky();
    const sun = new THREE.Vector3(...sky.sun);
    const moon = new THREE.Vector3(...sky.moon);
    const weights = this.clock.seasonWeights();
    const haze = 0.2 + weights.monsoon * 0.45 + weights.premonsoon * 0.25;
    const cloudCover = 0.15 + weights.monsoon * 0.5 + weights.premonsoon * 0.15;
    this.sky.update({ direction: sun, moonDirection: moon, cloudCover, haze }, camera.position);
    const hourAngle = ((this.clock.hour - 12) / 24) * Math.PI * 2;
    this.atmosphere.update(
      { sun, moonIllumination: sky.moonIllumination, haze, cloudCover },
      hourAngle,
      camera.position,
    );
    const renderer = this.engine.renderer;
    renderer.toneMappingExposure +=
      (this.atmosphere.targetExposure - renderer.toneMappingExposure) *
      Math.min(1, info.dt * 2 + (info.frame < 2 ? 1 : 0));

    this.seasonTimer -= info.dt;
    if (this.seasonTimer <= 0) {
      this.seasonTimer = 1;
      this.trees.setSeason(weights);
      const lush = 0.45 + weights.monsoon * 0.55 + weights.autumn * 0.35 + weights.spring * 0.25 + weights.winter * 0.1;
      (this.terrain.look.lushness as any).value = Math.min(1, lush);
      this.grass.setLook(Math.min(1, lush));
      (this.terrain.look.snowLine as any).value = 1250 + (1 - weights.winter) * 900 - weights.spring * 300;
    }

    this.terrain.update(camera.position);
    this.trees.update(camera.position, info.time);
    this.grass.update(camera.position);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.input.dispose();
    this.player.dispose();
    this.physics.dispose();
    this.sky.dispose();
    this.pipeline.dispose();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
