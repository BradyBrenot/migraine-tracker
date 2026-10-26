// Checkpoint 6: persistent reminder engine (app/server/reminders.js).
//
// Everything runs against a disposable temp database with an INJECTED clock
// and a fake transport: no real clock, no network, no listening port, no
// long timers. Local wall-clock instants are always explicit UTC strings for
// America/New_York (EDT = UTC-4, EST = UTC-5) so the host time zone is
// irrelevant.
//
// The engine is at-least-once by design around a crash: a process that dies
// between "status = sending" and the success write is requeued at startup and
// may deliver twice. Nothing here claims exactly-once delivery.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { makeApp, makeTempDir, cleanupDir } from './helpers.js';
import { createReminderEngine } from '../reminders.js';
import { createNtfyTransport, DeliveryError } from '../ntfy.js';
import { collectSettings } from '../snapshot.js';

const NY = 'America/New_York';

// ── harness ───────────────────────────────────────────────────────────
function makeDb(t, label = 'reminders') {
  const dir = makeTempDir(`migraine-${label}`);
  const db = openDatabase(join(dir, 'data'), { log: () => {} });
  t.after(() => {
    try {
      db.close(); // may already be closed by app.close()
    } catch {
      // ignore
    }
    cleanupDir(dir);
  });
  return { db, dir };
}

const setSetting = (db, key, value) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run(key, JSON.stringify(value));

const BASE_REMINDERS = {
  enabled: true,
  preventive: true,
  lowStock: true,
  checkIn: true,
  exercise: true,
  wakingStart: '09:00',
  wakingEnd: '21:00',
  checkInTime: '18:00',
  exerciseTime: '18:30',
  graceMinutes: 120,
};

function seedSettings(db, {
  reminders = {}, timezone = NY, threshold, planned,
} = {}) {
  if (timezone !== null) setSetting(db, 'timezone', timezone);
  setSetting(db, 'reminders', { ...BASE_REMINDERS, ...reminders });
  if (threshold !== undefined) setSetting(db, 'lowStockThreshold', threshold);
  if (planned !== undefined) setSetting(db, 'planned', planned);
}

/** Injectable clock: `set`/`plusMinutes` are explicit, never wall time. */
function makeClock(startIso) {
  let nowMs = Date.parse(startIso);
  return {
    now: () => nowMs,
    set(iso) {
      nowMs = Date.parse(iso);
      return this;
    },
    plusMinutes(minutes) {
      nowMs += minutes * 60000;
      return this;
    },
  };
}

/** Fake transport that records messages; `impl` may throw to simulate failure. */
function recorder(impl) {
  const calls = [];
  const transport = async (message) => {
    calls.push(message);
    if (impl) return impl(message, calls.length);
    return { status: 200 };
  };
  return { transport, calls };
}

const engineFor = (db, clock, transport, log = () => {}) =>
  createReminderEngine({ db, transport, now: clock.now, log });

const occurrence = (db, key) =>
  db.prepare('SELECT * FROM reminder_occurrences WHERE key = ?').get(key);
const occurrenceKeys = (db, type) => db.prepare(
  'SELECT key FROM reminder_occurrences WHERE type = ? ORDER BY key',
).all(type).map((row) => row.key);
const occurrenceCount = (db) =>
  db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get().n;
const stateValue = (db, key) => {
  const row = db.prepare('SELECT value FROM reminder_state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
};

const insertMeds = (db, rows) => {
  const stmt = db.prepare('INSERT INTO meds (id,med_id,ts,quantity) VALUES (?,?,?,?)');
  for (const [id, medId, ts, quantity = null] of rows) stmt.run(id, medId, ts, quantity);
};

const insertRefill = (db, id, medId, date, quantity) => db.prepare(
  'INSERT INTO refills (id,med_id,date,quantity) VALUES (?,?,?,?)',
).run(id, medId, date, quantity);

const insertBaseline = (db, id, medId, effectiveAt, quantity) => db.prepare(
  `INSERT INTO stock_baselines (id,med_id,effective_at,quantity,created_at)
   VALUES (?,?,?,?,?)`,
).run(id, medId, effectiveAt, quantity, effectiveAt);

const insertWorkout = (db, id, performedAt, kind) => db.prepare(
  'INSERT INTO workouts (id,performed_at,kind,effort) VALUES (?,?,?,?)',
).run(id, performedAt, kind, 'medium');

function seedWorkouts(db, list) {
  for (const [i, [performedAt, kind]] of list.entries()) {
    insertWorkout(db, `w-${i}-${kind}`, performedAt, kind);
  }
}

/** 2 strength + 3 cardio inside the Sunday week 2026-04-05..11. */
const WEEK_GOALS_MET = [
  ['2026-04-06T12:00:00.000Z', 'strength'],
  ['2026-04-08T12:00:00.000Z', 'strength'],
  ['2026-04-07T12:00:00.000Z', 'cardio'],
  ['2026-04-09T12:00:00.000Z', 'cardio'],
  ['2026-04-10T12:00:00.000Z', 'cardio'],
];

// ── 1. preventive ─────────────────────────────────────────────────────
test('preventive: a planned local date overrides auto and fires at 09:00 local', async (t) => {
  const { db } = makeDb(t, 'preventive-planned');
  seedSettings(db, { planned: { emgality: '2026-04-10' } });
  // Without the planned date the automatic schedule would be 2026-05-02
  // (local dose day + 30); the plan must win.
  insertMeds(db, [['dose-1', 'emgality', '2026-04-02T15:00:00.000Z']]);

  const clock = makeClock('2026-04-10T12:59:00.000Z'); // 08:59 EDT
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  const early = await engine.tick();
  assert.equal(early.sent, 0);
  assert.equal(calls.length, 0);
  assert.equal(occurrence(db, 'preventive:emgality:2026-04-10'), undefined);
  assert.equal(occurrence(db, 'preventive:emgality:2026-05-02'), undefined);

  clock.set('2026-04-10T13:00:00.000Z'); // 09:00 EDT exactly
  const due = await engine.tick();
  assert.equal(due.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Emgality dose due');
  assert.match(calls[0].body, /Apr 10/);
  const row = occurrence(db, 'preventive:emgality:2026-04-10');
  assert.equal(row.status, 'succeeded');
  assert.equal(row.scheduled_at, '2026-04-10T13:00:00.000Z');
});

test('preventive: automatic due is local dose day + 30/84 calendar days at 09:00, across spring-forward', async (t) => {
  const { db } = makeDb(t, 'preventive-auto');
  seedSettings(db);
  // Emgality local day 2026-02-10 -> due 2026-03-12 (after the 2026-03-08 DST
  // change, so 09:00 local is 13:00Z EDT).
  insertMeds(db, [
    ['e1', 'emgality', '2026-02-10T15:00:00.000Z'],
    // Botox local day 2025-12-01 -> +84 = 2026-02-23 (still EST, 14:00Z).
    ['b1', 'botox', '2025-12-01T15:00:00.000Z'],
  ]);

  const clock = makeClock('2026-02-23T13:59:00.000Z'); // 08:59 EST
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 0);
  assert.equal(calls.length, 0);

  clock.set('2026-02-23T14:00:00.000Z'); // 09:00 EST
  assert.equal((await engine.tick()).sent, 1);
  assert.deepEqual(calls.map((c) => c.title), ['Botox dose due']);
  assert.equal(
    occurrence(db, 'preventive:botox:2026-02-23').scheduled_at,
    '2026-02-23T14:00:00.000Z',
  );

  clock.set('2026-03-12T12:59:00.000Z'); // 08:59 EDT
  assert.equal((await engine.tick()).sent, 0);
  assert.equal(calls.length, 1);

  clock.set('2026-03-12T13:00:00.000Z'); // 09:00 EDT
  assert.equal((await engine.tick()).sent, 1);
  assert.deepEqual(calls.map((c) => c.title), ['Botox dose due', 'Emgality dose due']);
  assert.equal(
    occurrence(db, 'preventive:emgality:2026-03-12').scheduled_at,
    '2026-03-12T13:00:00.000Z',
  );
});

test('preventive: never logged and no planned date never reminds', async (t) => {
  const { db } = makeDb(t, 'preventive-none');
  seedSettings(db);
  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  const summary = await engine.tick();
  assert.equal(summary.sent, 0);
  assert.equal(calls.length, 0);
  assert.equal(occurrenceCount(db), 0);
});

test('preventive: the latest valid dose wins and invalid timestamps are ignored', async (t) => {
  const { db } = makeDb(t, 'preventive-latest');
  seedSettings(db);
  insertMeds(db, [
    ['e1', 'emgality', '2026-04-01T15:00:00.000Z'], // local Apr 1 -> due May 1
    ['e2', 'emgality', '2026-04-05T15:00:00.000Z'], // latest valid -> due May 5
    ['e3', 'emgality', '2026-04-03T15:00:00.000Z'],
    ['e-bad-1', 'emgality', 'not-a-timestamp'],
    ['e-bad-2', 'emgality', '2099-13-40T99:99:99Z'],
  ]);

  const clock = makeClock('2026-05-05T13:00:00.000Z'); // 09:00 EDT
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 1);
  assert.deepEqual(occurrenceKeys(db, 'preventive'), ['preventive:emgality:2026-05-05']);
});

