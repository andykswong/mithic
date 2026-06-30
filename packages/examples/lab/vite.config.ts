import { defineConfig } from 'vite';
import { bundleGuestPlugin } from './build/bundle-plugin.ts';

export default defineConfig({
  plugins: [bundleGuestPlugin()],
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
  base: './',
});
