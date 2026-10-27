// Weather pressure-drop reminders in the existing persistent engine.
//
// Injected clock/transport/weather getter only: no network, no real clock, no
// real ntfy traffic, disposable temp database. The engine's at-least-once
// crash caveat is unchanged; these tests cover episode dedup, rearming,
// per-type/persistent behavior, transient failures, and target expiry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { makeTempDir, cleanupDir } from './helpers.js';
import { createReminderEngine } from '../reminders.js';

const NY = 'America/New_York';
const HOUR = 60 * 60 * 1000;

const BOSTON = {
  id: 4930956,
  name: 'Boston',
  admin1: 'Massachusetts',
  country: 'United States',
  latitude: 42.35843,
  longitude: -71.05977,
};
const SALEM = { ...BOSTON, id: 2, name: 'Salem', latitude: 42.52 };

const BASE_REMINDERS = {
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

function makeDb(t, label) {
  const dir = makeTempDir(`migraine-${label}`);
  const db = openDatabase(join(dir, 'data'), { log: () => {} });
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    cleanupDir(dir);
  });
  return { db, dir };
}

const setSetting = (db, key, value) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run(key, JSON.stringify(value));

function seed(db, { reminders = {}, location = BOSTON, enabled = true } = {}) {
  setSetting(db, 'timezone', NY);
  setSetting(db, 'reminders', { ...BASE_REMINDERS, ...reminders });
  setSetting(db, 'weather', {
    enabled, location, pressureDropThresholdHpa: 5,
  });
}

function clock(startIso) {
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

function recorder() {
  const calls = [];
  return {
    transport: async (message) => {
      calls.push(message);
    },
    calls,
  };
}

function snapshot({
  warning = true, status = 'ready', stale = false, targetTimeMs, location = BOSTON,
} = {}) {
  return {
    status,
    stale,
    location,
    current: null,
    warning: warning && status === 'ready'
      ? {
        baselineHpa: 1013,
        targetHpa: 1005,
        dropHpa: 8,
        targetTimeMs,
        thresholdHpa: 5,
      }
      : null,
    fetchedAt: null,
    thresholdHpa: 5,
    timeZone: NY,
  };
}

const engineFor = (db, clockImpl, transport, getWeather) => createReminderEngine({
  db,
  transport,
  now: clockImpl.now,
  getWeather,
});

const weatherRows = (db) => db.prepare(
  "SELECT * FROM reminder_occurrences WHERE type = 'weather' ORDER BY created_at, key",
).all();
const weatherState = (db) => {
  const row = db.prepare("SELECT value FROM reminder_state WHERE key = 'weather'").get();
  return row ? JSON.parse(row.value) : null;
};

test('one weather notification per distinct episode, across ticks and restart', async (t) => {
  const { db } = makeDb(t, 'weather-episode');
  seed(db);
  const c = clock('2026-04-10T14:00:00.000Z'); // 10:00 EDT
  const { transport, calls } = recorder();
  let current = snapshot({ targetTimeMs: c.now() + 2 * HOUR });
  const engine = engineFor(db, c, transport, () => current);

  const first = await engine.tick();
  assert.equal(first.sent, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].title, /Pressure drop forecast/);
  assert.match(calls[0].body, /a possible trigger for some people/);
  assert.doesNotMatch(calls[0].body, /likely|predicted|risk/i);
  // Privacy: ntfy gets magnitude/time only, never the saved city.
  assert.match(calls[0].body, /8 hPa lower by/);
  assert.doesNotMatch(calls[0].title, /Boston|Massachusetts/i);
  assert.doesNotMatch(calls[0].body, /Boston|Massachusetts/i);

  assert.equal(weatherRows(db).length, 1);
  assert.equal(weatherRows(db)[0].status, 'succeeded');
  const episodeKey = weatherRows(db)[0].key;

  // Repeated poll and a fresh process (same DB) must not duplicate it.
  assert.equal((await engine.tick()).sent, 0);
  const restarted = engineFor(db, c, transport, () => current);
  assert.equal((await restarted.tick()).sent, 0);
  assert.equal(calls.length, 1);
  assert.equal(weatherRows(db).length, 1);
  assert.equal(weatherRows(db)[0].key, episodeKey);
});

test('a clear forecast rearms; the next drop is a new episode', async (t) => {
  const { db } = makeDb(t, 'weather-rearm');
  seed(db);
  const c = clock('2026-04-10T14:00:00.000Z');
  const { transport, calls } = recorder();
  let current = snapshot({ targetTimeMs: c.now() + 2 * HOUR });
  const engine = engineFor(db, c, transport, () => current);
  await engine.tick();
  const firstKey = weatherRows(db)[0].key;

  current = snapshot({ warning: false, targetTimeMs: c.now() + HOUR });
  c.plusMinutes(15);
  assert.equal((await engine.tick()).sent, 0);
  assert.equal(weatherState(db).phase, 'armed');
  assert.equal(weatherState(db).episodeKey, null);

  current = snapshot({ targetTimeMs: c.now() + 2 * HOUR });
  c.plusMinutes(15);
  assert.equal((await engine.tick()).sent, 1);
  assert.equal(calls.length, 2);
  const rows = weatherRows(db);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[1].key, firstKey);
  assert.equal(rows[1].status, 'succeeded');
});