test('preventive: success dedupes on repeated ticks and across a fresh engine on the same database', async (t) => {
  const { db } = makeDb(t, 'preventive-dedupe');
  seedSettings(db, { planned: { emgality: '2026-04-10' } });
  const clock = makeClock('2026-04-10T13:00:00.000Z'); // 09:00 EDT
  const { transport, calls } = recorder();

  const first = engineFor(db, clock, transport);
  assert.equal((await first.tick()).sent, 1);
  assert.equal((await first.tick()).sent, 0);
  assert.equal(calls.length, 1);

  clock.plusMinutes(5);
  const restarted = engineFor(db, clock, transport);
  assert.equal((await restarted.tick()).sent, 0);
  assert.equal(calls.length, 1);

  const row = occurrence(db, 'preventive:emgality:2026-04-10');
  assert.equal(row.status, 'succeeded');
  assert.equal(row.attempt, 1);
  assert.equal(row.sent_at, '2026-04-10T13:00:00.000Z');
});

// ── 2. waking hours ───────────────────────────────────────────────────
test('waking: persistent preventive and low-stock rows wait outside 09:00-21:00 and send at the next 09:00', async (t) => {
  const { db } = makeDb(t, 'waking-wait');
  seedSettings(db, {
    planned: { emgality: '2026-04-09' },
    threshold: 2,
    reminders: { checkIn: false, exercise: false },
  });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);

  const clock = makeClock('2026-04-10T12:00:00.000Z'); // 08:00 EDT
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 0);
  assert.equal(calls.length, 0);
  assert.equal(occurrence(db, 'preventive:emgality:2026-04-09').status, 'pending');
  const stockKeys = occurrenceKeys(db, 'stock');
  assert.equal(stockKeys.length, 1);
  assert.equal(occurrence(db, stockKeys[0]).status, 'pending');

  clock.set('2026-04-10T12:59:00.000Z'); // 08:59 EDT — still outside
  assert.equal((await engine.tick()).sent, 0);
  assert.equal(calls.length, 0);

  clock.set('2026-04-10T13:00:00.000Z'); // 09:00 EDT — inclusive start
  const open = await engine.tick();
  assert.equal(open.sent, 2);
  assert.equal(occurrence(db, 'preventive:emgality:2026-04-09').status, 'succeeded');
  assert.equal(occurrence(db, stockKeys[0]).status, 'succeeded');
});

test('waking: 20:59 is inside and 21:00 is outside the default window', async (t) => {
  const inside = makeDb(t, 'waking-2059');
  seedSettings(inside.db, {
    planned: { emgality: '2026-04-10' },
    reminders: { checkIn: false, exercise: false, lowStock: false },
  });
  const insideClock = makeClock('2026-04-11T00:59:00.000Z'); // 20:59 EDT Apr 10
  const insideRecorder = recorder();
  const insideEngine = engineFor(inside.db, insideClock, insideRecorder.transport);
  assert.equal((await insideEngine.tick()).sent, 1);

  const outside = makeDb(t, 'waking-2100');
  seedSettings(outside.db, {
    planned: { emgality: '2026-04-10' },
    reminders: { checkIn: false, exercise: false, lowStock: false },
  });
  const outsideClock = makeClock('2026-04-11T01:00:00.000Z'); // 21:00 EDT
  const outsideRecorder = recorder();
  const outsideEngine = engineFor(outside.db, outsideClock, outsideRecorder.transport);

  assert.equal((await outsideEngine.tick()).sent, 0);
  assert.equal(outsideRecorder.calls.length, 0);
  assert.equal(occurrence(outside.db, 'preventive:emgality:2026-04-10').status, 'pending');

  outsideClock.set('2026-04-11T13:00:00.000Z'); // next 09:00 EDT
  assert.equal((await outsideEngine.tick()).sent, 1);
  assert.equal(outsideRecorder.calls.length, 1);
});

