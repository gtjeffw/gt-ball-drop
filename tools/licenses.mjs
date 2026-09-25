// Licence notices for build outputs: the project's LICENSE, plus the licence texts of every
// npm package that ends up in a bundle (THIRD_PARTY_LICENSES.txt). Used by the Vite builds
// (licenseNotices plugin) and the desktop build (apps/desktop/build.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

/** The npm package a bundled file belongs to, or null for the project's own files. */
export function packageOf(file) {
  const i = file.replace(/\\/g, '/').lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const parts = file
    .replace(/\\/g, '/')
    .slice(i + '/node_modules/'.length)
    .split('/');
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  const dir = file.replace(/\\/g, '/').slice(0, i) + '/node_modules/' + name;
  return { name, dir };
}

/** THIRD_PARTY_LICENSES.txt for the packages the given bundled files come from. */
export function thirdPartyNotices(files, product) {
  const packages = new Map();
  for (const f of files) {
    // Absolute paths (Vite) or relative to the working directory (esbuild's metafile).
    const p = packageOf(path.resolve(f.replace(/^\0/, '').split('?')[0]));
    if (p && !packages.has(p.name)) packages.set(p.name, p.dir);
  }
  const sections = [...packages]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, dir]) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const texts = fs
        .readdirSync(dir)
        .filter((f) => LICENSE_FILE.test(f))
        .sort()
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim());
      const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'unknown');
      const text = texts.length ? texts.join('\n\n') : `(no licence file in the package; package.json says ${license})`;
      return `${'='.repeat(78)}\n${name}@${pkg.version} (${license})\n${'='.repeat(78)}\n\n${text}\n`;
    });
  const head =
    `Third-party software included in ${product}.\n` +
    `GT Ball Drop itself is under the MIT License: see LICENSE.\n\n` +
    (sections.length ? `${sections.length} package${sections.length === 1 ? '' : 's'}: ${[...packages.keys()].sort().join(', ')}\n\n` : 'None.\n');
  return head + sections.join('\n');
}

export const projectLicense = () => fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');

/** Vite plugin: add LICENSE and THIRD_PARTY_LICENSES.txt to the build output. */
export function licenseNotices(product) {
  return {
    name: 'gtbd-license-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = new Set();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) files.add(id);
      }
      this.emitFile({ type: 'asset', fileName: 'LICENSE', source: projectLicense() });
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_LICENSES.txt', source: thirdPartyNotices(files, product) });
    },
  };
}
