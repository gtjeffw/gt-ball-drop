import { defineConfig } from 'vite';

// In dev the participant host runs separately (npm run dev:participant) and Vite proxies
// the UI link to it. In production the host serves the built files itself.
const hostPort = process.env.GTBD_HOST_PORT ?? '4280';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/ui': { target: `ws://127.0.0.1:${hostPort}`, ws: true } },
  },
  build: { target: 'es2022' },
});
