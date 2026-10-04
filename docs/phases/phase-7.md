# Phase 7 — Spatial nature audio

Task checklist for [Phase 7](../plan.md#phase-7--spatial-nature-audio-m). Status: **code done, checks pending** (G15–G16
in the plan). Written in a cloud session, which can't play or hear sound, so nobody has listened yet (P24). Every sound
is generated in code (C27).

## Sound generation (unit-tested in Node)

- [x] Building blocks: seeded noise, pink and brown noise, filters, eased parameters, bubbles, limiter — `src/audio/dsp/core.ts`
- [x] Stream water: pool, riffle and rapids characters and the waterfall's rumble — `water.ts`
- [x] Wind with gusts, whistle, and rustle by plant (leaves, pines, grass, bamboo hiss, knocks and creaks) — `wind.ts`
- [x] Rain on leaves, rock and water, the downpour roar — `rain.ts`
- [x] Thrush, songbirds, kingfisher, cicadas, frogs, splashes, bubbles, thunder, footsteps by surface — `calls.ts`
- [x] River mix, sliding emitter positions, who sings when, call scheduler, footstep surfaces, underwater filter, rain shares — `src/audio/scene.ts`
- [x] Tests: `tests/unit/audio.test.ts` (15), including "never repeats"

## In the app

- [x] AudioWorklet processors — `src/audio/worklets/` (loaded with Vite's `?worker&url`)
- [x] Audio graph: context unlocked by the first click or key, HRTF panners, underwater low-pass, limiter, volume, meter — `src/audio/AudioEngine.ts` (C28)
- [x] `NatureAudio`: emitters sliding along the river, waterfall, wind and rustle, rain, life, kingfisher, rising fish, thunder after lightning, footsteps, underwater — `src/audio/NatureAudio.ts`
- [x] Sound on/off in the top bar, volume in Time & weather (`src/state/preferences.ts`, kept in this browser)
- [x] e2e `tests/e2e/audio.spec.ts` (G15)
- [ ] G15 and the ten-minute listen (G16) on your PC; tuning after it (P24)
