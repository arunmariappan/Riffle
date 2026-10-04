# Phase 6 — Ecosystem and evolution

Task checklist for [Phase 6](../plan.md#phase-6--ecosystem-and-evolution-xl). Status: **code done, GPU checks
pending** (G11–G14 in the plan). Written in a cloud session without a GPU, so the new visuals haven't been seen on
screen yet (P21). The simulation is pure TypeScript and unit-tested in Node.

## Simulation (unit-tested in Node)

- [x] Stretches of about 50 m from the solved stream, plus the pond, with habitat per species — `src/sim/ecology/stretches.ts`
- [x] Canopy shade grid from the trees — `src/sim/ecology/canopy.ts`
- [x] Daily environment per stretch: water temperature, oxygen and its dawn low, light, insects, algae, nutrients — `environment.ts` (C24)
- [x] Weather states with season odds and durations; the catchment (rain → discharge after a delay, silt) — `src/sim/weather/weatherSystem.ts`
- [x] Fish cohorts: fry, juveniles, adults; growth, deaths, spawning seasons and grounds, Beverton–Holt recruitment — `cohorts.ts`
- [x] Food chain, mahseer and kingfisher predation, brightness makes fish easier to catch
- [x] Dispersal, the mahseer's monsoon run upstream and back, juvenile drift
- [x] Genetics: five traits, breeder's equation (Lande), two pulls on color, mutation–selection balance, koi pattern mixing — `genetics.ts`
- [x] The whole valley: fixed hourly and daily steps, settings, restock floor, history for the graphs, hash, save and restore — `ecology.ts`
- [x] Plants: tolerance curves (in the plant JSON files), growth, spread by kind, die-back, a growth-versus-spread gene — `plants.ts` (C25)
- [x] The two-level hand-off planner: enter/leave with hysteresis, counts follow the cohorts within a budget, out-of-sight spawning, genes from cohort statistics — `view.ts`
- [x] Kingfisher behavior: arrive, perch, fly, hover, dive — `src/sim/fauna/kingfisher.ts`
- [x] Tests: `tests/unit/ecology.test.ts` (reproducibility, 10-year balance of a synthetic valley and of the real generated valley, both adaptation experiments, evolution off, migration, save/restore, weather and catchment, genetics, stretches), `ecologyView.test.ts`, `plants.test.ts`, `kingfisher.test.ts`, save migration in `save.test.ts`

## In the app

- [x] Ecology worker — `src/workers/ecology.worker.ts`
- [x] `EcologySystem`: stretches from the flow, sync with the clock, fish hand-off, plant steps applied to the world, discharge and silt from the catchment, ecology overlays — `src/engine/ecology/EcologySystem.ts`
- [x] Fish come from the ecology (the Phase 5 starting schools are gone); released schools join their cohort; `?allfish`
- [x] Weather on "Follow the seasons" comes from the ecology; storm gusts add to the wind; lightning flash with a thunder hook
- [x] Rain streaks (vertex shader), raindrop rings on the water, wet ground and stones — `src/engine/weather/Rain.ts`, water, terrain and rock materials
- [x] The kingfisher bird — `src/engine/fauna/Kingfisher.ts`
- [x] Ecosystem panel and uPlot graphs — `src/app/panels/EcosystemPanel.tsx`, `EcoGraph.tsx`
- [x] Ecosystem settings (`settings.ecosystem`), saves version 2 with `ecology` and `plants` sections and a migration from version 1 (C26)
- [x] e2e `tests/e2e/ecology.spec.ts` (G11); `fish.spec.ts` uses `?allfish`
- [ ] G11–G13 on your PC; G14 after P1
- [ ] Trees and grass in the plant ecology (P22)
