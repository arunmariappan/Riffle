# Phase 3 — Wind and vegetation

Task checklist for [Phase 3](../plan.md#phase-3--wind-and-vegetation-l). Status: **code done, GPU checks pending**
(G1–G4 in the plan). Nothing from this phase has been seen on screen yet (P14); expect a few fixes after G1.

- [x] One wind state: `World.setWind` updates the CPU state and every shader (trees, bamboo, grass, plants, water chop, clouds)
- [x] CPU wind twin `src/sim/wind/windField.ts` (gust fronts, presets, Beaufort) + unit tests
- [x] Tree fern generator (`generateTreeFern` in `src/procgen/plants.ts`) in `TreeSystem`
- [x] Ground plants: fern, wildflowers, wild orchid generators; `PlantSystem` + `plantMaterial` (part colors, wind, seasons)
- [x] Water plants: lotus, lily, Java fern, Cryptocoryne, red Rotala, moss; placed by solved depth and current (`src/sim/scatter/aquatic.ts`); bend with the current
- [x] Grass: per-blade lean and curve; bends away from the player
- [x] Falling petals, leaves and pollen (`AirParticles.ts`), seasonal mix, measured drift (`air.drift`)
- [x] Content schemas and JSON for bushes and water plants
- [x] Tree dynamics sliders in the dev panel (flexibility, sway, flutter, response delay)
- [x] Waterfall spray and mist, splashes (P11): `src/sim/particles/spray.ts` (pure, 5 unit tests) + `src/engine/water/Spray.ts`
- [x] Test hooks: `World.windReport()`, `World.frozenTime` (repeatable screenshots), `TreeSystem.nearest()`, `GrassSystem.densityAt()`
- [x] e2e `tests/e2e/wind.spec.ts`: a wind change reaches every consumer within 1 s; each tree slider makes a visible difference (G3)
- [x] Storm-wind benchmark `?bench=storm` in `tests/e2e/bench.spec.ts`, ≤ 1,500 draw calls for both flights (G4)
- [ ] Tree baking in the Workshop (detail levels + impostors): replaced by lite trees (C10); not needed so far (P13)
- [ ] Local GPU checks G1–G4 on your PC: first look, spring and autumn golden shots, e2e, benchmark
- [ ] Screenshots in `docs/screenshots/` once G1–G2 pass
