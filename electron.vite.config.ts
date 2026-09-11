import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const root = import.meta.dirname;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve(root, 'src/main/index.ts'),
        // CommonJS, like the preload: an ESM main entry (the default under
        // the package's "type": "module") never actually executes when
        // loaded from inside an asar - Electron packaged builds silently
        // fail to run it (nothing past the first line, no error anywhere)
        // while the exact same file runs fine unpacked. Force .cjs so this
        // isn't type-dependent.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(root, 'src/preload/index.ts'),
        // sandboxed preload must be CommonJS; force a .cjs extension so it is
        // not treated as ESM under the package's "type": "module"
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') },
    },
  },
});
