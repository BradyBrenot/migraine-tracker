// Import/export compatibility, backup envelope + rotation, and reset
// semantics. Import must stay additive (INSERT OR IGNORE) and accept both
// legacy unversioned payloads and the versioned envelope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { currentUserVersion, SCHEMA_VERSION } from '../migrations.js';
import { dumpBackup } from '../backup.js';
import { makeApp, makeTempDir, cleanupDir } from './helpers.js';

const attack = (id, start) => ({
  id, start, end: null, painLog: [], peakPain: -1,
  symptoms: [], triggers: [], aura: null, notes: '', source: 'import',
});
const med = (id, medId, ts) => ({
  id, medId, ts, dose: '', attackId: null, notes: '', source: 'import',
});
const refill = (id, medId, date) => ({ id, medId, date, notes: '', source: 'import' });

test('legacy unversioned payload imports additively', async (t) => {
  const h = await makeApp({ label: 'migraine-import-legacy' });
  t.after(() => h.close());
  const res = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: { attacks: [attack('a1', '2026-01-01T00:00:00Z')], meds: [med('m1', 'nurtec', '2026-01-01T01:00:00Z')], refills: [refill('r1', 'nurtec', '2026-01-02')] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, attacks: 1, meds: 1, refills: 1, workouts: 0, dayStates: 0, stockBaselines: 0 });

  // legacy payloads without optional keys still import (defaults applied)
  const sparse = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: { attacks: [{ id: 'a2', start: '2026-01-05T00:00:00Z' }], meds: [{ id: 'm2', medId: 'tylenol' }], refills: [{ id: 'r2', medId: 'nurtec', date: '2026-02-01' }] },
  });
  assert.equal(sparse.statusCode, 200);
  const attacks = (await h.app.inject({ method: 'GET', url: '/api/attacks' })).json();
  assert.equal(attacks.length, 2);
  // sparse attack gets source 'manual' — the original server only defaulted
  // meds/refills to 'import' during import; attacks kept the mapper default
  assert.equal(attacks.find((a) => a.id === 'a2').source, 'manual');
  const meds = (await h.app.inject({ method: 'GET', url: '/api/meds' })).json();
  const m2 = meds.find((m) => m.id === 'm2');
  assert.equal(m2.source, 'import'); // import default source preserved
  assert.equal(m2.dose, '');
  // empty payload and absent body behave like the original
  const empty = await h.app.inject({ method: 'POST', url: '/api/import', payload: {} });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), { ok: true, attacks: 0, meds: 0, refills: 0, workouts: 0, dayStates: 0, stockBaselines: 0 });
  const noBody = await h.app.inject({ method: 'POST', url: '/api/import' });
  assert.equal(noBody.statusCode, 200);
});

test('envelope version policy: legacy absence/null and every known version import; future fails safely', async (t) => {
  const h = await makeApp({ label: 'migraine-envelope' });
  t.after(() => h.close());

  // legacy backup-shaped envelope: exportedAt + settings, NO schemaVersion —
  // exactly what pre-versioning backups (and /api/export) produced
  const legacyEnvelope = {
    exportedAt: '2025-12-01T00:00:00.000Z',
    attacks: [attack('a1', '2026-01-01T00:00:00Z')],
    meds: [med('m1', 'nurtec', '2026-01-01T01:00:00Z')],
    refills: [],
    settings: { rules: { nurtec: { limit: 15, windowDays: 30 } } },
  };
  const legacy = await h.app.inject({ method: 'POST', url: '/api/import', payload: legacyEnvelope });
  assert.equal(legacy.statusCode, 200);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/attacks' })).json().length, 1);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/meds' })).json().length, 1);

  // explicit null is treated as absent (legacy tolerance)
  const nulled = await h.app.inject({
    method: 'POST', url: '/api/import', payload: { ...legacyEnvelope, schemaVersion: null, attacks: [], meds: [] },
  });
  assert.equal(nulled.statusCode, 200);

  // every version this build knows (1..SCHEMA_VERSION) stays importable,
  // including older ones after SCHEMA_VERSION grows
  for (let v = 1; v <= SCHEMA_VERSION; v++) {
    const res = await h.app.inject({
      method: 'POST', url: '/api/import', payload: { schemaVersion: v, attacks: [] },
    });
    assert.equal(res.statusCode, 200, `schemaVersion ${v} must be accepted`);
  }

  // rejections are derived from SCHEMA_VERSION so they stay correct as it
  // grows: the next future version, below-oldest, non-integers, wrong types
  for (const bad of [SCHEMA_VERSION + 1, 0, -1, 1.5, '1']) {
    const res = await h.app.inject({
      method: 'POST', url: '/api/import', payload: { schemaVersion: bad, attacks: [] },
    });
    assert.equal(res.statusCode, 400, `schemaVersion ${JSON.stringify(bad)} must be rejected`);
    assert.match(res.json().error, /schemaVersion/);
  }
});

