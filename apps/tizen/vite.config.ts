import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    legacy({
      // Older Samsung TV browser engines need legacy chunks/polyfills.
      targets: ['chrome >= 38'],
      renderLegacyChunks: true,
      renderModernChunks: false,
      modernPolyfills: true
    })
  ],
  server: {
    host: true,
    port: 5173
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});
