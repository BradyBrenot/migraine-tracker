// POST /api/restore: destructive replacement semantics.
//
// The route validates the WHOLE payload (shared parser + the server's own item
// validators) before writing, then clears and re-inserts everything inside one
// SQLite transaction. These tests exercise the real app factory and
// transaction behavior against disposable temp databases only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { buildApp } from '../app.js';
import { dumpBackup } from '../backup.js';
import { SCHEMA_VERSION } from '../migrations.js';
import { isReservedSettingsKey } from '../validate.js';
import {
  MAX_BACKUP_SCHEMA_VERSION,
  isReservedBackupSettingsKey,
} from '../../shared/backup.ts';
import { makeApp, makeTempDir, cleanupDir } from './helpers.js';

const NY = 'America/New_York';

// ── fixtures ──────────────────────────────────────────────────────────
const attackRecord = (id, start, overrides = {}) => ({
  id, start, end: null, painLog: [], peakPain: -1,
  symptoms: [], triggers: [], aura: null, notes: '', source: 'import',
  ...overrides,
});

const medalRecord = (id, medId, ts) => ({
  id, medId, ts, dose: '', quantity: null, attackId: null, notes: '', source: 'import',
});

const refillRecord = (id, medId, date) => ({
  id, medId, date, quantity: null, notes: '', source: 'import',
});

const workoutRecord = (id, performedAt) => ({
  id, performedAt, kind: 'strength', effort: 'low',
  durationMinutes: null, notes: '', source: 'import',
});

const dayStateRecord = (day, status) => ({
  day, status, notes: '', updatedAt: `${day}T12:00:00.000Z`,
});

const baselineRecord = (id, effectiveAt, quantity) => ({
  id, medId: 'nurtec', effectiveAt, quantity, notes: '', source: 'import',
  createdAt: effectiveAt,
});

const REMINDERS = {
  enabled: true,
  preventive: true,
  lowStock: true,
  checkIn: true,
  exercise: true,
  weather: true,
  wakingStart: '09:00',
  wakingEnd: '21:00',
  checkInTime: '18:00',
  exerciseTime: '18:30',
  graceMinutes: 120,
};

/** A fully populated replacement envelope with every whitelisted setting but `planned`. */
const replacementEnvelope = () => ({
  schemaVersion: SCHEMA_VERSION,
  exportedAt: '2026-04-10T09:30:00.000Z',
  attacks: [{
    id: 'restore-a1',
    start: '2026-02-01T08:15:00.000Z',
    end: '2026-02-01T12:45:00.000Z',
    painLog: [{ ts: '2026-02-01T09:00:00.000Z', level: 7 }],
    peakPain: 7,
    symptoms: ['nausea'],
    triggers: ['stress'],
    aura: false,
    notes: 'restored attack',
    source: 'import',
  }],
  meds: [{
    id: 'restore-m1',
    medId: 'nurtec',
    ts: '2026-02-01T09:30:00.000Z',
    dose: '75mg',
    quantity: 1,
    attackId: 'restore-a1',
    notes: 'restored dose',
    source: 'import',
  }],
  refills: [{
    id: 'restore-r1',
    medId: 'nurtec',
    date: '2026-02-02',
    quantity: 8,
    notes: 'pharmacy',
    source: 'import',
  }],
  workouts: [{
    id: 'restore-w1',
    performedAt: '2026-02-01T18:00:00.000Z',
    kind: 'cardio',
    effort: 'hard',
    durationMinutes: 30,
    notes: 'restored workout',
    source: 'import',
  }],
  dayStates: [{
    day: '2026-02-01',
    status: 'attack',
    notes: 'rough day',
    updatedAt: '2026-02-01T20:00:00.000Z',
  }],
  stockBaselines: [{
    id: 'restore-b1',
    medId: 'nurtec',
    effectiveAt: '2026-02-01T00:00:00.000Z',
    quantity: 8,
    notes: 'initial stock',
    source: 'import',
    createdAt: '2026-02-01T00:00:05.000Z',
  }],
  settings: {
    rules: { nurtec: { limit: 15, windowDays: 30 } },
    doses: { nurtec: '75mg' },
    timezone: NY,
    lowStockThreshold: 3,
    lowStockAlert: { latchedAt: '2026-04-09T12:00:00.000Z' },
    reminders: { ...REMINDERS },
  },
});

