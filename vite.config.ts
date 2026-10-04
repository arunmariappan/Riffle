import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// SharedArrayBuffer needs cross-origin isolation (plan principle 6). The local servers send these headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Static hosts (GitHub Pages) can't send those headers, so builds also ship a service worker that adds them. It must
 * sit next to index.html: a service worker only controls pages at or below its own folder.
 */
function isolationServiceWorker(): Plugin {
  return {
    name: 'riffle-isolation-sw',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'chunk', id: 'src/workers/isolation.sw.ts', fileName: 'coi-sw.js' });
    },
  };
}

// The base is '/' locally; the GitHub Pages workflow builds with `--base /<repo>/`.
export default defineConfig({
  plugins: [react(), isolationServiceWorker()],
  resolve: {
    // One three.js instance: libraries importing 'three' (EZ-Tree, three-mesh-bvh) get the WebGPU build.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: { port: 5173, strictPort: true, headers: isolation },
  preview: { port: 4173, strictPort: true, headers: isolation },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
