// Checkpoint 2: immediate attack start/end ntfy alerts (app/server/reminders.js,
// app/server/reminder-config.js, app/server/app.js wiring).
//
// Everything runs against a disposable temp database with an INJECTED clock and
// fake transports: no real clock, no network, no listening port, no real ntfy
// server, no real data directory. Personal and attack topics each get their own
// recorder so routing is observable.
//
// Event-driven policy under test:
// - only a genuine INSERT (before === null) records a start alert;
// - only a null/absent -> non-null `end` transition records an end alert;
// - an event instant is fresh when now-60min <= t <= now+5min (inclusive);
// - stale alerts are skipped at send time when the attack changed or vanished.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { buildApp } from '../app.js';
import { makeTempDir, cleanupDir } from './helpers.js';
import {
  ATTACK_FUTURE_WINDOW_MS, ATTACK_PAST_WINDOW_MS, ATTACK_RETRY_WINDOW_MS, createReminderEngine,
} from '../reminders.js';
import { attackViewUrl } from '../reminder-config.js';
import { createNtfyTransport, DeliveryError } from '../ntfy.js';
import { dumpBackup } from '../backup.js';
import { collectSettings } from '../snapshot.js';

const NY = 'America/New_York';
const NOW = '2026-04-10T22:00:00.000Z'; // 18:00 EDT
const FAKE_ATTACK_URL = 'https://ntfy.example.invalid/attack-secret-topic';
const FAKE_ATTACK_TOKEN = 'tk_fake_attack_secret_xyz789';

// Personal reminder types are all off so only attack rows can ever be sent in
// most tests; the master switch and waking window are irrelevant to attacks.
const ATTACK_PERSONAL = {
  enabled: true, preventive: false, lowStock: false, checkIn: false, exercise: false,
};

const START_SUPPRESSED_LOG =
  'attack alert start suppressed: instant outside freshness window or invalid';
const END_SUPPRESSED_LOG =
  'attack alert end suppressed: instant outside freshness window or invalid';

// ── harness ───────────────────────────────────────────────────────────
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

function seedSettings(db, { reminders = {}, timezone = NY } = {}) {
  setSetting(db, 'timezone', timezone);
  setSetting(db, 'reminders', { ...BASE_REMINDERS, ...reminders });
}

/** Injectable clock: explicit instants only, never wall time. */
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

const fmt = (instant, timeZone = NY) => new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone,
}).format(new Date(instant));

function makeHarness(t, {
  label = 'attack-alerts',
  reminders = ATTACK_PERSONAL,
  timezone = NY,
  nowIso = NOW,
  personal = true,
  attack = true,
  personalImpl,
  attackImpl,
} = {}) {
  const dir = makeTempDir(`migraine-${label}`);
  const db = openDatabase(join(dir, 'data'), { log: () => {} });
  const clock = makeClock(nowIso);
  const personalRecorder = recorder(personalImpl);
  const attackRecorder = recorder(attackImpl);
  seedSettings(db, { reminders, timezone });
  const logs = [];
  const engine = createReminderEngine({
    db,
    transport: personal ? personalRecorder.transport : null,
    attackTransport: attack ? attackRecorder.transport : null,
    now: clock.now,
    log: (message) => logs.push(message),
  });
  let app = null;
  t.after(async () => {
    try {
      await app?.close(); // onClose closes the database
    } catch {
      // already closed
    }
    try {
      db.close();
    } catch {
      // already closed
    }
    cleanupDir(dir);
  });
  return {
    db,
    dir,
    clock,
    engine,
    logs,
    personal: personalRecorder,
    attack: attackRecorder,
    async openApp(hook) {
      app = await buildApp({ db, logger: false, onAttackChange: hook });
      return app;
    },
  };
}

const occurrence = (db, key) =>
  db.prepare('SELECT * FROM reminder_occurrences WHERE key = ?').get(key);
const occurrenceKeys = (db, type) => db.prepare(
  'SELECT key FROM reminder_occurrences WHERE type = ? ORDER BY key',
).all(type).map((row) => row.key);
const occurrenceCount = (db) =>
  db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get().n;

const insertAttack = (db, id, start, end = null) => db.prepare(
  'INSERT INTO attacks (id,start,"end") VALUES (?,?,?)',
).run(id, start, end);

/** Raw pending personal occurrence (personal generation never runs here). */
const insertPendingOccurrence = (db, {
  key, type, scheduledAt, expiresAt = null, nextAttemptAt = NOW,
}) => db.prepare(`INSERT INTO reminder_occurrences
  (key,type,med_id,scheduled_at,expires_at,status,attempt,next_attempt_at,
   last_attempt_at,sent_at,last_error_category,last_error_status,created_at,updated_at)
  VALUES (?,?,NULL,?,?,'pending',0,?,NULL,NULL,NULL,NULL,?,?)`)
  .run(key, type, scheduledAt, expiresAt, nextAttemptAt, scheduledAt, scheduledAt);

const postAttack = (app, payload) => app.inject({
  method: 'POST', url: '/api/attacks', payload,
});

const endOccurrenceKey = (id, instant) => `attack_end:${id}:${instant}`;
const startOccurrenceKey = (id, instant) => `attack_start:${id}:${instant}`;
/** Retry bound: an occurrence for `instant` expires ATTACK_RETRY_WINDOW_MS later. */
const retryExpiry = (instant) =>
  new Date(Date.parse(instant) + ATTACK_RETRY_WINDOW_MS).toISOString();

// ── 1. configuration constants are exported and documented ────────────
test('policy: the freshness window is 60 minutes past / 5 minutes future', () => {
  assert.equal(ATTACK_PAST_WINDOW_MS, 60 * 60 * 1000);
  assert.equal(ATTACK_FUTURE_WINDOW_MS, 5 * 60 * 1000);
  assert.equal(ATTACK_RETRY_WINDOW_MS, 24 * 60 * 60 * 1000);
});

