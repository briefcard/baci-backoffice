import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const proxy = (target) => ({ target, changeOrigin: true });

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Baci Reps',
        short_name: 'Baci Reps',
        description: 'B2B sales floor companion',
        theme_color: '#111111',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
      },
      workbox: {
        // App shell is precached; product images cached at runtime. Catalog data lives in IndexedDB.
        navigateFallback: 'index.html',
        // CRITICAL: the SW must NOT serve the cached app shell for these — let them reach the
        // server, or the OAuth install/callback flow is intercepted and never authenticates.
        navigateFallbackDenylist: [/^\/auth/, /^\/api/, /^\/webhooks/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin.includes('cdn.shopify.com'),
            handler: 'CacheFirst',
            options: { cacheName: 'product-images', expiration: { maxEntries: 600 } },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': proxy('http://localhost:8080'),
      '/auth': proxy('http://localhost:8080'),
      '/webhooks': proxy('http://localhost:8080'),
    },
  },
});
