// Schema v2: workouts + day states. Covers the additive migration, validated
// CRUD/upsert routes, and deliberate export/import/backup/reset inclusion.
// Every database lives in a disposable temp dir; requests use inject() only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db.js';
import { currentUserVersion, SCHEMA_VERSION } from '../migrations.js';
import { dumpBackup } from '../backup.js';
import { isValidIsoInstant } from '../validate.js';
import { makeApp, makeTempDir, cleanupDir, LEGACY_DDL } from './helpers.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const workout = (overrides = {}) => ({
  performedAt: '2026-03-01T07:00:00.000Z', kind: 'strength', effort: 'medium', ...overrides,
});

const tableNames = (db) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
).all().map((r) => r.name).sort();

// ── migrations ────────────────────────────────────────────────────────
test('fresh database reaches the current schema with workouts and day_states', () => {
  const dir = makeTempDir('migraine-v2-fresh');
  try {
    const db = openDatabase(dir, { log: () => {} });
    try {
      assert.equal(SCHEMA_VERSION, 4);
      assert.equal(currentUserVersion(db), SCHEMA_VERSION);
      assert.ok(tableNames(db).includes('workouts'));
      assert.ok(tableNames(db).includes('day_states'));
      assert.ok(tableNames(db).includes('reminder_occurrences'));
      assert.ok(tableNames(db).includes('reminder_state'));
      // NOT NULL + defaults behave as designed
      db.prepare(`INSERT INTO workouts (id,performed_at,kind,effort) VALUES ('w1','2026-01-01T00:00:00Z','cardio','low')`).run();
      const w = db.prepare('SELECT * FROM workouts WHERE id = ?').get('w1');
      assert.equal(w.duration_minutes, null);
      assert.equal(w.notes, '');
      assert.equal(w.source, 'manual');
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('legacy v0 database upgrades to the current schema without data loss and gains both tables', () => {
  const dir = makeTempDir('migraine-v2-from-v0');
  try {
    const file = join(dir, 'migraine.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY_DDL);
    legacy.prepare(`INSERT INTO attacks (id,start,notes) VALUES ('atk1','2025-06-01T08:00:00Z','legacy')`).run();
    legacy.prepare(`INSERT INTO meds (id,med_id,ts) VALUES ('m1','nurtec','2025-06-01T09:00:00Z')`).run();
    legacy.prepare(`INSERT INTO refills (id,med_id,date) VALUES ('r1','nurtec','2025-05-20')`).run();
    legacy.prepare(`INSERT INTO settings (key,value) VALUES ('rules','{}')`).run();
    assert.equal(currentUserVersion(legacy), 0);
    legacy.close();

    const db = openDatabase(dir, { log: () => {} });
    try {
      assert.equal(currentUserVersion(db), SCHEMA_VERSION);
      assert.ok(tableNames(db).includes('workouts'));
      assert.ok(tableNames(db).includes('day_states'));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attacks').get().n, 1);
      assert.equal(db.prepare('SELECT notes FROM attacks WHERE id = ?').get('atk1').notes, 'legacy');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meds').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refills').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 1);
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('v1 database upgrades to the current schema without data loss and gains both tables', () => {
  const dir = makeTempDir('migraine-v2-from-v1');
  try {
    const file = join(dir, 'migraine.db');
    const v1 = new DatabaseSync(file);
    v1.exec(LEGACY_DDL);
    v1.exec('PRAGMA user_version = 1');
    v1.prepare(`INSERT INTO attacks (id,start) VALUES ('atk1','2026-01-01T00:00:00Z')`).run();
    v1.prepare(`INSERT INTO refills (id,med_id,date) VALUES ('r1','nurtec','2026-01-02')`).run();
    assert.equal(currentUserVersion(v1), 1);
    v1.close();

    const db = openDatabase(dir, { log: () => {} });
    try {
      assert.equal(currentUserVersion(db), SCHEMA_VERSION);
      assert.deepEqual(
        tableNames(db),
        [
          'attacks', 'day_states', 'meds', 'refills', 'reminder_occurrences',
          'reminder_state', 'settings', 'stock_baselines', 'workouts',
        ],
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attacks').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refills').get().n, 1);
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ── workouts CRUD ─────────────────────────────────────────────────────
test('workout POST applies documented defaults and returns 201', async (t) => {
  const h = await makeApp({ label: 'migraine-workout-post' });
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'POST', url: '/api/workouts', payload: workout() });
  assert.equal(res.statusCode, 201);
  const created = res.json();
  assert.match(created.id, /^./);
  assert.deepEqual(created, {
    id: created.id,
    performedAt: '2026-03-01T07:00:00.000Z',
    kind: 'strength',
    effort: 'medium',
    durationMinutes: null,
    notes: '',
    source: 'manual',
  });

  // full payload round-trips
  const full = await h.app.inject({
    method: 'POST', url: '/api/workouts',
    payload: workout({ kind: 'cardio', effort: 'hard', durationMinutes: 45, notes: 'tempo', source: 'manual' }),
  });
  assert.equal(full.statusCode, 201);
  assert.equal(full.json().durationMinutes, 45);
  assert.equal(full.json().notes, 'tempo');

  // durationMinutes: 0 is a valid integer
  const zero = await h.app.inject({
    method: 'POST', url: '/api/workouts', payload: workout({ durationMinutes: 0 }),
  });
  assert.equal(zero.statusCode, 201);
  assert.equal(zero.json().durationMinutes, 0);
});

test('workout GET is ordered by performedAt; PATCH merges only provided keys', async (t) => {
  const h = await makeApp({ label: 'migraine-workout-patch' });
  t.after(() => h.close());

  const later = (await h.app.inject({
    method: 'POST', url: '/api/workouts',
    payload: workout({ performedAt: '2026-03-05T07:00:00.000Z', durationMinutes: 30 }),
  })).json();
  const earlier = (await h.app.inject({
    method: 'POST', url: '/api/workouts',
    payload: workout({ performedAt: '2026-03-02T07:00:00.000Z', kind: 'mobility', effort: 'low' }),
  })).json();

  const list = (await h.app.inject({ method: 'GET', url: '/api/workouts' })).json();
  assert.deepEqual(list.map((w) => w.id), [earlier.id, later.id]);

  // changing kind keeps effort and the rest
  const changed = (await h.app.inject({
    method: 'PATCH', url: `/api/workouts/${later.id}`, payload: { kind: 'cardio' },
  })).json();
  assert.equal(changed.kind, 'cardio');
  assert.equal(changed.effort, 'medium'); // untouched
  assert.equal(changed.durationMinutes, 30); // untouched
  assert.equal(changed.notes, '');

  // explicit null clears the nullable column; missing key keeps it
  const cleared = (await h.app.inject({
    method: 'PATCH', url: `/api/workouts/${later.id}`, payload: { durationMinutes: null },
  })).json();
  assert.equal(cleared.durationMinutes, null);
  assert.equal(cleared.kind, 'cardio');

  const kept = (await h.app.inject({
    method: 'PATCH', url: `/api/workouts/${later.id}`, payload: { notes: 'after' },
  })).json();
  assert.equal(kept.notes, 'after');
  assert.equal(kept.durationMinutes, null);

  // route id wins over a body id
  const idWins = (await h.app.inject({
    method: 'PATCH', url: `/api/workouts/${later.id}`, payload: { id: 'other', effort: 'hard' },
  })).json();
  assert.equal(idWins.id, later.id);
  assert.equal(idWins.effort, 'hard');
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/workouts' })).json().length, 2);
});

test('workout DELETE removes the row; unknown ids 404; invalid patches change nothing', async (t) => {
  const h = await makeApp({ label: 'migraine-workout-delete' });
  t.after(() => h.close());

  const created = (await h.app.inject({ method: 'POST', url: '/api/workouts', payload: workout() })).json();
  const del = await h.app.inject({ method: 'DELETE', url: `/api/workouts/${created.id}` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { ok: true });
  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/workouts' })).json(), []);

  assert.equal((await h.app.inject({ method: 'DELETE', url: `/api/workouts/${created.id}` })).statusCode, 404);
  assert.equal((await h.app.inject({
    method: 'PATCH', url: '/api/workouts/nope', payload: { notes: 'x' },
  })).statusCode, 404);

  // a rejected patch leaves the stored row untouched
  const kept = (await h.app.inject({ method: 'POST', url: '/api/workouts', payload: workout() })).json();
  const bad = await h.app.inject({
    method: 'PATCH', url: `/api/workouts/${kept.id}`, payload: { kind: 'run' },
  });
  assert.equal(bad.statusCode, 400);
  const after = (await h.app.inject({ method: 'GET', url: '/api/workouts' })).json();
  assert.equal(after.length, 1);
  assert.equal(after[0].kind, 'strength');
});

test('workout write validation: 400 with nothing inserted', async (t) => {
  const h = await makeApp({ label: 'migraine-workout-invalid' });
  t.after(() => h.close());

  const badBodies = [
    workout({ kind: 'run' }),
    workout({ effort: 'LOW' }),                    // case matters
    workout({ effort: 'low ' }),
    workout({ durationMinutes: -5 }),
    workout({ durationMinutes: 2.5 }),
    workout({ durationMinutes: '30' }),
    workout({ durationMinutes: true }),
    workout({ performedAt: undefined }),           // missing
    workout({ performedAt: null }),                // explicit null (NOT NULL)
    workout({ performedAt: '' }),
    workout({ performedAt: 'not-a-timestamp' }),   // arbitrary string
    workout({ performedAt: '2026-03-01' }),        // date only
    workout({ performedAt: '2026-03-01T07:00:00' }),           // no timezone
    workout({ performedAt: '2026-03-01T07:00:00.000' }),       // fraction, no timezone
    workout({ performedAt: '2026-03-01T24:00:00.000Z' }),      // hour 24
    workout({ performedAt: '2026-03-01T07:60:00.000Z' }),      // minute 60
    workout({ performedAt: '2026-02-30T07:00:00.000Z' }),      // impossible date
    workout({ performedAt: 42 }),                  // not a string
    workout({ kind: undefined }),                  // missing kind
    workout({ effort: undefined }),                // missing effort
    workout({ kind: null }),
    workout({ notes: 5 }),
    workout({ source: 7 }),
    { id: 42, ...workout() },
  ];
  for (const payload of badBodies) {
    const res = await h.app.inject({ method: 'POST', url: '/api/workouts', payload });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    assert.ok(res.json().error);
  }
  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/workouts' })).json(), []);
});

test('performedAt accepts canonical and explicit-offset instants, stored verbatim', async (t) => {
  const h = await makeApp({ label: 'migraine-workout-instant-forms' });
  t.after(() => h.close());

  // canonical Z (frontend toISOString) plus legitimate full-ISO backup
  // forms with explicit offsets; values are never normalised
  const forms = [
    '2026-03-01T07:00:00.000Z',
    '2026-03-01T07:00:00Z',
    '2026-03-01t07:00:00.000z', // RFC 3339 lowercase t/z
    '2026-03-01T09:00:00+05:30',
    '2026-03-01T09:00:00+0530',
    '2026-02-28T21:15:00.5-03:00',
  ];
  for (const [i, performedAt] of forms.entries()) {
    const res = await h.app.inject({
      method: 'POST', url: '/api/workouts',
      payload: workout({ id: `w-form-${i}`, performedAt }),
    });
    assert.equal(res.statusCode, 201, `expected 201 for ${performedAt}`);
    assert.equal(res.json().performedAt, performedAt);
  }
});

test('workout PATCH rejects bad performedAt without touching the row; valid offsets patch through', async (t) => {
  const h = await makeApp({ label: 'migraine-workout-patch-instant' });
  t.after(() => h.close());

  const created = (await h.app.inject({
    method: 'POST', url: '/api/workouts',
    payload: workout({ performedAt: '2026-03-05T07:00:00.000Z' }),
  })).json();

  for (const bad of ['not-a-timestamp', '2026-03-01', '2026-03-01T07:00:00', '', null, 42]) {
    const res = await h.app.inject({
      method: 'PATCH', url: `/api/workouts/${created.id}`, payload: { performedAt: bad },
    });
    assert.equal(res.statusCode, 400, `expected 400 for PATCH performedAt ${JSON.stringify(bad)}`);
    assert.ok(res.json().error);
  }

  // the rejected patches left the stored row untouched
  const after = (await h.app.inject({ method: 'GET', url: '/api/workouts' })).json();
  assert.equal(after.length, 1);
  assert.equal(after[0].performedAt, '2026-03-05T07:00:00.000Z');
  assert.equal(after[0].kind, 'strength');

  const patched = await h.app.inject({
    method: 'PATCH', url: `/api/workouts/${created.id}`,
    payload: { performedAt: '2026-03-06T00:30:00+02:00' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().performedAt, '2026-03-06T00:30:00+02:00');
});

test('isValidIsoInstant: full ISO instants with an explicit timezone only', () => {
  const ok = [
    '2026-03-01T07:00:00.000Z',
    '2026-03-01T07:00:00Z',
    '2026-03-01t07:00:00.000z',
    '2026-03-01T09:00:00+05:30',
    '2026-03-01T09:00:00+0530',
    '2026-03-01T02:15:00.5-03:00',
    '2026-12-31T23:59:59.999+00:00',
  ];
  for (const v of ok) assert.equal(isValidIsoInstant(v), true, `expected ok: ${v}`);

  const bad = [
    '2026-03-01',                      // date only
    '2026-03-01T07:00:00',             // timezone-less local datetime
    '2026-03-01T07:00:00.000',         // fraction but no timezone
    '2026-03-01T07:00Z',               // reduced-accuracy time
    '2026-03-01 07:00:00Z',            // space separator
    '2026-3-1T07:00:00Z',              // unpadded components
    '2026-02-30T07:00:00.000Z',        // impossible calendar date
    '2026-13-01T07:00:00.000Z',        // month 13
    '2026-03-01T24:00:00.000Z',        // hour 24 (not parseable by JS Date)
    '2026-03-01T07:60:00.000Z',        // minute 60
    '2026-03-01T07:00:60.000Z',        // leap second
    '2026-03-01T07:00:00+99:00',       // offset hour out of range
    '2026-03-01T07:00:00+05:99',       // offset minute out of range
    'not-a-timestamp',
    '',
    'Z',
    42,
    null,
    undefined,
    {},
  ];
  for (const v of bad) assert.equal(isValidIsoInstant(v), false, `expected reject: ${String(v)}`);
});

// ── day states ────────────────────────────────────────────────────────
test('day-state PUT creates, then upserts one row per day', async (t) => {
  const h = await makeApp({ label: 'migraine-day-state-upsert' });
  t.after(() => h.close());

  const first = await h.app.inject({
    method: 'PUT', url: '/api/day-states/2026-03-01', payload: { status: 'well', notes: 'good day' },
  });
  assert.equal(first.statusCode, 200);
  const created = first.json();
  assert.deepEqual(Object.keys(created).sort(), ['day', 'notes', 'status', 'updatedAt']);
  assert.equal(created.day, '2026-03-01');
  assert.equal(created.status, 'well');
  assert.equal(created.notes, 'good day');
  assert.match(created.updatedAt, ISO);

  // same day again replaces status/notes (one row) and bumps updated_at
  const second = await h.app.inject({
    method: 'PUT', url: '/api/day-states/2026-03-01', payload: { status: 'attack' },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().day, '2026-03-01');
  assert.equal(second.json().status, 'attack');
  assert.equal(second.json().notes, ''); // omitted → '' (not the old value)
  assert.ok(second.json().updatedAt >= created.updatedAt);
  // a client-supplied updatedAt is ignored in favour of the server clock
  const third = await h.app.inject({
    method: 'PUT', url: '/api/day-states/2026-03-01',
    payload: { status: 'off', notes: 'wiped', updatedAt: '1999-01-01T00:00:00.000Z' },
  });
  assert.notEqual(third.json().updatedAt, '1999-01-01T00:00:00.000Z');
  assert.match(third.json().updatedAt, ISO);

  // explicit null notes → ''
  const nulled = await h.app.inject({
    method: 'PUT', url: '/api/day-states/2026-03-01', payload: { status: 'well', notes: null },
  });
  assert.equal(nulled.json().notes, '');
  // unknown keys are ignored
  const extra = await h.app.inject({
    method: 'PUT', url: '/api/day-states/2026-03-01', payload: { status: 'well', whatever: 1 },
  });
  assert.equal(extra.statusCode, 200);

  // different days coexist, ordered by day
  await h.app.inject({ method: 'PUT', url: '/api/day-states/2026-02-27', payload: { status: 'off' } });
  const list = (await h.app.inject({ method: 'GET', url: '/api/day-states' })).json();
  assert.deepEqual(list.map((d) => d.day), ['2026-02-27', '2026-03-01']);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM day_states').get().n, 2);
});

test('day-state validation: bad days and statuses 400 with nothing inserted', async (t) => {
  const h = await makeApp({ label: 'migraine-day-state-invalid' });
  t.after(() => h.close());

  for (const day of ['2026-13-01', '2026-02-30', 'not-a-day', '2026-1-1', '2026-00-10', '2026-04-31']) {
    const res = await h.app.inject({
      method: 'PUT', url: `/api/day-states/${day}`, payload: { status: 'well' },
    });
    assert.equal(res.statusCode, 400, `expected 400 for day ${day}`);
    assert.ok(res.json().error);
  }

  const badBodies = [
    { status: 'Attack' },  // wrong case
    { status: 'WELL' },
    { status: 'sick' },
    { status: null },      // NOT NULL column
    {},                    // missing
    { status: 1 },
    { status: 'well', notes: 3 },
  ];
  for (const payload of badBodies) {
    const res = await h.app.inject({
      method: 'PUT', url: '/api/day-states/2026-03-02', payload,
    });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/day-states' })).json(), []);
});

// ── export / import / reset / backup ──────────────────────────────────
test('export envelope includes workouts and dayStates', async (t) => {
  const h = await makeApp({ label: 'migraine-v2-export' });
  t.after(() => h.close());

  await h.app.inject({ method: 'POST', url: '/api/workouts', payload: workout({ durationMinutes: 20 }) });
  await h.app.inject({
    method: 'PUT', url: '/api/day-states/2026-03-03', payload: { status: 'off', notes: 'tired' },
  });

  const envelope = (await h.app.inject({ method: 'GET', url: '/api/export' })).json();
  assert.equal(envelope.schemaVersion, SCHEMA_VERSION);
  assert.ok(Array.isArray(envelope.workouts));
  assert.ok(Array.isArray(envelope.dayStates));
  assert.equal(envelope.workouts.length, 1);
  assert.equal(envelope.workouts[0].durationMinutes, 20);
  assert.equal(envelope.dayStates.length, 1);
  assert.deepEqual(
    { day: envelope.dayStates[0].day, status: envelope.dayStates[0].status, notes: envelope.dayStates[0].notes },
    { day: '2026-03-03', status: 'off', notes: 'tired' },
  );
});

test('import restores workouts/dayStates additively; duplicates are ignored', async (t) => {
  const h = await makeApp({ label: 'migraine-v2-import' });
  t.after(() => h.close());

  const payload = {
    schemaVersion: 2,
    exportedAt: '2026-03-04T00:00:00.000Z',
    attacks: [],
    meds: [],
    refills: [],
    workouts: [
      workout({ id: 'w1', durationMinutes: 30, notes: 'first' }),
      workout({ id: 'w2', performedAt: '2026-03-02T07:00:00.000Z', kind: 'cardio', effort: 'hard' }),
    ],
    dayStates: [
      { day: '2026-03-01', status: 'well', notes: 'ok', updatedAt: '2026-03-01T20:00:00.000Z' },
      { day: '2026-03-02', status: 'attack', notes: '' },
    ],
  };
  const first = await h.app.inject({ method: 'POST', url: '/api/import', payload });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), {
    ok: true, attacks: 0, meds: 0, refills: 0, workouts: 2, dayStates: 2, stockBaselines: 0,
  });

  const workouts = (await h.app.inject({ method: 'GET', url: '/api/workouts' })).json();
  assert.deepEqual(workouts.map((w) => w.id), ['w1', 'w2']);
  // import defaults source to 'import' when absent, like meds
  assert.equal(workouts[0].source, 'import');
  assert.equal(workouts[0].notes, 'first');
  const days = (await h.app.inject({ method: 'GET', url: '/api/day-states' })).json();
  assert.equal(days[0].updatedAt, '2026-03-01T20:00:00.000Z'); // payload value preserved
  assert.match(days[1].updatedAt, ISO); // absent → generated

  // duplicate id/day in a second import: counts are payload lengths, rows kept
  const second = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: {
      workouts: [workout({ id: 'w1', kind: 'mobility', notes: 'overwritten?' }), workout({ id: 'w3' })],
      dayStates: [{ day: '2026-03-01', status: 'attack' }, { day: '2026-03-05', status: 'well' }],
    },
  });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), {
    ok: true, attacks: 0, meds: 0, refills: 0, workouts: 2, dayStates: 2, stockBaselines: 0,
  });
  const afterWorkouts = (await h.app.inject({ method: 'GET', url: '/api/workouts' })).json();
  assert.equal(afterWorkouts.length, 3);
  assert.equal(afterWorkouts.find((w) => w.id === 'w1').kind, 'strength'); // original kept
  assert.equal(afterWorkouts.find((w) => w.id === 'w1').notes, 'first');
  const afterDays = (await h.app.inject({ method: 'GET', url: '/api/day-states' })).json();
  assert.equal(afterDays.length, 3);
  assert.equal(afterDays.find((d) => d.day === '2026-03-01').status, 'well'); // original kept

  // legacy unversioned import without the new keys still works
  const legacy = await h.app.inject({
    method: 'POST', url: '/api/import', payload: { attacks: [] },
  });
  assert.equal(legacy.statusCode, 200);
  assert.deepEqual(legacy.json(), {
    ok: true, attacks: 0, meds: 0, refills: 0, workouts: 0, dayStates: 0, stockBaselines: 0,
  });
});

test('import rejects bad workout/dayState items atomically', async (t) => {
  const h = await makeApp({ label: 'migraine-v2-import-bad' });
  t.after(() => h.close());

  const attack = { id: 'a1', start: '2026-01-01T00:00:00Z' };
  const badBodies = [
    { workouts: 'nope' },
    { dayStates: {} },
    { attacks: [attack], workouts: [workout(), workout({ id: 'w2', kind: 'run' })] },
    { workouts: [workout({ id: 'w3', effort: 'extreme' })] },
    { workouts: [{ id: 'w4', kind: 'cardio', effort: 'low' }] }, // no performedAt
    { workouts: [workout({ id: 'w5', durationMinutes: -1 })] },
    { attacks: [attack], dayStates: [{ day: '2026-02-30', status: 'well' }] },
    { dayStates: [{ status: 'well' }] },                            // no day
    { dayStates: [{ day: '2026-03-01', status: 'Attack' }] },
    { dayStates: [{ day: '2026-03-01', status: null }] },
    { dayStates: [{ day: '2026-03-01', status: 'well', notes: 5 }] },
  ];
  for (const payload of badBodies) {
    const res = await h.app.inject({ method: 'POST', url: '/api/import', payload });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    assert.ok(res.json().error);
  }

  // the valid rows grouped with the bad ones were never inserted
  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/workouts' })).json(), []);
  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/day-states' })).json(), []);
  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/attacks' })).json(), []);
});

test('import enforces full ISO instants on workouts and imported dayState updatedAt', async (t) => {
  const h = await makeApp({ label: 'migraine-import-instant' });
  t.after(() => h.close());

  // coordinator reproduction shapes that used to slip through as 200/201
  const reproWorkout = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: { workouts: [{ id: 'wx', performedAt: 'not-a-timestamp', kind: 'cardio', effort: 'low' }] },
  });
  assert.equal(reproWorkout.statusCode, 400);
  assert.match(reproWorkout.json().error, /performedAt/);

  const reproDayState = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: { dayStates: [{ day: '2026-10-26', status: 'well', updatedAt: 'not-a-timestamp' }] },
  });
  assert.equal(reproDayState.statusCode, 400);
  assert.match(reproDayState.json().error, /updatedAt/);

  const badBodies = [
    { workouts: [workout({ id: 'w1', performedAt: '2026-03-01' })] },          // date only
    { workouts: [workout({ id: 'w1', performedAt: '2026-03-01T07:00:00' })] }, // no timezone
    { dayStates: [{ day: '2026-10-26', status: 'well', updatedAt: '2026-10-26' }] },
    { dayStates: [{ day: '2026-10-26', status: 'well', updatedAt: '2026-10-26T12:00:00' }] },
    { dayStates: [{ day: '2026-10-26', status: 'well', updatedAt: 42 }] },
  ];
  for (const payload of badBodies) {
    const res = await h.app.inject({ method: 'POST', url: '/api/import', payload });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    assert.ok(res.json().error);
  }

  // a mixed payload with one bad item is atomic: its valid row never lands
  const mixed = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: {
      workouts: [workout({ id: 'w-ok' })],
      dayStates: [{ day: '2026-10-26', status: 'well', updatedAt: 'nope' }],
    },
  });
  assert.equal(mixed.statusCode, 400);
  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/workouts' })).json(), []);
  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/day-states' })).json(), []);

  // valid controls: explicit-offset forms import verbatim and an absent
  // updatedAt is still defaulted by the mapper (additive legacy/current
  // payloads may omit it)
  const control = await h.app.inject({
    method: 'POST', url: '/api/import',
    payload: {
      workouts: [workout({ id: 'w-off', performedAt: '2026-03-01T09:00:00+05:30' })],
      dayStates: [
        { day: '2026-10-25', status: 'well', updatedAt: '2026-10-25T12:00:00+02:00' },
        { day: '2026-10-26', status: 'off' },
      ],
    },
  });
  assert.equal(control.statusCode, 200);
  const workouts = (await h.app.inject({ method: 'GET', url: '/api/workouts' })).json();
  assert.equal(workouts[0].performedAt, '2026-03-01T09:00:00+05:30');
  const days = (await h.app.inject({ method: 'GET', url: '/api/day-states' })).json();
  assert.equal(days.find((d) => d.day === '2026-10-25').updatedAt, '2026-10-25T12:00:00+02:00');
  assert.match(days.find((d) => d.day === '2026-10-26').updatedAt, ISO);

  // the day-state PUT route is deliberately untouched: a client updatedAt is
  // neither required nor validated — the server clock always wins
  const put = await h.app.inject({
    method: 'PUT', url: '/api/day-states/2026-10-27',
    payload: { status: 'well', updatedAt: 'not-a-timestamp' },
  });
  assert.equal(put.statusCode, 200);
  assert.match(put.json().updatedAt, ISO);
  assert.notEqual(put.json().updatedAt, 'not-a-timestamp');
});

test('a valid export envelope still round-trips through import', async (t) => {
  const source = await makeApp({ label: 'migraine-roundtrip-src' });
  t.after(() => source.close());
  await source.app.inject({
    method: 'POST', url: '/api/workouts',
    payload: workout({ durationMinutes: 40, notes: 'tempo', source: 'manual' }),
  });
  await source.app.inject({
    method: 'PUT', url: '/api/day-states/2026-03-01', payload: { status: 'attack', notes: 'rest' },
  });

  const envelope = (await source.app.inject({ method: 'GET', url: '/api/export' })).json();
  assert.equal(envelope.schemaVersion, SCHEMA_VERSION);

  const target = await makeApp({ label: 'migraine-roundtrip-dst' });
  t.after(() => target.close());
  const res = await target.app.inject({ method: 'POST', url: '/api/import', payload: envelope });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    ok: true, attacks: 0, meds: 0, refills: 0, workouts: 1, dayStates: 1, stockBaselines: 0,
  });
  assert.deepEqual(
    (await target.app.inject({ method: 'GET', url: '/api/workouts' })).json(),
    (await source.app.inject({ method: 'GET', url: '/api/workouts' })).json(),
  );
  assert.deepEqual(
    (await target.app.inject({ method: 'GET', url: '/api/day-states' })).json(),
    (await source.app.inject({ method: 'GET', url: '/api/day-states' })).json(),
  );
});