// ── 2. fresh start insert ─────────────────────────────────────────────
test('start: a fresh POST sends exactly one start alert on the attack topic only', async (t) => {
  const h = makeHarness(t, { label: 'attack-post-start' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  const res = await postAttack(app, { id: 'a-start', start: '2026-04-10T21:58:00.000Z' });
  assert.equal(res.statusCode, 201);

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 1);
  assert.equal(h.attack.calls.length, 1);
  assert.equal(h.attack.calls[0].title, 'Attack started');
  assert.match(h.attack.calls[0].body, /^Attack started at 5:58/);
  assert.equal(
    h.attack.calls[0].body,
    `Attack started at ${fmt('2026-04-10T21:58:00.000Z')}.`,
  );
  assert.equal(h.personal.calls.length, 0);

  const row = occurrence(h.db, startOccurrenceKey('a-start', '2026-04-10T21:58:00.000Z'));
  assert.equal(row.type, 'attack_start');
  assert.equal(row.med_id, 'a-start'); // attack id, not a medication
  assert.equal(row.scheduled_at, '2026-04-10T21:58:00.000Z');
  assert.equal(row.expires_at, retryExpiry('2026-04-10T21:58:00.000Z')); // 24h retry bound
  assert.equal(row.status, 'succeeded');
});

test('start: the attack message never contains health details', async (t) => {
  const h = makeHarness(t, { label: 'attack-message-details' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));
  await postAttack(app, {
    id: 'a-detail',
    start: '2026-04-10T21:58:00.000Z',
    peakPain: 8,
    symptoms: ['nausea'],
    triggers: ['sleep'],
    aura: true,
    notes: 'secret note',
    painLog: [{ ts: '2026-04-10T21:58:00.000Z', level: 8 }],
  });
  await h.engine.tick();
  assert.equal(h.attack.calls.length, 1);
  const text = `${h.attack.calls[0].title} ${h.attack.calls[0].body}`;
  for (const detail of ['nausea', 'sleep', 'aura', 'secret note', 'peak', 'pain']) {
    assert.equal(text.includes(detail), false, `message must not contain ${detail}`);
  }
});

// ── 3. freshness (enqueue-time) ───────────────────────────────────────
test('freshness: 60 minutes past and 5 minutes future are inclusive; outside both bounds is ignored', async (t) => {
  const cases = [
    ['61 minutes old', '2026-04-10T20:59:00.000Z', 0],
    ['1 second beyond the 60-minute past bound', '2026-04-10T20:59:59.000Z', 0],
    ['exactly 60 minutes old (boundary, inclusive)', '2026-04-10T21:00:00.000Z', 1],
    ['6 minutes ahead', '2026-04-10T22:06:00.000Z', 0],
    ['exactly 5 minutes ahead (boundary, inclusive)', '2026-04-10T22:05:00.000Z', 1],
  ];

  for (const [label, start, expected] of cases) {
    const h = makeHarness(t, { label: `attack-fresh-${expected}-${label.length}` });
    const app = await h.openApp((event) => h.engine.noteAttackWrite(event));
    const res = await postAttack(app, { id: 'a-fresh', start });
    assert.equal(res.statusCode, 201, label);
    await h.engine.tick();
    assert.equal(h.attack.calls.length, expected, label);
    assert.equal(
      occurrenceCount(h.db), expected, label,
    );
  }
});

test('freshness: an unparseable start is never enqueued', async (t) => {
  const h = makeHarness(t, { label: 'attack-fresh-invalid' });
  h.engine.noteAttackWrite({
    before: null, after: { id: 'a-bad', start: 'not-a-timestamp', end: null },
  });
  await h.engine.tick();
  assert.equal(h.attack.calls.length, 0);
  assert.equal(occurrenceCount(h.db), 0);
});

// ── 3b. safe suppression logging ──────────────────────────────────────
test('logging: a suppressed stale start logs exactly one fixed message and enqueues nothing', async (t) => {
  const h = makeHarness(t, { label: 'attack-log-stale-start' });
  const id = 'a-log-stale-9271';
  const instant = '2026-04-10T20:00:00.000Z'; // 2 hours old

  h.engine.noteAttackWrite({ before: null, after: { id, start: instant, end: null } });

  assert.deepEqual(h.logs, [START_SUPPRESSED_LOG]);
  assert.equal(occurrenceCount(h.db), 0);
  for (const line of h.logs) {
    assert.equal(line.includes(id), false);
    assert.equal(line.includes(instant), false);
  }
});

test('logging: suppressed future and invalid starts log the same fixed message', async (t) => {
  const h = makeHarness(t, { label: 'attack-log-bad-start' });
  const id = 'a-log-future-4412';
  const future = '2026-04-10T22:30:00.000Z'; // 30 minutes ahead
  const invalid = 'not-a-timestamp';

  h.engine.noteAttackWrite({ before: null, after: { id, start: future, end: null } });
  h.engine.noteAttackWrite({ before: null, after: { id, start: invalid, end: null } });

  assert.deepEqual(h.logs, [START_SUPPRESSED_LOG, START_SUPPRESSED_LOG]);
  assert.equal(occurrenceCount(h.db), 0);
  for (const line of h.logs) {
    assert.equal(line.includes(id), false);
    assert.equal(line.includes(future), false);
    assert.equal(line.includes(invalid), false);
  }
});

test('logging: a rejected end transition logs exactly the fixed end message', async (t) => {
  const h = makeHarness(t, { label: 'attack-log-stale-end' });
  const id = 'a-log-end-3388';
  const start = '2026-04-10T21:30:00.000Z';
  const end = '2026-04-10T19:00:00.000Z'; // stale end instant

  h.engine.noteAttackWrite({
    before: { id, start, end: null },
    after: { id, start, end },
  });

  assert.deepEqual(h.logs, [END_SUPPRESSED_LOG]);
  assert.equal(occurrenceCount(h.db), 0);
  for (const line of h.logs) {
    assert.equal(line.includes(id), false);
    assert.equal(line.includes(start), false);
    assert.equal(line.includes(end), false);
  }
});

test('logging: a normal fresh alert logs nothing', async (t) => {
  const h = makeHarness(t, { label: 'attack-log-fresh' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  const res = await postAttack(app, {
    id: 'a-log-fresh',
    start: '2026-04-10T21:30:00.000Z',
    end: '2026-04-10T21:58:00.000Z',
  });
  assert.equal(res.statusCode, 201);
  assert.equal(occurrenceCount(h.db), 2);
  assert.deepEqual(h.logs, []);
});

test('logging: existing-attack metadata and repeat-end PATCHes log nothing', async (t) => {
  const h = makeHarness(t, { label: 'attack-log-patch' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  const created = await postAttack(app, {
    id: 'a-log-patch',
    start: '2026-04-10T21:30:00.000Z',
    end: '2026-04-10T21:55:00.000Z',
  });
  assert.equal(created.statusCode, 201);
  assert.equal(occurrenceCount(h.db), 2);

  const metadata = await app.inject({
    method: 'PATCH',
    url: '/api/attacks/a-log-patch',
    payload: { peakPain: 7, notes: 'metadata only' },
  });
  assert.equal(metadata.statusCode, 200);
  const repeatEnd = await app.inject({
    method: 'PATCH',
    url: '/api/attacks/a-log-patch',
    payload: { end: '2026-04-10T21:58:00.000Z' },
  });
  assert.equal(repeatEnd.statusCode, 200);

  assert.deepEqual(h.logs, []);
  assert.equal(occurrenceCount(h.db), 2); // no new occurrence either
});

test('logging: a personal-only engine never logs attack suppression', async (t) => {
  const h = makeHarness(t, { label: 'attack-log-personal-only', attack: false });

  h.engine.noteAttackWrite({
    before: null,
    after: {
      id: 'a-log-personal-only',
      start: '2026-04-10T20:00:00.000Z',
      end: null,
    },
  });

  assert.deepEqual(h.logs, []);
  assert.equal(occurrenceCount(h.db), 0);
});

// ── 4. start + end in one POST; historical baselines ──────────────────
test('start+end: a fresh POST carrying both sends start then end with duration; a past-dated attack sends nothing', async (t) => {
  const h = makeHarness(t, { label: 'attack-post-complete' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  // Historical/backfilled attack (baseline): no occurrence, no alert ever.
  await postAttack(app, {
    id: 'a-old',
    start: '2026-04-10T10:00:00.000Z',
    end: '2026-04-10T11:00:00.000Z',
  });
  assert.equal(occurrenceCount(h.db), 0);

  await postAttack(app, {
    id: 'a-full',
    start: '2026-04-10T21:30:00.000Z',
    end: '2026-04-10T21:58:00.000Z',
  });

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 2);
  assert.deepEqual(h.attack.calls.map((c) => c.title), ['Attack started', 'Attack ended']);
  assert.equal(h.attack.calls[0].body, `Attack started at ${fmt('2026-04-10T21:30:00.000Z')}.`);
  assert.equal(h.attack.calls[1].body, `Attack ended at ${fmt('2026-04-10T21:58:00.000Z')} (28m).`);
  assert.equal(h.personal.calls.length, 0);
});

// ── 5. dedup across PATCHes, ticks, and restarts ──────────────────────
test('dedup: detail PATCHes, repeated ticks, and a fresh engine on the same DB never resend', async (t) => {
  const h = makeHarness(t, { label: 'attack-dedup' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));
  await postAttack(app, { id: 'a1', start: '2026-04-10T21:58:00.000Z' });

  assert.equal((await h.engine.tick()).sent, 1);
  assert.equal(h.attack.calls.length, 1);

  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/attacks/a1',
    payload: {
      peakPain: 7,
      notes: 'worse',
      symptoms: ['nausea'],
      painLog: [{ ts: '2026-04-10T21:58:00.000Z', level: 7 }],
    },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal((await h.engine.tick()).sent, 0);
  assert.equal(h.attack.calls.length, 1);
  assert.equal(occurrenceKeys(h.db, 'attack_start').length, 1);

  // A process restart (fresh engine, same database) dedupes on the key.
  h.clock.plusMinutes(2);
  const restarted = createReminderEngine({
    db: h.db,
    transport: h.personal.transport,
    attackTransport: h.attack.transport,
    now: h.clock.now,
    log: () => {},
  });
  assert.equal((await restarted.tick()).sent, 0);
  assert.equal(h.attack.calls.length, 1);
});

// ── 6. end transitions ────────────────────────────────────────────────
test('end: a null -> fresh end PATCH sends one end alert with duration', async (t) => {
  const h = makeHarness(t, { label: 'attack-end-patch' });
  insertAttack(h.db, 'a-end', '2026-04-10T21:30:00.000Z', null);
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/attacks/a-end',
    payload: { end: '2026-04-10T21:55:00.000Z' },
  });
  assert.equal(res.statusCode, 200);

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 1);
  assert.equal(h.attack.calls.length, 1);
  assert.equal(h.attack.calls[0].title, 'Attack ended');
  assert.equal(h.attack.calls[0].body, `Attack ended at ${fmt('2026-04-10T21:55:00.000Z')} (25m).`);
  const row = occurrence(h.db, endOccurrenceKey('a-end', '2026-04-10T21:55:00.000Z'));
  assert.equal(row.med_id, 'a-end');
  assert.equal(row.scheduled_at, '2026-04-10T21:55:00.000Z');
  assert.equal(row.expires_at, retryExpiry('2026-04-10T21:55:00.000Z')); // 24h retry bound
  assert.equal(row.status, 'succeeded');
});

test('end: correcting X -> Y enqueues nothing and the pending X alert is skipped at send time', async (t) => {
  const h = makeHarness(t, { label: 'attack-end-corrected' });
  insertAttack(h.db, 'a-cor', '2026-04-10T21:30:00.000Z', null);
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  await app.inject({
    method: 'PATCH', url: '/api/attacks/a-cor', payload: { end: '2026-04-10T21:55:00.000Z' },
  });
  assert.equal(occurrenceCount(h.db), 1);

  await app.inject({
    method: 'PATCH', url: '/api/attacks/a-cor', payload: { end: '2026-04-10T21:58:00.000Z' },
  });
  assert.equal(occurrenceCount(h.db), 1); // no new occurrence for the correction

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 0);
  assert.equal(h.attack.calls.length, 0);
  const row = occurrence(h.db, endOccurrenceKey('a-cor', '2026-04-10T21:55:00.000Z'));
  assert.equal(row.status, 'skipped');
  assert.equal(row.last_error_category, 'condition_gone');
});

test('end: clearing end back to null skips the pending end alert via relevance', async (t) => {
  const h = makeHarness(t, { label: 'attack-end-cleared' });
  insertAttack(h.db, 'a-clear', '2026-04-10T21:30:00.000Z', null);
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  await app.inject({
    method: 'PATCH', url: '/api/attacks/a-clear', payload: { end: '2026-04-10T21:55:00.000Z' },
  });
  assert.equal(occurrenceCount(h.db), 1);

  await app.inject({
    method: 'PATCH', url: '/api/attacks/a-clear', payload: { end: null },
  });
  const summary = await h.engine.tick();
  assert.equal(summary.sent, 0);
  assert.equal(h.attack.calls.length, 0);
  const row = occurrence(h.db, endOccurrenceKey('a-clear', '2026-04-10T21:55:00.000Z'));
  assert.equal(row.status, 'skipped');
  assert.equal(row.last_error_category, 'condition_gone');
});

test('end: deleting the attack skips pending start and end alerts', async (t) => {
  const h = makeHarness(t, { label: 'attack-deleted' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));
  await postAttack(app, {
    id: 'a-del',
    start: '2026-04-10T21:30:00.000Z',
    end: '2026-04-10T21:50:00.000Z',
  });
  assert.equal(occurrenceCount(h.db), 2);

  const res = await app.inject({ method: 'DELETE', url: '/api/attacks/a-del' });
  assert.equal(res.statusCode, 200);

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 0);
  assert.equal(h.attack.calls.length, 0);
  for (const row of h.db.prepare('SELECT * FROM reminder_occurrences').all()) {
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error_category, 'condition_gone');
  }
});

