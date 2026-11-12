// GET /api/status: the versioned read-only projection Home Assistant polls.
// Covers the response contract (shape, headers, apiVersion), the settings
// timezone and its UTC fallback, day attribution, ongoing/finished attacks,
// explicit day states, multiple ongoing rows, the shared Nurtec computation,
// privacy exclusions, and pathological stored instants (never a 500).
//
// Every database lives in a disposable temp dir and requests use inject().
// Clock-sensitive expectations are derived from the real clock via Intl (like
// inventory.test.js) or pinned with `withNow` for midnight/zone attribution.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

const DAY = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Full ISO instant `days` ago (fractional offsets allowed). */
const isoAgo = (days) => new Date(Date.now() - days * DAY).toISOString();
/** UTC 'YYYY-MM-DD' day key `days` ago (date-only record). */
const dayKeyAgo = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

/** Local day key of an instant, computed independently of the server helper. */
const dayKeyIn = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(ms);

const getStatus = async (app) => (await app.inject({ method: 'GET', url: '/api/status' })).json();
const getInventory = async (app) => (await app.inject({
  method: 'GET', url: '/api/inventory/nurtec',
})).json();

/** Writes a settings value directly (bypasses the PUT route's validation). */
const setSetting = (db, key, value) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run(key, JSON.stringify(value));

/** PUTs a JSON scalar/string settings value through the real route. */
const putSetting = (h, key, value) => h.app.inject({
  method: 'PUT',
  url: `/api/settings/${key}`,
  headers: { 'content-type': 'application/json' },
  payload: JSON.stringify(value),
});

/** Runs `fn` with Date.now() pinned, so a response's clock is deterministic. */
async function withNow(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

const STATUS_KEYS = [
  'apiVersion', 'generatedAt', 'timeZone', 'state', 'activeAttack', 'today',
  'lastAttack', 'history', 'inventory',
];

// ── contract shape ────────────────────────────────────────────────────
test('GET /api/status: JSON shape, apiVersion, and no-store caching', async (t) => {
  const h = await makeApp({ label: 'migraine-status-shape' });
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');

  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), [...STATUS_KEYS].sort());
  assert.equal(body.apiVersion, 1);
  assert.match(body.generatedAt, ISO);
  assert.ok(Math.abs(Date.parse(body.generatedAt) - Date.now()) < 60000);
  assert.equal(body.timeZone, 'UTC'); // missing setting falls back to UTC
});

test('empty database: no_data, no attacks, unknown inventory', async (t) => {
  const h = await makeApp({ label: 'migraine-status-empty' });
  t.after(() => h.close());

  const status = await getStatus(h.app);
  assert.equal(status.state, 'no_data');
  assert.equal(status.activeAttack, null);
  assert.deepEqual(status.today, {
    day: dayKeyIn(Date.now(), 'UTC'), status: null, source: 'none',
  });
  assert.equal(status.lastAttack, null);
  assert.deepEqual(status.history, {
    daysSinceLastAttackStart: null,
    attacksStartedLast30Days: 0,
    attackDaysLast7Days: 0,
    attackDaysLast30Days: 0,
  });
  assert.deepEqual(status.inventory.nurtec, {
    status: 'unknown', quantity: null, level: 'unknown',
    low: false, negative: false, threshold: 2,
  });
});

test('uses the saved timezone and falls back to UTC for a corrupt setting', async (t) => {
  const h = await makeApp({ label: 'migraine-status-timezone' });
  t.after(() => h.close());

  const put = await putSetting(h, 'timezone', 'America/New_York');
  assert.equal(put.statusCode, 200);
  let status = await getStatus(h.app);
  assert.equal(status.timeZone, 'America/New_York');
  assert.equal(status.today.day, dayKeyIn(Date.now(), 'America/New_York'));

  // The PUT route rejects invalid zones, so corrupt the row directly.
  setSetting(h.db, 'timezone', 'Mars/Olympus');
  status = await getStatus(h.app);
  assert.equal(status.timeZone, 'UTC');
  assert.equal(status.today.day, dayKeyIn(Date.now(), 'UTC'));
});

test('attributes today and history to the configured zone near local midnight', async (t) => {
  const h = await makeApp({ label: 'migraine-status-midnight' });
  t.after(() => h.close());

  assert.equal((await putSetting(h, 'timezone', 'America/New_York')).statusCode, 200);

  // 2026-06-14 22:30-23:00 in New York is still 06-14 locally but already
  // 06-15 in UTC, so a UTC implementation would report the wrong day.
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/attacks',
    payload: {
      start: '2026-06-14T22:30:00-04:00',
      end: '2026-06-14T23:00:00-04:00',
    },
  });
  assert.equal(created.statusCode, 201);

  const now = Date.parse('2026-06-15T03:30:00.000Z'); // 23:30 on 06-14 in NY
  const status = await withNow(now, () => getStatus(h.app));

  assert.equal(dayKeyIn(now, 'America/New_York'), '2026-06-14');
  assert.equal(dayKeyIn(now, 'UTC'), '2026-06-15');
  assert.equal(status.today.day, '2026-06-14');
  assert.deepEqual(status.today, {
    day: '2026-06-14', status: 'off', source: 'inferred',
  });
  assert.equal(status.state, 'off');
  assert.equal(status.history.daysSinceLastAttackStart, 0);
});

