import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    legacy({
      // MAG browser engines can be older than desktop Chromium.
      targets: ['chrome >= 38'],
      renderLegacyChunks: true,
      renderModernChunks: false,
      modernPolyfills: true
    })
  ],
  server: {
    host: true,
    port: 5176
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});