// ── 7. duration edge cases ────────────────────────────────────────────
test('duration: end before start prints no duration; an unparseable stored start still alerts', async (t) => {
  // (a) negative interval
  const neg = makeHarness(t, { label: 'attack-duration-negative' });
  insertAttack(neg.db, 'a-neg', '2026-04-10T21:59:00.000Z', null);
  const negApp = await neg.openApp((event) => neg.engine.noteAttackWrite(event));
  await negApp.inject({
    method: 'PATCH', url: '/api/attacks/a-neg', payload: { end: '2026-04-10T21:40:00.000Z' },
  });
  assert.equal((await neg.engine.tick()).sent, 1);
  assert.equal(
    neg.attack.calls[0].body,
    `Attack ended at ${fmt('2026-04-10T21:40:00.000Z')}.`,
  );

  // (b) stored start cannot be parsed -> no duration, alert still sends
  const bad = makeHarness(t, { label: 'attack-duration-badstart' });
  insertAttack(bad.db, 'a-badstart', 'not-a-timestamp', null);
  const badApp = await bad.openApp((event) => bad.engine.noteAttackWrite(event));
  await badApp.inject({
    method: 'PATCH', url: '/api/attacks/a-badstart', payload: { end: '2026-04-10T21:50:00.000Z' },
  });
  assert.equal((await bad.engine.tick()).sent, 1);
  assert.equal(
    bad.attack.calls[0].body,
    `Attack ended at ${fmt('2026-04-10T21:50:00.000Z')}.`,
  );
});