test('waking: a custom narrow waking window is honored', async (t) => {
  const { db } = makeDb(t, 'waking-narrow');
  seedSettings(db, {
    planned: { emgality: '2026-04-10' },
    reminders: {
      wakingStart: '10:00', wakingEnd: '12:00', checkIn: false, exercise: false, lowStock: false,
    },
  });
  const clock = makeClock('2026-04-10T13:59:00.000Z'); // 09:59 EDT
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 0);
  assert.equal(calls.length, 0);
  assert.equal(occurrence(db, 'preventive:emgality:2026-04-10').status, 'pending');

  clock.set('2026-04-10T14:00:00.000Z'); // 10:00 EDT — narrow window opens
  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
});

// ── 3. check-in ───────────────────────────────────────────────────────
const CHECKIN_ONLY = { preventive: false, lowStock: false, exercise: false };

test('check-in: missing day-state sends at checkInTime once per local day; prior-day records do not suppress', async (t) => {
  const { db } = makeDb(t, 'checkin-basic');
  seedSettings(db, { reminders: CHECKIN_ONLY });
  db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
    VALUES ('2026-04-09','well','','2026-04-09T20:00:00.000Z')`).run();

  const clock = makeClock('2026-04-10T21:59:00.000Z'); // 17:59 EDT
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 0);
  assert.equal(calls.length, 0);

  clock.set('2026-04-10T22:00:00.000Z'); // 18:00 EDT
  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Daily check-in');
  assert.equal(occurrence(db, 'checkin:2026-04-10').status, 'succeeded');

  clock.set('2026-04-10T22:30:00.000Z'); // same local day → deduped
  assert.equal((await engine.tick()).sent, 0);
  assert.equal(calls.length, 1);

  // midnight rollover creates a new occurrence for the new local day
  clock.set('2026-04-11T22:00:00.000Z'); // 18:00 EDT Apr 11
  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(occurrenceKeys(db, 'checkin'), ['checkin:2026-04-10', 'checkin:2026-04-11']);
});

test('check-in: any explicit day-state (well/off/attack) suppresses the prompt', async (t) => {
  for (const status of ['well', 'off', 'attack']) {
    const { db } = makeDb(t, `checkin-${status}`);
    seedSettings(db, { reminders: CHECKIN_ONLY });
    db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
      VALUES ('2026-04-10',?,'','2026-04-10T15:00:00.000Z')`).run(status);

    const clock = makeClock('2026-04-10T22:00:00.000Z'); // 18:00 EDT
    const { transport, calls } = recorder();
    const engine = engineFor(db, clock, transport);

    const summary = await engine.tick();
    assert.equal(summary.sent, 0, `status ${status} must suppress`);
    assert.equal(calls.length, 0);
    const row = occurrence(db, 'checkin:2026-04-10');
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error_category, 'condition_gone');
  }
});

test('check-in: a restart inside the grace window still delivers a missed prompt', async (t) => {
  const { db } = makeDb(t, 'checkin-restart');
  seedSettings(db, { reminders: CHECKIN_ONLY });
  // No tick happened at 18:00; the process starts again an hour later.
  const clock = makeClock('2026-04-10T23:00:00.000Z'); // 19:00 EDT
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    occurrence(db, 'checkin:2026-04-10').scheduled_at,
    '2026-04-10T22:00:00.000Z',
  );
});

test('check-in: a failed 18:00 send succeeds on the retry tick at 18:01', async (t) => {
  const { db } = makeDb(t, 'checkin-retry');
  seedSettings(db, { reminders: CHECKIN_ONLY });
  const clock = makeClock('2026-04-10T22:00:00.000Z'); // 18:00 EDT
  const { transport, calls } = recorder((_message, n) => {
    if (n === 1) throw new DeliveryError('fetch');
    return { status: 200 };
  });
  const engine = engineFor(db, clock, transport);

  const first = await engine.tick();
  assert.equal(first.failed, 1);
  assert.equal(calls.length, 1);
  let row = occurrence(db, 'checkin:2026-04-10');
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt, 1);
  assert.equal(row.next_attempt_at, '2026-04-10T22:01:00.000Z');

  clock.set('2026-04-10T22:01:00.000Z');
  const second = await engine.tick();
  assert.equal(second.sent, 1);
  assert.equal(second.failed, 0);
  assert.equal(calls.length, 2);
  row = occurrence(db, 'checkin:2026-04-10');
  assert.equal(row.status, 'succeeded');
  assert.equal(row.attempt, 2);
  assert.equal(row.sent_at, '2026-04-10T22:01:00.000Z');
});

test('check-in: beyond the grace window the occurrence is skipped as expired and never sends', async (t) => {
  const { db } = makeDb(t, 'checkin-expired');
  seedSettings(db, { reminders: CHECKIN_ONLY });
  const clock = makeClock('2026-04-11T00:00:00.000Z'); // 20:00 EDT = 18:00 + 2h
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  const summary = await engine.tick();
  assert.equal(summary.sent, 0);
  assert.equal(calls.length, 0);
  const row = occurrence(db, 'checkin:2026-04-10');
  assert.equal(row.status, 'skipped');
  assert.equal(row.last_error_category, 'expired');
});

// ── 4. exercise ───────────────────────────────────────────────────────
const EXERCISE_ONLY = { preventive: false, lowStock: false, checkIn: false };

test('exercise: a behind Sunday week sends at exerciseTime and met goals suppress it', async (t) => {
  const behind = makeDb(t, 'exercise-behind');
  seedSettings(behind.db, { reminders: EXERCISE_ONLY });
  const clock = makeClock('2026-04-10T22:29:00.000Z'); // 18:29 EDT Fri
  const behindRecorder = recorder();
  const behindEngine = engineFor(behind.db, clock, behindRecorder.transport);

  assert.equal((await behindEngine.tick()).sent, 0);
  assert.equal(behindRecorder.calls.length, 0);

  clock.set('2026-04-10T22:30:00.000Z'); // 18:30 EDT
  assert.equal((await behindEngine.tick()).sent, 1);
  assert.equal(behindRecorder.calls.length, 1);
  assert.equal(behindRecorder.calls[0].title, 'Weekly movement check');
  assert.equal(
    behindRecorder.calls[0].body,
    'Your weekly goals are still open: 2 strength days and 3 cardio days. '
      + 'A short workout still counts.',
  );

  const met = makeDb(t, 'exercise-met');
  seedSettings(met.db, { reminders: EXERCISE_ONLY });
  seedWorkouts(met.db, WEEK_GOALS_MET);
  const metClock = makeClock('2026-04-10T22:30:00.000Z');
  const metRecorder = recorder();
  const metEngine = engineFor(met.db, metClock, metRecorder.transport);

  assert.equal((await metEngine.tick()).sent, 0);
  assert.equal(metRecorder.calls.length, 0);
  assert.equal(occurrence(met.db, 'exercise:2026-04-10').status, 'skipped');
  assert.equal(occurrence(met.db, 'exercise:2026-04-10').last_error_category, 'condition_gone');
});