async function makeRestoreApp({ label = 'migraine-restore', onAttackChange } = {}) {
  const dir = makeTempDir(label);
  const dataDir = join(dir, 'data');
  const db = openDatabase(dataDir, { log: () => {} });
  const app = await buildApp({ db, logger: false, onAttackChange });
  return {
    app,
    db,
    dir,
    dataDir,
    close: async () => {
      await app.close(); // onClose hook closes the database
      cleanupDir(dir);
    },
  };
}

async function seedExistingData(h) {
  const res = await Promise.all([
    h.app.inject({ method: 'POST', url: '/api/attacks', payload: attackRecord('old-a1', '2026-01-01T00:00:00.000Z') }),
    h.app.inject({ method: 'POST', url: '/api/meds', payload: medalRecord('old-m1', 'nurtec', '2026-01-01T01:00:00.000Z') }),
    h.app.inject({ method: 'POST', url: '/api/refills', payload: refillRecord('old-r1', 'nurtec', '2026-01-02') }),
    h.app.inject({ method: 'POST', url: '/api/workouts', payload: workoutRecord('old-w1', '2026-01-01T18:00:00.000Z') }),
    h.app.inject({ method: 'PUT', url: '/api/day-states/2026-01-05', payload: { status: 'well', notes: 'old' } }),
    h.app.inject({ method: 'POST', url: '/api/stock-baselines', payload: { medId: 'nurtec', effectiveAt: '2026-01-01T00:00:00.000Z', quantity: 4 } }),
    // timezone bodies are JSON strings, so the content type must be explicit
    h.app.inject({
      method: 'PUT',
      url: '/api/settings/timezone',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify('UTC'),
    }),
    h.app.inject({ method: 'PUT', url: '/api/settings/planned', payload: { botox: '2026-06-01' } }),
    h.app.inject({ method: 'PUT', url: '/api/settings/rules', payload: { nurtec: { limit: 5, windowDays: 10 } } }),
  ]);
  for (const r of res) assert.ok(r.statusCode === 200 || r.statusCode === 201, `seed failed: ${r.statusCode}`);
}

const stripExportedAt = (envelope) => {
  const { exportedAt, ...rest } = envelope;
  return rest;
};

const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// ── full replacement ─────────────────────────────────────────────────
test('restore replaces every record type and the whitelisted settings', async (t) => {
  const h = await makeApp({ label: 'migraine-restore-roundtrip' });
  t.after(() => h.close());
  await seedExistingData(h);

  const payload = replacementEnvelope();
  const res = await h.app.inject({ method: 'POST', url: '/api/restore', payload });
  assert.equal(res.statusCode, 200);
  const envelope = res.json();

  // The response is the canonical export, so a follow-up GET must match it
  // exactly apart from the export timestamp.
  const exported = (await h.app.inject({ method: 'GET', url: '/api/export' })).json();
  assert.deepEqual(stripExportedAt(envelope), stripExportedAt(exported));
  assert.equal(envelope.schemaVersion, SCHEMA_VERSION);

  // Exact field round-trip for every record type; old rows are gone.
  assert.deepEqual(envelope.attacks, payload.attacks);
  assert.deepEqual(envelope.meds, payload.meds);
  assert.deepEqual(envelope.refills, payload.refills);
  assert.deepEqual(envelope.workouts, payload.workouts);
  assert.deepEqual(envelope.dayStates, payload.dayStates);
  assert.deepEqual(envelope.stockBaselines, payload.stockBaselines);
  for (const table of ['attacks', 'meds', 'refills', 'workouts', 'day_states', 'stock_baselines']) {
    const ids = h.db.prepare(`SELECT * FROM ${table}`).all();
    assert.equal(ids.length, 1, `${table} holds exactly the restored row`);
  }

  // Settings are REPLACED, not merged: `planned` was seeded but absent from the
  // backup, so it must be gone. Everything present round-trips.
  assert.deepEqual(envelope.settings, payload.settings);
  assert.equal(Object.hasOwn(exported.settings, 'planned'), false);
  const settingsRows = h.db.prepare('SELECT key FROM settings ORDER BY key').all().map((r) => r.key);
  assert.deepEqual(settingsRows, [
    'doses', 'lowStockAlert', 'lowStockThreshold', 'reminders', 'rules', 'timezone',
  ]);
});