test('duration: 60+ minutes format as Xh Ym and whole minutes are rounded', async (t) => {
  const h = makeHarness(t, { label: 'attack-duration-hour' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));
  // The start is deliberately older than the 60-minute enqueue window (so no
  // start alert), while the end is fresh: the duration still uses the stored
  // start/end from the current row (~89.5 minutes -> 1h 30m).
  await postAttack(app, {
    id: 'a-long',
    start: '2026-04-10T20:30:00.000Z',
    end: '2026-04-10T21:59:30.000Z',
  });
  await h.engine.tick();
  assert.equal(h.attack.calls.length, 1);
  assert.equal(h.attack.calls[0].title, 'Attack ended');
  assert.match(h.attack.calls[0].body, /\(1h 30m\)\.$/);
  assert.equal(occurrenceKeys(h.db, 'attack_start').length, 0);
});

// ── 8. immediate tick wiring + master-switch/waking-hour bypass ───────
test('immediate: the production wiring records the event and triggers a tick without the route awaiting it', async (t) => {
  const h = makeHarness(t, { label: 'attack-immediate' });
  let ticks = 0;
  const app = await h.openApp((event) => {
    h.engine.noteAttackWrite(event);
    ticks += 1;
    void h.engine.tick();
  });

  const res = await postAttack(app, { id: 'a-now', start: '2026-04-10T21:59:00.000Z' });
  assert.equal(res.statusCode, 201);
  await h.engine.tick(); // joins the in-flight tick if it is still running
  assert.equal(ticks, 1);
  assert.equal(h.attack.calls.length, 1);
  assert.equal(h.attack.calls[0].title, 'Attack started');
});

test('bypass: a disabled master switch and outside waking hours still deliver the attack alert', async (t) => {
  const h = makeHarness(t, {
    label: 'attack-bypass',
    reminders: {
      ...ATTACK_PERSONAL,
      enabled: false,
      wakingStart: '09:00',
      wakingEnd: '21:00',
    },
    nowIso: '2026-04-10T07:00:00.000Z', // 03:00 EDT, outside waking hours
  });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  await postAttack(app, { id: 'a-night', start: '2026-04-10T06:58:00.000Z' });
  const summary = await h.engine.tick();
  assert.equal(summary.disabled, false);
  assert.equal(summary.sent, 1);
  assert.equal(h.attack.calls.length, 1);
  assert.equal(h.attack.calls[0].title, 'Attack started');
  assert.equal(h.personal.calls.length, 0);
  assert.equal(collectSettings(h.db).reminders.enabled, false);
});

test('bypass: with the master switch off and no attack topic, the old disabled summary is unchanged', async (t) => {
  const h = makeHarness(t, {
    label: 'attack-bypass-disabled',
    reminders: { ...ATTACK_PERSONAL, enabled: false },
    attack: false,
  });
  assert.deepEqual(await h.engine.tick(), {
    disabled: true, generated: 0, sent: 0, failed: 0, skipped: 0,
  });
});

