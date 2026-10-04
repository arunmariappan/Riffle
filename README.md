# Riffle

A living monsoon mountain stream in the browser. Walk, wade and swim among colorful fish, shape the stream with stones,
plants and trees, control the water, the wind and how the trees move, and watch the valley evolve through the seasons.

*A riffle is the shallow, sparkling, fast stretch of a stream where the water carries the most oxygen and fish gather
to feed.*

Everything is TypeScript: three.js `WebGPURenderer` with TSL shaders, React 19 for the panels, Web Workers for the
simulation. The design, decisions and progress are in [docs/plan.md](docs/plan.md).

## Requirements

- Desktop **Google Chrome** or **Microsoft Edge** with WebGPU (other browsers see a "please use Chrome or Edge" page).
- Node.js 22.12+ (24 LTS recommended) and pnpm.
- Git LFS (for the CC0 source assets in `assets-src/`).
- KTX-Software (`toktx`) for `pnpm assets` texture compression (optional while it isn't installed).

## Getting started

```sh
git clone https://github.com/arunmariappan/Riffle.git
cd Riffle
pnpm install
pnpm dev          # http://localhost:5173
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server with instant reload |
| `pnpm start` | Build once and serve the optimized app at http://localhost:4173 |
| `pnpm typecheck` · `pnpm lint` · `pnpm format:check` | Static checks |
| `pnpm test` | Unit tests (Vitest, in Node) |
| `pnpm test:e2e` | End-to-end tests in real Chrome and Edge (uses the GPU) |
| `pnpm bench` | Benchmark flythrough, writes JSON to `bench-results/` |
| `pnpm assets` · `pnpm bake` | Rebuild processed and generated assets into `public/assets/` |

Useful URL parameters: `?quality=low|medium|high|ultra`, `?scene=test` (Phase 0 rendering test scene),
`?autostart` (skip the start screen).

## License

[MIT](LICENSE). Asset credits are in [CREDITS.md](CREDITS.md).
