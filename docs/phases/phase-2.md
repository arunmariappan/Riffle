# Phase 2 — Living water

Task checklist for [Phase 2](../plan.md#phase-2--living-water-l). Status: **done** (P10–P12 open).

- [x] Shared double buffer `src/sim/shared/doubleBuffer.ts` + race test
- [x] Flow worker `src/workers/flow.worker.ts`; shared sampler `src/sim/flow/sharedSampler.ts`
- [x] FlowSystem `src/engine/water/FlowSystem.ts`: river meshes per reach, pond, waterfall sheet, flow texture, level map
- [x] Water material `waterMaterial.ts` (flow-map ripples, depth color, refraction, foam), generated ripple normals `waterNormals.ts`
- [x] Caustics and wet lines on terrain and rocks `caustics.ts`; WebGPU per-stage limits
- [x] Wading, swimming, diving; underwater color and fog
- [x] Floating debris `Debris.ts` (seasonal mix)
- [x] Dev panel (Tweakpane) with water, time, wind and tree controls
- [x] World.placeStone / removeStone with local re-solve
- [x] First fish: generator `src/procgen/fish.ts`, material `src/engine/fauna/fishMaterial.ts`, school `src/sim/boids/school.ts`, fish worker, FishSystem
- [x] Tests: unit (school, shared buffer) and e2e (stone wake < 0.5 s, discharge, swim, barb school)
- [ ] Waterfall spray particles (P11), terrain detail normals (P10)