// ── 9. attack-only and personal-only engines ──────────────────────────
test('attack-only: no personal occurrences are generated and pre-existing ones stay pending while attack rows deliver', async (t) => {
  const h = makeHarness(t, {
    label: 'attack-only',
    personal: false,
    reminders: { ...ATTACK_PERSONAL, checkIn: true },
  });
  // 18:00 local with check-in enabled would normally generate a personal
  // occurrence; without a personal topic none may be created. A leftover
  // pending personal row (e.g. from an earlier personal-enabled deployment)
  // must be suppressed, not burned and not crashed on.
  h.db.prepare(`INSERT INTO reminder_occurrences
    (key,type,med_id,scheduled_at,expires_at,status,attempt,next_attempt_at,
     last_attempt_at,sent_at,last_error_category,last_error_status,created_at,updated_at)
    VALUES ('checkin:2026-04-10','checkin',NULL,'2026-04-10T22:00:00.000Z',
            '2026-04-11T00:00:00.000Z','pending',0,'2026-04-10T22:00:00.000Z',
            NULL,NULL,NULL,NULL,'2026-04-10T22:00:00.000Z','2026-04-10T22:00:00.000Z')`).run();
  insertAttack(h.db, 'a-only', '2026-04-10T21:58:00.000Z');
  h.engine.noteAttackWrite({
    before: null, after: { id: 'a-only', start: '2026-04-10T21:58:00.000Z', end: null },
  });

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 1);
  assert.equal(h.attack.calls.length, 1);
  const checkin = occurrence(h.db, 'checkin:2026-04-10');
  assert.equal(checkin.status, 'pending'); // suppressed, not burned
  assert.equal(checkin.attempt, 0);
  assert.equal(occurrenceCount(h.db), 2); // only the seeded row + the attack row
});

test('personal-only: noteAttackWrite is a no-op and the API route creates no attack occurrences', async (t) => {
  const h = makeHarness(t, { label: 'attack-personal-only', attack: false });
  assert.doesNotThrow(() => h.engine.noteAttackWrite({
    before: null, after: { id: 'a-no', start: '2026-04-10T21:58:00.000Z', end: null },
  }));
  assert.equal(occurrenceCount(h.db), 0);

  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));
  const res = await postAttack(app, { id: 'a-no', start: '2026-04-10T21:58:00.000Z' });
  assert.equal(res.statusCode, 201);
  await h.engine.tick();
  assert.equal(occurrenceCount(h.db), 0);
  assert.equal(h.personal.calls.length, 0);
});

// ── 10. retry, recovery, restart ──────────────────────────────────────
test('retry: a failed attack send backs off one minute and succeeds on the next tick', async (t) => {
  const h = makeHarness(t, {
    label: 'attack-retry',
    attackImpl: (_message, n) => {
      if (n === 1) throw new DeliveryError('fetch');
      return { status: 200 };
    },
  });
  insertAttack(h.db, 'a-retry', '2026-04-10T21:58:00.000Z');
  h.engine.noteAttackWrite({
    before: null, after: { id: 'a-retry', start: '2026-04-10T21:58:00.000Z', end: null },
  });
  const key = startOccurrenceKey('a-retry', '2026-04-10T21:58:00.000Z');

  const first = await h.engine.tick();
  assert.equal(first.failed, 1);
  assert.equal(h.attack.calls.length, 1);
  let row = occurrence(h.db, key);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt, 1);
  assert.equal(row.next_attempt_at, '2026-04-10T22:01:00.000Z');
  assert.equal(row.last_error_category, 'fetch');

  h.clock.plusMinutes(1);
  const second = await h.engine.tick();
  assert.equal(second.sent, 1);
  assert.equal(h.attack.calls.length, 2);
  row = occurrence(h.db, key);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.attempt, 2);
  assert.equal(h.personal.calls.length, 0);
});

test('retry bound: an attack alert still undelivered 24 hours after the event is skipped as expired', async (t) => {
  const h = makeHarness(t, { label: 'attack-retry-bound' });
  insertAttack(h.db, 'a-bound', '2026-04-10T21:58:00.000Z');
  h.engine.noteAttackWrite({
    before: null, after: { id: 'a-bound', start: '2026-04-10T21:58:00.000Z', end: null },
  });
  const key = startOccurrenceKey('a-bound', '2026-04-10T21:58:00.000Z');
  assert.equal(occurrence(h.db, key).expires_at, '2026-04-11T21:58:00.000Z');

  // Nothing was delivered and the clock is now 24h + 1min past the event
  // instant, so the generic expired path drops the row instead of retrying.
  h.clock.set('2026-04-11T21:59:00.000Z');
  const summary = await h.engine.tick();
  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(h.attack.calls.length, 0);
  assert.equal(h.personal.calls.length, 0);

  const row = occurrence(h.db, key);
  assert.equal(row.status, 'skipped');
  assert.equal(row.last_error_category, 'expired');
  assert.equal(row.attempt, 0); // never claimed, never sent

  // Expiry — not a vanished/changed attack — caused the skip: the attack row
  // and the recorded occurrence instant are both unchanged.
  const attack = h.db.prepare('SELECT * FROM attacks WHERE id = ?').get('a-bound');
  assert.equal(attack.start, '2026-04-10T21:58:00.000Z');
  assert.equal(attack.end, null);
  assert.equal(row.scheduled_at, '2026-04-10T21:58:00.000Z');
});

