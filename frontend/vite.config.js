import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

function copyPdfJsSupportAssets() {
  let outputDirectory = path.join(configDirectory, 'dist');

  return {
    name: 'copy-pdfjs-support-assets',
    apply: 'build',
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const sourceRoot = path.join(configDirectory, 'node_modules', 'pdfjs-dist');
      const targetRoot = path.join(outputDirectory, 'pdfjs');

      for (const directoryName of ['cmaps', 'standard_fonts']) {
        const source = path.join(sourceRoot, directoryName);
        if (!existsSync(source)) {
          throw new Error(`PDF.js support assets were not found: ${source}`);
        }
        cpSync(source, path.join(targetRoot, directoryName), { recursive: true });
      }
    }
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), copyPdfJsSupportAssets()],
  // Vite dev keeps the normal web root; packaged Electron loads file:// URLs.
  base: command === 'build' ? './' : '/',
  // Load the API directly, just like its worker URL, to avoid stale prebundles
  // mixing PDF.js versions after node_modules is restored or updated.
  optimizeDeps: { exclude: ['pdfjs-dist'] },
  server: {
    port: 5173,
    open: false,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
}));
