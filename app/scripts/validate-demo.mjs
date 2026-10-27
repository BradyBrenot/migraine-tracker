#!/usr/bin/env node
// Dependency-free validator for the static demo artifact (`app/dist-demo`).
//
// Run after `npm run build:demo`. It fails when the artifact is missing, when
// the build is actually production (no demo marker/title), when an asset or
// manifest URL escapes the configured base, when the SPA fallback/partner
// policy is broken, or when the mobile demo disclosure did not ship.
// No network, no service worker, no npm dependencies.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_DIR = join(APP_ROOT, 'dist-demo');
const DEFAULT_BASE = '/migraine-tracker/';
const BANNER_COPY = 'Do not enter real health information';

function normalizeBase(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_BASE;
  if (value === '/') return '/';
  return `/${value.replace(/^\/+|\/+$/g, '')}/`;
}

const base = normalizeBase(process.env.VITE_BASE);
const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function fail(message) {
  checks += 1;
  failures.push(message);
}

function read(file, label) {
  if (!existsSync(file)) {
    fail(`${label}: missing ${relative(APP_ROOT, file)}`);
    return null;
  }
  return readFileSync(file, 'utf8');
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/** Every src/href value in an HTML document. */
function htmlUrls(html) {
  const urls = [];
  const re = /(?:src|href)="([^"]*)"/g;
  let match;
  while ((match = re.exec(html)) !== null) urls.push(match[1]);
  return urls;
}

function isExternal(url) {
  return (
    url === ''
    || url.startsWith('#')
    || url.startsWith('//')
    || /^[a-z][a-z0-9+.-]*:/i.test(url)
  );
}

/** Assert local URLs stay under the configured base and exist on disk. */
function validateLocalUrls(html, label) {
  let underBase = 0;
  for (const url of htmlUrls(html)) {
    if (isExternal(url)) continue;
    if (!url.startsWith(base)) {
      fail(`${label}: URL ${JSON.stringify(url)} is not under the demo base ${JSON.stringify(base)}`);
      continue;
    }
    underBase += 1;
    const target = url.slice(base.length).split(/[?#]/)[0];
    if (target === '') continue;
    check(
      existsSync(join(DIST_DIR, target)),
      `${label}: referenced file ${target} does not exist in dist-demo`,
    );
  }
  check(underBase > 0, `${label}: expected base-prefixed assets`);
}

console.log('Demo validation');
console.log(`  artifact: ${relative(APP_ROOT, DIST_DIR)}/`);
console.log(`  base: ${base}`);

const indexFile = join(DIST_DIR, 'index.html');
const indexHtml = read(indexFile, 'demo index.html');
if (!indexHtml) {
  // Without the entry document there is nothing meaningful to validate.
  console.error(`\nDemo validation FAILED (${failures.length} of ${checks} checks)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

// ── demo marker / not production ───────────────────────────────────
check(
  /<meta[^>]+name="migraine-demo"[^>]+content="true"/.test(indexHtml),
  'demo index.html: missing the `migraine-demo` build marker meta tag',
);
check(
  indexHtml.includes('<title>Migraine Tracker Demo</title>'),
  'demo index.html: title must be "Migraine Tracker Demo"',
);
check(
  indexHtml.includes('fictional sample data'),
  'demo index.html: description must identify the synthetic demo',
);
check(!indexHtml.includes('src="/src/'), 'demo index.html: unbundled /src/ entry script');

// ── manifest link + base-prefixed assets ───────────────────────────
const manifestLink = indexHtml.match(/<link[^>]+rel="manifest"[^>]*>/);
const manifestHref = manifestLink?.[0].match(/href="([^"]+)"/)?.[1] ?? null;
check(
  manifestHref === `${base}manifest.webmanifest`,
  `demo index.html: manifest link must be ${JSON.stringify(`${base}manifest.webmanifest`)} `
  + `(got ${JSON.stringify(manifestHref)})`,
);
check(
  new RegExp(`(?:src|href)="${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}assets/`).test(indexHtml),
  'demo index.html: expected base-prefixed /assets/ URLs',
);
check(indexHtml.includes('viewport-fit=cover'), 'demo index.html: viewport-fit=cover');
check(indexHtml.includes('name="theme-color" content="#020617"'), 'demo index.html: theme-color');
validateLocalUrls(indexHtml, 'demo index.html');

// ── SPA fallback ───────────────────────────────────────────────────
const fallbackFile = join(DIST_DIR, '404.html');
const fallbackHtml = read(fallbackFile, 'demo 404.html (SPA fallback)');
if (fallbackHtml !== null) {
  check(
    fallbackHtml === indexHtml,
    'demo 404.html: must be an exact copy of index.html (SPA fallback)',
  );
  check(fallbackHtml.includes('id="root"'), 'demo 404.html: missing the app mount point');
}

// ── writer-only: no partner shell / manifest ───────────────────────
for (const partnerFile of ['view.html', 'partner.webmanifest']) {
  check(
    !existsSync(join(DIST_DIR, partnerFile)),
    `demo artifact: ${partnerFile} must not be shipped (writer-only demo)`,
  );
}
check(!indexHtml.includes('partner.webmanifest'), 'demo index.html: must not link the partner manifest');

// ── generated manifest ─────────────────────────────────────────────
const manifestFile = join(DIST_DIR, 'manifest.webmanifest');
const manifestText = read(manifestFile, 'demo manifest');
if (manifestText !== null) {
  let manifest = null;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    fail(`demo manifest: invalid JSON (${error.message})`);
  }
  if (manifest) {
    check(manifest.id === base, `demo manifest: id must be ${JSON.stringify(base)} (got ${JSON.stringify(manifest.id)})`);
    check(
      manifest.start_url === base,
      `demo manifest: start_url must be ${JSON.stringify(base)} (got ${JSON.stringify(manifest.start_url)})`,
    );
    check(
      manifest.scope === base,
      `demo manifest: scope must be ${JSON.stringify(base)} (got ${JSON.stringify(manifest.scope)})`,
    );
    check(
      typeof manifest.name === 'string' && /demo/i.test(manifest.name),
      'demo manifest: name must identify the demo (production marker leaked?)',
    );
    check(manifest.display === 'standalone', 'demo manifest: display must be "standalone"');
    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    check(icons.length > 0, 'demo manifest: at least one icon is required');
    for (const icon of icons) {
      check(
        typeof icon.src === 'string' && icon.src.startsWith(base),
        `demo manifest: icon ${JSON.stringify(icon.src)} must be under ${JSON.stringify(base)}`,
      );
      check(
        icon.type === 'image/png' && String(icon.src).endsWith('.png'),
        `demo manifest: icon ${JSON.stringify(icon.src)} must be a PNG`,
      );
      if (typeof icon.src === 'string' && icon.src.startsWith(base)) {
        check(
          existsSync(join(DIST_DIR, icon.src.slice(base.length))),
          `demo manifest: icon file ${icon.src.slice(base.length)} is missing`,
        );
      }
    }
  }
}

// ── disclosure copy actually shipped ───────────────────────────────
const scripts = listFiles(join(DIST_DIR, 'assets')).filter((file) => file.endsWith('.js'));
check(scripts.length > 0, 'demo assets: no JavaScript bundles found');
const bundle = scripts.map((file) => readFileSync(file, 'utf8')).join('\n');
check(
  bundle.includes(BANNER_COPY),
  `demo assets: missing the persistent demo disclosure (${JSON.stringify(BANNER_COPY)})`,
);

if (failures.length > 0) {
  console.error(`\nDemo validation FAILED (${failures.length} of ${checks} checks)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\nDemo validation passed (${checks} checks)`);
}