test('recovery: recoverInterrupted requeues a leftover sending attack row and it delivers', async (t) => {
  const h = makeHarness(t, { label: 'attack-recovery' });
  insertAttack(h.db, 'a-rec', '2026-04-10T21:30:00.000Z');
  h.db.prepare(`INSERT INTO reminder_occurrences
    (key,type,med_id,scheduled_at,expires_at,status,attempt,next_attempt_at,
     last_attempt_at,sent_at,last_error_category,last_error_status,created_at,updated_at)
    VALUES ('attack_start:a-rec:2026-04-10T21:30:00.000Z','attack_start','a-rec',
            '2026-04-10T21:30:00.000Z',NULL,'sending',1,
            '2026-04-10T21:30:00.000Z','2026-04-10T21:30:00.000Z',NULL,NULL,NULL,
            '2026-04-10T21:30:00.000Z','2026-04-10T21:30:00.000Z')`).run();

  assert.equal(h.engine.recoverInterrupted(), 1);
  assert.equal(
    occurrence(h.db, startOccurrenceKey('a-rec', '2026-04-10T21:30:00.000Z')).status,
    'pending',
  );
  assert.equal((await h.engine.tick()).sent, 1);
  assert.equal(h.attack.calls.length, 1);
  const row = occurrence(h.db, startOccurrenceKey('a-rec', '2026-04-10T21:30:00.000Z'));
  assert.equal(row.status, 'succeeded');
  assert.equal(row.attempt, 2);
});

test('restart: a pending fresh alert recorded before shutdown is delivered by a fresh engine', async (t) => {
  const h = makeHarness(t, { label: 'attack-restart-pending' });
  insertAttack(h.db, 'a-pending', '2026-04-10T21:30:00.000Z', '2026-04-10T21:45:00.000Z');
  h.engine.noteAttackWrite({
    before: null,
    after: { id: 'a-pending', start: '2026-04-10T21:30:00.000Z', end: '2026-04-10T21:45:00.000Z' },
  });
  h.clock.plusMinutes(3);

  const restarted = createReminderEngine({
    db: h.db,
    transport: h.personal.transport,
    attackTransport: h.attack.transport,
    now: h.clock.now,
    log: () => {},
  });
  assert.equal((await restarted.tick()).sent, 2); // start + end, still fresh at enqueue time
  assert.deepEqual(h.attack.calls.map((c) => c.title), ['Attack started', 'Attack ended']);
});

// ── 11. API onAttackChange callback contract ──────────────────────────
test('api: POST and PATCH invoke onAttackChange with the correct before/after shapes', async (t) => {
  const h = makeHarness(t, { label: 'attack-callback-shapes' });
  const events = [];
  const app = await h.openApp((event) => events.push(event));

  await postAttack(app, { id: 'a-cb', start: '2026-04-10T21:30:00.000Z' });
  assert.equal(events.length, 1);
  assert.equal(events[0].before, null);
  assert.equal(events[0].after.id, 'a-cb');
  assert.equal(events[0].after.start, '2026-04-10T21:30:00.000Z');
  assert.equal(events[0].after.end, null);
  assert.equal(events[0].after.notes, '');

  await app.inject({
    method: 'PATCH', url: '/api/attacks/a-cb', payload: { end: '2026-04-10T21:55:00.000Z' },
  });
  assert.equal(events.length, 2);
  assert.equal(events[1].before.id, 'a-cb');
  assert.equal(events[1].before.end, null);
  assert.equal(events[1].after.end, '2026-04-10T21:55:00.000Z');
});

test('api: import and DELETE never invoke onAttackChange', async (t) => {
  const h = makeHarness(t, { label: 'attack-callback-import' });
  const events = [];
  const app = await h.openApp((event) => events.push(event));

  const imported = await app.inject({
    method: 'POST',
    url: '/api/import',
    payload: {
      schemaVersion: 4,
      attacks: [
        { id: 'a-import', start: '2026-04-10T21:00:00.000Z' },
        { id: 'a-import-end', start: '2026-04-10T20:00:00.000Z', end: '2026-04-10T21:00:00.000Z' },
      ],
    },
  });
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json().attacks, 2);
  assert.deepEqual(events, []);
  assert.equal(occurrenceCount(h.db), 0);

  await postAttack(app, { id: 'a-keep', start: '2026-04-10T21:30:00.000Z' });
  assert.equal(events.length, 1);
  const deleted = await app.inject({ method: 'DELETE', url: '/api/attacks/a-keep' });
  assert.equal(deleted.statusCode, 200);
  assert.equal(events.length, 1);
});