test('exercise: mobility sessions never satisfy strength/cardio goals', async (t) => {
  const { db } = makeDb(t, 'exercise-mobility');
  seedSettings(db, { reminders: EXERCISE_ONLY });
  seedWorkouts(db, [
    ['2026-04-06T12:00:00.000Z', 'mobility'],
    ['2026-04-07T12:00:00.000Z', 'mobility'],
    ['2026-04-08T12:00:00.000Z', 'mobility'],
    ['2026-04-09T12:00:00.000Z', 'mobility'],
    ['2026-04-10T12:00:00.000Z', 'mobility'],
  ]);
  const clock = makeClock('2026-04-10T22:30:00.000Z');
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
});

test('exercise: duplicate same-day goal-kind workouts never meet the goals or suppress the prompt', async (t) => {
  const { db } = makeDb(t, 'exercise-duplicates');
  seedSettings(db, { reminders: EXERCISE_ONLY });
  // Strength x2 on Monday Apr 6 and Cardio x3 on Tuesday Apr 7: only two
  // distinct goal days, so the weekly minimums are still short.
  seedWorkouts(db, [
    ['2026-04-06T12:00:00.000Z', 'strength'],
    ['2026-04-06T18:00:00.000Z', 'strength'],
    ['2026-04-07T12:00:00.000Z', 'cardio'],
    ['2026-04-07T15:00:00.000Z', 'cardio'],
    ['2026-04-07T18:00:00.000Z', 'cardio'],
  ]);
  const clock = makeClock('2026-04-10T22:30:00.000Z'); // 18:30 EDT Fri
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Weekly movement check');
  assert.match(calls[0].body, /2 strength days and 3 cardio days/);
  assert.equal(occurrence(db, 'exercise:2026-04-10').status, 'succeeded');
});

test('exercise: explicit and attack-inferred Attack days suppress the prompt', async (t) => {
  const explicit = makeDb(t, 'exercise-attack');
  seedSettings(explicit.db, { reminders: EXERCISE_ONLY });
  explicit.db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
    VALUES ('2026-04-10','attack','','2026-04-10T12:00:00.000Z')`).run();
  const explicitClock = makeClock('2026-04-10T22:30:00.000Z');
  const explicitRecorder = recorder();
  const explicitEngine = engineFor(explicit.db, explicitClock, explicitRecorder.transport);

  assert.equal((await explicitEngine.tick()).sent, 0);
  assert.equal(explicitRecorder.calls.length, 0);
  assert.equal(occurrence(explicit.db, 'exercise:2026-04-10').status, 'skipped');

  const inferred = makeDb(t, 'exercise-inferred-attack');
  seedSettings(inferred.db, { reminders: EXERCISE_ONLY });
  // No day-state: the attack record itself makes 2026-04-10 an Attack day.
  inferred.db.prepare(`INSERT INTO attacks (id,start,"end")
    VALUES ('a1','2026-04-10T10:00:00.000Z','2026-04-10T20:00:00.000Z')`).run();
  const inferredClock = makeClock('2026-04-10T22:30:00.000Z');
  const inferredRecorder = recorder();
  const inferredEngine = engineFor(inferred.db, inferredClock, inferredRecorder.transport);

  assert.equal((await inferredEngine.tick()).sent, 0);
  assert.equal(inferredRecorder.calls.length, 0);
  assert.equal(occurrence(inferred.db, 'exercise:2026-04-10').status, 'skipped');
});

test('exercise: an attack active at now suppresses the prompt despite an earlier Well/Off record', async (t) => {
  // (a) explicit Off recorded earlier that day, attack still ongoing at 18:30 EDT
  {
    const { db } = makeDb(t, 'exercise-active-off');
    seedSettings(db, { reminders: EXERCISE_ONLY });
    db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
      VALUES ('2026-04-10','off','','2026-04-10T14:00:00.000Z')`).run();
    db.prepare(`INSERT INTO attacks (id,start,"end")
      VALUES ('a1','2026-04-10T21:00:00.000Z',NULL)`).run();
    const clock = makeClock('2026-04-10T22:30:00.000Z'); // 18:30 EDT Fri
    const { transport, calls } = recorder();
    const engine = engineFor(db, clock, transport);

    assert.equal((await engine.tick()).sent, 0);
    assert.equal(calls.length, 0);
    const row = occurrence(db, 'exercise:2026-04-10');
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error_category, 'condition_gone');
  }

  // (b) explicit Well recorded earlier that day, attack has a recorded end later than now
  {
    const { db } = makeDb(t, 'exercise-active-well');
    seedSettings(db, { reminders: EXERCISE_ONLY });
    db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
      VALUES ('2026-04-10','well','','2026-04-10T14:00:00.000Z')`).run();
    db.prepare(`INSERT INTO attacks (id,start,"end")
      VALUES ('a1','2026-04-10T21:00:00.000Z','2026-04-11T01:00:00.000Z')`).run();
    const clock = makeClock('2026-04-10T22:30:00.000Z');
    const { transport, calls } = recorder();
    const engine = engineFor(db, clock, transport);

    assert.equal((await engine.tick()).sent, 0);
    assert.equal(calls.length, 0);
    const row = occurrence(db, 'exercise:2026-04-10');
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error_category, 'condition_gone');
  }

  // (c) a pending prompt is dropped when an attack becomes active before the retry
  {
    const { db } = makeDb(t, 'exercise-active-pending');
    seedSettings(db, { reminders: EXERCISE_ONLY });
    const clock = makeClock('2026-04-10T22:30:00.000Z');
    const { transport, calls } = recorder(() => {
      throw new DeliveryError('fetch');
    });
    const engine = engineFor(db, clock, transport);

    assert.equal((await engine.tick()).failed, 1);
    assert.equal(calls.length, 1);
    db.prepare(`INSERT INTO attacks (id,start,"end")
      VALUES ('a1','2026-04-10T21:00:00.000Z',NULL)`).run();
    clock.set('2026-04-10T22:31:00.000Z');
    const retry = await engine.tick();
    assert.equal(retry.sent, 0);
    assert.equal(retry.failed, 0);
    assert.equal(calls.length, 1);
    const row = occurrence(db, 'exercise:2026-04-10');
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error_category, 'condition_gone');
  }

  // (d) an attack that already ended keeps the explicit Off gentle-wording behavior
  {
    const { db } = makeDb(t, 'exercise-ended-off');
    seedSettings(db, { reminders: EXERCISE_ONLY });
    db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
      VALUES ('2026-04-10','off','','2026-04-10T14:00:00.000Z')`).run();
    db.prepare(`INSERT INTO attacks (id,start,"end")
      VALUES ('a1','2026-04-10T18:00:00.000Z','2026-04-10T21:00:00.000Z')`).run();
    const clock = makeClock('2026-04-10T22:30:00.000Z');
    const { transport, calls } = recorder();
    const engine = engineFor(db, clock, transport);

    assert.equal((await engine.tick()).sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].title, 'Gentle movement option');
  }
});

