# Phase 8 — Photo mode and time-lapse

Task checklist for [Phase 8](../plan.md#phase-8--photo-mode-and-time-lapse-m). Status: **code done, GPU checks pending**
(G17–G19 in the plan). Written in a cloud session without a GPU, so nothing has been captured yet (P25); long captures
wait for P1 (P26).

## Pure parts (unit-tested in Node)

- [x] Lens: focal length ↔ field of view, aperture, depth of field, Halton jitter, lens and sun-disk samples, the thin-lens shift — `src/photo/lens.ts`
- [x] Time-lapse plans (spans, intervals, exact frame times) and keyframe camera paths — `src/photo/timelapse.ts`
- [x] Filters and exposure — `src/photo/filters.ts`
- [x] Readback row unpacking, capture file names — `src/photo/pixels.ts`
- [x] Tests: `tests/unit/photo.test.ts` (9), including "recording doesn't change the simulation"

## In the app

- [x] Photo mode: free camera with collision, lens, click to focus, exposure, filters, grid, hide controls, pause — `src/engine/photo/PhotoMode.ts`
- [x] Accumulation in half-float targets, shown while developing, read back to PNG up to 4K — `Accumulator.ts`
- [x] Pipeline option without TRAA for captures (`createPipeline(..., { temporal: false })`)
- [x] Time-lapse recorder: WebCodecs + Mediabunny streaming an MP4 to disk (in memory without a save dialog) — `TimeLapse.ts`
- [x] Photo panel (Photo and Time-lapse tabs), P / H / Esc keys, the Photo button, PNG and MP4 save dialogs — `src/app/panels/PhotoPanel.tsx`, `src/save/browserStorage.ts`
- [x] e2e `tests/e2e/photo.spec.ts` (G17)
- [ ] G17 and G18 on your PC; G19 after P1
