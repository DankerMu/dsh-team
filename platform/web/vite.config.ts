import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/_platform/',
  plugins: [react()],
  // Watch writes the same files consumed by Fastify; there is no second browser origin.
  build: { outDir: 'dist', emptyOutDir: true },
});
