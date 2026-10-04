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
import { RockSystem, setRockWaterLevel, type PlacedStone } from './RockSystem';
import { FlowSystem } from '../water/FlowSystem';
import { Debris } from '../water/Debris';
import { FishSystem } from '../fauna/FishSystem';
import { PlantSystem } from '../vegetation/PlantSystem';
import { AirParticles } from '../vegetation/AirParticles';
import { WaterEffects } from '../water/Spray';
import { scatterAquatic } from '../../sim/scatter/aquatic';
import { CALM_BREEZE, windVelocityAt, type WindState } from '../../sim/wind/windField';
import { DENISON_BARB } from '../../sim/boids/school';
import { DENISON_PATTERN } from '../fauna/fishMaterial';
import { globals } from '../globals';
import type { Stone } from '../../sim/flow/field';
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
  readonly flow: FlowSystem;
  readonly debris: Debris;
  readonly fish: FishSystem;
  readonly plants: PlantSystem;
  readonly air: AirParticles;
  /** Waterfall spray and mist, splashes. */
  readonly waterFx: WaterEffects;
  /**
   * When set, wind, water and shader animation use this fixed time instead of the running clock, so screenshots are
   * repeatable (tests).
   */
  frozenTime: number | null = null;
  /** The CPU wind state (authoritative); shader uniforms follow it. */
  readonly windState: WindState = { ...CALM_BREEZE };
  readonly physics: Physics;
  readonly player: ExplorePlayer;
  readonly input: Input;
  readonly post: PostControls;
  mode: CameraMode = 'explore';
  quality: QualityPreset;
  private pipeline: PipelineHandle;
  private seasonTimer = 0;
  private flowRevision = -1;
  private unsubscribe: (() => void) | null = null;

  private constructor(parts: {
    engine: Engine;
    valley: Valley;
    physics: Physics;
    terrain: TerrainSystem;
    trees: TreeSystem;
    grass: GrassSystem;
    rocks: RockSystem;
    flow: FlowSystem;
    fish: FishSystem;
    plants: PlantSystem;
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
    this.flow = parts.flow;
    this.debris = new Debris(this.flow);
    this.fish = parts.fish;
    this.plants = parts.plants;
    this.plants.setFlow(this.flow);
    this.air = new AirParticles((x, z) => this.heightAt(x, z));
    this.waterFx = new WaterEffects();
    this.wind = parts.wind;
    this.quality = parts.quality;
    this.clock = parts.clock;
    const { scene, renderer, camera } = this.engine;
    camera.near = 0.08;
    camera.far = 30000;
    camera.updateProjectionMatrix();
    scene.add(
      this.terrain.group,
      this.trees.group,
      this.grass.group,
      this.plants.group,
      this.air.mesh,
      this.rocks.group,
      this.flow.group,
      this.debris.mesh,
      this.waterFx.group,
      this.fish.group,
    );
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
    this.player.setWater(this.flow);
    this.lookFrom(start);
  }

  /** In-stream stones as flow obstacles (top height above the bed, sunk part excluded). */
  static stonesForFlow(stones: readonly PlacedStone[]): Stone[] {
    return stones
      .filter((s) => s.radius >= 0.25)
      .map((s) => ({ id: s.id, x: s.x, z: s.z, radius: s.radius, height: s.height * 0.8 }));
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
    const flow = new FlowSystem(valley);
    const terrain = new TerrainSystem(valley, flow.levelMap);
    setRockWaterLevel(flow.levelMap, valley.heightfield);

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
    const bushItems: ScatterItem[] = catalog.bushes.map((b) => ({
      id: b.id,
      placement: b.placement,
      variants: b.generator.variants,
    }));
    const bushInstances = scatterItems(valley, bushItems, { seed: `${options.seed}:bushes`, exclusions });
    const plants = new PlantSystem(catalog.bushes, bushInstances, wind);
    await nextFrame();
    progress('Placing the stones', 0.85);
    const heightAt = (x: number, z: number) => sampleHeight(valley.heightfield, x, z);
    const rocks = new RockSystem(catalog.stones, stoneInstances, heightAt, (x, z) => cellInfo(valley, x, z).wetness);
    progress('Letting the water run', 0.88);
    await flow.init(World.stonesForFlow(rocks.stones));
    // Water plants go where the solved water suits them (depth, current), the pond plants in still water.
    const pondLevel = flow.pondLevel();
    const aquatic = scatterAquatic(
      {
        probe: (x, z) => {
          const s = flow.sample(x, z);
          if (s) return { depth: s.depth, speed: Math.hypot(s.velocityX, s.velocityZ), bed: s.bed, surface: s.surface };
          const p = valley.pond;
          if ((x - p.x) ** 2 + (z - p.z) ** 2 < p.radius ** 2) {
            const bed = heightAt(x, z);
            return pondLevel > bed ? { depth: pondLevel - bed, speed: 0, bed, surface: pondLevel } : null;
          }
          return null;
        },
        pond: valley.pond,
        path: valley.path,
        halfWidth: valley.profile.halfWidth,
        stones: rocks.stones.map((s) => ({ x: s.x, z: s.z, top: s.y + s.height, radius: s.radius })),
      },
      catalog.plants.map((p) => ({ id: p.id, placement: p.placement, variants: p.generator.variants })),
      `${options.seed}:aquatic`,
    );
    plants.addInstances(catalog.plants, aquatic);
    // The first fish (plan D30): a school of Denison barbs in the riffles, where you start.
    progress('Waking the fish', 0.9);
    const fish = new FishSystem([{ behavior: DENISON_BARB, template: 'torpedo', pattern: DENISON_PATTERN }]);
    await fish.init(flow, options.seed);
    const riffles = valley.profile.zones.find((z) => z.name === 'riffles');
    if (riffles) {
      for (const k of [0.35, 0.5, 0.65]) {
        const i = Math.round(riffles.start + (riffles.end - riffles.start) * k);
        await fish.release(0, valley.path.points[i * 2] as number, valley.path.points[i * 2 + 1] as number, 18, 2.5);
      }
    }
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
      flow,
      fish,
      plants,
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

  /** Changes the wind (Wind panel, weather): updates the CPU state and every shader at once (plan 6.3). */
  setWind(change: Partial<WindState>): void {
    Object.assign(this.windState, change);
    const len = Math.hypot(this.windState.dirX, this.windState.dirZ) || 1;
    this.windState.dirX /= len;
    this.windState.dirZ /= len;
    (this.wind.direction as any).value.set(this.windState.dirX, this.windState.dirZ);
    (this.wind.speed as any).value = this.windState.speed;
    (this.wind.gustiness as any).value = this.windState.gustiness;
    (this.wind.turbulence as any).value = this.windState.turbulence;
    // Wind roughens the water (strongest on the pond) and moves the clouds.
    (this.flow.look.chop as any).value = 0.12 + Math.min(1, this.windState.speed / 14) * 0.6;
    (this.flow.pondLook.chop as any).value = 0.08 + Math.min(1, this.windState.speed / 12) * 0.8;
    (this.sky.sky.cloudSpeed as any).value = 0.00002 * (0.4 + this.windState.speed / 5);
  }

  /**
   * Places a stone (builder and tests): adds the rock, then re-solves the flow locally around it (plan 6.2: foam and
   * a wake appear within about half a second). Returns the placed stone.
   */
  async placeStone(kind: string, x: number, z: number, radius = 0.8, flatness = 0.7): Promise<PlacedStone> {
    const bed = this.flow.sample(x, z)?.bed ?? this.heightAt(x, z);
    const stone = this.rocks.add({
      kind,
      x,
      y: bed - radius * flatness * 0.25,
      z,
      radius,
      height: radius * flatness,
      yaw: Math.random() * Math.PI * 2,
      variant: 0,
      moss: 0.2,
    });
    await this.flow.setStones(World.stonesForFlow(this.rocks.stones), { x, z, radius: radius + 2 });
    return stone;
  }

  async removeStone(id: number): Promise<void> {
    const stone = this.rocks.stones.find((s) => s.id === id);
    this.rocks.remove(id);
    if (stone)
      await this.flow.setStones(World.stonesForFlow(this.rocks.stones), {
        x: stone.x,
        z: stone.z,
        radius: stone.radius + 2,
      });
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

  /** What every wind consumer is using right now (Phase 3 e2e: a wind change reaches all of them within 1 s). */
  windReport(): {
    state: WindState;
    shader: { speed: number; dirX: number; dirZ: number; gustiness: number; turbulence: number };
    waterChop: number;
    pondChop: number;
    cloudSpeed: number;
    particleDrift: [number, number];
  } {
    const w: any = this.wind;
    return {
      state: { ...this.windState },
      shader: {
        speed: w.speed.value,
        dirX: w.direction.value.x,
        dirZ: w.direction.value.y,
        gustiness: w.gustiness.value,
        turbulence: w.turbulence.value,
      },
      waterChop: (this.flow.look.chop as any).value,
      pondChop: (this.flow.pondLook.chop as any).value,
      cloudSpeed: (this.sky.sky.cloudSpeed as any).value,
      particleDrift: [this.air.drift[0], this.air.drift[1]],
    };
  }

  update(info: FrameInfo): void {
    const { camera } = this.engine;
    this.clock.advance(info.dt);
    const windTime = this.frozenTime ?? info.time;
    (this.wind.time as any).value = windTime;
    globals.time.value = windTime;
    (globals.player.value as THREE.Vector3).copy(this.player.position);
    this.flow.update(windTime);
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
    // Direct sun strength for caustics and in-water light.
    const sunLight = this.sky.sun.intensity / this.sky.sunStrength;
    globals.sunLight.value = sunLight;
    (globals.sunColor.value as THREE.Color).copy(this.sky.sun.color);
    (this.flow.look.light as any).value = 0.08 + sunLight * 0.9 + this.sky.hemi.intensity * 0.6;
    // Underwater whenever the camera itself is below the water surface (any camera mode).
    const surface = this.flow.surfaceAt(camera.position.x, camera.position.z);
    const target = surface !== null && camera.position.y < surface - 0.02 ? 1 : 0;
    const uw: any = this.post.underwater;
    uw.value += (target - uw.value) * Math.min(1, info.dt * 8 + (target === 1 && uw.value < 0.5 ? 0.5 : 0));
    const turbidity = (this.flow.look.turbidity as any).value as number;
    (this.post.underwaterVisibility as any).value = 16 - turbidity * 13;
    (this.post.underwaterColor as any).value
      .setRGB(0.03 + turbidity * 0.12, 0.2 + turbidity * 0.05, 0.19 - turbidity * 0.06)
      .multiplyScalar(0.3 + sunLight * 0.7);
    const renderer = this.engine.renderer;
    renderer.toneMappingExposure +=
      (this.atmosphere.targetExposure - renderer.toneMappingExposure) *
      Math.min(1, info.dt * 2 + (info.frame < 2 ? 1 : 0));

    this.seasonTimer -= info.dt;
    if (this.seasonTimer <= 0) {
      this.seasonTimer = 1;
      this.trees.setSeason(weights);
      this.plants.setSeason(weights);
      // Falling petals in spring, leaves in autumn, pollen before the monsoon.
      this.air.mix = {
        petal: weights.spring * 0.6,
        leaf: 0.15 + weights.monsoon * 0.2,
        autumnLeaf: weights.autumn * 0.6 + weights.winter * 0.2,
      };
      this.air.amount = 0.25 + weights.spring * 0.5 + weights.autumn * 0.5 + weights.premonsoon * 0.3;
      const lush = 0.45 + weights.monsoon * 0.55 + weights.autumn * 0.35 + weights.spring * 0.25 + weights.winter * 0.1;
      (this.terrain.look.lushness as any).value = Math.min(1, lush);
      this.grass.setLook(Math.min(1, lush));
      (this.terrain.look.snowLine as any).value = 1250 + (1 - weights.winter) * 900 - weights.spring * 300;
      // Floating debris follows the season: blossom petals in spring, red leaves in autumn.
      this.debris.mix = {
        petal: weights.spring * 0.55,
        leaf: 0.12 + weights.monsoon * 0.15,
        autumnLeaf: weights.autumn * 0.5 + weights.winter * 0.15,
      };
    }

    this.terrain.update(camera.position);
    this.trees.update(camera.position, info.time);
    this.plants.update(camera.position, info.time);
    this.air.update(info.dt, camera.position, windTime, this.windState);
    if (this.flow.revision !== this.flowRevision) {
      this.flowRevision = this.flow.revision;
      this.waterFx.setWaterfall(this.flow.waterfallInfo());
    }
    this.waterFx.update(
      info.dt,
      camera,
      (x, z) => windVelocityAt(this.windState, x, z, windTime),
      (x, z) => this.flow.surfaceAt(x, z) ?? this.heightAt(x, z),
    );
    this.grass.update(camera.position);
    this.debris.update(info.dt, camera.position, info.time);
    this.fish.update(info.dt, this.player.position);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.input.dispose();
    this.player.dispose();
    this.fish.dispose();
    this.flow.dispose();
    this.physics.dispose();
    this.sky.dispose();
    this.pipeline.dispose();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