test('api: a throwing onAttackChange never fails POST/PATCH', async (t) => {
  const h = makeHarness(t, { label: 'attack-callback-throws' });
  let calls = 0;
  const app = await h.openApp(() => {
    calls += 1;
    throw new Error('boom');
  });

  const created = await postAttack(app, { id: 'a-throw', start: '2026-04-10T21:30:00.000Z' });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().id, 'a-throw');

  const patched = await app.inject({
    method: 'PATCH', url: '/api/attacks/a-throw', payload: { notes: 'ok' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().notes, 'ok');
  assert.equal(calls, 2);
});

// ── 12. persistence boundaries ────────────────────────────────────────
test('persistence: export/backup exclude attack occurrences and reset clears them', async (t) => {
  const h = makeHarness(t, { label: 'attack-persistence' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));
  await postAttack(app, { id: 'a-persist', start: '2026-04-10T21:58:00.000Z' });
  await h.engine.tick();
  assert.equal(occurrenceCount(h.db), 1);

  // Raw row with a caller-chosen key, to prove the key itself never leaks.
  h.db.prepare(`INSERT INTO reminder_occurrences
    (key,type,med_id,scheduled_at,expires_at,status,attempt,next_attempt_at,
     last_attempt_at,sent_at,last_error_category,last_error_status,created_at,updated_at)
    VALUES ('attack_end:a-raw:2026-04-10T21:00:00.000Z','attack_end','a-raw',
            '2026-04-10T21:00:00.000Z',NULL,'succeeded',1,
            '2026-04-10T21:00:00.000Z','2026-04-10T21:00:00.000Z',NULL,NULL,NULL,
            '2026-04-10T21:00:00.000Z','2026-04-10T21:00:00.000Z')`).run();

  const exportText = (await app.inject({ method: 'GET', url: '/api/export' })).body;
  const file = dumpBackup({
    db: h.db, backupDir: join(h.dir, 'backups'), now: new Date('2026-04-10T12:00:00.000Z'), log: () => {},
  });
  const backupText = readFileSync(file, 'utf8');

  for (const [label, text] of [['export', exportText], ['backup', backupText]]) {
    assert.equal(text.includes('reminder_occurrences'), false, label);
    assert.equal(text.includes('attack_start'), false, label);
    assert.equal(text.includes('attack_end'), false, label);
    assert.equal(text.includes('attack_start:a-persist'), false, label);
    assert.equal(text.includes('attack_end:a-raw'), false, label);
    assert.equal(text.includes(FAKE_ATTACK_URL), false, label);
  }

  assert.equal(occurrenceCount(h.db), 2);
  const reset = await app.inject({ method: 'POST', url: '/api/reset' });
  assert.equal(reset.statusCode, 200);
  assert.equal(occurrenceCount(h.db), 0);
});

// ── 13. secrets and click link ────────────────────────────────────────
test('secrets: attack credentials never reach logs, occurrence rows, settings, or export', async (t) => {
  const h = makeHarness(t, { label: 'attack-secrets' });
  insertAttack(h.db, 'a-secret', '2026-04-10T21:58:00.000Z');
  const fetchCalls = [];
  const transport = createNtfyTransport({
    ntfyUrl: FAKE_ATTACK_URL,
    ntfyToken: FAKE_ATTACK_TOKEN,
    publicAppUrl: attackViewUrl('https://migraine.example.com'),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      throw new Error(`connect ECONNREFUSED ${FAKE_ATTACK_URL} token=${FAKE_ATTACK_TOKEN}`);
    },
  });
  const logs = [];
  const engine = createReminderEngine({
    db: h.db,
    transport: null,
    attackTransport: transport,
    now: h.clock.now,
    log: (message) => logs.push(message),
  });
  engine.noteAttackWrite({
    before: null, after: { id: 'a-secret', start: '2026-04-10T21:58:00.000Z', end: null },
  });

  const summary = await engine.tick();
  assert.equal(summary.failed, 1);
  assert.deepEqual(logs, ['reminder delivery failed (fetch)']);

  // The transport posts the exact topic URL with a /view click link.
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, FAKE_ATTACK_URL);
  assert.equal(fetchCalls[0].options.headers.Click, 'https://migraine.example.com/view');
  assert.equal(fetchCalls[0].options.headers.Authorization, `Bearer ${FAKE_ATTACK_TOKEN}`);

  const rowText = JSON.stringify(
    h.db.prepare('SELECT * FROM reminder_occurrences').get(),
  );
  const settingsText = JSON.stringify(collectSettings(h.db));
  const app = await h.openApp();
  const exportText = (await app.inject({ method: 'GET', url: '/api/export' })).body;
  for (const [label, text] of [
    ['occurrence row', rowText],
    ['logs', logs.join('\n')],
    ['settings', settingsText],
    ['export', exportText],
  ]) {
    assert.equal(text.includes(FAKE_ATTACK_URL), false, label);
    assert.equal(text.includes(FAKE_ATTACK_TOKEN), false, label);
    assert.equal(text.includes('attack-secret-topic'), false, label);
  }
});

// ── 14. master-gate, starvation, and start/end correction regressions ──
test('gate: with the master switch off, personal rows are suppressed before expiry and the attack alert still delivers', async (t) => {
  const h = makeHarness(t, {
    label: 'attack-master-gate',
    // checkIn stays ON at the per-type level so only the master switch can
    // stop these rows: that is exactly the regression under test.
    reminders: { ...ATTACK_PERSONAL, enabled: false, checkIn: true },
  });
  // Due and in grace; relevant if the master switch were on.
  insertPendingOccurrence(h.db, {
    key: 'checkin:2026-04-10',
    type: 'checkin',
    scheduledAt: '2026-04-10T22:00:00.000Z',
    expiresAt: '2026-04-11T00:00:00.000Z',
  });
  // Transient row already past its grace window: suppression must precede the
  // expiry skip, otherwise a disabled master switch burns it.
  insertPendingOccurrence(h.db, {
    key: 'checkin:2026-04-09',
    type: 'checkin',
    scheduledAt: '2026-04-09T22:00:00.000Z',
    expiresAt: '2026-04-10T00:00:00.000Z',
  });

  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));
  const res = await postAttack(app, { id: 'a-gate', start: '2026-04-10T21:58:00.000Z' });
  assert.equal(res.statusCode, 201);

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 1);
  assert.equal(h.attack.calls.length, 1);
  assert.equal(h.attack.calls[0].title, 'Attack started');
  assert.equal(h.personal.calls.length, 0);

  for (const key of ['checkin:2026-04-10', 'checkin:2026-04-09']) {
    const row = occurrence(h.db, key);
    assert.equal(row.status, 'pending', `${key} must stay pending, never burned`);
    assert.equal(row.attempt, 0, `${key} must never be claimed`);
    assert.equal(row.last_error_category, null, `${key} must not be skipped`);
  }
  assert.equal(occurrenceCount(h.db), 3); // two suppressed personal rows + the attack row
  assert.equal(collectSettings(h.db).reminders.enabled, false);
});

test('starvation: 25 earlier-scheduled suppressed personal rows cannot delay attack delivery', async (t) => {
  const h = makeHarness(t, {
    label: 'attack-starvation',
    reminders: { ...ATTACK_PERSONAL, enabled: false, checkIn: true },
  });
  // More due personal rows than one per-tick window, all scheduled before the
  // attack and all suppressed by the master switch. A single shared LIMIT
  // query would fill its whole window with these and never see the attack.
  const days = [];
  for (let i = 1; i <= 25; i += 1) {
    const day = `2026-03-${String(i).padStart(2, '0')}`;
    days.push(day);
    insertPendingOccurrence(h.db, {
      key: `checkin:${day}`,
      type: 'checkin',
      scheduledAt: `${day}T22:00:00.000Z`,
      expiresAt: `${day}T23:59:00.000Z`,
    });
  }

  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));
  const res = await postAttack(app, { id: 'a-starve', start: '2026-04-10T21:58:00.000Z' });
  assert.equal(res.statusCode, 201);

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 0);
  assert.equal(h.attack.calls.length, 1);
  assert.equal(h.attack.calls[0].title, 'Attack started');
  assert.equal(h.personal.calls.length, 0);

  // Every suppressed personal row is untouched and still pending.
  for (const day of days) {
    const row = occurrence(h.db, `checkin:${day}`);
    assert.equal(row.status, 'pending', `${day} stays pending`);
  }
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS n FROM reminder_occurrences WHERE status = 'pending'").get().n,
    25,
  );
});

