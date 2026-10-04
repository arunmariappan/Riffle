# Phase 0 — Groundwork and hardware check

Task checklist for [Phase 0](../plan.md#phase-0--groundwork-and-hardware-check-s). Status: **done**, except the
stability check (P1), which you run.

- [ ] Stability check: HWiNFO64 logging, 30-minute GPU stress test, Event Viewer 41/6008, dust, PSU (P1, you)
- [x] Tools: pnpm 12 (user install), Git LFS 3.6, Chrome 152, Edge 154 — Node 24 pending approval (P3), KTX-Software pending (P4)
- [x] Scaffold: `package.json` (pinned three 0.186.1), `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`
      (COOP/COEP, `three` → `three/webgpu` alias), `eslint.config.js` (pure `src/sim` rule), Prettier, Vitest, Playwright
- [x] WebGPU check + "please use Chrome or Edge" page (`src/engine/webgpu.ts`, `src/app/Unsupported.tsx`)
- [x] Repo: `.gitattributes` (LF + LFS for `assets-src/`), `.gitignore` (`public/assets/`), README, CREDITS, LICENSE
- [x] CI: `.github/workflows/ci.yml` (typecheck, lint, format, unit tests, build)
- [x] Engine core: `src/engine/Engine.ts` (60 fps cap, GPU timestamps, device-lost hook, render scale)
- [x] Post chain: `src/engine/post/pipeline.ts` (Low / Medium GTAO / High SSGI / Ultra SSGI, TRAA, bloom, grading, underwater)
- [x] Sky and sun: `src/engine/sky/SkySystem.ts` (SkyMesh with clouds, cascaded shadows, sky PMREM)
- [x] Wind shader and foliage materials: `src/engine/vegetation/wind.ts`, `materials.ts`, `grass.ts`
- [x] Generators: `src/procgen/bamboo.ts`, `src/procgen/trees.ts` (EZ-Tree wrapper), `src/procgen/geometry.ts`
- [x] Test scene `?scene=test` and measurements at 1080p (see the plan's Phase 0 Built note)
- [x] Flow solver prototype `src/sim/flow/` + `tests/unit/flow.test.ts` (7 tests)
- [x] e2e: `tests/e2e/smoke.spec.ts` — WebGPU frame read back in Chrome and Edge; non-WebGPU page
