import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import localDbPlugin from './server/localDbPlugin.mjs';
import chatPlugin from './server/chatPlugin.mjs';
import mapProxyPlugin from './server/mapProxyPlugin.mjs';
import sttPlugin from './server/sttPlugin.mjs';

export default defineConfig({
  plugins: [
    sttPlugin(),
    react(),
    localDbPlugin(),
    chatPlugin(),
    mapProxyPlugin()
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5173',
        changeOrigin: true,
        bypass: (req) => {
          const url = req.url || '';
          if (url.startsWith('/api')) {
            return url; // Bypass proxy for all /api endpoints to let Vite server plugins handle them in memory
          }
        }
      }
    }
  },
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  build: {
    // The PDF exporter is loaded only when a user explicitly exports a chat.
    chunkSizeWarningLimit: 1100,
  },
});

