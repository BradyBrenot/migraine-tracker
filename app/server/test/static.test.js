// Static SPA fallback, /api 404 behavior with and without dist/, and
// health. The app factory must work when dist/ is absent (tests, CI).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../app.js';
import { openDatabase } from '../db.js';
import { makeTempDir, cleanupDir } from './helpers.js';

// Runs fn with a database in a fresh temp dir; the db (and dir) are always
// released, even when assertions fail.
async function withDb(label, fn) {
  const dir = makeTempDir(label);
  const db = openDatabase(join(dir, 'data'), { log: () => {} });
  try {
    return await fn(dir, db);
  } finally {
    try {
      db.close();
    } catch {
      // already closed via app.close()
    }
    cleanupDir(dir);
  }
}

test('health endpoint reports ok', async () => {
  await withDb('migraine-health', async (_dir, db) => {
    const app = await buildApp({ db });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    await app.close();
  });
});

test('without dist/: unknown routes (including /api) get plain JSON 404s', async () => {
  await withDb('migraine-nodist', async (dir, db) => {
    const app = await buildApp({ db, distDir: join(dir, 'does-not-exist') });
    const api = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    assert.equal(api.statusCode, 404);
    // no dist → no custom not-found handler → Fastify's default JSON 404
    assert.equal(api.json().statusCode, 404);
    assert.equal(api.headers['content-type'], 'application/json; charset=utf-8');
    const apiPost = await app.inject({ method: 'POST', url: '/api/nonexistent', payload: {} });
    assert.equal(apiPost.statusCode, 404);
    const root = await app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 404);
    await app.close();
  });
});

test('with dist/: SPA fallback serves index.html for non-API GETs, /api stays JSON', async () => {
  await withDb('migraine-static', async (dir, db) => {
    const distDir = join(dir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>app</title>');

    const app = await buildApp({ db, distDir });
    const root = await app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 200);
    assert.match(root.body, /<title>app<\/title>/);
    const deep = await app.inject({ method: 'GET', url: '/history/deep/link' });
    assert.equal(deep.statusCode, 200);
    assert.match(deep.body, /<title>app<\/title>/);
    const api = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    assert.equal(api.statusCode, 404);
    assert.deepEqual(api.json(), { error: 'not found' });
    // real API routes still work alongside static
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    await app.close();
  });
});

// @fastify/static guards its wildcard route against path traversal. These
// encoded forms are the historical bypass shapes (encoded dots, encoded
// separators, double encoding, and case variants for case-insensitive
// filesystems). The sentinel lives OUTSIDE the served root, so any body that
// contains it proves the guard failed.
const TRAVERSAL_URLS = [
  '/%2e%2e/secret.txt',
  '/%2e%2e%2fsecret.txt',
  '/%2e%2e%5csecret.txt',
  '/..%2fsecret.txt',
  '/..%5csecret.txt',
  '/assets/%2e%2e/%2e%2e/secret.txt',
  '/%252e%252e/secret.txt',
  '/%2E%2E/secret.txt',
];
const SENTINEL = 'TOP-SECRET-SENTINEL';

test('with dist/: encoded traversal never serves files outside the static root', async () => {
  await withDb('migraine-traversal', async (dir, db) => {
    const distDir = join(dir, 'dist');
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("asset")');
    // Deliberately outside dist/, i.e. outside the @fastify/static root.
    writeFileSync(join(dir, 'secret.txt'), SENTINEL);

    const app = await buildApp({ db, distDir });

    // Baseline: real static assets are still served from dist/.
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.body, 'console.log("asset")');

    for (const url of TRAVERSAL_URLS) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(
        res.body.includes(SENTINEL),
        false,
        `${url} leaked a file outside the static root: ${res.body.slice(0, 120)}`,
      );
      if (res.statusCode === 200) {
        // Safe 200 is only the SPA fallback document, never the sentinel.
        assert.match(res.body, /<title>app<\/title>/, `${url} served a non-SPA 200`);
      } else {
        // 400/403/404 are all safe refusals for a traversal-shaped path.
        assert.ok(
          [400, 403, 404].includes(res.statusCode),
          `${url} returned an unexpected status ${res.statusCode}`,
        );
      }
    }

    // The SPA fallback and API boundary are unchanged by the guard.
    const deep = await app.inject({ method: 'GET', url: '/history/deep/link' });
    assert.equal(deep.statusCode, 200);
    assert.match(deep.body, /<title>app<\/title>/);
    const api = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    assert.equal(api.statusCode, 404);
    assert.deepEqual(api.json(), { error: 'not found' });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);

    await app.close();
  });
});
