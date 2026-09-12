import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is proxied so the browser makes same-origin requests. This keeps
    // EventSource working without CORS preflight complications on the stream.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split the renderer and the graph editor into their own chunks so the
        // app shell stays small and each is fetched only when first used.
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          flow: ['@xyflow/react'],
        },
      },
    },
  },
});
