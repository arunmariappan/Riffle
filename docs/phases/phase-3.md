# Phase 3 — Wind and vegetation

Task checklist for [Phase 3](../plan.md#phase-3--wind-and-vegetation-l). Status: **in progress**. The code is in,
but none of it has been seen on screen yet (P14). Work continues in a cloud session; the checks that need a GPU are
G1–G4 in the plan.

- [x] One wind state: `World.setWind` updates the CPU state and every shader (trees, bamboo, grass, plants, water chop, clouds)
- [x] CPU wind twin `src/sim/wind/windField.ts` (gust fronts, presets, Beaufort) + unit tests
- [x] Tree fern generator (`generateTreeFern` in `src/procgen/plants.ts`) in `TreeSystem`
- [x] Ground plants: fern, wildflowers, wild orchid generators; `PlantSystem` + `plantMaterial` (part colors, wind, seasons)
- [x] Water plants: lotus, lily, Java fern, Cryptocoryne, red Rotala, moss; placed by solved depth and current (`src/sim/scatter/aquatic.ts`); bend with the current
- [x] Grass: per-blade lean and curve; bends away from the player
- [x] Falling petals, leaves and pollen (`AirParticles.ts`), seasonal mix
- [x] Content schemas and JSON for bushes and water plants
- [x] Tree dynamics sliders in the dev panel (flexibility, sway, flutter, response delay)
- [ ] e2e: a wind change reaches every consumer within 1 s; each tree slider makes a visible difference (G3)
- [ ] Storm-wind benchmark, ≤ 1,500 draw calls (G4)
- [ ] Waterfall spray and mist particles (P11)
- [ ] Tree baking in the Workshop (detail levels + impostors): replaced by lite trees for now (C10, P13)
- [ ] Local GPU checks G1–G4 on your PC: first look, spring and autumn golden shots, e2e, benchmark
- [ ] Built note and screenshots once G1–G2 pass