// ── attacks ───────────────────────────────────────────────────────────
test('POST an ongoing attack reports activeAttack and lastAttack', async (t) => {
  const h = await makeApp({ label: 'migraine-status-ongoing' });
  t.after(() => h.close());

  const start = isoAgo(1);
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/attacks',
    payload: { start, peakPain: 6, aura: true },
  });
  assert.equal(created.statusCode, 201);

  const status = await getStatus(h.app);
  assert.equal(status.state, 'attack');
  assert.deepEqual(status.activeAttack, {
    id: created.json().id, start, peakPain: 6, latestPain: null, aura: true,
  });
  assert.equal(status.lastAttack.id, created.json().id);
  assert.deepEqual(status.lastAttack, {
    id: created.json().id, start, end: null, ongoing: true, durationMinutes: null, peakPain: 6,
  });
});

test('PATCH the end clears activeAttack and reports a stable duration', async (t) => {
  const h = await makeApp({ label: 'migraine-status-ended' });
  t.after(() => h.close());

  const startMs = Date.now() - 3600000; // 1 hour ago
  const endMs = Date.now() - 1800000; // 30 minutes ago
  const start = new Date(startMs).toISOString();
  const end = new Date(endMs).toISOString();
  const created = await h.app.inject({
    method: 'POST', url: '/api/attacks', payload: { start, peakPain: 8 },
  });
  assert.equal(created.statusCode, 201);

  const patched = await h.app.inject({
    method: 'PATCH', url: `/api/attacks/${created.json().id}`, payload: { end },
  });
  assert.equal(patched.statusCode, 200);

  const status = await getStatus(h.app);
  assert.equal(status.activeAttack, null);
  assert.equal(status.lastAttack.id, created.json().id);
  assert.equal(status.lastAttack.ongoing, false);
  assert.equal(status.lastAttack.end, end);
  assert.equal(status.lastAttack.durationMinutes, 30);
  assert.equal(status.lastAttack.peakPain, 8);
});

test('an empty-string end is a finished attack with no duration', async (t) => {
  const h = await makeApp({ label: 'migraine-status-empty-end' });
  t.after(() => h.close());

  const start = isoAgo(2);
  const created = await h.app.inject({
    method: 'POST', url: '/api/attacks', payload: { start, end: '' },
  });
  assert.equal(created.statusCode, 201);

  const status = await getStatus(h.app);
  assert.equal(status.activeAttack, null);
  assert.deepEqual(status.lastAttack, {
    id: created.json().id, start, end: null, ongoing: false, durationMinutes: null, peakPain: null,
  });
});

test('multiple ongoing attacks pick the canonical earliest start', async (t) => {
  const h = await makeApp({ label: 'migraine-status-multi-ongoing' });
  t.after(() => h.close());

  const earlier = await h.app.inject({
    method: 'POST', url: '/api/attacks', payload: { start: isoAgo(2) },
  });
  const later = await h.app.inject({
    method: 'POST', url: '/api/attacks', payload: { start: isoAgo(1) },
  });
  assert.equal(earlier.statusCode, 201);
  assert.equal(later.statusCode, 201);

  const status = await getStatus(h.app);
  assert.equal(status.state, 'attack');
  assert.equal(status.activeAttack.id, earlier.json().id);
  // Only one is reported; `lastAttack` is still the latest start.
  assert.equal(status.lastAttack.id, later.json().id);
});

// ── day states ────────────────────────────────────────────────────────
test('PUT a day state makes today explicit', async (t) => {
  const h = await makeApp({ label: 'migraine-status-daystate' });
  t.after(() => h.close());

  const day = dayKeyIn(Date.now(), 'UTC');
  const put = await h.app.inject({
    method: 'PUT', url: `/api/day-states/${day}`, payload: { status: 'well' },
  });
  assert.equal(put.statusCode, 200);

  const status = await getStatus(h.app);
  assert.deepEqual(status.today, { day, status: 'well', source: 'explicit' });
  assert.equal(status.state, 'well');
  assert.equal(status.activeAttack, null);
});

