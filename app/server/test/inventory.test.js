// Checkpoint 5: Nurtec inventory. Covers structured (nullable) quantities on
// meds/refills, dated absolute stock baselines, the authoritative
// GET /api/inventory/nurtec calculation, export/backup/import/reset
// inclusion, and pre-v3 rows where quantity stays NULL = UNKNOWN.
//
// Every database lives in a disposable temp dir; requests use inject() only
// and the calculation is exercised against the real clock, so all seeded
// instants are expressed as offsets from Date.now().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db.js';
import { buildApp } from '../app.js';
import { currentUserVersion, SCHEMA_VERSION } from '../migrations.js';
import { dumpBackup } from '../backup.js';
import { makeApp, makeTempDir, cleanupDir, LEGACY_DDL } from './helpers.js';

const DAY = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Full ISO instant `days` ago (fractional offsets allowed). */
const isoAgo = (days) => new Date(Date.now() - days * DAY).toISOString();
/** UTC 'YYYY-MM-DD' day key `days` ago (date-only refill record). */
const dayKeyAgo = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

const INVENTORY_KEYS = [
  'medId', 'status', 'quantity', 'level', 'threshold', 'low', 'negative',
  'baselineId', 'baselineEffectiveAt', 'timeZone', 'computedAt',
];

const getInventory = async (app) => (await app.inject({
  method: 'GET', url: '/api/inventory/nurtec',
})).json();

const listJson = async (app, url) => (await app.inject({ method: 'GET', url })).json();

/** Writes a settings value directly (bypasses the PUT route's JSON quirks). */
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