test('per-type off keeps a pending weather episode unburned until re-enabled', async (t) => {
  const { db } = makeDb(t, 'weather-toggle');
  seed(db);
  // 08:00 EDT: outside waking hours, so generation creates a pending row but
  // delivery waits.
  const c = clock('2026-04-10T12:00:00.000Z');
  const { transport, calls } = recorder();
  const current = snapshot({ targetTimeMs: c.now() + 8 * HOUR });
  const engine = engineFor(db, c, transport, () => current);

  await engine.tick();
  assert.equal(calls.length, 0);
  assert.equal(weatherRows(db).length, 1);
  assert.equal(weatherRows(db)[0].status, 'pending');

  setSetting(db, 'reminders', { ...BASE_REMINDERS, weather: false });
  c.set('2026-04-10T14:00:00.000Z'); // inside waking, but the per-type switch is off
  await engine.tick();
  assert.equal(calls.length, 0);
  assert.equal(weatherRows(db)[0].status, 'pending', 'not burned while disabled');

  setSetting(db, 'reminders', { ...BASE_REMINDERS, weather: true });
  await engine.tick();
  assert.equal(calls.length, 1);
  assert.equal(weatherRows(db)[0].status, 'succeeded');
});

test('master switch off leaves the pending weather row untouched', async (t) => {
  const { db } = makeDb(t, 'weather-master');
  seed(db);
  const c = clock('2026-04-10T12:00:00.000Z');
  const { transport, calls } = recorder();
  const current = snapshot({ targetTimeMs: c.now() + 8 * HOUR });
  const engine = engineFor(db, c, transport, () => current);
  await engine.tick();
  assert.equal(weatherRows(db)[0].status, 'pending');

  setSetting(db, 'reminders', { ...BASE_REMINDERS, enabled: false });
  c.set('2026-04-10T14:00:00.000Z');
  await engine.tick();
  assert.equal(calls.length, 0);
  assert.equal(weatherRows(db)[0].status, 'pending');
});

test('error/stale forecast blocks delivery without destroying the pending episode', async (t) => {
  const { db } = makeDb(t, 'weather-stale');
  seed(db);
  const c = clock('2026-04-10T12:00:00.000Z'); // outside waking
  const { transport, calls } = recorder();
  let current = snapshot({ targetTimeMs: c.now() + 8 * HOUR });
  const engine = engineFor(db, c, transport, () => current);
  await engine.tick();
  assert.equal(weatherRows(db).length, 1);
  assert.equal(weatherRows(db)[0].status, 'pending');
  const key = weatherRows(db)[0].key;

  current = snapshot({
    warning: false, status: 'error', stale: true,
    targetTimeMs: c.now() + 8 * HOUR,
  });
  c.set('2026-04-10T14:00:00.000Z'); // inside waking, still no usable forecast
  await engine.tick();
  assert.equal(calls.length, 0);
  assert.equal(weatherRows(db)[0].key, key);
  assert.equal(weatherRows(db)[0].status, 'pending');
  assert.equal(weatherState(db).phase, 'warning');

  current = snapshot({ targetTimeMs: c.now() + 2 * HOUR });
  await engine.tick();
  assert.equal(calls.length, 1);
  assert.equal(weatherRows(db)[0].status, 'succeeded');
});

test('changing the location deliberately rearms with a new episode key', async (t) => {
  const { db } = makeDb(t, 'weather-signature');
  seed(db);
  const c = clock('2026-04-10T12:00:00.000Z');
  const { transport, calls } = recorder();
  let current = snapshot({ targetTimeMs: c.now() + 8 * HOUR });
  const engine = engineFor(db, c, transport, () => current);
  await engine.tick();
  const oldKey = weatherRows(db)[0].key;

  setSetting(db, 'weather', {
    enabled: true, location: SALEM, pressureDropThresholdHpa: 5,
  });
  c.set('2026-04-10T14:00:00.000Z');
  current = snapshot({
    targetTimeMs: c.now() + 4 * HOUR, location: SALEM,
  });
  await engine.tick();

  assert.equal(calls.length, 1);
  const rows = weatherRows(db);
  assert.equal(rows.length, 2);
  const oldRow = rows.find((row) => row.key === oldKey);
  const newRow = rows.find((row) => row.key !== oldKey);
  assert.equal(oldRow.status, 'skipped');
  assert.equal(oldRow.last_error_category, 'condition_gone');
  assert.equal(newRow.status, 'succeeded');
  assert.equal(weatherState(db).signature.includes('42.520'), true);
});