test('reset clears workouts and day states and keeps the schema version', async (t) => {
  const h = await makeApp({ label: 'migraine-v2-reset' });
  t.after(() => h.close());

  await h.app.inject({ method: 'POST', url: '/api/workouts', payload: workout() });
  await h.app.inject({ method: 'PUT', url: '/api/day-states/2026-03-01', payload: { status: 'well' } });
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM workouts').get().n, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM day_states').get().n, 1);

  const res = await h.app.inject({ method: 'POST', url: '/api/reset' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });

  const envelope = (await h.app.inject({ method: 'GET', url: '/api/export' })).json();
  assert.deepEqual(envelope.workouts, []);
  assert.deepEqual(envelope.dayStates, []);
  assert.equal(currentUserVersion(h.db), SCHEMA_VERSION);
});

test('backup dump includes workouts and dayStates', () => {
  const dir = makeTempDir('migraine-v2-backup');
  try {
    const db = openDatabase(join(dir, 'data'), { log: () => {} });
    try {
      db.prepare(`INSERT INTO workouts (id,performed_at,kind,effort,duration_minutes,notes,source)
        VALUES ('w1','2026-03-01T07:00:00Z','cardio','hard',25,'run','manual')`).run();
      db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
        VALUES ('2026-03-01','attack','','2026-03-01T20:00:00Z')`).run();

      const backupDir = join(dir, 'backups');
      const file = dumpBackup({
        db, backupDir, now: new Date('2026-03-05T09:30:00.000Z'), log: () => {},
      });
      assert.ok(file);
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
      assert.equal(parsed.workouts.length, 1);
      assert.deepEqual(parsed.workouts[0], {
        id: 'w1', performedAt: '2026-03-01T07:00:00Z', kind: 'cardio', effort: 'hard',
        durationMinutes: 25, notes: 'run', source: 'manual',
      });
      assert.deepEqual(parsed.dayStates, [{
        day: '2026-03-01', status: 'attack', notes: '', updatedAt: '2026-03-01T20:00:00Z',
      }]);
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
