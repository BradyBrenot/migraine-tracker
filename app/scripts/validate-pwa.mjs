#!/usr/bin/env node
// Standalone, dependency-free validator for the installable-app shell.
//
// Checks the SOURCE (app/public + app/index.html) always, and the BUILT output
// (app/dist) when it exists — run `npm run build` first for the full check.
// Exits non-zero on any failure. No network, no service worker, no npm deps.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(APP_ROOT, 'public');
const DIST_DIR = join(APP_ROOT, 'dist');

const BACKGROUND = '#020617';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

function readJson(file, label) {
  if (!existsSync(file)) {
    fail(`${label}: missing ${file}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label}: invalid JSON in ${file} (${error.message})`);
    return null;
  }
}

/** Returns { width, height } or null after recording a failure. */
function pngSize(file, label, declared) {
  if (!existsSync(file)) {
    fail(`${label}: missing file ${file}`);
    return null;
  }
  const png = readFileSync(file);
  if (png.length === 0) {
    fail(`${label}: ${file} is empty`);
    return null;
  }
  const signature = [...png.subarray(0, 8)];
  if (signature.join(',') !== PNG_SIGNATURE.join(',')) {
    fail(`${label}: ${file} is not a PNG (bad signature)`);
    return null;
  }
  if (png.subarray(12, 16).toString('ascii') !== 'IHDR') {
    fail(`${label}: ${file} has no leading IHDR chunk`);
    return null;
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (declared && `${width}x${height}` !== declared) {
    fail(`${label}: ${file} is ${width}x${height} but the manifest declares ${declared}`);
  }
  return { width, height };
}

function validateManifest(manifest, label, expected = {}) {
  if (!manifest) return;
  const id = expected.id ?? '/';
  const startUrl = expected.start_url ?? '/';
  const scope = expected.scope ?? '/';
  check(manifest.id === id, `${label}: id must be ${JSON.stringify(id)} (got ${JSON.stringify(manifest.id)})`);
  check(
    manifest.start_url === startUrl,
    `${label}: start_url must be ${JSON.stringify(startUrl)} (got ${JSON.stringify(manifest.start_url)})`,
  );
  check(
    manifest.scope === scope,
    `${label}: scope must be ${JSON.stringify(scope)} (got ${JSON.stringify(manifest.scope)})`,
  );
  if (expected.name !== undefined) {
    check(
      manifest.name === expected.name,
      `${label}: name must be ${JSON.stringify(expected.name)} (got ${JSON.stringify(manifest.name)})`,
    );
  } else {
    check(
      typeof manifest.name === 'string' && manifest.name.trim().length > 0,
      `${label}: name is required`,
    );
  }
  if (expected.short_name !== undefined) {
    check(
      manifest.short_name === expected.short_name,
      `${label}: short_name must be ${JSON.stringify(expected.short_name)} (got ${JSON.stringify(manifest.short_name)})`,
    );
  } else {
    check(
      typeof manifest.short_name === 'string' && manifest.short_name.trim().length > 0,
      `${label}: short_name is required`,
    );
  }
  if (expected.requireDescription) {
    check(
      typeof manifest.description === 'string' && manifest.description.trim().length > 0,
      `${label}: description is required`,
    );
  }
  check(manifest.display === 'standalone', `${label}: display must be "standalone"`);
  check(
    manifest.background_color === BACKGROUND,
    `${label}: background_color must be ${BACKGROUND}`,
  );
  check(manifest.theme_color === BACKGROUND, `${label}: theme_color must be ${BACKGROUND}`);

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  check(icons.length > 0, `${label}: at least one icon is required`);
  const sizes = icons.map((icon) => icon.sizes);
  check(sizes.includes('192x192'), `${label}: a 192x192 icon is required`);
  check(sizes.includes('512x512'), `${label}: a 512x512 icon is required`);
  const purposes = icons.flatMap((icon) => String(icon.purpose ?? 'any').split(/\s+/));
  check(purposes.includes('maskable'), `${label}: a maskable icon is required`);

  for (const icon of icons) {
    check(
      typeof icon.src === 'string' && icon.src.startsWith('/'),
      `${label}: icon src must be root-absolute (got ${JSON.stringify(icon.src)})`,
    );
    check(
      icon.type === 'image/png' && String(icon.src).endsWith('.png'),
      `${label}: icon ${icon.src} must be a PNG`,
    );
    if (!/^\d+x\d+$/.test(String(icon.sizes))) {
      fail(`${label}: icon ${icon.src} has an invalid sizes value ${JSON.stringify(icon.sizes)}`);
    }
  }
}

function validateIcons(manifest, root, label) {
  if (!manifest || !Array.isArray(manifest.icons)) return [];
  return manifest.icons.map((icon) => {
    const src = String(icon.src).replace(/^\/+/, '');
    const declared = /^\d+x\d+$/.test(String(icon.sizes)) ? icon.sizes : null;
    const size = pngSize(join(root, src), `${label} icon ${icon.src}`, declared);
    return size ? `${icon.src} ${size.width}x${size.height} (${icon.purpose ?? 'any'})` : null;
  });
}

const PARTNER_IDENTITY = {
  id: '/view',
  start_url: '/view',
  scope: '/view',
  name: 'Migraine Partner',
  short_name: 'Partner',
};

function validateIndex(html, label, options = {}) {
  const manifestHref = options.manifestHref ?? '/manifest.webmanifest';
  const escapedHref = manifestHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  check(
    new RegExp(`<link[^>]+rel="manifest"[^>]+href="${escapedHref}"`).test(html) ||
      new RegExp(`<link[^>]+href="${escapedHref}"[^>]+rel="manifest"`).test(html),
    `${label}: missing root-absolute manifest link`,
  );
  if (options.forbiddenHref) {
    check(
      !html.includes(`href="${options.forbiddenHref}"`),
      `${label}: must not link ${options.forbiddenHref}`,
    );
  }
  if (options.title) {
    check(html.includes(`<title>${options.title}</title>`), `${label}: title must be ${options.title}`);
  }
  check(html.includes(`name="theme-color" content="${BACKGROUND}"`), `${label}: theme-color`);
  check(html.includes('viewport-fit=cover'), `${label}: viewport-fit=cover`);
  check(/<link[^>]+rel="apple-touch-icon"[^>]+href="\/[^"]+"/.test(html), `${label}: apple-touch-icon`);
}

console.log('PWA validation');
console.log(`  source root: ${APP_ROOT}`);

// ── source: manifest + icons ──────────────────────────────────────────
const sourceManifestFile = join(PUBLIC_DIR, 'manifest.webmanifest');
const sourceManifest = readJson(sourceManifestFile, 'source manifest');
console.log('  source manifest: public/manifest.webmanifest');
validateManifest(sourceManifest, 'source manifest');
if (sourceManifest) {
  console.log(
    `    id=${sourceManifest.id} start_url=${sourceManifest.start_url} ` +
      `scope=${sourceManifest.scope} display=${sourceManifest.display}`,
  );
  console.log(
    `    name="${sourceManifest.name}" short_name="${sourceManifest.short_name}" ` +
      `background=${sourceManifest.background_color} theme=${sourceManifest.theme_color}`,
  );
}

const sourceIcons = validateIcons(sourceManifest, PUBLIC_DIR, 'source');
console.log('  source icons:');
for (const line of sourceIcons) console.log(`    ${line ?? 'FAILED'}`);

// ── source: partner manifest + icons ──────────────────────────────────
const sourcePartnerFile = join(PUBLIC_DIR, 'partner.webmanifest');
const sourcePartner = readJson(sourcePartnerFile, 'source partner manifest');
console.log('  source partner manifest: public/partner.webmanifest');
validateManifest(sourcePartner, 'source partner manifest', {
  ...PARTNER_IDENTITY,
  requireDescription: true,
});
if (sourcePartner) {
  console.log(
    `    id=${sourcePartner.id} start_url=${sourcePartner.start_url} ` +
      `scope=${sourcePartner.scope} display=${sourcePartner.display}`,
  );
  console.log(
    `    name="${sourcePartner.name}" short_name="${sourcePartner.short_name}" ` +
      `background=${sourcePartner.background_color} theme=${sourcePartner.theme_color}`,
  );
  check(
    sourceManifest !== null &&
      JSON.stringify(sourcePartner.icons) === JSON.stringify(sourceManifest.icons),
    'source partner manifest: icons must match public/manifest.webmanifest',
  );
}

const sourcePartnerIcons = validateIcons(sourcePartner, PUBLIC_DIR, 'source partner');
console.log('  source partner icons:');
for (const line of sourcePartnerIcons) console.log(`    ${line ?? 'FAILED'}`);

// ── source: index.html metadata ───────────────────────────────────────
const sourceIndexFile = join(APP_ROOT, 'index.html');
if (existsSync(sourceIndexFile)) {
  validateIndex(readFileSync(sourceIndexFile, 'utf8'), 'source index.html', {
    forbiddenHref: '/partner.webmanifest',
  });
  console.log('  source index.html: manifest link, theme-color, viewport-fit=cover');
} else {
  fail(`source index.html: missing ${sourceIndexFile}`);
}

// ── source: partner shell (view.html) ─────────────────────────────────
const sourceViewFile = join(APP_ROOT, 'view.html');
if (existsSync(sourceViewFile)) {
  validateIndex(readFileSync(sourceViewFile, 'utf8'), 'source view.html', {
    manifestHref: '/partner.webmanifest',
    forbiddenHref: '/manifest.webmanifest',
    title: 'Migraine Partner',
  });
  console.log('  source view.html: partner manifest link, theme-color, viewport-fit=cover');
} else {
  fail(`source view.html: missing ${sourceViewFile}`);
}

// ── built output (optional) ───────────────────────────────────────────
const distIndexFile = join(DIST_DIR, 'index.html');
const distManifestFile = join(DIST_DIR, 'manifest.webmanifest');
const distPartnerManifestFile = join(DIST_DIR, 'partner.webmanifest');
const distBuilt = existsSync(distIndexFile) || existsSync(distManifestFile) || existsSync(distPartnerManifestFile);

if (!distBuilt) {
  console.log('  built dist: not present — skipping dist checks (run `npm run build`)');
} else {
  console.log('  built dist: dist/');
  const distManifest = readJson(distManifestFile, 'dist manifest');
  if (distManifest && sourceManifest) {
    check(
      JSON.stringify(distManifest) === JSON.stringify(sourceManifest),
      'dist manifest: does not match public/manifest.webmanifest',
    );
    validateManifest(distManifest, 'dist manifest');
  }

  const distIcons = validateIcons(distManifest, DIST_DIR, 'dist');
  for (const line of distIcons) console.log(`    ${line ?? 'FAILED'}`);

  // The partner files are produced only by a current build; with dist/
  // present these are required (a missing file means a stale build).
  const distPartner = readJson(distPartnerManifestFile, 'dist partner manifest');
  if (distPartner && sourcePartner) {
    check(
      JSON.stringify(distPartner) === JSON.stringify(sourcePartner),
      'dist partner manifest: does not match public/partner.webmanifest',
    );
  }
  const distPartnerIcons = validateIcons(distPartner, DIST_DIR, 'dist partner');
  for (const line of distPartnerIcons) console.log(`    ${line ?? 'FAILED'}`);

  if (existsSync(distIndexFile)) {
    const html = readFileSync(distIndexFile, 'utf8');
    validateIndex(html, 'dist index.html', { forbiddenHref: '/partner.webmanifest' });
    check(
      /(?:src|href)="\/assets\//.test(html),
      'dist index.html: asset URLs must be root-absolute (/assets/...)',
    );
    check(
      !html.includes('"./assets/'),
      'dist index.html: found relative ./assets/ URLs (base must be "/")',
    );
    check(
      !html.includes('src="/src/'),
      'dist index.html: unbundled /src/ entry script left in the build',
    );
    console.log('    dist index.html: root-absolute /assets/ URLs');
  }

  const distViewFile = join(DIST_DIR, 'view.html');
  if (existsSync(distViewFile)) {
    const html = readFileSync(distViewFile, 'utf8');
    validateIndex(html, 'dist view.html', {
      manifestHref: '/partner.webmanifest',
      forbiddenHref: '/manifest.webmanifest',
      title: 'Migraine Partner',
    });
    check(
      /(?:src|href)="\/assets\//.test(html),
      'dist view.html: asset URLs must be root-absolute (/assets/...)',
    );
    check(
      !html.includes('"./assets/'),
      'dist view.html: found relative ./assets/ URLs (base must be "/")',
    );
    check(
      !html.includes('src="/src/'),
      'dist view.html: unbundled /src/ entry script left in the build',
    );
    console.log('    dist view.html: root-absolute /assets/ URLs');
  } else {
    fail(`dist view.html: missing ${distViewFile} (stale build — run \`npm run build\`)`);
  }
}

// ── result ────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nPWA validation FAILED (${failures.length} of ${checks} checks)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\nPWA validation passed (${checks} checks)`);
}