// ── structured quantities on meds/refills ─────────────────────────────
test('med quantity: POST/PATCH persistence, null = unknown, invalid counts rejected', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-med-qty' });
  t.after(() => h.close());

  const created = await h.app.inject({
    method: 'POST', url: '/api/meds',
    payload: { medId: 'nurtec', ts: isoAgo(1), quantity: 1 },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().quantity, 1); // new Nurtec doses default to 1 client-side, stored explicitly

  // absent quantity stays UNKNOWN (null) — never zero, never inferred from free text
  const unknown = await h.app.inject({
    method: 'POST', url: '/api/meds',
    payload: { medId: 'nurtec', ts: isoAgo(1), dose: '75 mg' },
  });
  assert.equal(unknown.statusCode, 201);
  assert.equal(unknown.json().quantity, null);

  const id = created.json().id;
  const patched = await h.app.inject({
    method: 'PATCH', url: `/api/meds/${id}`, payload: { quantity: 3 },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().quantity, 3);

  // explicit null clears the structured count back to unknown
  const cleared = await h.app.inject({
    method: 'PATCH', url: `/api/meds/${id}`, payload: { quantity: null },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().quantity, null);

  for (const bad of [-1, 0.5, 1.5, 'three', true]) {
    const patch = await h.app.inject({
      method: 'PATCH', url: `/api/meds/${id}`, payload: { quantity: bad },
    });
    assert.equal(patch.statusCode, 400, `PATCH quantity ${JSON.stringify(bad)} must be rejected`);
    assert.match(patch.json().error, /quantity/);

    const post = await h.app.inject({
      method: 'POST', url: '/api/meds', payload: { medId: 'nurtec', ts: isoAgo(1), quantity: bad },
    });
    assert.equal(post.statusCode, 400, `POST quantity ${JSON.stringify(bad)} must be rejected`);
    assert.match(post.json().error, /quantity/);
  }

  // rejected writes changed/added nothing
  const meds = await listJson(h.app, '/api/meds');
  assert.equal(meds.length, 2);
  assert.equal(meds.find((m) => m.id === id).quantity, null);
});

test('refill quantity: POST/PATCH persistence, null = unknown, invalid counts rejected', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-refill-qty' });
  t.after(() => h.close());

  const created = await h.app.inject({
    method: 'POST', url: '/api/refills',
    payload: { medId: 'nurtec', date: '2026-01-10', quantity: 8 },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().quantity, 8); // default pack of 8 supplied by the client

  const unknown = await h.app.inject({
    method: 'POST', url: '/api/refills',
    payload: { medId: 'nurtec', date: '2026-01-11', notes: '8 tablets' },
  });
  assert.equal(unknown.statusCode, 201);
  assert.equal(unknown.json().quantity, null); // free text is NOT parsed

  const id = created.json().id;
  const patched = await h.app.inject({
    method: 'PATCH', url: `/api/refills/${id}`, payload: { quantity: 4 },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().quantity, 4);

  const cleared = await h.app.inject({
    method: 'PATCH', url: `/api/refills/${id}`, payload: { quantity: null },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().quantity, null);

  for (const bad of [-1, 0.5, '8']) {
    const patch = await h.app.inject({
      method: 'PATCH', url: `/api/refills/${id}`, payload: { quantity: bad },
    });
    assert.equal(patch.statusCode, 400, `PATCH quantity ${JSON.stringify(bad)} must be rejected`);
    assert.match(patch.json().error, /quantity/);

    const post = await h.app.inject({
      method: 'POST', url: '/api/refills',
      payload: { medId: 'nurtec', date: '2026-01-12', quantity: bad },
    });
    assert.equal(post.statusCode, 400, `POST quantity ${JSON.stringify(bad)} must be rejected`);
    assert.match(post.json().error, /quantity/);
  }

  const refills = await listJson(h.app, '/api/refills');
  assert.equal(refills.length, 2);
  assert.equal(refills.find((r) => r.id === id).quantity, null);
});

// ── stock baseline CRUD ───────────────────────────────────────────────
test('stock baselines: required fields, instant format, server-set createdAt, PATCH/DELETE', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-baselines' });
  t.after(() => h.close());

  const base = {
    medId: 'nurtec', effectiveAt: '2026-03-01T07:00:00.000Z', quantity: 8,
  };

  // all three fields required
  const missing = await h.app.inject({ method: 'POST', url: '/api/stock-baselines', payload: {} });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /medId/);
  assert.match(missing.json().error, /effectiveAt/);
  assert.match(missing.json().error, /quantity/);

  const missingMed = await h.app.inject({
    method: 'POST', url: '/api/stock-baselines',
    payload: { effectiveAt: base.effectiveAt, quantity: 8 },
  });
  assert.equal(missingMed.statusCode, 400);
  assert.match(missingMed.json().error, /medId/);

  const missingInstant = await h.app.inject({
    method: 'POST', url: '/api/stock-baselines', payload: { medId: 'nurtec', quantity: 8 },
  });
  assert.equal(missingInstant.statusCode, 400);
  assert.match(missingInstant.json().error, /effectiveAt/);

  const missingQuantity = await h.app.inject({
    method: 'POST', url: '/api/stock-baselines',
    payload: { medId: 'nurtec', effectiveAt: base.effectiveAt },
  });
  assert.equal(missingQuantity.statusCode, 400);
  assert.match(missingQuantity.json().error, /quantity/);

  // date-only and timezone-less strings are not instants (ordering column)
  for (const bad of ['2026-03-01', '2026-03-01T07:00:00', 'nope']) {
    const res = await h.app.inject({
      method: 'POST', url: '/api/stock-baselines', payload: { ...base, effectiveAt: bad },
    });
    assert.equal(res.statusCode, 400, `effectiveAt ${JSON.stringify(bad)} must be rejected`);
    assert.match(res.json().error, /effectiveAt .*full ISO 8601 instant/);
  }

  // baseline quantity is a required whole nonnegative count (NOT NULL column)
  for (const bad of [-1, 0.5, null, '8']) {
    const res = await h.app.inject({
      method: 'POST', url: '/api/stock-baselines', payload: { ...base, quantity: bad },
    });
    assert.equal(res.statusCode, 400, `quantity ${JSON.stringify(bad)} must be rejected`);
    assert.match(res.json().error, /quantity/);
  }

  // createdAt is server-set: a body value is never echoed or stored
  const created = await h.app.inject({
    method: 'POST', url: '/api/stock-baselines',
    payload: { ...base, notes: 'initial count', createdAt: '1970-01-01T00:00:00.000Z' },
  });
  assert.equal(created.statusCode, 201);
  const b = created.json();
  assert.match(b.createdAt, ISO);
  assert.notEqual(b.createdAt, '1970-01-01T00:00:00.000Z');
  assert.ok(Math.abs(Date.parse(b.createdAt) - Date.now()) < 60000, 'createdAt is the current clock');
  assert.equal(b.effectiveAt, base.effectiveAt);
  assert.equal(b.quantity, 8);
  assert.equal(b.notes, 'initial count');
  assert.equal(
    h.db.prepare('SELECT created_at FROM stock_baselines WHERE id = ?').get(b.id).created_at,
    b.createdAt,
  );

  // PATCH keeps the ORIGINAL createdAt even when the body sends one
  const patched = await h.app.inject({
    method: 'PATCH', url: `/api/stock-baselines/${b.id}`,
    payload: {
      effectiveAt: '2026-03-02T08:30:00.000Z',
      quantity: 6,
      notes: 'corrected',
      createdAt: '2030-01-01T00:00:00.000Z',
    },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().createdAt, b.createdAt);
  assert.equal(patched.json().effectiveAt, '2026-03-02T08:30:00.000Z');
  assert.equal(patched.json().quantity, 6);
  assert.equal(patched.json().notes, 'corrected');
  assert.equal(patched.json().medId, 'nurtec'); // untouched
  assert.equal(
    h.db.prepare('SELECT created_at FROM stock_baselines WHERE id = ?').get(b.id).created_at,
    b.createdAt,
  );

  // PATCH validates the same formats as POST
  const badPatchInstant = await h.app.inject({
    method: 'PATCH', url: `/api/stock-baselines/${b.id}`, payload: { effectiveAt: '2026-03-03' },
  });
  assert.equal(badPatchInstant.statusCode, 400);
  assert.match(badPatchInstant.json().error, /full ISO 8601 instant/);
  const badPatchQuantity = await h.app.inject({
    method: 'PATCH', url: `/api/stock-baselines/${b.id}`, payload: { quantity: null },
  });
  assert.equal(badPatchQuantity.statusCode, 400);
  assert.match(badPatchQuantity.json().error, /quantity/);

  const unknownPatch = await h.app.inject({
    method: 'PATCH', url: '/api/stock-baselines/nope', payload: { quantity: 1 },
  });
  assert.equal(unknownPatch.statusCode, 404);

  const del = await h.app.inject({ method: 'DELETE', url: `/api/stock-baselines/${b.id}` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(await listJson(h.app, '/api/stock-baselines'), []);
  assert.equal((await h.app.inject({ method: 'DELETE', url: `/api/stock-baselines/${b.id}` })).statusCode, 404);
  assert.equal((await h.app.inject({ method: 'DELETE', url: '/api/stock-baselines/nope' })).statusCode, 404);
});

// ── authoritative inventory calculation ───────────────────────────────
test('inventory: no baseline means stock unknown — never zero', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-unknown' });
  t.after(() => h.close());

  const inv = await getInventory(h.app);
  assert.deepEqual(Object.keys(inv).sort(), [...INVENTORY_KEYS].sort());
  assert.equal(inv.medId, 'nurtec');
  assert.equal(inv.status, 'unknown');
  assert.equal(inv.quantity, null);
  assert.equal(inv.level, 'unknown');
  assert.equal(inv.threshold, 2); // documented default
  assert.equal(inv.low, false); // unknown is never low
  assert.equal(inv.negative, false);
  assert.equal(inv.baselineId, null);
  assert.equal(inv.baselineEffectiveAt, null);
  assert.equal(inv.timeZone, 'UTC'); // fallback when no setting exists
  assert.match(inv.computedAt, ISO);

  // known events without any baseline still cannot establish stock
  await h.app.inject({
    method: 'POST', url: '/api/meds', payload: { medId: 'nurtec', ts: isoAgo(1), quantity: 1 },
  });
  await h.app.inject({
    method: 'POST', url: '/api/refills', payload: { medId: 'nurtec', date: dayKeyAgo(2), quantity: 8 },
  });
  assert.equal((await getInventory(h.app)).status, 'unknown');

  // a future baseline is not applicable yet
  await h.app.inject({
    method: 'POST', url: '/api/stock-baselines',
    payload: { medId: 'nurtec', effectiveAt: new Date(Date.now() + DAY).toISOString(), quantity: 99 },
  });
  const futureOnly = await getInventory(h.app);
  assert.equal(futureOnly.status, 'unknown');
  assert.equal(futureOnly.quantity, null);
});

test('inventory: baseline + later known doses/refills; unknown and earlier events do not count', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-arith' });
  t.after(() => h.close());

  const baselineAt = isoAgo(10);
  const postBaseline = await h.app.inject({
    method: 'POST', url: '/api/stock-baselines',
    payload: { medId: 'nurtec', effectiveAt: baselineAt, quantity: 8 },
  });
  assert.equal(postBaseline.statusCode, 201);
  const baselineId = postBaseline.json().id;

  // known post-baseline doses and refill
  await h.app.inject({ method: 'POST', url: '/api/meds', payload: { medId: 'nurtec', ts: isoAgo(3), quantity: 1 } });
  await h.app.inject({ method: 'POST', url: '/api/meds', payload: { medId: 'nurtec', ts: isoAgo(2), quantity: 2 } });
  // unknown quantities (absent and explicit null) change nothing
  await h.app.inject({ method: 'POST', url: '/api/meds', payload: { medId: 'nurtec', ts: isoAgo(1), dose: '75 mg' } });
  await h.app.inject({ method: 'POST', url: '/api/meds', payload: { medId: 'nurtec', ts: isoAgo(1), quantity: null } });
  await h.app.inject({ method: 'POST', url: '/api/refills', payload: { medId: 'nurtec', date: dayKeyAgo(5), quantity: 8 } });
  await h.app.inject({ method: 'POST', url: '/api/refills', payload: { medId: 'nurtec', date: dayKeyAgo(4) } });
  // events before the baseline are subsumed by the absolute count
  await h.app.inject({ method: 'POST', url: '/api/meds', payload: { medId: 'nurtec', ts: isoAgo(20), quantity: 99 } });
  await h.app.inject({ method: 'POST', url: '/api/refills', payload: { medId: 'nurtec', date: dayKeyAgo(15), quantity: 99 } });
  // future events do not count either
  await h.app.inject({
    method: 'POST', url: '/api/meds', payload: { medId: 'nurtec', ts: new Date(Date.now() + DAY).toISOString(), quantity: 99 },
  });

  const inv = await getInventory(h.app);
  assert.equal(inv.status, 'known');
  assert.equal(inv.quantity, 13); // 8 + 8 refill − 1 − 2 doses
  assert.equal(inv.level, 'ok');
  assert.equal(inv.low, false);
  assert.equal(inv.negative, false);
  assert.equal(inv.baselineId, baselineId);
  assert.equal(inv.baselineEffectiveAt, baselineAt);
});

test('inventory: negative stock is kept as a reconciliation warning', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-negative' });
  t.after(() => h.close());

  await h.app.inject({
    method: 'POST', url: '/api/stock-baselines',
    payload: { medId: 'nurtec', effectiveAt: isoAgo(10), quantity: 1 },
  });
  await h.app.inject({
    method: 'POST', url: '/api/meds', payload: { medId: 'nurtec', ts: isoAgo(1), quantity: 5 },
  });

  const inv = await getInventory(h.app);
  assert.equal(inv.status, 'known');
  assert.equal(inv.quantity, -4); // never clamped to zero
  assert.equal(inv.negative, true);
  assert.equal(inv.level, 'negative');
  assert.equal(inv.low, true); // quantity <= threshold as well
});

test('inventory: threshold defaults to 2, is configurable, and garbage falls back', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-threshold' });
  t.after(() => h.close());

  const baseline = await h.app.inject({
    method: 'POST', url: '/api/stock-baselines',
    payload: { medId: 'nurtec', effectiveAt: isoAgo(10), quantity: 5 },
  });
  assert.equal(baseline.statusCode, 201);

  // absent setting → documented default of 2
  let inv = await getInventory(h.app);
  assert.equal(inv.quantity, 5);
  assert.equal(inv.threshold, 2);
  assert.equal(inv.low, false);
  assert.equal(inv.level, 'ok');

  // equal to the threshold counts as low
  await putSetting(h, 'lowStockThreshold', 5);
  inv = await getInventory(h.app);
  assert.equal(inv.threshold, 5);
  assert.equal(inv.low, true);
  assert.equal(inv.level, 'low');

  await putSetting(h, 'lowStockThreshold', 3);
  inv = await getInventory(h.app);
  assert.equal(inv.threshold, 3);
  assert.equal(inv.low, false);
  assert.equal(inv.level, 'ok');

  // invalid stored values (wrong type / non-integer / negative) fall back to 2
  for (const garbage of ['five', 2.5, -1, null]) {
    setSetting(h.db, 'lowStockThreshold', garbage);
    inv = await getInventory(h.app);
    assert.equal(inv.threshold, 2, `garbage threshold ${JSON.stringify(garbage)} must fall back`);
  }

  // boundary: exactly 2 tablets on hand with the default threshold
  await h.app.inject({
    method: 'PATCH', url: `/api/stock-baselines/${baseline.json().id}`, payload: { quantity: 2 },
  });
  inv = await getInventory(h.app);
  assert.equal(inv.quantity, 2);
  assert.equal(inv.threshold, 2);
  assert.equal(inv.low, true);
  assert.equal(inv.level, 'low');

  // zero is a valid configured threshold (only negatives/non-integers fall back)
  await putSetting(h, 'lowStockThreshold', 0);
  inv = await getInventory(h.app);
  assert.equal(inv.threshold, 0);
  assert.equal(inv.low, false);
});

test('inventory: timezone resolves date-only refills; invalid zone falls back to UTC', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-timezone' });
  t.after(() => h.close());

  // The refill day starts at 00:00Z under UTC but 04:00Z/05:00Z under
  // America/New_York. A baseline at 02:00Z therefore excludes the refill in
  // UTC and includes it in New York — proving the zone is really applied.
  const day = dayKeyAgo(5);
  const baselineAt = `${day}T02:00:00.000Z`;
  const postBaseline = await h.app.inject({
    method: 'POST', url: '/api/stock-baselines',
    payload: { medId: 'nurtec', effectiveAt: baselineAt, quantity: 10 },
  });
  assert.equal(postBaseline.statusCode, 201);
  const baselineId = postBaseline.json().id;
  await h.app.inject({
    method: 'POST', url: '/api/refills', payload: { medId: 'nurtec', date: day, quantity: 8 },
  });

  let inv = await getInventory(h.app);
  assert.equal(inv.timeZone, 'UTC'); // no setting → UTC
  assert.equal(inv.baselineId, baselineId);
  assert.equal(inv.quantity, 10); // refill day started before the baseline

  const put = await putSetting(h, 'timezone', 'America/New_York');
  assert.equal(put.statusCode, 200);
  assert.equal((await listJson(h.app, '/api/settings')).timezone, 'America/New_York');

  inv = await getInventory(h.app);
  assert.equal(inv.timeZone, 'America/New_York');
  assert.equal(inv.quantity, 18); // 10 + 8: the same local day now starts after the baseline

  // garbage stored zone → UTC fallback without a 500
  setSetting(h.db, 'timezone', 'Mars/Olympus');
  inv = await getInventory(h.app);
  assert.equal(inv.timeZone, 'UTC');
  assert.equal(inv.quantity, 10);
});

