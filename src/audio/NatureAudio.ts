import * as THREE from 'three/webgpu';
import type { World } from '../engine/world/World';
import { AudioEngine, whenAudioUnlocked, type Emitter, type Vec3 } from './AudioEngine';
import { Noise } from './dsp/core';
import { bubbleRise, footstep, kingfisherCall, renderCall, splash, thunder } from './dsp/calls';
import {
  AmbienceScheduler,
  ambienceLevels,
  emitterSections,
  footstepSurface,
  rainShares,
  riverMix,
  underwaterFilter,
} from './scene';
import { FLOW, FLOW_STRIDE } from '../sim/flow/layout';
import { windStrengthAt } from '../sim/wind/windField';
import { airTemperature } from '../sim/ecology/temperature';
import { cellInfo } from '../sim/scatter/scatter';

/** Sliding river emitters (plan 6.9: a pool of 6–10) and their spacing along the stream, in cross-sections. */
const EMITTERS = 8;
const SPACING = 26;
/** Parameters and positions are refreshed this often (the listener every frame). */
const UPDATE_EVERY = 0.05;

/**
 * The valley's sound (plan 6.9), driven by the world: the stream through emitters that slide along the river to the
 * points nearest you, the waterfall, the generated wind with rustle by the plants around you, rain by what it lands
 * on, birds, cicadas and frogs by the hour and season, the kingfisher, rising fish, thunder after lightning,
 * footsteps by surface, and the underwater muffle. Starts at your first click (the browser's audio unlock).
 */
export class NatureAudio {
  engine: AudioEngine | null = null;
  private readonly world: World;
  private readonly noise = new Noise(0x5eed);
  private readonly scheduler = new AmbienceScheduler(new Noise(0xa11));
  private river: Emitter[] = [];
  private fall: Emitter | null = null;
  private wind: { node: AudioWorkletNode; params: Map<string, AudioParam> } | null = null;
  private rain: { node: AudioWorkletNode; params: Map<string, AudioParam> } | null = null;
  private timer = 0;
  private vegetationTimer = 0;
  private vegetation = { leaves: 0, bamboo: 0, pines: 0, grass: 0, trees: [] as Vec3[] };
  private stride = 0;
  private lastFeet = new THREE.Vector3(Number.NaN, 0, 0);
  private bubbleTimer = 2;
  private volume = 0.8;
  private muted = false;
  private disposed = false;
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  /** For tests: the latest river mix per emitter and where they are. */
  readonly debug = { sections: [] as number[], gains: [] as number[], wind: 0, rain: 0, cutoff: 20000 };

  constructor(world: World) {
    this.world = world;
  }

  /** Waits for your first click, then builds the graph. */
  async start(): Promise<void> {
    await whenAudioUnlocked();
    const ctx = AudioEngine.context();
    if (!ctx || this.disposed) return;
    const engine = new AudioEngine(ctx);
    await engine.ready();
    if (this.disposed) return;
    this.engine = engine;
    engine.setVolume(this.volume, this.muted);
    this.river = Array.from({ length: EMITTERS }, (_, k) => engine.emitter('riffle-water', 101 + k * 7919, 4, 1.15));
    this.fall = engine.emitter('riffle-water', 4242, 8, 0.9);
    this.wind = engine.ambient('riffle-wind', 77);
    this.rain = engine.ambient('riffle-rain', 99);
    this.hook();
  }

  setVolume(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    this.engine?.setVolume(volume, muted);
  }

  /** Listens to the world's events: rising fish, the kingfisher, lightning. */
  private hook(): void {
    const w = this.world;
    const rise = w.fish.onRise;
    w.fish.onRise = (x, z, length) => {
      rise?.(x, z, length);
      const e = this.engine;
      if (!e?.audible) return;
      const cam = w.engine.camera.position;
      if ((x - cam.x) ** 2 + (z - cam.z) ** 2 > 45 * 45) return;
      const y = w.flow.surfaceAt(x, z) ?? cam.y;
      e.play(splash(e.ctx.sampleRate, this.noise, Math.min(1, length * 2)), { x, y, z }, 0.7);
    };
    const kSplash = w.kingfisher.onSplash;
    w.kingfisher.onSplash = (x, y, z) => {
      kSplash?.(x, y, z);
      const e = this.engine;
      if (e?.audible) e.play(splash(e.ctx.sampleRate, this.noise, 0.35), { x, y, z }, 0.8);
    };
    w.kingfisher.onCall = (x, y, z) => {
      const e = this.engine;
      if (e?.audible) e.play(kingfisherCall(e.ctx.sampleRate, this.noise), { x, y, z }, 0.6, 0, 8);
    };
    const lightning = w.onLightning;
    w.onLightning = (delay, strength) => {
      lightning?.(delay, strength);
      const e = this.engine;
      if (!e?.audible) return;
      // Thunder takes the time sound needs to come from the strike (343 m/s).
      e.play(thunder(e.ctx.sampleRate, this.noise, delay * 343, strength), null, 1.4, delay);
    };
  }

