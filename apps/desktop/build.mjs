// Bundle the Electron main process (and the host it embeds) into one CommonJS file, and put
// the licence notices next to it: the project's LICENSE, the npm packages in the bundle
// (THIRD_PARTY_LICENSES.txt), and Electron's and Chromium's licences.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { projectLicense, thirdPartyNotices } from '../../tools/licenses.mjs';

const result = await build({
  entryPoints: ['src/main.ts'],
  outfile: 'out/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
});

fs.writeFileSync('out/LICENSE', projectLicense());
fs.writeFileSync('out/THIRD_PARTY_LICENSES.txt', thirdPartyNotices(Object.keys(result.metafile.inputs), 'the GT Ball Drop desktop app'));

// Electron's own licence ships in its npm package; Chromium's comes with the downloaded
// binary (not present when ELECTRON_SKIP_BINARY_DOWNLOAD is set, e.g. in CI).
const electronDir = path.dirname(createRequire(import.meta.url).resolve('electron/package.json'));
fs.copyFileSync(path.join(electronDir, 'LICENSE'), 'out/LICENSE.electron.txt');
const chromium = path.join(electronDir, 'dist', 'LICENSES.chromium.html');
if (fs.existsSync(chromium)) fs.copyFileSync(chromium, 'out/LICENSES.chromium.html');
else console.warn('LICENSES.chromium.html not found (Electron binary not downloaded); a packaged app must include it.');
