import { defineConfig } from 'vite';

// Relative base so the built site works from any folder or static host.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1500 },
  // three-mesh-bvh starts its own Web Worker; pre-bundling would break the worker's path in dev.
  optimizeDeps: { exclude: ['three-mesh-bvh'] },
});
