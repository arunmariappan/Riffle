# Phase 1 — The valley

Task checklist for [Phase 1](../plan.md#phase-1--the-valley-l). Status: **done** (reference photos pending, P6).

- [x] CC0 textures: `tools/asset-manifest.ts`, `pnpm fetch-assets` (Poly Haven → `assets-src/`, Git LFS), `pnpm assets` (→ WebP in `public/assets/`)
- [x] Valley generator `src/sim/terrain/valley.ts` (course, profile, pond, distance transform, erosion, masks, viewpoints) + tests
- [x] Terrain worker `src/workers/terrain.worker.ts` (Comlink, transferables, grass density)
- [x] Terrain rendering `src/engine/terrain/` (chunks + LOD + skirts, seven-layer material, far ring)
- [x] Clock `src/sim/time/clock.ts` (sun/moon, monsoon seasons) + tests
- [x] Sky, atmosphere, stars, exposure curve `src/engine/sky/`
- [x] Physics `src/engine/physics/Physics.ts` (1 m heightfield) + test; Explore player and input `src/engine/player/`
- [x] Content JSON (trees, stones) + Zod schemas `src/content/`; scatter `src/sim/scatter/` + tests
- [x] Trees (EZ-Tree near, lite far, seasonal looks), rocks, streamed grass
- [x] World assembly `src/engine/world/World.ts`, loading screen, shader precompile, smooth-frame wait
- [x] Benchmark `?bench=valley` + `tests/e2e/bench.spec.ts`; golden shots `tools/golden.ts`
- [x] e2e: valley loads, renders, walking works, seed reproducible
- [ ] Reference photo comparison (P6, needs your photo folder)