test('end: a stored empty-string end counts as absent, so the first real end still alerts', async (t) => {
  const h = makeHarness(t, { label: 'attack-end-empty-string' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  const created = await postAttack(app, {
    id: 'a-empty-end',
    start: '2026-04-10T21:30:00.000Z',
    end: '', // the API accepts any string end; '' means "not ended"
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().end, '');
  assert.equal(occurrenceKeys(h.db, 'attack_end').length, 0);

  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/attacks/a-empty-end',
    payload: { end: '2026-04-10T21:55:00.000Z' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().end, '2026-04-10T21:55:00.000Z');
  assert.equal(occurrenceKeys(h.db, 'attack_end').length, 1);

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 2); // the pending start alert plus the new end alert
  assert.equal(summary.failed, 0);
  const endCalls = h.attack.calls.filter((call) => call.title === 'Attack ended');
  assert.equal(endCalls.length, 1);
  assert.equal(
    endCalls[0].body,
    `Attack ended at ${fmt('2026-04-10T21:55:00.000Z')} (25m).`,
  );
  const row = occurrence(h.db, endOccurrenceKey('a-empty-end', '2026-04-10T21:55:00.000Z'));
  assert.equal(row.status, 'succeeded');
  assert.equal(h.personal.calls.length, 0);
});

test('start: correcting the start before delivery skips the pending alert and enqueues no replacement', async (t) => {
  const h = makeHarness(t, { label: 'attack-start-corrected' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  const created = await postAttack(app, { id: 'a-start-cor', start: '2026-04-10T21:40:00.000Z' });
  assert.equal(created.statusCode, 201);
  assert.equal(occurrenceKeys(h.db, 'attack_start').length, 1);

  // Correct the start BEFORE any tick: the recorded occurrence is now stale.
  // Conservative policy: a start correction never re-alerts.
  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/attacks/a-start-cor',
    payload: { start: '2026-04-10T21:58:00.000Z' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().start, '2026-04-10T21:58:00.000Z');
  assert.equal(occurrenceKeys(h.db, 'attack_start').length, 1);

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 0);
  assert.equal(h.attack.calls.length, 0);
  const row = occurrence(h.db, startOccurrenceKey('a-start-cor', '2026-04-10T21:40:00.000Z'));
  assert.equal(row.status, 'skipped');
  assert.equal(row.last_error_category, 'condition_gone');
  // No replacement occurrence for the corrected instant.
  assert.deepEqual(
    occurrenceKeys(h.db, 'attack_start'),
    [startOccurrenceKey('a-start-cor', '2026-04-10T21:40:00.000Z')],
  );
  assert.equal(h.personal.calls.length, 0);
});

// ── 15. delayed delivery on a later local day ─────────────────────────
test('delayed: an alert delivered the next local day dates the event and still includes duration', async (t) => {
  // Local event day: both instants are Apr 10 EDT. Delivery happens 16 hours
  // later, on Apr 11 EDT, still inside the 24h retry bound.
  const h = makeHarness(t, { label: 'attack-delayed-dating' });
  const app = await h.openApp((event) => h.engine.noteAttackWrite(event));

  const created = await postAttack(app, { id: 'a-late', start: '2026-04-10T21:00:00.000Z' });
  assert.equal(created.statusCode, 201);
  const patched = await app.inject({
    method: 'PATCH', url: '/api/attacks/a-late', payload: { end: '2026-04-10T22:00:00.000Z' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(h.attack.calls.length, 0); // recorded, not yet delivered

  h.clock.set('2026-04-11T14:00:00.000Z'); // Apr 11 10:00 EDT
  const summary = await h.engine.tick();
  assert.equal(summary.sent, 2);
  assert.deepEqual(h.attack.calls.map((c) => c.title), ['Attack started', 'Attack ended']);
  // The date keeps a stale alert from reading as a current event.
  assert.equal(h.attack.calls[0].body, 'Attack started at 5:00 PM on Apr 10, 2026.');
  assert.equal(h.attack.calls[1].body, 'Attack ended at 6:00 PM on Apr 10, 2026 (1h 0m).');
  assert.equal(h.personal.calls.length, 0);
});

// ── 16. one mixed tick (personal + attack topics) ─────────────────────
test('mixed: a due personal check-in and a fresh attack start both deliver in one tick', async (t) => {
  const h = makeHarness(t, {
    label: 'attack-mixed-tick',
    reminders: { ...ATTACK_PERSONAL, checkIn: true },
  });
  // With-checkin-time, inside grace and waking hours (18:00 EDT, 09:00-21:00),
  // and no day_states rows, so checkInMissing is true.
  insertPendingOccurrence(h.db, {
    key: 'checkin:2026-04-10',
    type: 'checkin',
    scheduledAt: '2026-04-10T22:00:00.000Z',
    expiresAt: '2026-04-11T00:00:00.000Z',
  });
  insertAttack(h.db, 'a-mixed', '2026-04-10T21:58:00.000Z');
  h.engine.noteAttackWrite({
    before: null, after: { id: 'a-mixed', start: '2026-04-10T21:58:00.000Z', end: null },
  });

  const summary = await h.engine.tick();
  assert.equal(summary.sent, 2); // counters combine across both topics
  assert.equal(summary.failed, 0);
  assert.equal(h.personal.calls.length, 1);
  assert.equal(h.personal.calls[0].title, 'Daily check-in');
  assert.equal(h.attack.calls.length, 1);
  assert.equal(h.attack.calls[0].title, 'Attack started');
  assert.equal(occurrence(h.db, 'checkin:2026-04-10').status, 'succeeded');
  assert.equal(
    occurrence(h.db, startOccurrenceKey('a-mixed', '2026-04-10T21:58:00.000Z')).status,
    'succeeded',
  );
});