test('restore clears internal reminder state', async (t) => {
  const h = await makeApp({ label: 'migraine-restore-reminders' });
  t.after(() => h.close());
  h.db.prepare(`INSERT INTO reminder_occurrences
    (key,type,med_id,scheduled_at,expires_at,status,attempt,next_attempt_at,created_at,updated_at)
    VALUES ('checkin:2026-01-05','checkin',NULL,'2026-01-05T18:00:00.000Z','2026-01-05T20:00:00.000Z',
      'succeeded',1,'2026-01-05T18:00:00.000Z','2026-01-05T17:00:00.000Z','2026-01-05T18:00:00.000Z')`).run();
  h.db.prepare(`INSERT INTO reminder_state (key,value,updated_at)
    VALUES ('stock:nurtec:latched','{"latchedAt":"2026-01-05T00:00:00.000Z"}','2026-01-05T00:00:00.000Z')`).run();
  await seedExistingData(h);

  const res = await h.app.inject({ method: 'POST', url: '/api/restore', payload: replacementEnvelope() });
  assert.equal(res.statusCode, 200);
  assert.equal(countRows(h.db, 'reminder_occurrences'), 0);
  assert.equal(countRows(h.db, 'reminder_state'), 0);
});

test('restore accepts a flattened browser export and maps lowStockAlertedAt', async (t) => {
  const h = await makeApp({ label: 'migraine-restore-browser' });
  t.after(() => h.close());
  await seedExistingData(h);

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/restore',
    payload: {
      attacks: [attackRecord('browser-a1', '2026-03-03T09:00:00.000Z')],
      meds: [medalRecord('browser-m1', 'nurtec', '2026-03-03T10:00:00.000Z')],
      refills: [refillRecord('browser-r1', 'nurtec', '2026-03-04')],
      workouts: [workoutRecord('browser-w1', '2026-03-03T18:00:00.000Z')],
      dayStates: [dayStateRecord('2026-03-03', 'off')],
      stockBaselines: [baselineRecord('browser-b1', '2026-03-03T00:00:00.000Z', 6)],
      rules: { nurtec: { limit: 12, windowDays: 30 } },
      doses: { nurtec: '75mg' },
      planned: { botox: '2026-07-01' },
      timezone: NY,
      lowStockThreshold: 4,
      lowStockAlertedAt: '2026-03-05T06:07:08.000Z',
      reminders: { ...REMINDERS },
      seeded: true,
    },
  });
  assert.equal(res.statusCode, 200);
  const envelope = res.json();
  assert.equal(envelope.attacks[0].id, 'browser-a1');
  assert.equal(envelope.attacks.length, 1);
  assert.equal(envelope.dayStates[0].day, '2026-03-03');
  assert.deepEqual(envelope.settings.lowStockAlert, { latchedAt: '2026-03-05T06:07:08.000Z' });
  assert.equal(envelope.settings.lowStockThreshold, 4);
  assert.equal(Object.hasOwn(envelope.settings, 'seeded'), false);
  const seededRow = h.db.prepare("SELECT value FROM settings WHERE key = 'seeded'").get();
  assert.equal(seededRow, undefined);
});

