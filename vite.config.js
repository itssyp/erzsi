import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['robots.txt', 'kasszas_erzsi_nobg.png'],
      manifest: {
        name: 'Kasszas Erzsi',
        short_name: 'Erzsi',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#c6132c',
        icons: [
          { src: 'kasszas_erzsi_nobg.png', sizes: '512x512', type: 'image/png' }
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // Activate new SW on next page load instead of waiting for all tabs
        // to close. Prevents stale bundles from masking newly deployed code
        // (which was hiding the T10V event in the admin events list).
        skipWaiting: true,
        clientsClaim: true,
        // Don't let workbox precache the index page itself — always fetch it
        // fresh so the <script> tag always points at the newest bundle hash.
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
