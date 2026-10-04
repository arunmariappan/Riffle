import * as THREE from 'three/webgpu';
import * as Comlink from 'comlink';
import type { Engine, FrameInfo } from '../Engine';
import type { TerrainWorkerApi } from '../../workers/terrain.worker';
import type { Valley, Spot } from '../../sim/terrain/valley';
import { sampleHeight } from '../../sim/terrain/heightfield';
import { SimClock } from '../../sim/time/clock';
import { scatterItems, cellInfo, type ScatterItem } from '../../sim/scatter/scatter';
import { loadCatalog, type Catalog } from '../../content/catalog';
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
import { windVelocityAt, type WindState } from '../../sim/wind/windField';
import { globals } from '../globals';
import type { Stone } from '../../sim/flow/field';
import { Physics } from '../physics/Physics';
import { ExplorePlayer } from '../player/ExplorePlayer';
import { BuilderCamera } from '../player/BuilderCamera';
import { Input } from '../player/Input';
import {
  createPipeline,
  createPostControls,
  type PipelineHandle,
  type PostControls,
  type QualityPreset,
} from '../post/pipeline';
import { grassDensityAt } from '../../sim/scatter/grassDensity';
import { WorldItems, stonesForFlow } from './WorldItems';
import { OverlaySystem } from '../overlays/Overlays';
import { defaultSettings, normalizeSettings, type ValleySettings } from '../../state/settings';
import { WEATHER_LOOKS, blendWeather, type WeatherLook } from '../../sim/weather/weather';
import { SAVE_VERSION, type SaveData } from '../../save/saveData';
import { cloneEditLayer, generatedUid, type PlacedItem } from '../../builder/editLayer';

export interface WorldOptions {
  seed: string;
  quality: QualityPreset;
  onProgress?: (label: string, fraction: number) => void;
  day?: number;
  hour?: number;
  spot?: string;
  /** A saved valley to restore on top of the generated one (plan 6.11). */
  restore?: SaveData;
}

export type CameraMode = 'explore' | 'builder' | 'photo' | 'fixed' | 'follow';

/**
 * The fish the valley starts with (plan 6.5): each species where it lives. Phase 6's ecology takes over from here.
 * Zone, school count and fish per school.
 */
