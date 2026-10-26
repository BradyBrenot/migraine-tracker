// Installable-shell checks: the manifest, its icon files, and the mobile-web
// metadata in index.html. Deliberately node-environment (like shared/sync.test)
// and disk-only — no jsdom, no network, no service worker, no build required
// (the dist assertions are skipped until `npm run build` has produced a dist/).
/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(APP_ROOT, 'public');
const DIST_DIR = join(APP_ROOT, 'dist');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description?: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

function readManifest(file: string): WebManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as WebManifest;
}

/** Verifies the PNG signature and reads the IHDR width/height. */
function pngDimensions(file: string): { width: number; height: number } {
  const png = readFileSync(file);
  expect(png.length).toBeGreaterThan(0);
  expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const manifest = readManifest(join(PUBLIC_DIR, 'manifest.webmanifest'));
const partnerManifest = readManifest(join(PUBLIC_DIR, 'partner.webmanifest'));

describe('web app manifest', () => {
  it('is app-scoped and installable', () => {
    expect(manifest.id).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.name).toBe('Migraine Tracker');
    expect(manifest.short_name).toBe('Migraine');
    expect(manifest.display).toBe('standalone');
    // Matches the shell's outer slate-950 background.
    expect(manifest.background_color).toBe('#020617');
    expect(manifest.theme_color).toBe('#020617');
  });

  it('declares 192/512 PNG icons and a maskable icon', () => {
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(true);
      expect(icon.src.endsWith('.png')).toBe(true);
      expect(icon.type).toBe('image/png');
    }
    const purposes = manifest.icons.map((icon) => icon.purpose ?? 'any');
    expect(purposes.some((purpose) => purpose.split(' ').includes('maskable'))).toBe(true);
  });

  it('points every icon at a real PNG with matching IHDR dimensions', () => {
    for (const icon of manifest.icons) {
      const { width, height } = pngDimensions(join(PUBLIC_DIR, icon.src));
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });
});

describe('partner web app manifest', () => {
  it('is /view-scoped and installs as a distinct read-only app', () => {
    expect(partnerManifest.id).toBe('/view');
    expect(partnerManifest.start_url).toBe('/view');
    expect(partnerManifest.scope).toBe('/view');
    expect(partnerManifest.name).toBe('Migraine Partner');
    expect(partnerManifest.short_name).toBe('Partner');
    expect(typeof partnerManifest.description).toBe('string');
    expect(partnerManifest.description!.trim().length).toBeGreaterThan(0);
    expect(partnerManifest.display).toBe('standalone');
    expect(partnerManifest.background_color).toBe('#020617');
    expect(partnerManifest.theme_color).toBe('#020617');
  });

  it('reuses the writer icons exactly', () => {
    expect(partnerManifest.icons).toEqual(manifest.icons);
  });

  it('points every icon at a real PNG with matching IHDR dimensions', () => {
    for (const icon of partnerManifest.icons) {
      const { width, height } = pngDimensions(join(PUBLIC_DIR, icon.src));
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });
});

describe('index.html mobile-web metadata', () => {
  const html = readFileSync(join(APP_ROOT, 'index.html'), 'utf8');

  it('links the root-absolute manifest and dark theme colour', () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).not.toContain('href="/partner.webmanifest"');
    expect(html).toContain('name="theme-color" content="#020617"');
    expect(html).toContain('viewport-fit=cover');
  });

  it('keeps the app title and entry script', () => {
    expect(html).toContain('<title>Migraine Tracker</title>');
    expect(html).toContain('src="/src/main.tsx"');
  });
});

describe('view.html partner shell metadata', () => {
  const html = readFileSync(join(APP_ROOT, 'view.html'), 'utf8');

  it('links the partner manifest and never the writer manifest', () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/partner.webmanifest"');
    expect(html).not.toContain('href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color" content="#020617"');
    expect(html).toContain('viewport-fit=cover');
  });

  it('keeps the partner title and the shared entry script', () => {
    expect(html).toContain('<title>Migraine Partner</title>');
    expect(html).toContain('src="/src/main.tsx"');
  });
});

describe('built output (only when dist/ exists)', () => {
  const distIndex = join(DIST_DIR, 'index.html');
  const distManifest = join(DIST_DIR, 'manifest.webmanifest');
  const built = existsSync(distIndex) && existsSync(distManifest);

  it.skipIf(!built)('copies the source manifest into dist', () => {
    expect(readManifest(distManifest)).toEqual(manifest);
  });

  it.skipIf(!built)('uses root-absolute asset URLs that survive deep links', () => {
    const html = readFileSync(distIndex, 'utf8');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toMatch(/(?:src|href)="\/assets\//);
    expect(html).not.toContain('"./assets/');
  });

  it.skipIf(!built)('ships every declared icon', () => {
    for (const icon of manifest.icons) {
      const { width, height } = pngDimensions(join(DIST_DIR, icon.src));
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });

  it.skipIf(!built)('copies the source partner manifest into dist', () => {
    // readFileSync throws when a stale dist/ lacks the partner manifest.
    expect(readManifest(join(DIST_DIR, 'partner.webmanifest'))).toEqual(partnerManifest);
  });

  it.skipIf(!built)('serves the partner shell for /view from dist', () => {
    const html = readFileSync(join(DIST_DIR, 'view.html'), 'utf8');
    expect(html).toContain('href="/partner.webmanifest"');
    expect(html).not.toContain('href="/manifest.webmanifest"');
    expect(html).toMatch(/(?:src|href)="\/assets\//);
    expect(html).not.toContain('"./assets/');
    expect(html).not.toContain('src="/src/');
  });

  it.skipIf(!built)('ships every partner icon', () => {
    for (const icon of partnerManifest.icons) {
      const { width, height } = pngDimensions(join(DIST_DIR, icon.src));
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });
});
