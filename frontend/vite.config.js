import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Load the API directly, just like its worker URL, to avoid stale prebundles
  // mixing PDF.js versions after node_modules is restored or updated.
  optimizeDeps: { exclude: ['pdfjs-dist'] },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
});