test('an empty envelope wipes everything and returns an empty canonical export', async (t) => {
  const h = await makeApp({ label: 'migraine-restore-empty' });
  t.after(() => h.close());
  await seedExistingData(h);
  h.db.prepare(`INSERT INTO reminder_state (key,value,updated_at)
    VALUES ('stock:nurtec:latched','1','2026-01-05T00:00:00.000Z')`).run();

  const res = await h.app.inject({ method: 'POST', url: '/api/restore', payload: { schemaVersion: SCHEMA_VERSION } });
  assert.equal(res.statusCode, 200);
  const envelope = res.json();
  assert.deepEqual(envelope.attacks, []);
  assert.deepEqual(envelope.meds, []);
  assert.deepEqual(envelope.refills, []);
  assert.deepEqual(envelope.workouts, []);
  assert.deepEqual(envelope.dayStates, []);
  assert.deepEqual(envelope.stockBaselines, []);
  assert.deepEqual(envelope.settings, {});
  for (const table of ['attacks', 'meds', 'refills', 'workouts', 'day_states', 'stock_baselines', 'settings', 'reminder_state']) {
    assert.equal(countRows(h.db, table), 0, `${table} must be empty`);
  }
});

// ── rejections keep existing data ────────────────────────────────────
test('invalid restore requests are rejected with the current data intact', async (t) => {
  const h = await makeApp({ label: 'migraine-restore-reject' });
  t.after(() => h.close());
  await seedExistingData(h);
  const before = (await h.app.inject({ method: 'GET', url: '/api/export' })).json();

  const cases = [
    // a missing body must never be read as "wipe everything"
    [{ method: 'POST', url: '/api/restore' }, /backup must be a JSON object/],
    [{ method: 'POST', url: '/api/restore', payload: {} }, /unrecognized backup format/],
    [{ method: 'POST', url: '/api/restore', payload: { attacks: [{ id: 'x' }] } }, /attacks\[0\]: .*start/],
    [{ method: 'POST', url: '/api/restore', payload: { schemaVersion: SCHEMA_VERSION + 1 } }, /schemaVersion/],
    [{ method: 'POST', url: '/api/restore', payload: { schemaVersion: SCHEMA_VERSION, settings: { ntfyUrl: 'https://ntfy.example/topic' } } }, /ntfyUrl/],
    [{ method: 'POST', url: '/api/restore', payload: { schemaVersion: SCHEMA_VERSION, settings: { timezone: 'Not/AZone' } } }, /timezone/],

    // strict settings shapes: lookup objects and the low-stock latch must be
    // usable after a restore, and secret-looking names anywhere inside them
    // fail the whole parse (never silently dropped).
    [{
      method: 'POST',
      url: '/api/restore',
      payload: { schemaVersion: SCHEMA_VERSION, settings: { rules: { nurtec: 5 } } },
    }, /rules\[nurtec\] must be an object/],
    [{
      method: 'POST',
      url: '/api/restore',
      payload: { schemaVersion: SCHEMA_VERSION, settings: { rules: { nurtec: { limit: '10', windowDays: 30 } } } },
    }, /rules\[nurtec\]\.limit must be an integer >= 0/],
    [{
      method: 'POST',
      url: '/api/restore',
      payload: { schemaVersion: SCHEMA_VERSION, settings: { rules: { nurtec: { limit: -1, windowDays: 30 } } } },
    }, /rules\[nurtec\]\.limit must be an integer >= 0/],
    [{
      method: 'POST',
      url: '/api/restore',
      payload: { schemaVersion: SCHEMA_VERSION, settings: { doses: { nurtec: 42 } } },
    }, /doses\[nurtec\] must be a string/],
    [{
      method: 'POST',
      url: '/api/restore',
      payload: { schemaVersion: SCHEMA_VERSION, settings: { planned: { botox: '2026-02-30' } } },
    }, /planned\[botox\] must be a YYYY-MM-DD date/],
    [{
      method: 'POST',
      url: '/api/restore',
      payload: { schemaVersion: SCHEMA_VERSION, settings: { planned: { botox: '2026-13-01' } } },
    }, /planned\[botox\] must be a YYYY-MM-DD date/],
    [{
      method: 'POST',
      url: '/api/restore',
      payload: { schemaVersion: SCHEMA_VERSION, settings: { lowStockAlert: { latchedAt: 'yesterday' } } },
    }, /lowStockAlert\.latchedAt must be a full ISO 8601 instant or null/],
    [{
      method: 'POST',
      url: '/api/restore',
      payload: {
        schemaVersion: SCHEMA_VERSION,
        settings: { rules: { nurtec: { limit: 10, windowDays: 30, ntfyToken: 'x' } } },
      },
    }, /rules entry 'nurtec' must not contain 'ntfyToken'/],
    [{
      method: 'POST',
      url: '/api/restore',
      payload: { schemaVersion: SCHEMA_VERSION, settings: { planned: { ntfyToken: '2026-01-01' } } },
    }, /planned entry 'ntfyToken' must not be a reserved secret name/],
  ];
  for (const [request, pattern] of cases) {
    const res = await h.app.inject(request);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(request.payload ?? '<no body>')}`);
    assert.match(res.json().error, pattern);
  }

  // duplicate explicit ids: a replacement must be exact, so this fails instead
  // of silently keeping the first row like additive import would.
  const dup = await h.app.inject({
    method: 'POST',
    url: '/api/restore',
    payload: {
      schemaVersion: SCHEMA_VERSION,
      attacks: [
        attackRecord('dup-a', '2026-02-01T00:00:00.000Z'),
        attackRecord('dup-a', '2026-02-02T00:00:00.000Z'),
      ],
      dayStates: [dayStateRecord('2026-02-03', 'well'), dayStateRecord('2026-02-03', 'off')],
    },
  });
  assert.equal(dup.statusCode, 400);
  assert.match(dup.json().error, /duplicate ids in attacks: 1, dayStates: 1/);

  // Nothing was written by any of the rejected requests.
  const after = (await h.app.inject({ method: 'GET', url: '/api/export' })).json();
  assert.deepEqual(stripExportedAt(after), stripExportedAt(before));
  const leakedSecret = h.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE '%ntfy%'").get();
  assert.equal(leakedSecret.n, 0);
});

// ── forced write failure must roll back atomically ───────────────────
/**
 * Proxies the database handle so a statement matching `throwOnPrepare` (or a
 * `run` on a statement matching `throwOnRun`) fails, simulating a write error
 * in the middle of the restore transaction. Everything else passes through.
 */
function failingDb(db, { throwOnPrepare, throwOnRun } = {}) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql, ...rest) => {
          if (throwOnPrepare && sql.includes(throwOnPrepare)) {
            throw new Error('forced prepare failure');
          }
          const statement = target.prepare(sql, ...rest);
          if (throwOnRun && sql.includes(throwOnRun)) {
            return new Proxy(statement, {
              get(stmt, method) {
                if (method === 'run') {
                  return () => { throw new Error('forced write failure'); };
                }
                const value = stmt[method];
                return typeof value === 'function' ? value.bind(stmt) : value;
              },
            });
          }
          return statement;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function seedRaw(db) {
  db.prepare(`INSERT INTO attacks (id,start,source) VALUES ('old-a1','2026-01-01T00:00:00.000Z','import')`).run();
  db.prepare(`INSERT INTO meds (id,med_id,ts,source) VALUES ('old-m1','nurtec','2026-01-01T01:00:00.000Z','import')`).run();
  db.prepare(`INSERT INTO day_states (day,status,updated_at) VALUES ('2026-01-05','well','2026-01-05T12:00:00.000Z')`).run();
  db.prepare(`INSERT INTO settings (key,value) VALUES ('planned','{"botox":"2026-06-01"}')`).run();
  db.prepare(`INSERT INTO reminder_state (key,value,updated_at) VALUES ('kept','1','2026-01-05T00:00:00.000Z')`).run();
}

test('a forced write failure mid-transaction rolls the whole restore back', async (t) => {
  const dirs = [];
  const handles = [];
  const apps = [];
  // Release every handle even when an assertion fails early; on Windows an
  // open SQLite handle blocks temp-dir cleanup. Closing twice is harmless
  // because each close is guarded.
  t.after(async () => {
    for (const app of apps) {
      try {
        await app.close();
      } catch {
        // already closed
      }
    }
    for (const handle of handles) {
      try {
        handle.close();
      } catch {
        // already closed
      }
    }
    for (const dir of dirs) cleanupDir(dir);
  });

  // Failure points ordered along the restore transaction. The record inserts
  // run attacks -> meds -> refills -> workouts -> day_states -> stock_baselines,
  // with settings last, so these cover an early, a mid-record and a
  // final-stage failure, plus the post-write canonical-export read that now
  // runs inside the transaction (before COMMIT). Every case must prove the
  // ROLLBACK removed the rows whose inserts already ran before the failing
  // statement.
  const scenarios = [
    {
      label: 'prepare-settings',
      // SANITY ONLY: this throws while the statement is being PREPARED, which
      // happens before db.exec('BEGIN') — nothing has been written yet, so it
      // does not prove a mid-transaction rollback. Kept to pin the 500 shape.
      failure: { throwOnPrepare: 'INSERT INTO settings' },
      expected: /forced prepare failure/,
    },
    {
      label: 'run-attacks',
      failure: { throwOnRun: 'INSERT INTO attacks' },
      expected: /forced write failure/,
    },
    {
      label: 'run-workouts',
      failure: { throwOnRun: 'INSERT INTO workouts' },
      expected: /forced write failure/,
    },
    {
      label: 'run-settings',
      failure: { throwOnRun: 'INSERT INTO settings' },
      expected: /forced write failure/,
    },
    {
      // The real "read the canonical export inside the transaction" proof: the
      // route only PREPAREs INSERT statements (deletes go through db.exec), so
      // failing the exportEnvelope read of attacks happens after ALL writes
      // ran and before COMMIT. A 500 here must leave the old data untouched.
      label: 'export-attacks',
      failure: { throwOnPrepare: 'SELECT * FROM attacks' },
      expected: /forced prepare failure/,
    },
  ];

  for (const { label, failure, expected } of scenarios) {
    const dir = makeTempDir(`migraine-restore-fail-${label}`);
    dirs.push(dir);
    const db = openDatabase(join(dir, 'data'), { log: () => {} });
    handles.push(db);
    seedRaw(db);
    const app = await buildApp({ db: failingDb(db, failure), logger: false });
    apps.push(app);

    const res = await app.inject({
      method: 'POST', url: '/api/restore', payload: replacementEnvelope(),
    });
    assert.equal(res.statusCode, 500, `${label}: a failed transaction must surface as 500`);
    // The 500 must come from the injected failure, not from an unrelated bug.
    assert.match(
      String(res.json().message ?? res.json().error ?? ''),
      expected,
      `${label}: unexpected failure reason`,
    );

    const column = (table, name) =>
      db.prepare(`SELECT ${name} AS v FROM ${table} ORDER BY ${name}`).all().map((r) => r.v);

    // Every original seeded row survived...
    assert.deepEqual(column('attacks', 'id'), ['old-a1'], `${label}: attacks kept`);
    assert.deepEqual(column('meds', 'id'), ['old-m1'], `${label}: meds kept`);
    assert.deepEqual(column('day_states', 'day'), ['2026-01-05'], `${label}: day states kept`);
    assert.deepEqual(column('settings', 'key'), ['planned'], `${label}: settings kept`);
    assert.deepEqual(column('reminder_state', 'key'), ['kept'], `${label}: reminder state kept`);
    assert.equal(
      db.prepare("SELECT value FROM settings WHERE key = 'planned'").get().value,
      '{"botox":"2026-06-01"}',
      `${label}: the settings value is unchanged`,
    );

    // ...and ZERO restored rows exist in ANY user table, including the ones
    // whose inserts ran before the failure.
    const restoredRowWhere = {
      attacks: "id LIKE 'restore-%'",
      meds: "id LIKE 'restore-%'",
      refills: "id LIKE 'restore-%'",
      workouts: "id LIKE 'restore-%'",
      stock_baselines: "id LIKE 'restore-%'",
      // day_states are keyed by day; the backup carries 2026-02-01 and the
      // seed keeps 2026-01-05.
      day_states: "day = '2026-02-01'",
    };
    for (const [table, where] of Object.entries(restoredRowWhere)) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n,
        0,
        `${label}: ${table} must not hold partial backup rows`,
      );
    }
    for (const table of ['refills', 'workouts', 'stock_baselines']) {
      assert.equal(countRows(db, table), 0, `${label}: ${table} must be empty`);
    }

    await app.close(); // releases `db` through the onClose hook
  }
});

// ── body size limit ──────────────────────────────────────────────────
// Pretty-printed nightly dumps are far larger than Fastify's 1 MiB default,
// so both bulk routes declare an explicit 25 MiB per-route limit.
test('restore accepts a multi-megabyte backup and rejects one over 25 MiB', async (t) => {
  const h = await makeApp({ label: 'migraine-restore-bodysize' });
  t.after(() => h.close());

  // ~3 MiB of attacks: comfortably over the 1 MiB default, well under 25 MiB.
  const attacks = Array.from({ length: 3 }, (_, i) =>
    attackRecord(`big-a${i}`, `2026-02-0${i + 1}T00:00:00.000Z`, {
      notes: 'x'.repeat(1024 * 1024),
    }));
  const payload = { schemaVersion: SCHEMA_VERSION, attacks };
  const size = Buffer.byteLength(JSON.stringify(payload));
  assert.ok(size > 1024 * 1024, `payload must exceed the 1 MiB default (got ${size})`);
  assert.ok(size < 25 * 1024 * 1024, `payload must stay under the route limit (got ${size})`);

  const res = await h.app.inject({ method: 'POST', url: '/api/restore', payload });
  assert.equal(res.statusCode, 200);
  const exported = (await h.app.inject({ method: 'GET', url: '/api/export' })).json();
  assert.equal(exported.attacks.length, attacks.length);
  assert.equal(exported.attacks[0].notes.length, 1024 * 1024);

  // One byte over the per-route limit must be refused by the content-type
  // parser (413), and the accepted restore above must stay untouched.
  const tooBig = {
    schemaVersion: SCHEMA_VERSION,
    attacks: [attackRecord('huge-a1', '2026-02-01T00:00:00.000Z', {
      notes: 'x'.repeat(26 * 1024 * 1024),
    })],
  };
  const over = await h.app.inject({ method: 'POST', url: '/api/restore', payload: tooBig });
  assert.equal(over.statusCode, 413);

  const after = (await h.app.inject({ method: 'GET', url: '/api/export' })).json();
  assert.equal(after.attacks.length, attacks.length);
});

// ── the real nightly artifact must restore ──────────────────────────
test('a nightly-dump artifact round-trips through POST /api/restore', async (t) => {
  const source = await makeApp({ label: 'migraine-restore-dump-source' });
  t.after(() => source.close());
  await seedExistingData(source);
  // Cover every restorable settings kind, not just the ones the shared seed
  // writes (doses / the latch / reminders).
  for (const [key, value] of [
    ['doses', { nurtec: '75mg', botox: '155u' }],
    ['lowStockAlert', { latchedAt: '2026-01-06T00:00:00.000Z' }],
    ['reminders', { ...REMINDERS }],
  ]) {
    const res = await source.app.inject({ method: 'PUT', url: `/api/settings/${key}`, payload: value });
    assert.equal(res.statusCode, 200, `PUT /api/settings/${key} failed`);
  }

  const backupDir = join(source.dir, 'backups');
  const file = dumpBackup({ db: source.db, backupDir, now: new Date(), log: () => {} });
  assert.ok(file, 'the nightly dump must be written');
  const text = readFileSync(file, 'utf8');
  // The production artifact is pretty-printed; restore must accept that exact
  // file, not a compacted variant of it.
  assert.ok(text.includes('\n  "attacks"'), 'the dump must be pretty-printed');
  const artifact = JSON.parse(text);
  assert.equal(artifact.schemaVersion, SCHEMA_VERSION);

  const target = await makeApp({ label: 'migraine-restore-dump-target' });
  t.after(() => target.close());
  const res = await target.app.inject({ method: 'POST', url: '/api/restore', payload: artifact });
  assert.equal(res.statusCode, 200, `restore of the dump failed: ${res.body}`);

  const expected = (await source.app.inject({ method: 'GET', url: '/api/export' })).json();
  const actual = (await target.app.inject({ method: 'GET', url: '/api/export' })).json();
  // Sanity: the dump really carried several record types plus settings.
  for (const key of ['attacks', 'meds', 'refills', 'workouts', 'dayStates', 'stockBaselines', 'settings']) {
    assert.ok(
      Array.isArray(expected[key]) ? expected[key].length >= 1 : Object.keys(expected[key]).length >= 1,
      `${key} must be populated in the source app`,
    );
  }
  assert.deepEqual(stripExportedAt(actual), stripExportedAt(expected));
  assert.deepEqual(actual.settings, expected.settings);
});

// ── side effects and compatibility ───────────────────────────────────
test('restore never fires the direct attack alert callback', async (t) => {
  const events = [];
  const h = await makeRestoreApp({
    label: 'migraine-restore-noalert',
    onAttackChange: (event) => events.push(event),
  });
  t.after(() => h.close());

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/restore',
    payload: { schemaVersion: SCHEMA_VERSION, attacks: [attackRecord('alert-a1', '2026-02-01T00:00:00.000Z')] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(events, []);
});

test('/api/import stays additive (INSERT OR IGNORE) next to the restore route', async (t) => {
  const h = await makeApp({ label: 'migraine-restore-import' });
  t.after(() => h.close());

  const first = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: { attacks: [attackRecord('keep-a1', '2026-01-01T00:00:00.000Z')] },
  });
  assert.equal(first.statusCode, 200);
  const second = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: { attacks: [attackRecord('keep-a1', '2030-12-31T00:00:00.000Z')] },
  });
  assert.equal(second.statusCode, 200);
  const attacks = (await h.app.inject({ method: 'GET', url: '/api/attacks' })).json();
  assert.equal(attacks.length, 1);
  assert.equal(attacks[0].start, '2026-01-01T00:00:00.000Z'); // original kept, never replaced
});

// ── contract invariants ──────────────────────────────────────────────
test('MAX_BACKUP_SCHEMA_VERSION tracks the server schema version', () => {
  assert.equal(MAX_BACKUP_SCHEMA_VERSION, SCHEMA_VERSION);
});

test('isReservedBackupSettingsKey agrees with the server policy', () => {
  const probes = [
    'ntfyUrl', 'NTFY_TOKEN', 'public-app-url', 'apikey', 'mysecret', 'tokenX',
    'rules', 'doses', 'planned', 'timezone', 'lowStockThreshold', 'lowStockAlert',
    'reminders', 'seeded', 'authorization', 'bearer_token', 'credential',
  ];
  for (const key of probes) {
    assert.equal(
      isReservedBackupSettingsKey(key),
      isReservedSettingsKey(key),
      `reserved-key policy disagrees for ${key}`,
    );
  }
});
