import { defineConfig } from 'vite';

const hostPort = process.env.GTBD_HOST_PORT ?? '4290';

export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    proxy: { '/ui': { target: `ws://127.0.0.1:${hostPort}`, ws: true } },
  },
  build: { target: 'es2022' },
});
