import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // the laser server (npm run dev:server) is reached through the same address as the app, so the browser's Origin matches
  server: { port: 5174, fs: { allow: ['..'] }, proxy: { '/ws': { target: 'http://127.0.0.1:8090', ws: true } } },
});
