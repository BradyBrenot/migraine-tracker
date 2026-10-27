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

const NO_NOTIFICATIONS = {
  ok: true,
  notifications: { reminders: false, attackAlerts: false },
};

/** Inject GET /api/health into a fresh app and return the parsed body. */
async function healthFor(label, notificationStatus) {
  return withDb(label, async (_dir, db) => {
    const app = await buildApp({ db, notificationStatus });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(res.statusCode, 200);
      return res.json();
    } finally {
      await app.close();
    }
  });
}

test('health endpoint reports ok and defaults notification flags to false', async () => {
  assert.deepEqual(await healthFor('migraine-health'), NO_NOTIFICATIONS);
});

test('health: reminders-only, attack-only, and both configurations', async () => {
  assert.deepEqual(
    await healthFor('migraine-health-reminders', { reminders: true, attackAlerts: false }),
    { ok: true, notifications: { reminders: true, attackAlerts: false } },
  );
  assert.deepEqual(
    await healthFor('migraine-health-attacks', { reminders: false, attackAlerts: true }),
    { ok: true, notifications: { reminders: false, attackAlerts: true } },
  );
  assert.deepEqual(
    await healthFor('migraine-health-both', { reminders: true, attackAlerts: true }),
    { ok: true, notifications: { reminders: true, attackAlerts: true } },
  );
});

test('health: malformed or partial status falls back to false', async () => {
  assert.deepEqual(
    await healthFor('migraine-health-garbage', { reminders: 'yes', attackAlerts: 1 }),
    NO_NOTIFICATIONS,
  );
  assert.deepEqual(
    await healthFor('migraine-health-partial', { reminders: true }),
    { ok: true, notifications: { reminders: true, attackAlerts: false } },
  );
});

test('health: never echoes ntfy URLs, tokens, or reasons', async () => {
  const body = await healthFor('migraine-health-secrets', {
    reminders: true,
    attackAlerts: false,
    ntfyUrl: 'https://ntfy.example.invalid/attack-secret-topic',
    ntfyToken: 'tk_fake_attack_secret_xyz789',
    reason: 'NTFY_ATTACK_URL is not set',
  });

  assert.deepEqual(body, {
    ok: true,
    notifications: { reminders: true, attackAlerts: false },
  });
  const text = JSON.stringify(body);
  for (const secret of [
    'ntfy.example.invalid',
    'attack-secret-topic',
    'tk_fake_attack_secret_xyz789',
    'NTFY_ATTACK_URL',
  ]) {
    assert.equal(text.includes(secret), false, `health leaked ${secret}`);
  }
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

const INDEX_FIXTURE =
  '<!doctype html><title>app</title><link rel="manifest" href="/manifest.webmanifest">';
const VIEW_FIXTURE =
  '<!doctype html><title>partner</title><link rel="manifest" href="/partner.webmanifest">';

function assertPartnerShell(res, label) {
  assert.equal(res.statusCode, 200, label);
  assert.match(res.body, /<title>partner<\/title>/, label);
  assert.match(res.body, /href="\/partner\.webmanifest"/, label);
  assert.doesNotMatch(res.body, /href="\/manifest\.webmanifest"/, label);
}

function assertWriterShell(res, label) {
  assert.equal(res.statusCode, 200, label);
  assert.match(res.body, /<title>app<\/title>/, label);
  assert.match(res.body, /href="\/manifest\.webmanifest"/, label);
  assert.doesNotMatch(res.body, /href="\/partner\.webmanifest"/, label);
}

test('with dist/: /view and nested partner routes get the partner shell', async () => {
  await withDb('migraine-partner-static', async (dir, db) => {
    const distDir = join(dir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), INDEX_FIXTURE);
    writeFileSync(join(distDir, 'view.html'), VIEW_FIXTURE);

    const app = await buildApp({ db, distDir });

    assertPartnerShell(await app.inject({ method: 'GET', url: '/view' }), '/view');
    assertPartnerShell(await app.inject({ method: 'GET', url: '/view/' }), '/view/');
    assertPartnerShell(
      await app.inject({ method: 'GET', url: '/view/history' }),
      '/view/history',
    );
    assertPartnerShell(
      await app.inject({ method: 'GET', url: '/view?refresh=1' }),
      '/view?refresh=1',
    );

    assertWriterShell(await app.inject({ method: 'GET', url: '/' }), '/');
    assertWriterShell(await app.inject({ method: 'GET', url: '/settings' }), '/settings');
    assertWriterShell(
      await app.inject({ method: 'GET', url: '/history/deep/link' }),
      '/history/deep/link',
    );

    const api = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    assert.equal(api.statusCode, 404);
    assert.deepEqual(api.json(), { error: 'not found' });

    await app.close();
  });
});

test('with dist/ lacking view.html: /view falls back to the writer shell', async () => {
  await withDb('migraine-partner-stale', async (dir, db) => {
    // A stale dist from before the partner shell existed: only index.html.
    const distDir = join(dir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), INDEX_FIXTURE);

    const app = await buildApp({ db, distDir });

    const view = await app.inject({ method: 'GET', url: '/view' });
    assert.equal(view.statusCode, 200);
    assert.match(view.body, /<title>app<\/title>/);
    const nested = await app.inject({ method: 'GET', url: '/view/history' });
    assert.equal(nested.statusCode, 200);
    assert.match(nested.body, /<title>app<\/title>/);

    await app.close();
  });
});

test('with dist/: a missing /assets file is a JSON 404, never the SPA shell', async () => {
  await withDb('migraine-static-assets', async (dir, db) => {
    const distDir = join(dir, 'dist');
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), INDEX_FIXTURE);
    writeFileSync(join(distDir, 'view.html'), VIEW_FIXTURE);
    writeFileSync(join(distDir, 'assets', 'main-abc123.js'), 'console.log("asset")');

    const app = await buildApp({ db, distDir });

    // A stale lazy-chunk request must not receive index.html as "JavaScript".
    const missingJs = await app.inject({ method: 'GET', url: '/assets/History-def456.js' });
    assert.equal(missingJs.statusCode, 404);
    assert.equal(missingJs.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(missingJs.json(), { error: 'not found' });
    assert.doesNotMatch(missingJs.body, /<title>app<\/title>/);

    // Query strings are ignored and nested asset paths follow the same rule.
    const missingCss = await app.inject({ method: 'GET', url: '/assets/index-0.css?v=1' });
    assert.equal(missingCss.statusCode, 404);
    const missingNested = await app.inject({ method: 'GET', url: '/assets/chunks/Reports-abc.js' });
    assert.equal(missingNested.statusCode, 404);

    // Existing assets keep being served, and both shells keep deep links.
    const asset = await app.inject({ method: 'GET', url: '/assets/main-abc123.js' });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.body, 'console.log("asset")');
    assertWriterShell(await app.inject({ method: 'GET', url: '/' }), '/');
    assertWriterShell(await app.inject({ method: 'GET', url: '/reports' }), '/reports');
    assertPartnerShell(await app.inject({ method: 'GET', url: '/view/reports' }), '/view/reports');

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
  '/view/%2e%2e/secret.txt',
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
