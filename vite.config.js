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
      },
    }),
  ],
});
