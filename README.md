# Riffle

A living monsoon mountain stream in the browser. Walk, wade and swim among colorful fish, shape the stream with stones,
plants and trees, control the water, the wind and how the trees move, and watch the valley evolve through the seasons.

*A riffle is the shallow, sparkling, fast stretch of a stream where the water carries the most oxygen and fish gather
to feed.*

Everything is TypeScript: three.js `WebGPURenderer` with TSL shaders, React 19 for the panels, Web Workers for the
simulation, AudioWorklets for the generated sound. The design, decisions and progress are in
[docs/plan.md](docs/plan.md); each phase has a checklist in [docs/phases/](docs/phases/).

## What you need

- Desktop **Google Chrome** or **Microsoft Edge** with WebGPU (other browsers see a "Riffle needs WebGPU" page).
  A graphics card around an RTX 3060 runs the High preset at 60 fps; Low and Medium suit smaller cards.
- **Node.js 24** (22.12+ works) and **pnpm** (the version is pinned in `package.json`; `corepack enable` sets it up).
- **Git LFS** for the CC0 source textures in `assets-src/` (or run `pnpm fetch-assets` to download them).

## From a fresh clone

```sh
git lfs install
git clone https://github.com/arunmariappan/Riffle.git
cd Riffle
pnpm install
pnpm assets     # turns the CC0 sources into the app's textures (public/assets/, not committed)
pnpm start      # builds once and serves the optimized app at http://localhost:4173
```

Open http://localhost:4173 in Chrome or Edge and click **Enter the valley**. The first load compiles shaders for
20–35 seconds in a fresh browser profile; later loads are much faster. Without `pnpm assets` the valley still runs,
with plain colors where the ground textures would be.

To develop, use `pnpm dev` instead (http://localhost:5173, instant reload). `npx tsx tools/fresh-clone.ts` repeats
these steps in a temporary folder and checks that they all pass.

### Install it as an app (optional)

In Chrome or Edge, use the install icon in the address bar (or ⋮ → Cast, save and share → Install page as app) while
`pnpm start` is running. Riffle then opens in its own window with a desktop shortcut.

## Controls

| Explore | |
|---|---|
| Click | Look around (Esc releases the mouse) |
| W A S D, Shift | Walk, run |
| Space / C | Jump, swim up / sink while swimming |
| F | Throw food onto the water ahead |
| E | Look at the fish in the middle of the view (Follow to trail it) |
| Tab | Build mode |
| P | Photo mode |

| Build | |
|---|---|
| Right-drag, middle-drag (or Shift + right-drag), wheel | Turn, pan, zoom (W A S D, Q E also pan and turn) |
| Drag a card from the catalog | Place it: a green ring means it can go there, red says why not. While dragging, the wheel turns it and Shift + wheel scales it |
| Click, Shift + click | Select, add to the selection |
| 1, 2, 3 · Delete | Move, turn, scale · remove |
| Ctrl + Z, Ctrl + Shift + Z | Undo, redo (100 steps) |
| Tab | Explore from here |

| Photo | |
|---|---|
| Right-drag · W A S D, Q E, Shift | Look · move, down and up, faster |
| Wheel · click | Zoom (focal length) · focus there |
| H · Esc | Hide the controls · back to exploring |

The panels in Build mode set the water, wind, trees, time and weather, and the ecosystem (evolution, mutation,
predators, population caps, graphs and overlays). **⚙ Settings** has the quality preset (Low, Medium, High, Ultra),
dynamic resolution, a 30 or 60 fps cap, field of view, mouse sensitivity and inversion, head bob, softer lightning,
the volume and this list of controls. 🔊 mutes.

## Saving

Riffle autosaves every five minutes and when you leave the tab, keeping the last three; the start screen offers to
continue. **Valley ▾ → Save valley as…** writes a `.riffle` file (your edits, the settings, the time and the whole
ecosystem); **Open valley…** loads one. A valley is grown from its seed, so the files stay small.

## Photos and time-lapses

In photo mode, **Take photo** averages 64–256 frames, each with a slightly shifted camera, lens and sun, for smooth
edges, real depth of field and soft shadows, and saves a PNG up to 4K. **Time-lapse** records a day, a season or a
year from a fixed camera or a path through up to five keyframes, straight into an MP4 file. Long captures at 4K are
long GPU loads: keep them short until your PC's stability check (P1 in the plan) has passed.

## If something goes wrong

- **"Riffle needs WebGPU"**: WebGPU isn't available. Update the browser, and check `chrome://gpu` shows WebGPU as
  hardware accelerated.
- **The picture freezes and Riffle says the graphics device stopped**: the GPU driver reset. Riffle saves the valley
  and reloads it from the autosave by itself; if it happens again soon it switches to a lighter preset.
- **No sound**: browsers start audio only after a click; click the view once. Check 🔊 and the volume in ⚙ Settings.
- **Slow**: pick a lighter preset in ⚙ Settings, keep dynamic resolution on, or try the 30 fps cap.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server with instant reload (http://localhost:5173) |
| `pnpm start` | Build once and serve the optimized app (http://localhost:4173) |
| `pnpm build` | Type check and production build into `dist/` |
| `pnpm typecheck` · `pnpm lint` · `pnpm format:check` | Static checks |
| `pnpm test` | Unit tests (Vitest, in Node, no GPU needed) |
| `pnpm test:e2e` | End-to-end tests in real Chrome and Edge (uses the GPU) |
| `pnpm bench` | Benchmark flights (valley, storm, 500 fish) with JSON in `bench-results/` |
| `pnpm fetch-assets` · `pnpm assets` | Download the CC0 sources · process them into `public/assets/` |

Useful URL parameters: `?quality=low|medium|high|ultra`, `?autostart` (skip the start screen), `?continue` (the latest
autosave), `?seed=…` (another valley), `?spot=waterfall|rapids|riffles|pool|bend|pond&hour=…&day=…` (a viewpoint and time), `?stats`.

## License

[MIT](LICENSE). Asset credits are in [CREDITS.md](CREDITS.md).
