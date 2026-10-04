# Phase 9 — Polish and hardening

Task checklist for [Phase 9](../plan.md#phase-9--polish-and-hardening-m). Status: **code done, checks pending**
(G20–G23 in the plan). Written in a cloud session without a GPU (P27); the hour-long run waits for P1.

## Built

- [x] Dynamic resolution within each preset's range — `src/perf/resolution.ts`, driven in `src/app/boot.ts`
- [x] Low / Medium / High / Ultra presets in one table (render scale and range, grass, fish budget) — `src/state/quality.ts`
- [x] Settings dialog: quality, dynamic resolution, frame cap, field of view, mouse sensitivity, invert Y, head bob, softer lightning, volume, controls guide — `src/app/shell/SettingsDialog.tsx`, `src/state/preferences.ts`, `src/app/controls.ts`
- [x] Lost GPU device: message, save, reload from the autosave (lighter preset when it repeats) — `src/app/recovery.ts`, `App.tsx`
- [x] Code-splitting: the engine loads after the start screen (closes P9) — `src/app/boot.ts`
- [x] `pnpm start`; install as an app (manifest, icon) — `public/manifest.webmanifest`, `public/icon.svg`
- [x] README and controls guide
- [x] Fresh-clone check — `tools/fresh-clone.ts` (passes in the cloud)
- [x] Hour-long soak test — `tests/e2e/soak.spec.ts` (`SOAK_MINUTES`)
- [x] Tests: `tests/unit/polish.test.ts` (8)

## On your PC

- [ ] G20 fresh clone with assets, `pnpm start`, install as an app
- [ ] G21 every earlier phase's checks (`pnpm test:e2e`, `pnpm bench`)
- [ ] G22 first look at settings, dynamic resolution and the device-lost reload
- [ ] G23 the hour-long session (after P1)
