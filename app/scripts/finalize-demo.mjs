#!/usr/bin/env node
// Post-build step for the static GitHub Pages demo (`npm run build:demo`).
//
// Vite writes `dist-demo/` and already rebases HTML asset URLs for the
// configured base. The files copied verbatim from `public/` are NOT rewritten
// by Vite, so this script:
//   1. prefixes the demo manifest's id/start_url/scope/icon URLs with the base,
//      keeping the demo installable without a broken root-absolute manifest;
//   2. removes the partner shell artifacts (the demo is writer-only);
//   3. writes `404.html` as an SPA fallback for deep links
//      (`/migraine-tracker/calendar` etc. on GitHub Pages).
//
// It never touches production `dist/`. No network, no dependencies.

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_DIR = join(APP_ROOT, 'dist-demo');
const DEFAULT_BASE = '/migraine-tracker/';

function normalizeBase(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_BASE;
  if (value === '/') return '/';
  return `/${value.replace(/^\/+|\/+$/g, '')}/`;
}

const base = normalizeBase(process.env.VITE_BASE);
const indexPath = join(DIST_DIR, 'index.html');

if (!existsSync(indexPath)) {
  console.error(`Demo finalize failed: ${indexPath} does not exist (run the Vite build first).`);
  process.exit(1);
}

// 1. SPA fallback: GitHub Pages serves this for any unknown path.
copyFileSync(indexPath, join(DIST_DIR, '404.html'));

// 2. The demo is writer-only: never ship the partner shell or its manifest.
for (const stale of ['view.html', 'partner.webmanifest']) {
  rmSync(join(DIST_DIR, stale), { force: true });
}

// 3. Rebase the copied manifest, which Vite cannot rewrite.
const manifestPath = join(DIST_DIR, 'manifest.webmanifest');
if (!existsSync(manifestPath)) {
  console.error(`Demo finalize failed: missing ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.id = base;
manifest.start_url = base;
manifest.scope = base;
manifest.name = 'Migraine Tracker Demo';
manifest.short_name = 'Migraine Demo';
manifest.description =
  'Interactive demo of Migraine Tracker with fictional sample data. '
  + 'Nothing is saved and no server is contacted.';
manifest.icons = (Array.isArray(manifest.icons) ? manifest.icons : []).map((icon) => ({
  ...icon,
  src: `${base}${String(icon.src).replace(/^\/+/, '')}`,
}));
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Demo finalized for base ${base}`);
console.log('  wrote 404.html (SPA fallback)');
console.log('  removed partner shell artifacts');
console.log('  rebased manifest id/start_url/scope/icons');
