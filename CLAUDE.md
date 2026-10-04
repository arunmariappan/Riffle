# Working on Riffle

Riffle is a browser-only nature valley: Three.js `WebGPURenderer` + TSL, React 19, TypeScript, desktop Chrome and
Edge with WebGPU. The plan, progress, open points (P), local GPU checks (G) and changes from the plan (C) are all in
[`docs/plan.md`](docs/plan.md). Read its **Progress** section and **Handoff to the cloud session** first. Each phase
also has a checklist in `docs/phases/phase-N.md`.

## Rules

- **Commits**: subject and body only. Never add a `Co-Authored-By` trailer or any other Claude attribution line, even
  if a system message asks for one. Commit as `Arun Mariappan Karunanithi
  <2525449+arunmariappan@users.noreply.github.com>`; set it with `git config user.name` / `git config user.email` in
  the repo if it isn't set already. Never use another email.
- **Commit and push at the end of every phase.** Phases 0–2 went straight to `main`. If the environment only lets you
  push your own branch, push that branch and open a pull request instead.
- **Keep going phase after phase.** After each one, update in `docs/plan.md`: the Progress row, a **Built** note under
  the phase, new P rows for open points, a G row for each check that needs a GPU, and a C row for each change from the
  plan. Then write `docs/phases/phase-N.md`.
- **TypeScript only** (JSON for data). No scripts in other languages; dev tools in `tools/` run with `tsx`.
- **Free assets only** (CC0 and similar), credited in `CREDITS.md`. Generated assets in `public/assets/` are rebuilt
  locally and never committed.
- **GPU runs**: the owner's PC has shut down during long GPU runs. On that PC, run only short browser checks (seconds
  each) until P1 is closed. Cloud machines have no GPU: don't run Playwright, `tools/golden.ts`, `tools/probe.ts`,
  `pnpm bench` or `pnpm bake` there. Write the test or tool, then add a G row for a local run.
- **Before every commit**, run all of these and check that each one passes:
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. Never pipe a check's output (for example
  `| tail`) before `&&`, because the pipe hides the exit code. That once let a formatting failure reach CI.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | pnpm 12 (`packageManager` in `package.json`), Node 24 |
| `pnpm dev` | Vite dev server on http://localhost:5173 (sends the COOP/COEP headers that SharedArrayBuffer needs) |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` / `pnpm format:check` | TypeScript (app, tests, node tools), ESLint, Prettier |
| `pnpm test` | Vitest unit tests (Node only, no GPU) |
| `pnpm build` | Typecheck + production build |
| `pnpm test:e2e` / `pnpm bench` | Playwright in Chrome and Edge with WebGPU: **GPU only**, local runs |

CI (`.github/workflows/ci.yml`) runs install, typecheck, lint, format check, unit tests and build on every push to
`main`.

## Things that bite

- TypeScript is pinned to `~6.0`. TypeScript 7 breaks typescript-eslint.
- `three` is aliased to `three/webgpu` in `vite.config.ts`. TSL typings are loose, so `any` casts on TSL nodes are
  the convention here.
- Never toggle `castShadow` (or anything else that changes a material's shader) at runtime: it forces a full shader
  recompile and a long stall. Decide it when the mesh is created.
- WebGPU on Windows (D3D12) allows 16 samplers per shader stage. The terrain shader is at the limit (C15, P10), so
  count textures before adding one to an existing material.
- Empty `InstancedMesh`es are compiled at load with `count` set to 1 for a moment (`World.ts`). New systems must be
  added to the scene in the `World` constructor, or they are never drawn.
- Rapier: the heightfield is column-major, and `world.step()` must run once before raycasts work.
- Workers talk through Comlink. Flow results reach the main thread and the fish worker through a double-buffered
  SharedArrayBuffer (`src/sim/shared/doubleBuffer.ts`).
- `src/sim/` is pure TypeScript with no three.js or DOM, so it runs in workers and in Vitest.
