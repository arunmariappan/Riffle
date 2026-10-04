# Phase 4 — Builder

Task checklist for [Phase 4](../plan.md#phase-4--builder-l). Status: **code done, GPU checks pending** (G5–G6 in
the plan). Written in a cloud session without a GPU, so nothing here has been seen on screen yet (P15).

## Pure logic (unit-tested in Node)

- [x] Undo/redo stack, 100 steps, async-safe queue, merged slider drags, batches — `src/builder/undo.ts`
- [x] Edit layer (additions, removals, moves, grass strokes, springs) applied on top of the seed — `src/builder/editLayer.ts`
- [x] Placement rules with readable reasons for every category — `src/builder/placement.ts`
- [x] Analytic picking (height map, water surface, ellipsoids, cylinders) — `src/builder/picking.ts` (C21)
- [x] Brushes: scatter dabs, eraser circle, grass painting — `src/builder/brush.ts`
- [x] Settings object, limits, normalization, dotted paths — `src/state/settings.ts`
- [x] `.riffle` format (gzip, versioned header, JSON + binary sections) — `src/save/format.ts`
- [x] Save document, validation, migrations table — `src/save/saveData.ts`
- [x] Autosave rotation over a storage interface — `src/save/autosave.ts`
- [x] Water temperature model — `src/sim/ecology/temperature.ts` (C22)
- [x] Weather states and their looks — `src/sim/weather/weather.ts`
- [x] Fish content schema + `content/fish/denison-barb.json`

## Engine

- [x] Item registry with stable ids; add/remove/move; edit layer upkeep; flow re-solves; hosted plants — `src/engine/world/WorldItems.ts`
- [x] Stones fall, splash and settle with Rapier convex hulls, then freeze (`Physics.dropStone`, `WorldItems.drop`)
- [x] Rock, tree and plant systems: uids, add/remove/move, growing instance buffers with the same materials, previews
- [x] Fish schools tagged with ids (release / remove a school); species built from content
- [x] Builder camera — `src/engine/player/BuilderCamera.ts`
- [x] Overlays: flow arrows, depth and speed drape, legend — `src/engine/overlays/Overlays.ts`
- [x] Live catalog thumbnails with a cache — `src/engine/thumbnails.ts` (C19, closes P13)
- [x] World: modes, settings, weather blend, snapshot/restore — `src/engine/world/World.ts`
- [x] Builder controller: drag sessions, ghost and ring, brushes, springs, selection, gizmo, keys, saving — `src/engine/builder/Builder.ts`

## UI

- [x] Start screen: Enter, Continue (latest autosave), Open a valley file
- [x] Top bar: Explore / Build / (Photo in Phase 8), Valley menu (save as, open, new)
- [x] Catalog panel with thumbnails; drag from a card; school size
- [x] Toolbar: tools, brush size and density, gizmo modes, delete, undo/redo, overlays, explore from here
- [x] Control panels: Water, Wind (dial, Beaufort), Trees (+ per species), Time & weather
- [x] Placement hint, toasts, legend
- [x] Autosave every 5 minutes and when hidden; storage persistence

## Tests

- [x] 32 new unit tests (77 total)
- [x] e2e `tests/e2e/builder.spec.ts`: drag a stone in, invalid reason, every item placed, slider + 100 undo/redo, save/reload from OPFS and from a file (G5)
- [ ] G5 and G6 on your PC
