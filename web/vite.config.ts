import { defineConfig } from 'vitest/config';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Mic and camera need a secure context, so dev and preview run over (self-signed) HTTPS, which a phone on the
  // LAN can use. NO_SSL=1 serves plain http instead: http://localhost is a secure context too, and (unlike a
  // self-signed https origin) Chromium lets it register a service worker, which the automated tests need.
  plugins: [
    ...(process.env.NO_SSL === '1' ? [] : [basicSsl()]),
    VitePWA({
      registerType: 'prompt', // an update must never reload the page mid-walk
      manifest: false, // public/manifest.webmanifest is used as is
      workbox: {
        cleanupOutdatedCaches: true,
        // Take control of the page that registered the worker, so the very first session already works offline.
        // (Updates still wait for the app to be closed: no skipWaiting.)
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,woff2,ttf,svg,png,json,webmanifest}'], // fonts too: the app must look right offline
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  server: { host: true },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