// ── export / nightly backup ───────────────────────────────────────────
test('export and nightly backup include stock baselines under the current schema version', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-export' });
  t.after(() => h.close());

  await h.app.inject({
    method: 'POST', url: '/api/stock-baselines',
    payload: { medId: 'nurtec', effectiveAt: isoAgo(2), quantity: 9, notes: 'after pickup' },
  });

  const envelope = await listJson(h.app, '/api/export');
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(envelope.schemaVersion, SCHEMA_VERSION);
  assert.equal(envelope.stockBaselines.length, 1);
  assert.equal(envelope.stockBaselines[0].medId, 'nurtec');
  assert.equal(envelope.stockBaselines[0].quantity, 9);
  assert.match(envelope.stockBaselines[0].createdAt, ISO);

  const backupDir = join(h.dir, 'backups');
  const clock = new Date('2026-03-05T09:30:00.000Z');
  const file = dumpBackup({ db: h.db, backupDir, now: clock, log: () => {} });
  assert.equal(file, join(backupDir, 'migraine-2026-03-05.json'));
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
  assert.equal(parsed.exportedAt, '2026-03-05T09:30:00.000Z');
  assert.deepEqual(parsed.stockBaselines, envelope.stockBaselines);
});

// ── import ────────────────────────────────────────────────────────────
test('import: legacy payloads, additive duplicates, createdAt preservation, atomic rejection', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-import' });
  t.after(() => h.close());

  // legacy unversioned payload without stockBaselines
  const legacy = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: {
      attacks: [{ id: 'a1', start: '2026-01-01T00:00:00Z' }],
      meds: [{ id: 'm1', medId: 'nurtec', ts: '2026-01-01T01:00:00Z', dose: '75 mg' }],
      refills: [{ id: 'r1', medId: 'nurtec', date: '2026-01-02', notes: '8 tablets' }],
    },
  });
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.json().ok, true);
  assert.equal(legacy.json().stockBaselines, 0);

  // absent quantities map to null (unknown)
  const meds = await listJson(h.app, '/api/meds');
  assert.equal(meds.find((m) => m.id === 'm1').quantity, null);
  const refills = await listJson(h.app, '/api/refills');
  assert.equal(refills.find((r) => r.id === 'r1').quantity, null);

  // duplicates never overwrite: same med id with a different quantity
  const firstQuantity = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: { meds: [{ id: 'm2', medId: 'nurtec', ts: '2026-01-03T01:00:00Z', quantity: 1 }] },
  });
  assert.equal(firstQuantity.statusCode, 200);
  const secondQuantity = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: { meds: [{ id: 'm2', medId: 'nurtec', ts: '2026-01-03T01:00:00Z', quantity: 9 }] },
  });
  assert.equal(secondQuantity.statusCode, 200);
  assert.equal(
    (await listJson(h.app, '/api/meds')).find((m) => m.id === 'm2').quantity,
    1, // original import kept
  );

  // stock_baselines import preserves a valid createdAt (restore ordering)
  const createdAt = '2026-01-01T00:00:00.000Z';
  const baselineImport = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: {
      stockBaselines: [{
        id: 'b1', medId: 'nurtec', effectiveAt: '2026-01-05T00:00:00.000Z',
        quantity: 4, notes: 'restore', createdAt,
      }],
    },
  });
  assert.equal(baselineImport.statusCode, 200);
  assert.equal(baselineImport.json().stockBaselines, 1);
  const baselines = await listJson(h.app, '/api/stock-baselines');
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0].createdAt, createdAt);
  assert.equal(baselines[0].quantity, 4);

  // duplicate baseline ids are ignored too
  await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: {
      stockBaselines: [{
        id: 'b1', medId: 'nurtec', effectiveAt: '2026-01-05T00:00:00.000Z',
        quantity: 99, createdAt,
      }],
    },
  });
  assert.equal((await listJson(h.app, '/api/stock-baselines'))[0].quantity, 4);

  // invalid baseline (negative quantity) rejects the whole payload atomically
  const attacksBefore = (await listJson(h.app, '/api/attacks')).length;
  const medsBefore = (await listJson(h.app, '/api/meds')).length;
  const baselinesBefore = (await listJson(h.app, '/api/stock-baselines')).length;
  const bad = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: {
      attacks: [{ id: 'a-atomic', start: '2026-02-01T00:00:00Z' }],
      meds: [{ id: 'm-atomic', medId: 'nurtec', ts: '2026-02-01T01:00:00Z', quantity: 1 }],
      stockBaselines: [{
        id: 'b-bad', medId: 'nurtec', effectiveAt: '2026-02-02T00:00:00.000Z', quantity: -1,
      }],
    },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /quantity/);
  assert.equal((await listJson(h.app, '/api/attacks')).length, attacksBefore);
  assert.equal((await listJson(h.app, '/api/meds')).length, medsBefore);
  assert.equal((await listJson(h.app, '/api/stock-baselines')).length, baselinesBefore);
  assert.equal((await listJson(h.app, '/api/attacks')).some((a) => a.id === 'a-atomic'), false);
  assert.equal((await listJson(h.app, '/api/meds')).some((m) => m.id === 'm-atomic'), false);
  assert.equal((await listJson(h.app, '/api/stock-baselines')).some((b) => b.id === 'b-bad'), false);
});

