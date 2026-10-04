# Phase 5 — Fish

Task checklist for [Phase 5](../plan.md#phase-5--fish-l). Status: **code done, GPU checks pending** (G7–G10 in the
plan). Written in a cloud session without a GPU, so the fish haven't been seen on screen yet (P19).

## Content and behavior (unit-tested in Node)

- [x] Fish schema (Phase 4) and six species: `content/fish/` (mahseer, barb, white cloud minnow, celestial pearl danio, hillstream loach, koi)
- [x] Species file → school behavior: `src/sim/boids/species.ts`
- [x] Genes per fish (size, swim strength, preferred flow, brightness, shyness) and their effects
- [x] Habitat seeking by depth, current and water temperature
- [x] Loaches cling to the bed in fast water, face into the current, dart between rocks
- [x] Rising to insects at dawn and dusk (`fishEnvironment`), food (koi from afar, at the surface)
- [x] Curiosity when you stand still, fleeing, night rest near the bottom, koi gliding
- [x] Stable fish ids, school ids, `inspect` in the worker; shared layout with ids, brightness, pattern, flags (`src/sim/boids/layout.ts`)
- [x] Pond water in the shared flow sampler (koi)
- [x] Tests: `tests/unit/fish.test.ts` (9) with a stream-and-pond fixture `tests/unit/streamFixture.ts`

## Look and motion

- [x] Generator: four bodies, four fin shapes as membranes with a fin coordinate, barbels — `src/procgen/fish.ts`
- [x] Pattern shader per kind with the brightness gene, iridescence, metallic scales, backlit fins — `src/engine/fauna/fishMaterial.ts`
- [x] Swim motion: wave scaled by the beat (glides), banked turns, fin flutter and ripples
- [x] `FishSystem`: species from content, per-fish genes in the instance data, rise splashes, picking, inspect, previews

## In the world

- [x] Every species starts in its own water (`World.findFishSpot`)
- [x] F throws food; E (Explore) or a click (Build) opens the fish card; Follow camera
- [x] e2e `tests/e2e/fish.spec.ts` (G7); 500-fish benchmark flight (G8)
- [ ] G7–G9 on your PC; G10 after P1
- [ ] Optional GPU schools (P20)