  // --- Per frame -------------------------------------------------------------------------------------------------

  update(dt: number): void {
    const e = this.engine;
    if (!e) return;
    const cam = this.world.engine.camera;
    cam.getWorldDirection(this.forward);
    this.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    e.setListener(cam.position, this.forward, this.up);
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = UPDATE_EVERY;
    if (!e.audible) return;
    const now = e.now;
    this.vegetationTimer -= UPDATE_EVERY;
    if (this.vegetationTimer <= 0) {
      this.vegetationTimer = 1;
      this.surroundings(cam.position);
    }
    this.updateRiver(cam.position, now);
    this.updateWind(cam.position, now);
    this.updateRain(cam.position, now);
    this.updateLife(cam.position, UPDATE_EVERY);
    this.updateFeet(UPDATE_EVERY);
    this.updateUnderwater(cam.position, UPDATE_EVERY);
  }

  /** The nearest cross-section to a point, and how far the stream is. */
  private nearestSection(x: number, z: number): { section: number; distance: number } {
    const p = this.world.flow.path;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < p.count; i += 4) {
      const d = ((p.points[i * 2] as number) - x) ** 2 + ((p.points[i * 2 + 1] as number) - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    for (let i = Math.max(0, best - 4); i <= Math.min(p.count - 1, best + 4); i++) {
      const d = ((p.points[i * 2] as number) - x) ** 2 + ((p.points[i * 2 + 1] as number) - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { section: best, distance: Math.sqrt(bestD) };
  }

  /** Mean current, foam and depth across a cross-section. */
  private sectionWater(i: number): { speed: number; foam: number; depth: number } {
    const flow = this.world.flow;
    const { nn } = flow.layout;
    const cells = flow.cells;
    let n = 0;
    let speed = 0;
    let foam = 0;
    let depth = 0;
    for (let j = 0; j < nn; j++) {
      const o = (i * nn + j) * FLOW_STRIDE;
      const d = cells[o + FLOW.depth] ?? 0;
      if (d < 0.03) continue;
      n++;
      depth += d;
      speed += Math.hypot(cells[o + FLOW.velX] ?? 0, cells[o + FLOW.velZ] ?? 0);
      foam += cells[o + FLOW.foam] ?? 0;
    }
    return n ? { speed: speed / n, foam: foam / n, depth: depth / n } : { speed: 0, foam: 0, depth: 0 };
  }

  private updateRiver(cam: THREE.Vector3, now: number): void {
    const flow = this.world.flow;
    const p = flow.path;
    if (!p.count || !flow.cells.length) return;
    const near = this.nearestSection(cam.x, cam.z);
    // Too far from the stream to hear it: the emitters fade (the panners' distance does the rest).
    const audible = near.distance < 220 ? 1 : 0;
    const sections = emitterSections(near.section, p.count, EMITTERS, SPACING);
    // Louder streams: the water speed slider (and the discharge) raise the level.
    const level = Math.sqrt(Math.max(0.2, flow.discharge / 4)) * flow.speedMultiplier ** 0.5;
    this.debug.sections = sections;
    this.debug.gains = [];
    sections.forEach((s, k) => {
      const em = this.river[k];
      if (!em) return;
      const i = Math.round(s);
      const water = this.sectionWater(i);
      const mix = riverMix(water.speed, water.foam, water.depth);
      const y = (flow.levels[i] as number) ?? 0;
      AudioEngine.place(em.panner, { x: p.points[i * 2] as number, y: y + 0.1, z: p.points[i * 2 + 1] as number }, now);
      const gain = mix.gain * level * audible;
      this.debug.gains.push(gain);
      AudioEngine.set(em.params, 'rapids', mix.rapids, now);
      AudioEngine.set(em.params, 'riffle', mix.riffle, now);
      AudioEngine.set(em.params, 'pool', mix.pool, now);
      AudioEngine.set(em.params, 'fall', 0, now);
      AudioEngine.set(em.params, 'gain', gain, now, 0.3);
    });
    if (this.fall) {
      const info = flow.waterfallInfo();
      const foot = { x: info.x + info.tx * 2, y: info.foot + 0.5, z: info.z + info.tz * 2 };
      AudioEngine.place(this.fall.panner, foot, now);
      AudioEngine.set(this.fall.params, 'fall', Math.min(2, info.strength), now);
      AudioEngine.set(this.fall.params, 'rapids', 0.6, now);
      AudioEngine.set(this.fall.params, 'riffle', 0.2, now);
      AudioEngine.set(this.fall.params, 'pool', 0, now);
      AudioEngine.set(this.fall.params, 'gain', 0.9 * Math.min(1.5, Math.sqrt(info.strength)), now, 0.4);
    }
  }

  /** What grows around you (rustle and rain), refreshed once a second. */
  private surroundings(cam: THREE.Vector3): void {
    let leaves = 0;
    let bamboo = 0;
    let pines = 0;
    const trees: Vec3[] = [];
    for (const t of this.world.trees.all()) {
      const d2 = (t.x - cam.x) ** 2 + (t.z - cam.z) ** 2;
      if (d2 > 45 * 45) continue;
      trees.push({ x: t.x, y: t.y + t.height * 0.7, z: t.z });
      if (d2 > 25 * 25) continue;
      const near = 1 - Math.sqrt(d2) / 25;
      if (t.kind === 'bamboo') bamboo += near * 0.5;
      else if (t.kind === 'himalayan-pine') pines += near * 0.4;
      else if (t.kind !== 'tree-fern') leaves += near * 0.35;
    }
    const v = this.world.valley;
    const hf = v.heightfield;
    const cx = Math.min(hf.size - 1, Math.max(0, Math.round((cam.x - hf.originX) / hf.cell)));
    const cz = Math.min(hf.size - 1, Math.max(0, Math.round((cam.z - hf.originZ) / hf.cell)));
    const grass = v.grassDensity ? (v.grassDensity[cz * hf.size + cx] ?? 0) : 0;
    this.vegetation = {
      leaves: Math.min(1, leaves),
      bamboo: Math.min(1, bamboo),
      pines: Math.min(1, pines),
      grass: Math.min(1, grass),
      trees,
    };
  }

  private updateWind(cam: THREE.Vector3, now: number): void {
    if (!this.wind) return;
    const w = this.world.windState;
    const time = this.world.frozenTime ?? performance.now() / 1000;
    const base = Math.min(2, Math.max(0, w.speed / 12));
    const gust = base > 0 ? windStrengthAt(w, cam.x, cam.z, time) / base : 1;
    const v = this.vegetation;
    const p = this.wind.params;
    AudioEngine.set(p, 'speed', w.speed, now, 0.2);
    AudioEngine.set(p, 'gust', gust, now, 0.1);
    AudioEngine.set(p, 'leaves', v.leaves, now, 0.5);
    AudioEngine.set(p, 'bamboo', v.bamboo, now, 0.5);
    AudioEngine.set(p, 'pines', v.pines, now, 0.5);
    AudioEngine.set(p, 'grass', v.grass, now, 0.5);
    AudioEngine.set(p, 'gain', 0.75, now, 0.5);
    this.debug.wind = w.speed * gust;
  }

  private updateRain(cam: THREE.Vector3, now: number): void {
    if (!this.rain) return;
    const rate = this.world.weather.rain;
    let wet = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (this.world.flow.surfaceAt(cam.x + Math.cos(a) * 8, cam.z + Math.sin(a) * 8) !== null) wet++;
    }
    const shares = rainShares(this.world.ecology.shadeAt(cam.x, cam.z), wet / 8);
    const p = this.rain.params;
    AudioEngine.set(p, 'rate', rate, now, 0.4);
    AudioEngine.set(p, 'leaves', shares.leaves, now, 0.5);
    AudioEngine.set(p, 'rock', shares.rock, now, 0.5);
    AudioEngine.set(p, 'water', shares.water, now, 0.5);
    AudioEngine.set(p, 'gain', rate > 0.05 ? 0.9 : 0, now, 0.5);
    this.debug.rain = rate;
  }

  /** Birds, thrushes, cicadas and frogs: who sings now, and from where. */
  private updateLife(cam: THREE.Vector3, dt: number): void {
    const e = this.engine;
    if (!e) return;
    const w = this.world;
    const clock = w.clock;
    const water = this.nearestSection(cam.x, cam.z);
    const pond = w.valley.pond;
    const pondD = Math.hypot(cam.x - pond.x, cam.z - pond.z) - pond.radius;
    const nearWater = 1 - Math.min(1, Math.max(0, (Math.min(water.distance, pondD) - 5) / 60));
    const levels = ambienceLevels({
      hour: clock.hour,
      season: clock.seasonWeights(),
      airTemp: airTemperature(clock.dayOfYear, clock.hour),
      rain: w.weather.rain,
      wind: w.windState.speed,
      nearWater,
    });
    const n = this.noise;
    for (const ev of this.scheduler.step(dt, levels)) {
      let at: Vec3;
      const trees = this.vegetation.trees;
      if ((ev.kind === 'songbird' || ev.kind === 'cicada') && trees.length) {
        at = trees[Math.floor(n.next() * trees.length)] as Vec3;
      } else if (ev.kind === 'thrush' || ev.kind === 'frog') {
        // Thrushes sing from rocks along the stream; frogs call from the water's edge (the pond when it's close).
        const usePond = ev.kind === 'frog' && pondD < 60 && n.next() < 0.6;
        if (usePond) {
          const a = n.range(0, Math.PI * 2);
          at = {
            x: pond.x + Math.cos(a) * pond.radius,
            y: w.flow.pondLevel() + 0.1,
            z: pond.z + Math.sin(a) * pond.radius,
          };
        } else {
          const p = w.flow.path;
          const i = Math.min(p.count - 1, Math.max(0, water.section + Math.round(n.range(-60, 60))));
          const side = n.next() < 0.5 ? -1 : 1;
          const hw = (w.valley.profile.halfWidth[i] as number) ?? 5;
          const x = (p.points[i * 2] as number) + (p.normals[i * 2] as number) * hw * side;
          const z = (p.points[i * 2 + 1] as number) + (p.normals[i * 2 + 1] as number) * hw * side;
          at = { x, y: w.heightAt(x, z) + 0.4, z };
        }
      } else {
        const a = n.range(0, Math.PI * 2);
        const r = n.range(12, 40);
        const x = cam.x + Math.cos(a) * r;
        const z = cam.z + Math.sin(a) * r;
        at = { x, y: w.heightAt(x, z) + n.range(3, 9), z };
      }
      const gain = ev.kind === 'cicada' ? 0.35 : ev.kind === 'frog' ? 0.45 : 0.5;
      e.play(renderCall(ev.kind, e.ctx.sampleRate, n), at, gain, 0, ev.kind === 'thrush' ? 10 : 6);
    }
  }

  /** Footsteps by surface while you walk (Explore). */
  private updateFeet(_dt: number): void {
    const e = this.engine;
    const w = this.world;
    const player = w.player;
    if (!e || w.mode !== 'explore' || player.swimming) {
      this.lastFeet.set(Number.NaN, 0, 0);
      return;
    }
    const feet = player.position;
    if (Number.isNaN(this.lastFeet.x)) this.lastFeet.copy(feet);
    const moved = Math.hypot(feet.x - this.lastFeet.x, feet.z - this.lastFeet.z);
    this.lastFeet.copy(feet);
    if (!player.onGround && player.waterDepth < 0.05) return;
    if (moved > 2) return; // a teleport, not a step
    this.stride += moved;
    const run = player.speed > 3;
    const stride = run ? 1.15 : 0.72;
    if (this.stride < stride) return;
    this.stride = 0;
    const info = cellInfo(w.valley, feet.x, feet.z);
    const surface = footstepSurface({
      waterDepth: player.waterDepth,
      riverDistance: info.riverDistance,
      slope: info.slope,
      wetness: info.wetness,
      forest: w.ecology.shadeAt(feet.x, feet.z),
      rainWet: w.wetness,
    });
    e.play(footstep(e.ctx.sampleRate, this.noise, surface, run ? 1 : 0.3), null, run ? 0.6 : 0.4);
  }

  private updateUnderwater(cam: THREE.Vector3, dt: number): void {
    const e = this.engine;
    if (!e) return;
    const surface = this.world.flow.surfaceAt(cam.x, cam.z);
    const depth = surface === null ? 0 : surface - cam.y;
    const f = underwaterFilter(depth);
    e.setUnderwater(f.cutoff, f.gain);
    this.debug.cutoff = f.cutoff;
    if (depth > 0.05) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0) {
        this.bubbleTimer = this.noise.range(1.5, 5);
        e.play(
          bubbleRise(e.ctx.sampleRate, this.noise),
          { x: cam.x + this.noise.range(-1, 1), y: cam.y - 0.5, z: cam.z + 0.8 },
          0.5,
        );
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const em of [...this.river, this.fall]) em?.node.disconnect();
    this.wind?.node.disconnect();
    this.rain?.node.disconnect();
    this.engine?.dispose();
  }
}
