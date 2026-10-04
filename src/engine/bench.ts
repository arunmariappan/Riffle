import * as THREE from 'three/webgpu';
import type { Engine } from './Engine';
import type { World } from './world/World';

export interface BenchResult {
  name: string;
  seconds: number;
  frames: number;
  fpsAvg: number;
  /** 5th percentile fps (the slow frames). */
  fpsLow: number;
  frameMsAvg: number;
  frameMsP95: number;
  frameMsMax: number;
  /** Frames longer than 100 ms. */
  hitches: number;
  cpuMsAvg: number;
  gpuMsAvg: number;
  drawCallsMax: number;
  trianglesMax: number;
  quality: string;
}

/**
 * Benchmark flythrough (plan 9): glides the camera along the stream through every viewpoint and records frame
 * times. Kept short by default (20 s) until the GPU stability check passes (open item P2).
 */
export async function runBenchmark(engine: Engine, world: World, name: string): Promise<BenchResult> {
  const params = new URLSearchParams(window.location.search);
  const seconds = Number(params.get('benchSeconds') ?? 20);
  world.mode = 'fixed';
  const points = world.valley.spots.map((s) => new THREE.Vector3(s.x, world.heightAt(s.x, s.z) + 3, s.z));
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const frameMs: number[] = [];
  const cpu: number[] = [];
  const gpu: number[] = [];
  let drawCallsMax = 0;
  let trianglesMax = 0;
  // Warm up for 2 s so shader compilation doesn't count.
  await new Promise((r) => setTimeout(r, 2000));
  return new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    const unsubscribe = engine.onLateFrame(() => {
      const now = performance.now();
      const t = Math.min(1, (now - start) / (seconds * 1000));
      const p = curve.getPointAt(t);
      const ahead = curve.getPointAt(Math.min(1, t + 0.02));
      p.y = Math.max(p.y, world.heightAt(p.x, p.z) + 2.2);
      engine.camera.position.copy(p);
      engine.camera.lookAt(ahead.x, ahead.y - 0.8, ahead.z);
      frameMs.push(now - last);
      last = now;
      cpu.push(engine.stats.cpuMs);
      if (engine.stats.gpuMs > 0) gpu.push(engine.stats.gpuMs);
      drawCallsMax = Math.max(drawCallsMax, engine.stats.drawCalls);
      trianglesMax = Math.max(trianglesMax, engine.stats.triangles);
      if (t >= 1) {
        unsubscribe();
        world.mode = 'explore';
        const sorted = [...frameMs.slice(1)].sort((a, b) => a - b);
        const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
        const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
        resolve({
          name,
          seconds,
          frames: frameMs.length,
          fpsAvg: 1000 / avg(sorted),
          fpsLow: 1000 / Math.max(1, p95),
          frameMsAvg: avg(sorted),
          frameMsP95: p95,
          frameMsMax: sorted[sorted.length - 1] ?? 0,
          hitches: sorted.filter((v) => v > 100).length,
          cpuMsAvg: avg(cpu),
          gpuMsAvg: avg(gpu),
          drawCallsMax,
          trianglesMax,
          quality: world.quality,
        });
      }
    });
  });
}
