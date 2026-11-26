import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: false },
  preview: { port: 4317, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1600
  }
});