test('exercise: an explicit Off day sends gentle wording; Off plus met goals suppresses', async (t) => {
  const off = makeDb(t, 'exercise-off');
  seedSettings(off.db, { reminders: EXERCISE_ONLY });
  off.db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
    VALUES ('2026-04-10','off','','2026-04-10T12:00:00.000Z')`).run();
  const offClock = makeClock('2026-04-10T22:30:00.000Z');
  const offRecorder = recorder();
  const offEngine = engineFor(off.db, offClock, offRecorder.transport);

  assert.equal((await offEngine.tick()).sent, 1);
  assert.equal(offRecorder.calls.length, 1);
  assert.equal(offRecorder.calls[0].title, 'Gentle movement option');
  assert.match(offRecorder.calls[0].body, /light walk or mobility/i);

  const offMet = makeDb(t, 'exercise-off-met');
  seedSettings(offMet.db, { reminders: EXERCISE_ONLY });
  offMet.db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
    VALUES ('2026-04-10','off','','2026-04-10T12:00:00.000Z')`).run();
  seedWorkouts(offMet.db, WEEK_GOALS_MET);
  const offMetClock = makeClock('2026-04-10T22:30:00.000Z');
  const offMetRecorder = recorder();
  const offMetEngine = engineFor(offMet.db, offMetClock, offMetRecorder.transport);

  assert.equal((await offMetEngine.tick()).sent, 0);
  assert.equal(offMetRecorder.calls.length, 0);
  assert.equal(occurrence(offMet.db, 'exercise:2026-04-10').status, 'skipped');
});

test('exercise: the Sunday-week rollover creates a new occurrence and previous-week workouts do not count', async (t) => {
  const { db } = makeDb(t, 'exercise-rollover');
  seedSettings(db, { reminders: EXERCISE_ONLY });
  seedWorkouts(db, WEEK_GOALS_MET); // all inside 2026-04-05..11
  const clock = makeClock('2026-04-11T22:30:00.000Z'); // Sat 18:30 EDT
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 0); // goals met that week
  assert.equal(calls.length, 0);
  assert.equal(occurrence(db, 'exercise:2026-04-11').status, 'skipped');

  clock.set('2026-04-12T22:30:00.000Z'); // Sun 18:30 EDT: new week, goals reset
  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(occurrence(db, 'exercise:2026-04-12').status, 'succeeded');
  assert.deepEqual(
    occurrenceKeys(db, 'exercise'),
    ['exercise:2026-04-11', 'exercise:2026-04-12'],
  );
});

test('exercise: an occurrence past its grace window is skipped as expired', async (t) => {
  const { db } = makeDb(t, 'exercise-expired');
  seedSettings(db, { reminders: EXERCISE_ONLY });
  const clock = makeClock('2026-04-11T00:31:00.000Z'); // 20:31 EDT = 18:30 + 2h + 1m
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  const summary = await engine.tick();
  assert.equal(summary.sent, 0);
  assert.equal(calls.length, 0);
  const row = occurrence(db, 'exercise:2026-04-10');
  assert.equal(row.status, 'skipped');
  assert.equal(row.last_error_category, 'expired');
});

// ── 5. low stock ──────────────────────────────────────────────────────
const STOCK_ONLY = { preventive: false, checkIn: false, exercise: false };

test('stock: unknown stock never alerts and stock above the threshold does not either', async (t) => {
  const unknown = makeDb(t, 'stock-unknown');
  seedSettings(unknown.db, { reminders: STOCK_ONLY });
  const unknownClock = makeClock('2026-04-10T14:00:00.000Z');
  const unknownRecorder = recorder();
  const unknownEngine = engineFor(unknown.db, unknownClock, unknownRecorder.transport);

  assert.equal((await unknownEngine.tick()).sent, 0);
  assert.equal(unknownRecorder.calls.length, 0);
  assert.equal(occurrenceCount(unknown.db), 0); // never zero-stock, never a false alert

  const above = makeDb(t, 'stock-above');
  seedSettings(above.db, { reminders: STOCK_ONLY });
  insertBaseline(above.db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 5);
  const aboveClock = makeClock('2026-04-10T14:00:00.000Z');
  const aboveRecorder = recorder();
  const aboveEngine = engineFor(above.db, aboveClock, aboveRecorder.transport);

  assert.equal((await aboveEngine.tick()).sent, 0);
  assert.equal(aboveRecorder.calls.length, 0);
  assert.equal(occurrenceCount(above.db), 0);
  assert.equal(stateValue(above.db, 'low_stock'), null);
});

test('stock: at or below the threshold sends once per low episode, even across a restart', async (t) => {
  const { db } = makeDb(t, 'stock-low');
  seedSettings(db, { threshold: 2, reminders: STOCK_ONLY });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 2); // exactly at the threshold

  const clock = makeClock('2026-04-10T14:00:00.000Z'); // 10:00 EDT
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Nurtec stock low');
  assert.match(calls[0].body, /at or below your 2-tablet alert level/);

  assert.equal((await engine.tick()).sent, 0);
  assert.equal(calls.length, 1);

  clock.plusMinutes(1);
  const restarted = engineFor(db, clock, transport);
  assert.equal((await restarted.tick()).sent, 0);
  assert.equal(calls.length, 1);
  assert.equal(occurrenceKeys(db, 'stock').length, 1);
  assert.equal(occurrence(db, occurrenceKeys(db, 'stock')[0]).status, 'succeeded');
});

test('stock: negative stock alerts with explicit negative wording', async (t) => {
  const { db } = makeDb(t, 'stock-negative');
  seedSettings(db, { reminders: STOCK_ONLY });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);
  insertMeds(db, [['d1', 'nurtec', '2026-04-02T12:00:00.000Z', 5]]); // 1 - 5 = -4

  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Nurtec stock low');
  assert.match(calls[0].body, /negative/);
  assert.match(calls[0].body, /-4/);
});

test('stock: replenishing above the threshold re-arms so a later new low episode alerts again', async (t) => {
  const { db } = makeDb(t, 'stock-rearm');
  seedSettings(db, { reminders: STOCK_ONLY });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);

  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 1); // episode A
  const firstKey = occurrenceKeys(db, 'stock')[0];
  assert.equal(stateValue(db, 'low_stock').phase, 'low');

  // Replenish: 1 + 8 = 9, comfortably above the default threshold of 2.
  insertRefill(db, 'r1', 'nurtec', '2026-04-10', 8);
  clock.plusMinutes(1);
  assert.equal((await engine.tick()).sent, 0);
  assert.equal(calls.length, 1);
  assert.equal(stateValue(db, 'low_stock').phase, 'armed');
  assert.equal(occurrence(db, firstKey).status, 'succeeded');

  // A new low episode (9 - 8 = 1) must alert again under a NEW occurrence key.
  insertMeds(db, [['d1', 'nurtec', '2026-04-10T14:02:00.000Z', 8]]);
  clock.set('2026-04-10T14:03:00.000Z');
  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 2);
  const keys = occurrenceKeys(db, 'stock');
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(occurrence(db, keys[1]).status, 'succeeded');
});