// ── reset ─────────────────────────────────────────────────────────────
test('reset clears stock baselines and settings as well as records', async (t) => {
  const h = await makeApp({ label: 'migraine-inv-reset' });
  t.after(() => h.close());

  await h.app.inject({
    method: 'POST', url: '/api/stock-baselines',
    payload: { medId: 'nurtec', effectiveAt: isoAgo(10), quantity: 5 },
  });
  await h.app.inject({
    method: 'POST', url: '/api/meds', payload: { medId: 'nurtec', ts: isoAgo(1), quantity: 1 },
  });
  await h.app.inject({
    method: 'POST', url: '/api/refills', payload: { medId: 'nurtec', date: dayKeyAgo(2), quantity: 8 },
  });
  await putSetting(h, 'lowStockThreshold', 5);
  await putSetting(h, 'timezone', 'America/New_York');

  const summaryBefore = await getInventory(h.app);
  assert.equal(summaryBefore.status, 'known');
  assert.equal(summaryBefore.threshold, 5);

  const res = await h.app.inject({ method: 'POST', url: '/api/reset' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });

  const envelope = await listJson(h.app, '/api/export');
  assert.deepEqual(envelope.stockBaselines, []);
  assert.deepEqual(envelope.meds, []);
  assert.deepEqual(envelope.refills, []);
  assert.deepEqual(envelope.settings, {});
  assert.deepEqual(await listJson(h.app, '/api/settings'), {});

  // defaults apply again: no baseline → unknown, default threshold
  const after = await getInventory(h.app);
  assert.equal(after.status, 'unknown');
  assert.equal(after.quantity, null);
  assert.equal(after.threshold, 2);
  assert.equal(after.timeZone, 'UTC');
  assert.equal(currentUserVersion(h.db), SCHEMA_VERSION);
});

