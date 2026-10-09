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

function fixQpdfResizableMemoryDecode() {
  return {
    name: 'fix-qpdf-resizable-memory-decode',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').includes('/pdfstudio/dist/wasm/qpdf.js')) return null;
      const original = 'UTF8Decoder.decode(heapOrArray.subarray(idx,endPtr))';
      if (!code.includes(original)) throw new Error('pdfstudio qpdf decoder changed; review the compatibility fix.');
      // Chromium rejects a TextDecoder view backed by growable WASM memory.
      return code.replace(original, 'UTF8Decoder.decode(Uint8Array.from(heapOrArray.subarray(idx,endPtr)))');
    }
  };
}

export default defineConfig(({ command }) => ({
  plugins: [fixQpdfResizableMemoryDecode(), react(), copyPdfJsSupportAssets()],
  // Vite dev keeps the normal web root; packaged Electron loads file:// URLs.
  base: command === 'build' ? './' : '/',
  // Load the API directly, just like its worker URL, to avoid stale prebundles
  // mixing PDF.js versions after node_modules is restored or updated.
  optimizeDeps: { exclude: ['pdfjs-dist', 'pdfstudio'] },
  worker: { format: 'es' },
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