test('bulk import tolerates empty-string medId from legacy CSV exports; direct POST does not', async (t) => {
  const h = await makeApp({ label: 'migraine-empty-medid' });
  t.after(() => h.close());

  // the CSV importer can emit medId '' for custom non-Latin medication names
  const res = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: { meds: [{ id: 'm-empty', medId: '', ts: '2026-01-01T00:00:00Z', notes: 'custom med' }] },
  });
  assert.equal(res.statusCode, 200);
  const meds = (await h.app.inject({ method: 'GET', url: '/api/meds' })).json();
  assert.equal(meds.length, 1);
  assert.equal(meds[0].medId, ''); // stored as-is, no generated replacement

  // the direct write endpoint still requires a usable key
  const direct = await h.app.inject({ method: 'POST', url: '/api/meds', payload: { medId: '' } });
  assert.equal(direct.statusCode, 400);
  // null medId stays invalid on both paths (NOT NULL column)
  const nulled = await h.app.inject({
    method: 'POST', url: '/api/import', payload: { meds: [{ id: 'm-null', medId: null }] },
  });
  assert.equal(nulled.statusCode, 400);
});

test('duplicate ids are ignored and existing rows are never overwritten', async (t) => {
  const h = await makeApp({ label: 'migraine-import-dup' });
  t.after(() => h.close());
  await h.app.inject({ method: 'POST', url: '/api/import', payload: { attacks: [attack('a1', '2026-01-01T00:00:00Z')] } });

  // same id, different content → ignored
  const res = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: { attacks: [attack('a1', '2030-12-31T00:00:00Z'), attack('a2', '2026-01-02T00:00:00Z')] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().attacks, 2); // response counts payload length (unchanged)
  const attacks = (await h.app.inject({ method: 'GET', url: '/api/attacks' })).json();
  assert.equal(attacks.length, 2);
  assert.equal(attacks.find((a) => a.id === 'a1').start, '2026-01-01T00:00:00Z'); // original kept
});

test('import validates payloads: bad shapes 400 with nothing inserted (atomic)', async (t) => {
  const h = await makeApp({ label: 'migraine-import-bad' });
  t.after(() => h.close());
  const valid = attack('a1', '2026-01-01T00:00:00Z');

  const badBodies = [
    [1, 2],                                    // not an object
    { attacks: 'nope' },                       // not an array
    { meds: {} },
    { schemaVersion: SCHEMA_VERSION + 1, attacks: [] }, // future envelope
    { schemaVersion: 0, attacks: [] },                  // below the oldest version
    { schemaVersion: 1.5, attacks: [] },                // non-integer
    { schemaVersion: '1', attacks: [] },                // wrong type
    { attacks: [valid, { nope: true }] },      // second item missing start
    { attacks: [{ id: 'a9', start: 5 }] },
    { meds: [{ id: 'm9' }] },                  // missing medId
    { meds: [{ id: 'm9', medId: 7 }] },
    { refills: [{ id: 'r9', medId: 'nurtec' }] }, // missing date
    { refills: [{ id: 'r9', medId: 'nurtec', date: '2026-01-01', notes: 3 }] },
  ];
  for (const payload of badBodies) {
    const res = await h.app.inject({ method: 'POST', url: '/api/import', payload });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    assert.ok(res.json().error);
  }

  // the valid item grouped with an invalid one must not have been inserted
  const attacks = (await h.app.inject({ method: 'GET', url: '/api/attacks' })).json();
  assert.equal(attacks.length, 0);
});