// ── legacy rows: NULL quantity means unknown ──────────────────────────
test('pre-v3 rows keep NULL quantity and are ignored by stock arithmetic', async () => {
  const dir = makeTempDir('migraine-inv-legacy');
  let app = null;
  try {
    // Simulate a real pre-v3 install: legacy DDL, seeded rows, no user_version.
    const file = join(dir, 'migraine.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY_DDL);
    legacy.prepare(`INSERT INTO attacks (id,start,notes) VALUES ('atk1','2025-06-01T08:00:00Z','legacy')`).run();
    legacy.prepare(`INSERT INTO meds (id,med_id,ts,dose,notes,source)
      VALUES ('m-legacy','nurtec',?,'75 mg','free text dose','manual')`).run(isoAgo(5));
    legacy.prepare(`INSERT INTO refills (id,med_id,date,notes,source)
      VALUES ('r-legacy','nurtec',?,'8 tablets','manual')`).run(dayKeyAgo(4));
    assert.equal(currentUserVersion(legacy), 0);
    legacy.close();

    const db = openDatabase(dir, { log: () => {} });
    app = await buildApp({ db, logger: false });
    assert.equal(currentUserVersion(db), SCHEMA_VERSION);

    const meds = await listJson(app, '/api/meds');
    assert.equal(meds.length, 1);
    assert.equal(meds[0].quantity, null); // SQL NULL, never 0
    assert.equal(meds[0].dose, '75 mg'); // free text preserved verbatim
    const refills = await listJson(app, '/api/refills');
    assert.equal(refills.length, 1);
    assert.equal(refills[0].quantity, null);
    assert.equal(refills[0].notes, '8 tablets');

    // Only the baseline establishes stock; the unknown legacy refill/dose
    // (both AFTER the baseline) change nothing.
    const postBaseline = await app.inject({
      method: 'POST', url: '/api/stock-baselines',
      payload: { medId: 'nurtec', effectiveAt: isoAgo(10), quantity: 5 },
    });
    assert.equal(postBaseline.statusCode, 201);
    const inv = await getInventory(app);
    assert.equal(inv.status, 'known');
    assert.equal(inv.quantity, 5); // 5 + unknown refill − unknown dose
    assert.equal(inv.low, false);
    assert.equal(inv.negative, false);

    // export carries the legacy rows with null quantities plus the baseline
    const envelope = await listJson(app, '/api/export');
    assert.equal(envelope.meds.find((m) => m.id === 'm-legacy').quantity, null);
    assert.equal(envelope.refills.find((r) => r.id === 'r-legacy').quantity, null);
    assert.equal(envelope.stockBaselines.length, 1);
  } finally {
    if (app) await app.close(); // closes the database handle
    cleanupDir(dir);
  }
});