const STARTING_FISH: { id: string; zone: string; schools: number; count: number }[] = [
  { id: 'denison-barb', zone: 'riffles', schools: 3, count: 18 },
  { id: 'hillstream-loach', zone: 'rapids', schools: 2, count: 10 },
  { id: 'golden-mahseer', zone: 'pool', schools: 1, count: 4 },
  { id: 'white-cloud-minnow', zone: 'bend', schools: 2, count: 25 },
  { id: 'celestial-pearl-danio', zone: 'bend', schools: 1, count: 20 },
  { id: 'koi', zone: 'pond', schools: 1, count: 6 },
];

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
  readonly catalog: Catalog;
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
  /** Every placed thing behind stable ids, and your edit layer (plan 6.4, 6.8). */
  readonly items: WorldItems;
  readonly overlays: OverlaySystem;
  /** The CPU wind state (authoritative); shader uniforms follow it. */
  readonly windState: WindState;
  /** Everything the control panels set (plan 6.8). */
  settings: ValleySettings = defaultSettings();
  /**
   * When set, wind, water and shader animation use this fixed time instead of the running clock, so screenshots are
   * repeatable (tests).
   */
  frozenTime: number | null = null;
  readonly physics: Physics;
  readonly player: ExplorePlayer;
  readonly builderCamera: BuilderCamera;
  readonly input: Input;
  readonly post: PostControls;
  mode: CameraMode = 'explore';
  /** True while the builder uses the mouse wheel (rotating a drag ghost), so the camera doesn't zoom. */
  wheelCaptured = false;
  quality: QualityPreset;
  /** The weather as it looks right now (eases toward the chosen state). */
  readonly weather: WeatherLook = { ...WEATHER_LOOKS.clear };
  private pipeline: PipelineHandle;
  private seasonTimer = 0;
  private flowRevision = -1;
  private unsubscribe: (() => void) | null = null;
  private readonly modeListeners = new Set<(mode: CameraMode) => void>();

  private constructor(parts: {
    engine: Engine;
    valley: Valley;
    catalog: Catalog;
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
    this.catalog = parts.catalog;
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
    this.windState = { ...this.settings.wind };
    this.quality = parts.quality;
    this.clock = parts.clock;
    const hf = this.valley.heightfield;
    this.overlays = new OverlaySystem(this.flow, (x, z) => this.heightAt(x, z), (hf.size - 1) * hf.cell);
    this.items = new WorldItems({
      valley: this.valley,
      catalog: this.catalog,
      clock: this.clock,
      rocks: this.rocks,
      trees: this.trees,
      plants: this.plants,
      fish: this.fish,
      flow: this.flow,
      physics: this.physics,
      grass: this.grass,
      waterFx: this.waterFx,
      heightAt: (x, z) => this.heightAt(x, z),
    });
    const { scene, renderer, camera } = this.engine;
    camera.near = 0.08;
    camera.far = 30000;
    camera.updateProjectionMatrix();
    // Every system goes into the scene here, so its materials compile behind the loading screen (CLAUDE.md).
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
      this.overlays.group,
    );
    this.sky = new SkySystem(renderer, scene, camera, 260);
    this.sky.sky.material.fog = false;
    this.atmosphere = new Atmosphere(scene);
    this.post = createPostControls();
    this.pipeline = createPipeline(renderer, scene, camera, this.quality, this.post);
    this.engine.pipeline = this.pipeline.pipeline;
    this.engine.setRenderScale(QUALITY_RENDER_SCALE[this.quality]);
    this.input = new Input(renderer.domElement);
    this.builderCamera = new BuilderCamera(renderer.domElement, (x, z) => this.heightAt(x, z));
    const start = this.valley.spots.find((s) => s.name === 'riffles') ?? (this.valley.spots[0] as Spot);
    this.player = new ExplorePlayer(this.physics, new THREE.Vector3(start.x, this.heightAt(start.x, start.z), start.z));
    this.player.setWater(this.flow);
    this.lookFrom(start);
  }

  /** In-stream stones as flow obstacles (top height above the bed, sunk part excluded). */
  static stonesForFlow(stones: readonly PlacedStone[]): Stone[] {
    return stonesForFlow(stones);
  }

  static async create(engine: Engine, options: WorldOptions): Promise<World> {
    const progress = options.onProgress ?? (() => undefined);
    const seed = options.restore?.seed ?? options.seed;
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
      seed,
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
    const treeInstances = scatterItems(valley, treeItems, { seed: `${seed}:trees`, exclusions });
    const stoneItems: ScatterItem[] = catalog.stones.map((s) => ({
      id: s.id,
      placement: { ...s.placement, surface: 'bed' as const },
      variants: s.generator.variants,
    }));
    const stoneInstances = scatterItems(valley, stoneItems, { seed: `${seed}:stones`, densityScale: 0.6 });
    const wind = createWindUniforms();
    await nextFrame();
    progress('Growing the trees', 0.7);
    const trees = new TreeSystem(catalog.trees, treeInstances, wind);
    const bushItems: ScatterItem[] = catalog.bushes.map((b) => ({
      id: b.id,
      placement: b.placement,
      variants: b.generator.variants,
    }));
    const bushInstances = scatterItems(valley, bushItems, { seed: `${seed}:bushes`, exclusions });
    const plants = new PlantSystem(catalog.bushes, bushInstances, wind);
    await nextFrame();
    progress('Placing the stones', 0.85);
    const heightAt = (x: number, z: number) => sampleHeight(valley.heightfield, x, z);
    const rocks = new RockSystem(catalog.stones, stoneInstances, heightAt, (x, z) => cellInfo(valley, x, z).wetness);
    progress('Letting the water run', 0.88);
    await flow.init(stonesForFlow(rocks.stones));
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
        stones: rocks.stones.map((s) => ({ x: s.x, z: s.z, top: s.y + s.height, radius: s.radius, uid: s.uid })),
      },
      catalog.plants.map((p) => ({ id: p.id, placement: p.placement, variants: p.generator.variants })),
      `${seed}:aquatic`,
    );
    plants.addInstances(catalog.plants, aquatic);
    // Every species from content/fish gets its mesh now; the first barbs swim in the riffles (plan D30).
    progress('Waking the fish', 0.9);
    const fish = new FishSystem(catalog.fish);
    await fish.init(flow, seed);
    const grassDensity = valley.grassDensity ?? new Float32Array(valley.heightfield.size ** 2);
    valley.grassDensity = grassDensity;
    const grass = new GrassSystem({ heightAt, densityAt: (x, z) => grassDensityAt(valley, grassDensity, x, z) }, wind);
    grass.density = QUALITY_GRASS[options.quality];
    const clock = new SimClock(options.day ?? 95, options.hour ?? 8);
    const world = new World({
      engine,
      valley,
      catalog,
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
    // Every species starts where it lives (plan 6.5): barbs in the riffles, loaches in the rapids, mahseer in the pool,
    // minnows and danios along the bend's calm margins, koi in the pond.
    let schoolId = 1;
    for (const start of STARTING_FISH) {
      const index = fish.speciesIndex(start.id);
      if (index < 0) continue;
      for (let k = 0; k < start.schools; k++) {
        const spot = world.findFishSpot(index, start.zone, (k + 0.5) / start.schools);
        if (!spot) continue;
        const placed = await fish.release(
          index,
          spot.x,
          spot.z,
          start.count,
          1.5 + Math.sqrt(start.count) * 0.3,
          schoolId,
        );
        if (placed === 0) continue;
        const item: PlacedItem = {
          uid: generatedUid('fish', schoolId - 1),
          category: 'fish',
          kind: start.id,
          variant: 0,
          x: spot.x,
          y: heightAt(spot.x, spot.z),
          z: spot.z,
          yaw: 0,
          scale: 1,
          count: start.count,
        };
        world.items.registerSchool(item, schoolId);
        schoolId++;
      }
    }
    fish.onRise = (x, z, length) => {
      const surface = flow.surfaceAt(x, z);
      if (surface !== null) world.waterFx.splash(x, surface, z, 0.03 + Math.min(0.5, length * 0.6));
    };
    if (options.restore) {
      progress('Putting your valley back', 0.91);
      await world.restore(options.restore);
    } else {
      await world.applySettings(world.settings);
      if (options.spot) world.goToSpot(options.spot);
    }
    world.update({ dt: 0, time: 0, frame: 0 });
    // Compile every material up front (asynchronously, behind the loading screen) instead of hitching later.
    progress('Preparing the light', 0.92);
    // Empty instanced meshes (e.g. near-detail trees nobody is close to yet) would otherwise compile mid-walk, and
    // hidden helpers (the overlay drape) the first time they are shown.
    const empty: THREE.InstancedMesh[] = [];
    engine.scene.traverse((o) => {
      const mesh = o as THREE.InstancedMesh;
      if (mesh.isInstancedMesh && mesh.count === 0) {
        mesh.count = 1;
        empty.push(mesh);
      }
    });
    const hidden = world.overlays.compileTargets().filter((o) => !o.visible);
    for (const o of hidden) o.visible = true;
    await engine.renderer.compileAsync(engine.scene, engine.camera);
    // Render one frame so shadow and post-processing pipelines compile behind the loading screen too.
    engine.renderNow();
    for (const mesh of empty) mesh.count = 0;
    for (const o of hidden) o.visible = false;
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
    this.settings.wind = { ...this.windState };
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
   * Applies panel settings (plan 6.8). Cheap values apply at once; water changes re-solve the flow, so the returned
   * promise resolves when the new water is in.
   */
  async applySettings(next: ValleySettings): Promise<void> {
    const s = normalizeSettings(next);
    this.settings = s;
    this.setWind(s.wind);
    const w: any = this.wind;
    w.flexibility.value = s.trees.flexibility;
    w.swayStrength.value = s.trees.sway;
    w.leafFlutter.value = s.trees.flutter;
    w.responseDelay.value = s.trees.delay;
    for (const id of this.trees.speciesIds()) this.trees.setSpeciesFlexibility(id, s.trees.species[id] ?? 1);
    (this.flow.look.turbidity as any).value = 1 - s.water.clarity;
    this.clock.timeScale = s.time.timeScale;
    this.clock.paused = s.time.paused;
    this.clock.lockedDay = s.time.lockedDay;
    if (s.water.discharge !== this.flow.discharge) await this.flow.setDischarge(s.water.discharge);
    if (s.water.speed !== this.flow.speedMultiplier) await this.flow.setSpeedMultiplier(s.water.speed);
    if (s.water.level !== this.flow.levelOffset) await this.flow.setLevelOffset(s.water.level);
    this.plants.invalidate();
  }

  /**
   * A spot in a stream zone (or the pond) whose water suits a fish species: right depth and current. `at` picks how
   * far along the zone to start looking (0..1).
   */
  findFishSpot(speciesIndex: number, zone: string, at = 0.5): { x: number; z: number } | null {
    const b = this.fish.behaviors[speciesIndex];
    if (!b) return null;
    const h = b.habitat;
    const ok = (x: number, z: number) => {
      const s = this.flow.sample(x, z);
      if (!s || s.depth < b.minDepth) return false;
      if (b.pondOnly && !s.pond) return false;
      if (!h) return true;
      const speed = Math.hypot(s.velocityX, s.velocityZ);
      return s.depth >= h.depth[0] && s.depth <= h.depth[1] && speed >= h.flow[0] && speed <= h.flow[1];
    };
    if (zone === 'pond' || b.pondOnly) {
      const p = this.valley.pond;
      for (let r = 0; r <= p.radius; r += 1.5)
        for (let a = 0; a < Math.PI * 2; a += 0.5) {
          const x = p.x + Math.cos(a + at * 6) * r;
          const z = p.z + Math.sin(a + at * 6) * r;
          if (ok(x, z)) return { x, z };
        }
      return null;
    }
    const zz = this.valley.profile.zones.find((q) => q.name === zone);
    if (!zz) return null;
    const path = this.flow.path;
    const span = zz.end - zz.start;
    for (let step = 0; step < span; step += 4) {
      // Search outward from the chosen point, alternating up and downstream.
      for (const dir of [1, -1]) {
        const i = Math.round(zz.start + span * at + dir * step);
        if (i < zz.start || i > zz.end) continue;
        const hw = (this.valley.profile.halfWidth[i] as number) ?? 5;
        for (let k = 0; k <= 8; k++) {
          const off = (k % 2 ? -1 : 1) * Math.ceil(k / 2) * (hw / 4.5);
          const x = (path.points[i * 2] as number) + (path.normals[i * 2] as number) * off;
          const z = (path.points[i * 2 + 1] as number) + (path.normals[i * 2 + 1] as number) * off;
          if (ok(x, z)) return { x, z };
        }
      }
    }
    return null;
  }

  // --- Fish: food and following ------------------------------------------------------------------------------------

  /** Throws a little food onto the water ahead of you (Explore: F); fish nearby gather, koi come from afar. */
  throwFood(): boolean {
    const cam = this.engine.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) return false;
    dir.normalize();
    for (let d = 1.5; d <= 9; d += 0.5) {
      const x = cam.position.x + dir.x * d;
      const z = cam.position.z + dir.z * d;
      const surface = this.flow.surfaceAt(x, z);
      if (surface === null) continue;
      void this.fish.throwFood(x, surface, z);
      this.waterFx.splash(x, surface, z, 0.12);
      return true;
    }
    return false;
  }

  private following: number | null = null;
  private followFrom: CameraMode = 'explore';
  private readonly followPos = new THREE.Vector3();

  /** Follows a fish with the camera (plan 6.5: inspect / follow). */
  followFish(id: number): void {
    if (this.mode !== 'follow') this.followFrom = this.mode;
    this.following = id;
    const f = this.fish.get(id);
    if (f) this.followPos.set(f.x, f.y, f.z);
    this.setMode('follow');
  }

  stopFollowing(): void {
    this.following = null;
    if (this.mode === 'follow') this.setMode(this.followFrom === 'follow' ? 'explore' : this.followFrom);
  }

  get followedFish(): number | null {
    return this.mode === 'follow' ? this.following : null;
  }

  private updateFollow(dt: number): void {
    const f = this.following === null ? null : this.fish.get(this.following);
    if (!f) {
      this.stopFollowing();
      return;
    }
    const cam = this.engine.camera;
    // Behind and a little to the side of the fish, a few body lengths back, looking at it.
    const dist = Math.max(0.35, f.length * 4.5);
    const hx = Math.sin(f.yaw);
    const hz = Math.cos(f.yaw);
    this.followPos.lerp(new THREE.Vector3(f.x, f.y, f.z), Math.min(1, dt * 6));
    const target = new THREE.Vector3(
      this.followPos.x - hx * dist + hz * dist * 0.45,
      this.followPos.y + dist * 0.25,
      this.followPos.z - hz * dist - hx * dist * 0.45,
    );
    cam.position.lerp(target, Math.min(1, dt * 3));
    cam.lookAt(this.followPos);
  }

  // --- Modes ---------------------------------------------------------------------------------------------------

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    const was = this.mode;
    this.mode = mode;
    this.builderCamera.enabled = mode === 'builder';
    if (mode === 'builder') {
      this.input.unlockPointer();
      if (was === 'explore' || was === 'fixed') {
        // Look down at where you were standing, a little ahead.
        const p = this.player.position;
        const ax = p.x - Math.sin(this.player.yaw) * 10;
        const az = p.z - Math.cos(this.player.yaw) * 10;
        this.builderCamera.frame(ax, az, { yaw: this.player.yaw, pitch: 0.8, distance: 38 });
      }
    }
    for (const l of this.modeListeners) l(mode);
  }

  onModeChange(listener: (mode: CameraMode) => void): () => void {
    this.modeListeners.add(listener);
    return () => this.modeListeners.delete(listener);
  }

  /** Puts the explorer on the ground at the builder camera's focus ("Explore from here"). */
  exploreFromBuilder(): void {
    const v = this.builderCamera.view();
    this.player.teleport(v.x, this.heightAt(v.x, v.z), v.z, v.yaw);
    this.setMode('explore');
  }

  // --- Saving ----------------------------------------------------------------------------------------------------

  /** Everything needed to rebuild this valley exactly (plan 6.11). */
  snapshot(): SaveData {
    const p = this.player.position;
    return {
      version: SAVE_VERSION,
      savedAt: new Date().toISOString(),
      seed: this.valley.seed,
      clock: this.clock.seconds,
      settings: JSON.parse(JSON.stringify(this.settings)) as ValleySettings,
      edits: cloneEditLayer(this.items.edits),
      view: {
        mode: this.mode === 'builder' ? 'builder' : 'explore',
        player: { x: p.x, y: p.y, z: p.z, yaw: this.player.yaw, pitch: this.player.pitch },
        builder: this.builderCamera.view(),
      },
      extra: {},
    };
  }

  /** Restores a saved valley on top of the generated one (seed must match). */
  async restore(data: SaveData): Promise<void> {
    if (data.seed !== this.valley.seed) throw new Error('That valley was made from a different seed');
    this.clock.seconds = data.clock;
    await this.applySettings(data.settings);
    await this.items.applyEditLayer(data.edits);
    const p = data.view.player;
    this.player.teleport(p.x, p.y, p.z, p.yaw);
    this.player.pitch = p.pitch;
    const b = data.view.builder;
    this.builderCamera.frame(b.x, b.z, { yaw: b.yaw, pitch: b.pitch, distance: b.distance });
    this.setMode(data.view.mode);
  }

  // --- Older helpers (tests) -------------------------------------------------------------------------------------

  /**
   * Places a stone at once, without physics (tests): adds the rock, then re-solves the flow locally around it (plan
   * 6.2: foam and a wake appear within about half a second). Returns the placed stone.
   */
  async placeStone(kind: string, x: number, z: number, radius = 0.8, flatness = 0.7): Promise<PlacedStone> {
    const bed = this.flow.sample(x, z)?.bed ?? this.heightAt(x, z);
    const uid = `u${this.items.edits.nextId++}`;
    await this.items.add({
      uid,
      category: 'stones',
      kind,
      variant: 0,
      x,
      y: bed - radius * flatness * 0.25,
      z,
      yaw: Math.random() * Math.PI * 2,
      scale: 1,
      radius,
      height: radius * flatness,
      moss: 0.2,
    });
    return this.rocks.get(uid) as PlacedStone;
  }

  async removeStone(uid: string): Promise<void> {
    await this.items.remove(uid);
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

  /** The weather the season suggests when the Time & weather panel is on "auto" (Phase 6 makes it a real process). */
  private seasonalWeather(): WeatherLook {
    const w = this.clock.seasonWeights();
    const hour = this.clock.hour;
    const dawn = Math.max(0, 1 - Math.abs(hour - 6.5) / 2);
    return {
      cloudCover: 0.15 + w.monsoon * 0.5 + w.premonsoon * 0.15,
      haze: 0.2 + w.monsoon * 0.45 + w.premonsoon * 0.25,
      mist: dawn * (0.25 + w.monsoon * 0.4 + w.autumn * 0.3 + w.winter * 0.2),
      rain: 0,
      wind: 0,
      gustiness: 0,
      lightning: false,
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
    else if (this.mode === 'builder') this.builderCamera.update(info.dt, this.input, camera, !this.wheelCaptured);
    else if (this.mode === 'follow') this.updateFollow(info.dt);
    this.physics.step(info.dt);
    this.items.update(info.dt);

    // Weather eases toward the chosen state (or the season's own on "auto").
    const mode = this.settings.weather.mode;
    const target = mode === 'auto' ? this.seasonalWeather() : WEATHER_LOOKS[mode];
    Object.assign(
      this.weather,
      blendWeather(this.weather, target, Math.min(1, info.dt * 0.6 + (info.frame < 2 ? 1 : 0))),
    );
    const sky = this.clock.sky();
    const sun = new THREE.Vector3(...sky.sun);
    const moon = new THREE.Vector3(...sky.moon);
    const weights = this.clock.seasonWeights();
    const haze = this.weather.haze;
    const cloudCover = this.weather.cloudCover;
    this.sky.update({ direction: sun, moonDirection: moon, cloudCover, haze }, camera.position);
    const hourAngle = ((this.clock.hour - 12) / 24) * Math.PI * 2;
    this.atmosphere.update(
      { sun, moonIllumination: sky.moonIllumination, haze, cloudCover },
      hourAngle,
      camera.position,
    );
    // Valley mist pools a little above the ground under the camera.
    (this.atmosphere.mistHeight as any).value = this.heightAt(camera.position.x, camera.position.z) + 18;
    (this.atmosphere.mistDensity as any).value = this.weather.mist * 0.006;
    // Direct sun strength for caustics and in-water light.
    const sunLight = this.sky.sun.intensity / this.sky.sunStrength;
    globals.sunLight.value = sunLight;
    (globals.sunColor.value as THREE.Color).copy(this.sky.sun.color);
    (globals.sunDirection.value as THREE.Vector3).copy(sun);
    (this.flow.look.light as any).value = 0.08 + sunLight * 0.9 + this.sky.hemi.intensity * 0.6;
    // Underwater whenever the camera itself is below the water surface (any camera mode).
    const surface = this.flow.surfaceAt(camera.position.x, camera.position.z);
    const target2 = surface !== null && camera.position.y < surface - 0.02 ? 1 : 0;
    const uw: any = this.post.underwater;
    uw.value += (target2 - uw.value) * Math.min(1, info.dt * 8 + (target2 === 1 && uw.value < 0.5 ? 0.5 : 0));
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
    this.grass.update(camera.position);
    this.debris.update(info.dt, camera.position, info.time);
    if (this.flow.revision !== this.flowRevision) {
      this.flowRevision = this.flow.revision;
      this.waterFx.setWaterfall(this.flow.waterfallInfo());
      this.plants.invalidate();
    }
    this.waterFx.update(
      info.dt,
      camera,
      (x, z) => windVelocityAt(this.windState, x, z, windTime),
      (x, z) => this.flow.surfaceAt(x, z) ?? this.heightAt(x, z),
    );
    this.fish.update(info.dt, this.player.position, this.clock.dayOfYear, this.clock.hour);
    const focus =
      this.mode === 'builder'
        ? new THREE.Vector3(this.builderCamera.goal.x, 0, this.builderCamera.goal.z)
        : camera.position;
    this.overlays.update(focus);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.input.dispose();
    this.builderCamera.dispose();
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