test('stock: POST /api/reset clears internal reminder tables so a re-seeded low episode may alert again', async (t) => {
  const h = await makeApp({ label: 'stock-reset' });
  t.after(() => h.close());
  const { db } = h;

  seedSettings(db, { reminders: STOCK_ONLY });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);
  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 1);
  assert.equal(occurrenceCount(db), 1);
  assert.equal(stateValue(db, 'low_stock').phase, 'low');

  const res = await h.app.inject({ method: 'POST', url: '/api/reset' });
  assert.equal(res.statusCode, 200);
  assert.equal(occurrenceCount(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_state').get().n, 0);

  // The reset deleted user records/settings too (documented behavior), so a
  // low episode can only be re-seeded explicitly — but because the internal
  // latch is gone it alerts again instead of staying silent forever.
  seedSettings(db, { reminders: STOCK_ONLY });
  insertBaseline(db, 'b2', 'nurtec', '2026-04-10T00:00:00.000Z', 1);
  clock.set('2026-04-10T14:05:00.000Z');
  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 2);
});

test('stock: non-Nurtec meds/refills/baselines never change the Nurtec episode', async (t) => {
  const { db } = makeDb(t, 'stock-scoping');
  seedSettings(db, { reminders: STOCK_ONLY });

  // Nurtec is comfortably above threshold...
  insertBaseline(db, 'b-nurtec', 'nurtec', '2026-04-01T00:00:00.000Z', 5);
  // ...while more recent Tylenol records would dominate a global stock query
  // (5 - 3 = 2, or 0 - 3 = -3 depending on the governing baseline).
  insertBaseline(db, 'b-tylenol', 'tylenol', '2026-04-02T00:00:00.000Z', 0);
  insertMeds(db, [['t1', 'tylenol', '2026-04-03T12:00:00.000Z', 3]]);
  insertRefill(db, 'r-tylenol', 'tylenol', '2026-04-04', 0);

  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 0); // scoped to Nurtec: still 5 > 2
  assert.equal(calls.length, 0);
  assert.equal(occurrenceCount(db), 0);

  // A real Nurtec dose still counts: 5 - 4 = 1 -> low.
  insertMeds(db, [['n1', 'nurtec', '2026-04-05T12:00:00.000Z', 4]]);
  clock.plusMinutes(1);
  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /1 Nurtec tablets left/);
});

test('stock: the browser lowStockAlert/lowStockAlertedAt latch settings are irrelevant', async (t) => {
  const alerted = makeDb(t, 'stock-browser-latch-set');
  seedSettings(alerted.db, { reminders: STOCK_ONLY });
  setSetting(alerted.db, 'lowStockAlert', true);
  setSetting(alerted.db, 'lowStockAlertedAt', '2026-04-09T12:00:00.000Z');
  insertBaseline(alerted.db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);
  const alertedClock = makeClock('2026-04-10T14:00:00.000Z');
  const alertedRecorder = recorder();
  const alertedEngine = engineFor(alerted.db, alertedClock, alertedRecorder.transport);
  assert.equal((await alertedEngine.tick()).sent, 1); // server-side episode, not the browser latch

  const cleared = makeDb(t, 'stock-browser-latch-cleared');
  seedSettings(cleared.db, { reminders: STOCK_ONLY });
  setSetting(cleared.db, 'lowStockAlert', false);
  insertBaseline(cleared.db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);
  const clearedClock = makeClock('2026-04-10T14:00:00.000Z');
  const clearedRecorder = recorder();
  const clearedEngine = engineFor(cleared.db, clearedClock, clearedRecorder.transport);
  assert.equal((await clearedEngine.tick()).sent, 1);
});

// ── 6. failure and backoff ────────────────────────────────────────────
test('failure: delivery errors back off at +1,+5,+15,+60,+240 minutes and then stay at 240', async (t) => {
  const { db } = makeDb(t, 'backoff');
  seedSettings(db, { reminders: STOCK_ONLY });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);

  const clock = makeClock('2026-04-10T14:00:00.000Z'); // 10:00 EDT (inside waking hours)
  const { transport, calls } = recorder(() => {
    throw new DeliveryError('fetch');
  });
  const engine = engineFor(db, clock, transport);
  const stockKey = () => occurrenceKeys(db, 'stock')[0];

  // [tick instant, expected attempt number, next_attempt_at produced]
  const steps = [
    ['2026-04-10T14:00:00.000Z', 1, '2026-04-10T14:01:00.000Z'],
    ['2026-04-10T14:01:00.000Z', 2, '2026-04-10T14:06:00.000Z'],
    ['2026-04-10T14:06:00.000Z', 3, '2026-04-10T14:21:00.000Z'],
    ['2026-04-10T14:21:00.000Z', 4, '2026-04-10T15:21:00.000Z'],
    ['2026-04-10T15:21:00.000Z', 5, '2026-04-10T19:21:00.000Z'],
    ['2026-04-10T19:21:00.000Z', 6, '2026-04-10T23:21:00.000Z'],
    ['2026-04-10T23:21:00.000Z', 7, '2026-04-11T03:21:00.000Z'],
  ];

  for (const [at, attempt, nextAttempt] of steps) {
    clock.set(at);
    const result = await engine.tick();
    assert.equal(result.failed, 1, `attempt ${attempt} fails`);
    assert.equal(calls.length, attempt);
    const row = occurrence(db, stockKey());
    assert.equal(row.status, 'pending');
    assert.equal(row.attempt, attempt);
    assert.equal(row.next_attempt_at, nextAttempt);
    assert.equal(row.last_error_category, 'fetch');
    assert.equal(row.last_error_status, null);

    // nothing is sent before next_attempt_at (including the retry tick)
    clock.set(new Date(Date.parse(nextAttempt) - 1000).toISOString());
    const idle = await engine.tick();
    assert.equal(idle.failed, 0);
    assert.equal(idle.sent, 0);
    assert.equal(calls.length, attempt, `no retry before ${nextAttempt}`);
    assert.equal(occurrence(db, stockKey()).next_attempt_at, nextAttempt);
  }
});

