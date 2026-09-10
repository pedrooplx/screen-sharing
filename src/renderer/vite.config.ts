import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone config for running the renderer in a plain browser
// (`vite src/renderer`, used for visual work with `?mock`).
// The Electron build uses the `renderer` block in ../../electron.vite.config.ts.
export default defineConfig({
  plugins: [react()],
});