test('a target time in the past is skipped as condition_gone', async (t) => {
  const { db } = makeDb(t, 'weather-target');
  seed(db);
  const c = clock('2026-04-10T12:00:00.000Z');
  const { transport, calls } = recorder();
  const target = c.now() + 2 * HOUR;
  const current = snapshot({ targetTimeMs: target });
  const engine = engineFor(db, c, transport, () => current);
  await engine.tick();
  assert.equal(weatherRows(db)[0].status, 'pending');

  c.set(new Date(target + 60000).toISOString());
  await engine.tick();
  assert.equal(calls.length, 0);
  assert.equal(weatherRows(db)[0].status, 'skipped');
  assert.equal(weatherRows(db)[0].last_error_category, 'condition_gone');
});

test('a later target after an unobserved clear is a new episode and alerts again', async (t) => {
  const { db } = makeDb(t, 'weather-missed-clear');
  seed(db);
  const c = clock('2026-04-10T14:00:00.000Z'); // 10:00 EDT, inside waking hours
  const { transport, calls } = recorder();
  let current = snapshot({ targetTimeMs: c.now() + HOUR });
  const engine = engineFor(db, c, transport, () => current);

  await engine.tick();
  assert.equal(calls.length, 1);
  const firstKey = weatherRows(db)[0].key;
  assert.equal(weatherState(db).targetTimeMs, c.now() + HOUR);

  // Time passes beyond the recorded target with no forecast observation at all
  // (downtime/master-off): the old episode completed without an observed clear.
  // The next successful forecast warns for a LATER target, so it is a new
  // episode and must notify again.
  c.plusMinutes(120);
  current = snapshot({ targetTimeMs: c.now() + 2 * HOUR });
  await engine.tick();

  assert.equal(calls.length, 2);
  assert.match(calls[1].title, /Pressure drop forecast/);
  assert.doesNotMatch(calls[1].body, /likely|predicted|risk/i);
  const rows = weatherRows(db);
  assert.equal(rows.length, 2);
  const first = rows.find((row) => row.key === firstKey);
  const second = rows.find((row) => row.key !== firstKey);
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'succeeded');
  assert.equal(weatherState(db).targetTimeMs, c.now() + 2 * HOUR);
});

test('a target moving before the recorded target passes stays one episode', async (t) => {
  const { db } = makeDb(t, 'weather-target-moves');
  seed(db);
  const c = clock('2026-04-10T14:00:00.000Z');
  const { transport, calls } = recorder();
  let current = snapshot({ targetTimeMs: c.now() + 6 * HOUR });
  const engine = engineFor(db, c, transport, () => current);

  await engine.tick();
  assert.equal(calls.length, 1);
  const episodeKey = weatherState(db).episodeKey;

  // The forecast target moves later, but the recorded target has not passed:
  // this is still the same continuous episode, so it must not alert again.
  c.plusMinutes(60);
  const movedTarget = c.now() + 6 * HOUR;
  current = snapshot({ targetTimeMs: movedTarget });
  await engine.tick();

  assert.equal(calls.length, 1);
  assert.equal(weatherRows(db).length, 1);
  assert.equal(weatherState(db).episodeKey, episodeKey);
  assert.equal(weatherState(db).targetTimeMs, movedTarget);
});

test('a malformed warning (no finite target) cannot create an episode', async (t) => {
  const { db } = makeDb(t, 'weather-malformed');
  seed(db);
  const c = clock('2026-04-10T14:00:00.000Z');
  const { transport, calls } = recorder();
  const current = snapshot(); // warning object with targetTimeMs: undefined
  const engine = engineFor(db, c, transport, () => current);

  await engine.tick();

  assert.equal(calls.length, 0);
  assert.equal(weatherRows(db).length, 0);
  assert.equal(weatherState(db), null);
});

test('disabling weather clears episode state and pending rows', async (t) => {
  const { db } = makeDb(t, 'weather-disabled');
  seed(db);
  const c = clock('2026-04-10T12:00:00.000Z');
  const { transport, calls } = recorder();
  let current = snapshot({ targetTimeMs: c.now() + 8 * HOUR });
  const engine = engineFor(db, c, transport, () => current);
  await engine.tick();
  assert.equal(weatherState(db).phase, 'warning');

  setSetting(db, 'weather', {
    enabled: false, location: BOSTON, pressureDropThresholdHpa: 5,
  });
  current = snapshot({ warning: false, status: 'disabled', targetTimeMs: c.now() });
  c.set('2026-04-10T14:00:00.000Z');
  await engine.tick();

  assert.equal(calls.length, 0);
  assert.equal(weatherState(db).phase, 'armed');
  assert.equal(weatherRows(db)[0].status, 'skipped');
});
