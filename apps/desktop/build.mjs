// Bundle the Electron main process (and the host it embeds) into one CommonJS file.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'out/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
  logLevel: 'info',
});