test('failure: a non-2xx response stores category http and the status without reading the body', async (t) => {
  const { db } = makeDb(t, 'backoff-http');
  seedSettings(db, { reminders: STOCK_ONLY });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);

  const fetchCalls = [];
  const fakeFetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: false,
      status: 503,
      get body() {
        throw new Error('response body must not be read');
      },
      text() {
        throw new Error('response body must not be read');
      },
      json() {
        throw new Error('response body must not be read');
      },
    };
  };
  const transport = createNtfyTransport({
    ntfyUrl: 'https://ntfy.example.invalid/topic', fetchImpl: fakeFetch,
  });

  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const engine = engineFor(db, clock, transport);
  const summary = await engine.tick();

  assert.equal(summary.failed, 1);
  assert.equal(fetchCalls.length, 1);
  const row = occurrence(db, occurrenceKeys(db, 'stock')[0]);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt, 1);
  assert.equal(row.last_error_category, 'http');
  assert.equal(row.last_error_status, 503);
  assert.equal(row.next_attempt_at, '2026-04-10T14:01:00.000Z');
});

// ── 7. condition disappearing before the retry ────────────────────────
test('retry: a disappeared condition turns the pending occurrence into a skip and never retries', async (t) => {
  // (a) preventive: logging a dose moves the automatic due day
  {
    const { db } = makeDb(t, 'retry-preventive');
    seedSettings(db, { reminders: { checkIn: false, lowStock: false, exercise: false } });
    insertMeds(db, [['e0', 'emgality', '2026-03-01T15:00:00.000Z']]); // due 2026-03-31
    const clock = makeClock('2026-03-31T14:00:00.000Z'); // 10:00 EDT
    const { transport, calls } = recorder(() => {
      throw new DeliveryError('fetch');
    });
    const engine = engineFor(db, clock, transport);

    assert.equal((await engine.tick()).failed, 1);
    assert.equal(calls.length, 1);
    assert.equal(occurrence(db, 'preventive:emgality:2026-03-31').status, 'pending');

    insertMeds(db, [['e1', 'emgality', '2026-03-31T14:00:00.000Z']]); // due 2026-04-30 now
    clock.set('2026-03-31T14:01:00.000Z');
    const retry = await engine.tick();
    assert.equal(retry.sent, 0);
    assert.equal(retry.failed, 0);
    assert.equal(calls.length, 1); // no transport call on the retry tick
    const row = occurrence(db, 'preventive:emgality:2026-03-31');
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error_category, 'condition_gone');
  }

  // (b) check-in: logging a day-state suppresses the pending prompt
  {
    const { db } = makeDb(t, 'retry-checkin');
    seedSettings(db, { reminders: CHECKIN_ONLY });
    const clock = makeClock('2026-04-10T22:00:00.000Z');
    const { transport, calls } = recorder(() => {
      throw new DeliveryError('fetch');
    });
    const engine = engineFor(db, clock, transport);

    assert.equal((await engine.tick()).failed, 1);
    assert.equal(calls.length, 1);
    db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
      VALUES ('2026-04-10','well','','2026-04-10T22:00:00.000Z')`).run();
    clock.set('2026-04-10T22:01:00.000Z');
    const retry = await engine.tick();
    assert.equal(retry.sent, 0);
    assert.equal(retry.failed, 0);
    assert.equal(calls.length, 1);
    const row = occurrence(db, 'checkin:2026-04-10');
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error_category, 'condition_gone');
  }

  // (c) exercise: meeting the weekly goals suppresses the pending prompt
  {
    const { db } = makeDb(t, 'retry-exercise');
    seedSettings(db, { reminders: EXERCISE_ONLY });
    const clock = makeClock('2026-04-10T22:30:00.000Z');
    const { transport, calls } = recorder(() => {
      throw new DeliveryError('fetch');
    });
    const engine = engineFor(db, clock, transport);

    assert.equal((await engine.tick()).failed, 1);
    assert.equal(calls.length, 1);
    seedWorkouts(db, WEEK_GOALS_MET);
    clock.set('2026-04-10T22:31:00.000Z');
    const retry = await engine.tick();
    assert.equal(retry.sent, 0);
    assert.equal(retry.failed, 0);
    assert.equal(calls.length, 1);
    const row = occurrence(db, 'exercise:2026-04-10');
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error_category, 'condition_gone');
  }

  // (d) stock: replenishing above the threshold releases the pending alert
  {
    const { db } = makeDb(t, 'retry-stock');
    seedSettings(db, { reminders: STOCK_ONLY });
    insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);
    const clock = makeClock('2026-04-10T14:00:00.000Z');
    const { transport, calls } = recorder(() => {
      throw new DeliveryError('fetch');
    });
    const engine = engineFor(db, clock, transport);

    assert.equal((await engine.tick()).failed, 1);
    assert.equal(calls.length, 1);
    insertRefill(db, 'r1', 'nurtec', '2026-04-10', 8); // 1 + 8 = 9 > 2
    clock.set('2026-04-10T14:01:00.000Z');
    const retry = await engine.tick();
    assert.equal(retry.sent, 0);
    assert.equal(retry.failed, 0);
    assert.equal(calls.length, 1);
    const row = occurrence(db, occurrenceKeys(db, 'stock')[0]);
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error_category, 'condition_gone');
    assert.equal(stateValue(db, 'low_stock').phase, 'armed');
  }
});

// ── 8. persistence, restart, and recovery ─────────────────────────────
test('restart: a failed pending row is retried by a fresh engine on the same database', async (t) => {
  const { db } = makeDb(t, 'restart-failed');
  seedSettings(db, { reminders: STOCK_ONLY });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);

  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const { transport, calls } = recorder((_message, n) => {
    if (n === 1) throw new DeliveryError('fetch');
    return { status: 200 };
  });

  const first = engineFor(db, clock, transport);
  assert.equal((await first.tick()).failed, 1);

  clock.plusMinutes(1);
  const restarted = engineFor(db, clock, transport);
  assert.equal((await restarted.tick()).sent, 1);
  assert.equal(calls.length, 2);
  const row = occurrence(db, occurrenceKeys(db, 'stock')[0]);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.attempt, 2);
});

test('recovery: recoverInterrupted requeues a leftover sending row and the next tick sends it', async (t) => {
  const { db } = makeDb(t, 'recovery');
  seedSettings(db, { reminders: CHECKIN_ONLY });
  // Simulate a process that died AFTER claiming the row and BEFORE writing
  // the result. At-least-once: if the HTTP POST actually landed, the user may
  // see this check-in twice. Exactly-once is NOT claimed.
  db.prepare(`INSERT INTO reminder_occurrences
    (key,type,med_id,scheduled_at,expires_at,status,attempt,next_attempt_at,
     last_attempt_at,sent_at,last_error_category,last_error_status,created_at,updated_at)
    VALUES ('checkin:2026-04-10','checkin',NULL,'2026-04-10T22:00:00.000Z',
            '2026-04-11T00:00:00.000Z','sending',1,'2026-04-10T22:00:00.000Z',
            '2026-04-10T22:00:00.000Z',NULL,NULL,NULL,
            '2026-04-10T22:00:00.000Z','2026-04-10T22:00:00.000Z')`).run();

  const clock = makeClock('2026-04-10T22:05:00.000Z'); // 18:05 EDT, inside grace
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal(engine.recoverInterrupted(), 1);
  assert.equal(occurrence(db, 'checkin:2026-04-10').status, 'pending');

  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(occurrence(db, 'checkin:2026-04-10').status, 'succeeded');
  assert.equal(occurrence(db, 'checkin:2026-04-10').attempt, 2);
});

test('concurrency: tick() returns the same in-flight promise and sends exactly once', async (t) => {
  const { db } = makeDb(t, 'concurrent');
  seedSettings(db, { reminders: STOCK_ONLY });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const transport = async (message) => {
    calls.push(message);
    await gate;
    return { status: 200 };
  };
  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const engine = engineFor(db, clock, transport);

  const p1 = engine.tick();
  const p2 = engine.tick();
  assert.equal(p1, p2, 'one-process non-overlap: the same promise is returned');

  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, r2);
  assert.equal(r1.sent, 1);
  assert.equal(calls.length, 1);

  clock.plusMinutes(1);
  assert.equal((await engine.tick()).sent, 0); // and later ticks run normally
  assert.equal(calls.length, 1);
});

test('disabled: the master switch returns {disabled:true} and never calls a transport', async (t) => {
  const { db } = makeDb(t, 'disabled');
  seedSettings(db, {
    reminders: { ...STOCK_ONLY, enabled: false },
    planned: { emgality: '2026-04-01' },
  });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);

  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.deepEqual(await engine.tick(), {
    disabled: true, generated: 0, sent: 0, failed: 0, skipped: 0,
  });
  assert.equal(calls.length, 0);
  assert.equal(occurrenceCount(db), 0);
});

// ── 9. DST contract ───────────────────────────────────────────────────
test('DST: a nonexistent spring-forward 02:30 resolves to 03:30 local / 07:30Z and sends', async (t) => {
  const { db } = makeDb(t, 'dst-spring');
  seedSettings(db, {
    reminders: {
      preventive: false, lowStock: false, exercise: false,
      wakingStart: '02:00', wakingEnd: '05:00', checkInTime: '02:30',
    },
  });
  const clock = makeClock('2026-03-08T07:29:00.000Z');
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 0); // 03:29 local: not yet scheduled
  assert.equal(calls.length, 0);

  clock.set('2026-03-08T07:30:00.000Z'); // resolved 03:30 EDT
  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
  const row = occurrence(db, 'checkin:2026-03-08');
  assert.equal(row.scheduled_at, '2026-03-08T07:30:00.000Z');
  assert.equal(row.expires_at, '2026-03-08T09:30:00.000Z');
});

test('DST: an ambiguous fall-back 01:30 resolves to the first occurrence and never duplicates', async (t) => {
  const { db } = makeDb(t, 'dst-fall');
  seedSettings(db, {
    reminders: {
      preventive: false, lowStock: false, exercise: false,
      wakingStart: '01:00', wakingEnd: '04:00', checkInTime: '01:30',
    },
  });
  const clock = makeClock('2026-11-01T05:30:00.000Z'); // first 01:30 EDT
  const { transport, calls } = recorder();
  const engine = engineFor(db, clock, transport);

  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    occurrence(db, 'checkin:2026-11-01').scheduled_at,
    '2026-11-01T05:30:00.000Z',
  );

  clock.set('2026-11-01T06:30:00.000Z'); // the repeated second 01:30 EST
  assert.equal((await engine.tick()).sent, 0);
  assert.equal(calls.length, 1);
  assert.equal(occurrenceKeys(db, 'checkin').length, 1);
});

// ── 10. secrets never reach logs or stored error fields ───────────────
test('secrets: engine logs and stored error fields never contain the ntfy URL or token', async (t) => {
  const { db } = makeDb(t, 'secrets-log');
  seedSettings(db, { reminders: STOCK_ONLY });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);

  const FAKE_URL = 'https://ntfy.example.invalid/secret-topic';
  const FAKE_TOKEN = 'tk_fake_secret_abc123';
  const logs = [];
  const transport = createNtfyTransport({
    ntfyUrl: FAKE_URL,
    ntfyToken: FAKE_TOKEN,
    fetchImpl: async () => {
      throw new Error(`connect ECONNREFUSED ${FAKE_URL} token=${FAKE_TOKEN}`);
    },
  });
  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const engine = engineFor(db, clock, transport, (message) => logs.push(message));

  const summary = await engine.tick();
  assert.equal(summary.failed, 1);
  assert.deepEqual(logs, ['reminder delivery failed (fetch)']); // fixed category text only

  const row = db.prepare('SELECT * FROM reminder_occurrences').get();
  assert.equal(row.last_error_category, 'fetch');
  assert.equal(row.last_error_status, null);
  const rowText = JSON.stringify(row);
  assert.equal(rowText.includes(FAKE_URL), false);
  assert.equal(rowText.includes(FAKE_TOKEN), false);
  assert.equal(logs.join('\n').includes(FAKE_URL), false);
  assert.equal(logs.join('\n').includes(FAKE_TOKEN), false);

  // The environment-only credentials are never written into settings/export.
  const settingsText = JSON.stringify(collectSettings(db));
  assert.equal(settingsText.includes(FAKE_URL), false);
  assert.equal(settingsText.includes(FAKE_TOKEN), false);
});

test('secrets: a non-DeliveryError is classified as unknown without its message', async (t) => {
  const { db } = makeDb(t, 'secrets-unknown');
  seedSettings(db, { reminders: STOCK_ONLY });
  insertBaseline(db, 'b1', 'nurtec', '2026-04-01T00:00:00.000Z', 1);

  const logs = [];
  const secret = 'https://ntfy.example.invalid/another-secret';
  const transport = async () => {
    throw new Error(`unexpected failure at ${secret}`);
  };
  const clock = makeClock('2026-04-10T14:00:00.000Z');
  const engine = engineFor(db, clock, transport, (message) => logs.push(message));

  assert.equal((await engine.tick()).failed, 1);
  assert.deepEqual(logs, ['reminder delivery failed (unknown)']);
  const row = db.prepare('SELECT * FROM reminder_occurrences').get();
  assert.equal(row.last_error_category, 'unknown');
  assert.equal(row.last_error_status, null);
  assert.equal(JSON.stringify(row).includes(secret), false);
});