test('legacy explicit attack day: state attack with activeAttack null', async (t) => {
  const h = await makeApp({ label: 'migraine-status-legacy-attack' });
  t.after(() => h.close());

  const day = dayKeyIn(Date.now(), 'UTC');
  const put = await h.app.inject({
    method: 'PUT', url: `/api/day-states/${day}`, payload: { status: 'attack' },
  });
  assert.equal(put.statusCode, 200);

  const status = await getStatus(h.app);
  assert.equal(status.state, 'attack');
  assert.equal(status.activeAttack, null);
  assert.deepEqual(status.today, { day, status: 'attack', source: 'explicit' });
});

// ── inventory parity ──────────────────────────────────────────────────
test('inventory mirrors GET /api/inventory/nurtec exactly', async (t) => {
  const h = await makeApp({ label: 'migraine-status-inventory' });
  t.after(() => h.close());

  await h.app.inject({
    method: 'POST',
    url: '/api/stock-baselines',
    payload: { medId: 'nurtec', effectiveAt: isoAgo(10), quantity: 8 },
  });
  await h.app.inject({
    method: 'POST',
    url: '/api/refills',
    payload: { medId: 'nurtec', date: dayKeyAgo(5), quantity: 8 },
  });
  await h.app.inject({
    method: 'POST',
    url: '/api/meds',
    payload: { medId: 'nurtec', ts: isoAgo(1), quantity: 3 },
  });

  const status = await getStatus(h.app);
  const inventory = await getInventory(h.app);

  assert.deepEqual(Object.keys(status.inventory.nurtec).sort(), [
    'level', 'low', 'negative', 'quantity', 'status', 'threshold',
  ]);
  assert.equal(status.inventory.nurtec.quantity, 13); // 8 + 8 - 3
  for (const key of ['status', 'quantity', 'level', 'low', 'negative', 'threshold']) {
    assert.equal(
      status.inventory.nurtec[key],
      inventory[key],
      `inventory.${key} must match GET /api/inventory/nurtec`,
    );
  }
});

// ── privacy and robustness ────────────────────────────────────────────
test('the response never exposes notes, painLog text, symptoms, or triggers', async (t) => {
  const h = await makeApp({ label: 'migraine-status-privacy' });
  t.after(() => h.close());

  const created = await h.app.inject({
    method: 'POST',
    url: '/api/attacks',
    payload: {
      start: isoAgo(1),
      notes: 'SECRET_ATTACK_NOTE',
      symptoms: ['SECRET_SYMPTOM'],
      triggers: ['SECRET_TRIGGER'],
      painLog: [{ ts: isoAgo(0.5), level: 9 }],
      peakPain: 9,
    },
  });
  assert.equal(created.statusCode, 201);
  await h.app.inject({
    method: 'PUT',
    url: `/api/day-states/${dayKeyIn(Date.now(), 'UTC')}`,
    payload: { status: 'well', notes: 'SECRET_DAY_NOTE' },
  });

  const res = await h.app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(res.statusCode, 200);
  for (const secret of [
    'SECRET_ATTACK_NOTE', 'SECRET_SYMPTOM', 'SECRET_TRIGGER', 'SECRET_DAY_NOTE',
  ]) {
    assert.equal(res.body.includes(secret), false, `${secret} must not leak`);
  }
  assert.equal(res.body.includes('painLog'), false);
  assert.equal(res.body.includes('"notes"'), false);

  // The minimal pain projection is still there.
  const status = res.json();
  assert.equal(status.activeAttack.id, created.json().id);
  assert.equal(status.activeAttack.peakPain, 9);
  assert.equal(status.activeAttack.latestPain.level, 9);
});

test('pathological stored instants still return 200 with null/absent fields', async (t) => {
  const h = await makeApp({ label: 'migraine-status-pathological' });
  t.after(() => h.close());

  const far = await h.app.inject({
    method: 'POST', url: '/api/attacks', payload: { start: '+275760-09-13T00:00:00.000Z' },
  });
  assert.equal(far.statusCode, 201);
  const garbage = await h.app.inject({
    method: 'POST', url: '/api/attacks', payload: { start: 'not-a-date', end: 'also-garbage' },
  });
  assert.equal(garbage.statusCode, 201);

  const res = await h.app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(res.statusCode, 200);
  const status = res.json();
  assert.equal(status.lastAttack.start, '+275760-09-13T00:00:00.000Z');
  assert.equal(status.history.daysSinceLastAttackStart, null);
  assert.equal(status.history.attacksStartedLast30Days, 0);
  assert.equal(status.history.attackDaysLast7Days, 0);
  assert.equal(status.history.attackDaysLast30Days, 0);
  assert.equal(status.today.status, null);
});

// ── cross-origin guard ────────────────────────────────────────────────
test('GET still works with an Origin header (reads are not guarded)', async (t) => {
  const h = await makeApp({ label: 'migraine-status-origin' });
  t.after(() => h.close());

  const res = await h.app.inject({
    method: 'GET',
    url: '/api/status',
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().apiVersion, 1);
  assert.equal(res.headers['cache-control'], 'no-store');
});