test('versioned export envelope: same keys plus schemaVersion/exportedAt', async (t) => {
  const h = await makeApp({ label: 'migraine-export' });
  t.after(() => h.close());
  await h.app.inject({ method: 'POST', url: '/api/import', payload: { attacks: [attack('a1', '2026-01-01T00:00:00Z')], meds: [med('m1', 'nurtec', '2026-01-01T01:00:00Z')] } });
  await h.app.inject({ method: 'PUT', url: '/api/settings/rules', payload: { nurtec: { limit: 15, windowDays: 30 } } });

  const envelope = (await h.app.inject({ method: 'GET', url: '/api/export' })).json();
  assert.equal(envelope.schemaVersion, SCHEMA_VERSION);
  assert.match(envelope.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(envelope.attacks.length, 1);
  assert.equal(envelope.meds.length, 1);
  assert.deepEqual(envelope.refills, []);
  assert.deepEqual(envelope.settings, { rules: { nurtec: { limit: 15, windowDays: 30 } } });

  // the versioned envelope re-imports cleanly (legacy path accepts it)
  const re = await h.app.inject({ method: 'POST', url: '/api/import', payload: envelope });
  assert.equal(re.statusCode, 200);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/attacks' })).json().length, 1); // duplicate ignored
});

test('import restores records from a backup JSON but not settings (known limitation)', async (t) => {
  const source = await makeApp({ label: 'migraine-restore-src' });
  t.after(source.close);
  await source.app.inject({ method: 'POST', url: '/api/import', payload: { attacks: [attack('a1', '2026-01-01T00:00:00Z')], meds: [med('m1', 'nurtec', '2026-01-01T01:00:00Z')], refills: [refill('r1', 'nurtec', '2026-01-02')] } });
  await source.app.inject({ method: 'PUT', url: '/api/settings/rules', payload: { nurtec: { limit: 15, windowDays: 30 } } });
  const backupJson = (await source.app.inject({ method: 'GET', url: '/api/export' })).body;

  const target = await makeApp({ label: 'migraine-restore-dst' });
  t.after(target.close);
  const res = await target.app.inject({ method: 'POST', url: '/api/import', payload: JSON.parse(backupJson) });
  assert.equal(res.statusCode, 200);
  const attacks = (await target.app.inject({ method: 'GET', url: '/api/attacks' })).json();
  assert.equal(attacks.length, 1);
  assert.equal((await target.app.inject({ method: 'GET', url: '/api/meds' })).json().length, 1);
  assert.equal((await target.app.inject({ method: 'GET', url: '/api/refills' })).json().length, 1);
  // settings import is NOT implemented; import ignores the settings key
  assert.deepEqual((await target.app.inject({ method: 'GET', url: '/api/settings' })).json(), {});
});

test('reset clears records and settings but preserves schema version', async (t) => {
  const h = await makeApp({ label: 'migraine-reset' });
  t.after(() => h.close());
  await h.app.inject({ method: 'POST', url: '/api/import', payload: { attacks: [attack('a1', '2026-01-01T00:00:00Z')], meds: [med('m1', 'nurtec', '2026-01-01T01:00:00Z')], refills: [refill('r1', 'nurtec', '2026-01-02')] } });
  await h.app.inject({ method: 'PUT', url: '/api/settings/rules', payload: { nurtec: { limit: 15, windowDays: 30 } } });

  const res = await h.app.inject({ method: 'POST', url: '/api/reset' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });

  const envelope = (await h.app.inject({ method: 'GET', url: '/api/export' })).json();
  assert.deepEqual(envelope.attacks, []);
  assert.deepEqual(envelope.meds, []);
  assert.deepEqual(envelope.refills, []);
  assert.deepEqual(envelope.settings, {});
  assert.equal(currentUserVersion(h.db), SCHEMA_VERSION); // migration state kept
});

test('backup dump: versioned payload, once-per-day skip, rotation', () => {
  const dir = makeTempDir('migraine-backup');
  try {
    const db = openDatabase(join(dir, 'data'), { log: () => {} });
    try {
      db.prepare(`INSERT INTO attacks (id,start) VALUES ('a1','2026-03-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO settings (key,value) VALUES ('rules','{"nurtec":{"limit":15,"windowDays":30}}')`).run();
      const backupDir = join(dir, 'backups');
      const clock = new Date('2026-03-05T09:30:00.000Z');

      const file = dumpBackup({ db, backupDir, now: clock, log: () => {} });
      assert.equal(file, join(backupDir, 'migraine-2026-03-05.json'));
      assert.ok(existsSync(file));
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
      assert.equal(parsed.exportedAt, '2026-03-05T09:30:00.000Z');
      assert.equal(parsed.attacks.length, 1);
      assert.deepEqual(parsed.meds, []);
      assert.deepEqual(parsed.refills, []);
      assert.deepEqual(parsed.settings, { rules: { nurtec: { limit: 15, windowDays: 30 } } });

      // same day again → skipped, existing file untouched
      writeFileSync(file, 'untouched-marker');
      assert.equal(dumpBackup({ db, backupDir, now: clock, log: () => {} }), null);
      assert.equal(readFileSync(file, 'utf8'), 'untouched-marker');

      // rotation runs when a new dump is written: 32 old dumps + today's
      // + tomorrow's → only the newest 31 kept
      const base = new Date('2026-01-01T00:00:00.000Z').getTime();
      for (let i = 0; i < 32; i++) {
        const day = new Date(base + i * 86400000).toISOString().slice(0, 10);
        writeFileSync(join(backupDir, `migraine-${day}.json`), 'old');
      }
      const nextDay = new Date('2026-03-06T09:30:00.000Z');
      assert.equal(dumpBackup({ db, backupDir, now: nextDay, log: () => {} }),
        join(backupDir, 'migraine-2026-03-06.json'));
      const kept = readdirSync(backupDir).filter((f) => /^migraine-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      assert.equal(kept.length, 31);
      assert.equal(kept[0], 'migraine-2026-01-04.json');
      assert.equal(kept[kept.length - 1], 'migraine-2026-03-06.json');
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
