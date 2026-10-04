import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// SharedArrayBuffer needs cross-origin isolation (plan principle 6). Everything is served locally.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
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
