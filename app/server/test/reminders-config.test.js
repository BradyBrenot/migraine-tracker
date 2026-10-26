// Checkpoint 6: reminder configuration, ntfy transport, runtime scheduler, and
// the secret/persistence boundaries around settings, export, the nightly
// backup, reset, and import.
//
// No listening port (Fastify inject() only), no real network (fake fetch), no
// real dataset, and no long real timers (the scheduler's setInterval/
// clearInterval are injected).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNtfyTransport, DeliveryError } from '../ntfy.js';
import { attackViewUrl, resolveAttackConfig, resolveReminderConfig } from '../reminder-config.js';
import { startReminderScheduler } from '../scheduler.js';
import { createReminderEngine } from '../reminders.js';
import { dumpBackup } from '../backup.js';
import { collectSettings } from '../snapshot.js';
import { normalizeReminderSettings } from '../../shared/reminders.ts';
import { makeApp } from './helpers.js';

const NY = 'America/New_York';
const FAKE_URL = 'https://ntfy.example.invalid/secret-topic';
const FAKE_ATTACK_URL = 'https://ntfy.example.invalid/secret-attack-topic';
const FAKE_TOKEN = 'tk_fake_secret_abc123';

const VALID_REMINDERS = {
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

/** PUT a JSON value through the real settings route. */
const putJson = (h, key, value) => h.app.inject({
  method: 'PUT',
  url: `/api/settings/${key}`,
  headers: { 'content-type': 'application/json' },
  payload: JSON.stringify(value),
});

const getSettings = async (h) =>
  (await h.app.inject({ method: 'GET', url: '/api/settings' })).json();

const rawSetting = (db, key, value) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run(key, value);

// ── settings validation ───────────────────────────────────────────────
test('settings: environment secret keys are rejected while normal keys succeed', async (t) => {
  const h = await makeApp({ label: 'reminder-secret-keys' });
  t.after(() => h.close());

  const reserved = [
    'NTFY_URL', 'ntfyUrl', 'ntfy_token', 'NTFY_TOKEN', 'PUBLIC_APP_URL',
    'public-app-url', 'publicAppUrl', 'authToken', 'ntfy-token', 'apiKey',
    'bearerToken', 'secretValue', 'password', 'clientSecret',
    'NTFY-ATTACK-URL', 'ntfyAttackUrl', 'ntfy_attack_url', 'ntfyAttackToken',
  ];
  for (const key of reserved) {
    const payload = /attack/i.test(key) ? FAKE_ATTACK_URL : FAKE_URL;
    const res = await putJson(h, encodeURIComponent(key), payload);
    assert.equal(res.statusCode, 400, `reserved key ${key} must be rejected`);
    assert.match(res.json().error, /invalid settings key/);
    assert.equal(res.body.includes(payload), false);
  }
  assert.deepEqual(await getSettings(h), {});

  const threshold = await putJson(h, 'lowStockThreshold', 3);
  assert.equal(threshold.statusCode, 200);
  const rules = await putJson(h, 'rules', { nurtec: { limit: 15, windowDays: 30 } });
  assert.equal(rules.statusCode, 200);
  const reminders = await putJson(h, 'reminders', VALID_REMINDERS);
  assert.equal(reminders.statusCode, 200);

  const settings = await getSettings(h);
  assert.equal(settings.lowStockThreshold, 3);
  assert.deepEqual(settings.rules, { nurtec: { limit: 15, windowDays: 30 } });
  assert.deepEqual(settings.reminders, normalizeReminderSettings(VALID_REMINDERS));
});

test('settings: reminders reject nested delivery secrets and round-trip the non-secret shape', async (t) => {
  const h = await makeApp({ label: 'reminder-nested-secrets' });
  t.after(() => h.close());

  assert.equal((await putJson(h, 'reminders', VALID_REMINDERS)).statusCode, 200);
  assert.deepEqual(
    (await getSettings(h)).reminders,
    normalizeReminderSettings(VALID_REMINDERS),
  );

  for (const key of ['ntfyUrl', 'NTFY_TOKEN', 'public_app_url', 'authToken', 'credentials']) {
    const res = await putJson(h, 'reminders', {
      ...VALID_REMINDERS, [key]: 'https://ntfy.example.invalid/secret',
    });
    assert.equal(res.statusCode, 400, `nested ${key} must be rejected`);
    assert.match(res.json().error, new RegExp(key));
    assert.equal(res.body.includes('ntfy.example.invalid'), false);
  }
  // the rejected writes did not replace the stored shape
  assert.deepEqual(
    (await getSettings(h)).reminders,
    normalizeReminderSettings(VALID_REMINDERS),
  );

  // unknown non-secret keys are dropped, not persisted
  assert.equal((await putJson(h, 'reminders', { ...VALID_REMINDERS, theme: 'dark' })).statusCode, 200);
  const normalized = (await getSettings(h)).reminders;
  assert.deepEqual(normalized, normalizeReminderSettings(VALID_REMINDERS));
  assert.equal(Object.hasOwn(normalized, 'theme'), false);

  // invalid shapes are rejected, never repaired
  for (const bad of [
    {},
    { ...VALID_REMINDERS, wakingStart: '9:00' },
    { ...VALID_REMINDERS, wakingEnd: '09:00' }, // end <= start
    { ...VALID_REMINDERS, enabled: 'yes' },
    { ...VALID_REMINDERS, graceMinutes: 5 },
    'nope',
  ]) {
    assert.equal((await putJson(h, 'reminders', bad)).statusCode, 400);
  }
});

test('settings: legacy secret rows are filtered from settings/export/backup; corrupt rows do not break them', async (t) => {
  const h = await makeApp({ label: 'reminder-legacy-secrets' });
  t.after(() => h.close());
  const { db } = h;

  // Hand-inserted rows that bypassed the PUT route (legacy/hand-edited DB).
  rawSetting(db, 'NTFY_URL', JSON.stringify(FAKE_URL));
  rawSetting(db, 'ntfyToken', JSON.stringify(FAKE_TOKEN));
  rawSetting(db, 'PUBLIC_APP_URL', JSON.stringify('https://secret-app.example.invalid/'));
  rawSetting(db, 'ntfy-attack-url', JSON.stringify(FAKE_ATTACK_URL));
  rawSetting(db, 'reminders', JSON.stringify({
    ...VALID_REMINDERS,
    ntfyUrl: FAKE_URL,
    NTFY_TOKEN: FAKE_TOKEN,
    public_app_url: 'https://secret-app.example.invalid/',
  }));
  rawSetting(db, 'timezone', JSON.stringify(NY));
  rawSetting(db, 'lowStockThreshold', JSON.stringify(3));
  rawSetting(db, 'rules', '{this is not valid json');

  const settings = await getSettings(h);
  assert.deepEqual(Object.keys(settings).sort(), ['lowStockThreshold', 'reminders', 'timezone']);
  assert.equal(settings.timezone, NY);
  assert.equal(settings.lowStockThreshold, 3);
  assert.deepEqual(settings.reminders, normalizeReminderSettings(VALID_REMINDERS));

  const exportText = (await h.app.inject({ method: 'GET', url: '/api/export' })).body;
  const backupDir = join(h.dir, 'backups');
  const file = dumpBackup({
    db, backupDir, now: new Date('2026-04-10T12:00:00.000Z'), log: () => {},
  });
  assert.ok(file, 'backup is written even with a corrupt legacy settings row');
  const backupText = readFileSync(file, 'utf8');

  for (const [label, text] of [
    ['settings', JSON.stringify(settings)], ['export', exportText], ['backup', backupText],
  ]) {
    assert.equal(text.includes(FAKE_URL), false, `${label} must not contain the ntfy URL`);
    assert.equal(text.includes(FAKE_ATTACK_URL), false, `${label} must not contain the attack ntfy URL`);
    assert.equal(text.includes(FAKE_TOKEN), false, `${label} must not contain the token`);
    assert.equal(text.includes('secret-app.example.invalid'), false);
    assert.equal(text.includes('secret-attack-topic'), false);
    assert.equal(text.includes('ntfy-attack-url'), false);
    assert.equal(text.includes('ntfyUrl'), false);
    assert.equal(text.includes('NTFY_URL'), false);
    assert.equal(text.includes('ntfyToken'), false);
    assert.equal(text.includes('public_app_url'), false);
    assert.equal(text.includes('not valid json'), false);
  }

  const exported = JSON.parse(exportText);
  const backup = JSON.parse(backupText);
  assert.deepEqual(exported.settings.reminders, normalizeReminderSettings(VALID_REMINDERS));
  assert.deepEqual(backup.settings, exported.settings);
});

// ── persistence boundaries ────────────────────────────────────────────
test('persistence: export/backup exclude reminder tables and reset deletes them', async (t) => {
  const h = await makeApp({ label: 'reminder-persistence' });
  t.after(() => h.close());
  const { db } = h;

  db.prepare(`INSERT INTO reminder_occurrences
    (key,type,med_id,scheduled_at,expires_at,status,attempt,next_attempt_at,
     last_attempt_at,sent_at,last_error_category,last_error_status,created_at,updated_at)
    VALUES ('checkin:2026-04-10','checkin',NULL,'2026-04-10T22:00:00.000Z',
            '2026-04-11T00:00:00.000Z','succeeded',1,'2026-04-10T22:00:00.000Z',
            '2026-04-10T22:00:00.000Z','2026-04-10T22:00:00.000Z',NULL,NULL,
            '2026-04-10T22:00:00.000Z','2026-04-10T22:00:00.000Z')`).run();
  db.prepare(`INSERT INTO reminder_state (key,value,updated_at)
    VALUES ('low_stock','{"phase":"low","episodeKey":"ep-1"}','2026-04-10T12:00:00.000Z')`).run();

  const envelope = (await h.app.inject({ method: 'GET', url: '/api/export' })).json();
  assert.deepEqual(Object.keys(envelope).sort(), [
    'attacks', 'dayStates', 'exportedAt', 'meds', 'refills',
    'schemaVersion', 'settings', 'stockBaselines', 'workouts',
  ]);
  const exportText = JSON.stringify(envelope);
  assert.equal(exportText.includes('reminder_occurrences'), false);
  assert.equal(exportText.includes('reminder_state'), false);
  assert.equal(exportText.includes('checkin:2026-04-10'), false);
  assert.equal(exportText.includes('low_stock'), false);

  const file = dumpBackup({
    db, backupDir: join(h.dir, 'backups'), now: new Date('2026-04-10T12:00:00.000Z'), log: () => {},
  });
  const backupText = readFileSync(file, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(backupText)).sort(), Object.keys(envelope).sort());
  assert.equal(backupText.includes('reminder_occurrences'), false);
  assert.equal(backupText.includes('reminder_state'), false);
  assert.equal(backupText.includes('checkin:2026-04-10'), false);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_state').get().n, 1);
  const reset = await h.app.inject({ method: 'POST', url: '/api/reset' });
  assert.equal(reset.statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_state').get().n, 0);
});

test('import: export-shaped payloads do not restore settings/reminder state and never overwrite rows', async (t) => {
  const h = await makeApp({ label: 'reminder-import' });
  t.after(() => h.close());
  const { db } = h;

  rawSetting(db, 'timezone', JSON.stringify(NY));
  rawSetting(db, 'lowStockThreshold', JSON.stringify(3));
  db.prepare(`INSERT INTO meds (id,med_id,ts,quantity)
    VALUES ('m1','nurtec','2026-04-01T12:00:00.000Z',1)`).run();
  db.prepare(`INSERT INTO reminder_occurrences
    (key,type,med_id,scheduled_at,expires_at,status,attempt,next_attempt_at,
     last_attempt_at,sent_at,last_error_category,last_error_status,created_at,updated_at)
    VALUES ('checkin:2026-04-10','checkin',NULL,'2026-04-10T22:00:00.000Z',
            '2026-04-11T00:00:00.000Z','succeeded',1,'2026-04-10T22:00:00.000Z',
            '2026-04-10T22:00:00.000Z','2026-04-10T22:00:00.000Z',NULL,NULL,
            '2026-04-10T22:00:00.000Z','2026-04-10T22:00:00.000Z')`).run();
  db.prepare(`INSERT INTO reminder_state (key,value,updated_at)
    VALUES ('low_stock','{"phase":"low","episodeKey":"ep-1"}','2026-04-10T12:00:00.000Z')`).run();

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/import',
    payload: {
      schemaVersion: 4,
      exportedAt: '2026-04-10T12:00:00.000Z',
      attacks: [{ id: 'a-imported', start: '2026-04-02T00:00:00.000Z' }],
      meds: [{ id: 'm1', medId: 'nurtec', ts: '2026-04-01T12:00:00.000Z', quantity: 9 }],
      refills: [],
      workouts: [],
      dayStates: [],
      stockBaselines: [],
      settings: {
        timezone: 'Asia/Tokyo',
        lowStockThreshold: 0,
        ntfyUrl: FAKE_URL,
        reminders: { ...VALID_REMINDERS, enabled: true, ntfyUrl: FAKE_URL },
      },
      reminder_occurrences: [{
        key: 'checkin:1970-01-01', type: 'checkin', status: 'pending',
      }],
      reminder_state: [{ key: 'low_stock', value: '{"phase":"armed"}' }],
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    ok: true, attacks: 1, meds: 1, refills: 0, workouts: 0, dayStates: 0, stockBaselines: 0,
  });

  // Settings are NOT restored and no secret leaked into storage.
  assert.deepEqual(await getSettings(h), { timezone: NY, lowStockThreshold: 3 });
  const settingsText = JSON.stringify(await getSettings(h));
  assert.equal(settingsText.includes(FAKE_URL), false);
  assert.equal(settingsText.includes('Asia/Tokyo'), false);

  // Existing rows are never overwritten by a duplicate id.
  assert.equal(db.prepare("SELECT quantity FROM meds WHERE id = 'm1'").get().quantity, 1);

  // Scheduler bookkeeping is untouched (not imported).
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get().n, 1);
  assert.equal(
    db.prepare("SELECT status FROM reminder_occurrences WHERE key = 'checkin:2026-04-10'").get().status,
    'succeeded',
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM reminder_occurrences WHERE key = 'checkin:1970-01-01'").get().n,
    0,
  );
  assert.equal(
    JSON.parse(db.prepare("SELECT value FROM reminder_state WHERE key = 'low_stock'").get().value)
      .episodeKey,
    'ep-1',
  );

  // Additive import of user records still works.
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/attacks' })).json().length, 1);
});

// ── ntfy transport ────────────────────────────────────────────────────
test('ntfy: posts the exact full URL with title/body, optional token and Click header', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  const send = createNtfyTransport({
    ntfyUrl: 'https://ntfy.example.invalid/migraine',
    ntfyToken: 'tk_test',
    publicAppUrl: 'https://migraine.example.com/',
    fetchImpl,
  });

  assert.deepEqual(await send({ title: 'Daily check-in', body: 'One tap is enough.' }), {
    status: 200,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ntfy.example.invalid/migraine');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, 'One tap is enough.');
  assert.equal(calls[0].options.headers.Title, 'Daily check-in');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tk_test');
  assert.equal(calls[0].options.headers.Click, 'https://migraine.example.com/');
  assert.equal(calls[0].url.includes('tk_test'), false); // never credentials in the URL/query
  assert.equal(calls[0].url.includes('?'), false);

  // no token/click headers when not configured
  const bare = [];
  const bareSend = createNtfyTransport({
    ntfyUrl: 'https://ntfy.example.invalid/migraine',
    fetchImpl: async (url, options) => {
      bare.push({ url, options });
      return { ok: true, status: 200 };
    },
  });
  await bareSend({ title: 'T', body: 'B' });
  assert.equal(Object.hasOwn(bare[0].options.headers, 'Authorization'), false);
  assert.equal(Object.hasOwn(bare[0].options.headers, 'Click'), false);
});

test('ntfy: a non-2xx response becomes DeliveryError(http, status) without reading the body', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    get body() {
      throw new Error('response body must not be read');
    },
    text() {
      throw new Error('response body must not be read');
    },
    json() {
      throw new Error('response body must not be read');
    },
  });
  const send = createNtfyTransport({
    ntfyUrl: 'https://ntfy.example.invalid/topic', fetchImpl,
  });

  await assert.rejects(send({ title: 'T', body: 'B' }), (error) => {
    assert.ok(error instanceof DeliveryError);
    assert.equal(error.category, 'http');
    assert.equal(error.status, 429);
    assert.equal(error.message, 'http'); // fixed text, never the URL/body
    return true;
  });
});

test('ntfy: fetch rejections and timeouts are classified as fetch/timeout with no URL', async () => {
  const failing = createNtfyTransport({
    ntfyUrl: 'https://ntfy.example.invalid/secret-topic',
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED https://ntfy.example.invalid/secret-topic');
    },
  });
  await assert.rejects(failing({ title: 'T', body: 'B' }), (error) => {
    assert.ok(error instanceof DeliveryError);
    assert.equal(error.category, 'fetch');
    assert.equal(error.status, null);
    assert.equal(error.message.includes('secret-topic'), false);
    return true;
  });

  for (const name of ['TimeoutError', 'AbortError']) {
    const timedOut = createNtfyTransport({
      ntfyUrl: 'https://ntfy.example.invalid/topic',
      fetchImpl: async () => {
        const error = new Error(`request timed out: https://ntfy.example.invalid/topic`);
        error.name = name;
        throw error;
      },
    });
    await assert.rejects(timedOut({ title: 'T', body: 'B' }), (error) => {
      assert.equal(error.category, 'timeout');
      assert.equal(error.message, 'timeout');
      return true;
    });
  }

  assert.throws(
    () => createNtfyTransport({ ntfyUrl: 'https://ntfy.example.invalid/topic', fetchImpl: null }),
    /requires fetch/,
  );
});

// ── environment configuration ─────────────────────────────────────────
test('config: missing/blank/invalid/protocol/userinfo/query-token NTFY_URL is disabled with fixed reasons', () => {
  const cases = [
    [{}, 'NTFY_URL is not set'],
    [{ NTFY_URL: '   ' }, 'NTFY_URL is not set'],
    [{ NTFY_URL: 'not a url' }, 'NTFY_URL is not a valid URL'],
    [{ NTFY_URL: 'https://' }, 'NTFY_URL is not a valid URL'],
    [{ NTFY_URL: 'ftp://ntfy.example.invalid/topic' }, 'NTFY_URL must use http or https'],
    [{ NTFY_URL: 'https://user:pass@ntfy.example.invalid/topic' }, 'NTFY_URL must not contain credentials'],
    [{ NTFY_URL: 'https://ntfy.example.invalid/topic?token=abc' }, 'NTFY_URL must not contain credentials in query parameters'],
    [{ NTFY_URL: 'https://ntfy.example.invalid/topic?auth=abc' }, 'NTFY_URL must not contain credentials in query parameters'],
    [{ NTFY_URL: 'https://ntfy.example.invalid/topic?api_key=abc' }, 'NTFY_URL must not contain credentials in query parameters'],
  ];
  for (const [env, reason] of cases) {
    const out = resolveReminderConfig(env);
    assert.equal(out.enabled, false, JSON.stringify(env));
    assert.equal(out.reason, reason);
    assert.equal(out.ntfyUrl, null);
    assert.equal(out.ntfyToken, null);
    assert.equal(out.reason.includes('ntfy.example.invalid'), false); // no env values echoed
    assert.equal(out.reason.includes('abc'), false);
  }
});

test('config: valid topic URLs are enabled; a malformed PUBLIC_APP_URL only disables click links', () => {
  const out = resolveReminderConfig({
    NTFY_URL: 'https://ntfy.example.invalid/migraine?tags=pill',
    NTFY_TOKEN: 'tk_test_123',
    PUBLIC_APP_URL: 'https://migraine.example.com',
  });
  assert.equal(out.enabled, true);
  assert.equal(out.reason, null);
  assert.equal(out.ntfyUrl, 'https://ntfy.example.invalid/migraine?tags=pill');
  assert.equal(out.ntfyToken, 'tk_test_123');
  assert.equal(out.publicAppUrl, 'https://migraine.example.com/');

  const noClick = resolveReminderConfig({
    NTFY_URL: 'https://ntfy.example.invalid/migraine', PUBLIC_APP_URL: 'not a url',
  });
  assert.equal(noClick.enabled, true); // delivery still works
  assert.equal(noClick.publicAppUrl, null);

  const userinfoApp = resolveReminderConfig({
    NTFY_URL: 'https://ntfy.example.invalid/migraine',
    PUBLIC_APP_URL: 'https://user:pass@migraine.example.com',
  });
  assert.equal(userinfoApp.enabled, true);
  assert.equal(userinfoApp.publicAppUrl, null);

  const noToken = resolveReminderConfig({ NTFY_URL: 'https://ntfy.example.invalid/migraine' });
  assert.equal(noToken.enabled, true);
  assert.equal(noToken.ntfyToken, null);
});

test('config: tokens with whitespace or control characters disable delivery', () => {
  for (const token of ['has space', 'tab\there', 'line\nbreak', 'nul\u0000char', 'del\u007fchar']) {
    const out = resolveReminderConfig({
      NTFY_URL: 'https://ntfy.example.invalid/topic', NTFY_TOKEN: token,
    });
    assert.equal(out.enabled, false);
    assert.equal(out.reason, 'NTFY_TOKEN contains invalid characters');
    assert.equal(out.ntfyToken, null);
    assert.equal(out.reason.includes(token), false);
  }
});

const ATTACK_URL = 'https://ntfy.example.invalid/attack-secret-topic';
const ATTACK_TOKEN = 'tk_fake_attack_secret_xyz789';

test('config: attack topic validation mirrors the personal rules with fixed reasons', () => {
  const cases = [
    [{}, 'NTFY_ATTACK_URL is not set'],
    [{ NTFY_ATTACK_URL: '   ' }, 'NTFY_ATTACK_URL is not set'],
    [{ NTFY_ATTACK_URL: 'not a url' }, 'NTFY_ATTACK_URL is not a valid URL'],
    [{ NTFY_ATTACK_URL: 'https://' }, 'NTFY_ATTACK_URL is not a valid URL'],
    [{ NTFY_ATTACK_URL: 'ftp://ntfy.example.invalid/attack' }, 'NTFY_ATTACK_URL must use http or https'],
    [{ NTFY_ATTACK_URL: 'https://user:pass@ntfy.example.invalid/attack' }, 'NTFY_ATTACK_URL must not contain credentials'],
    [{ NTFY_ATTACK_URL: 'https://ntfy.example.invalid/attack?token=abc' }, 'NTFY_ATTACK_URL must not contain credentials in query parameters'],
    [{ NTFY_ATTACK_URL: 'https://ntfy.example.invalid/attack?auth=abc' }, 'NTFY_ATTACK_URL must not contain credentials in query parameters'],
    [{ NTFY_ATTACK_URL: 'https://ntfy.example.invalid/attack?api_key=abc' }, 'NTFY_ATTACK_URL must not contain credentials in query parameters'],
  ];
  for (const [env, reason] of cases) {
    const out = resolveAttackConfig(env);
    assert.equal(out.enabled, false, JSON.stringify(env));
    assert.equal(out.reason, reason);
    assert.equal(out.ntfyUrl, null);
    assert.equal(out.ntfyToken, null);
    assert.equal(out.reason.includes('ntfy.example.invalid'), false); // no env values echoed
    assert.equal(out.reason.includes('abc'), false);
  }

  for (const token of ['has space', 'tab\there', 'line\nbreak', 'nul\u0000char', 'del\u007fchar']) {
    const out = resolveAttackConfig({ NTFY_ATTACK_URL: ATTACK_URL, NTFY_ATTACK_TOKEN: token });
    assert.equal(out.enabled, false);
    assert.equal(out.reason, 'NTFY_ATTACK_TOKEN contains invalid characters');
    assert.equal(out.ntfyUrl, null);
    assert.equal(out.ntfyToken, null);
    assert.equal(out.reason.includes(token), false);
  }
});

test('config: attack topic is independent from the personal topic and never echoes env values', () => {
  const out = resolveAttackConfig({
    NTFY_ATTACK_URL: ATTACK_URL,
    NTFY_ATTACK_TOKEN: ATTACK_TOKEN,
    PUBLIC_APP_URL: 'https://migraine.example.com',
  });
  assert.deepEqual(Object.keys(out).sort(), [
    'enabled', 'ntfyToken', 'ntfyUrl', 'publicAppUrl', 'reason',
  ]);
  assert.equal(out.enabled, true);
  assert.equal(out.reason, null);
  assert.equal(out.ntfyUrl, ATTACK_URL);
  assert.equal(out.ntfyToken, ATTACK_TOKEN);
  assert.equal(out.publicAppUrl, 'https://migraine.example.com/');
  assert.equal(JSON.stringify(out.reason), 'null');

  // A malformed PUBLIC_APP_URL only disables click links (delivery still works).
  const noClick = resolveAttackConfig({
    NTFY_ATTACK_URL: ATTACK_URL, PUBLIC_APP_URL: 'not a url',
  });
  assert.equal(noClick.enabled, true);
  assert.equal(noClick.publicAppUrl, null);
  assert.equal(attackViewUrl(noClick.publicAppUrl), null);

  // The two topics never fall back to each other.
  assert.equal(resolveAttackConfig({ NTFY_URL: ATTACK_URL }).enabled, false);
  assert.equal(resolveReminderConfig({ NTFY_ATTACK_URL: ATTACK_URL }).enabled, false);
  assert.equal(resolveAttackConfig({ NTFY_TOKEN: ATTACK_TOKEN }).enabled, false);
});

test('config: attackViewUrl always targets /view and tolerates trailing slashes', () => {
  assert.equal(attackViewUrl(null), null);
  assert.equal(attackViewUrl(undefined), null);
  assert.equal(attackViewUrl(''), null);
  assert.equal(attackViewUrl('not a url'), null);
  assert.equal(attackViewUrl('https://migraine.example.com'), 'https://migraine.example.com/view');
  assert.equal(attackViewUrl('https://migraine.example.com/'), 'https://migraine.example.com/view');
  assert.equal(attackViewUrl('https://migraine.example.com///'), 'https://migraine.example.com/view');
  assert.equal(attackViewUrl('https://migraine.example.com/base'), 'https://migraine.example.com/base/view');
  // Query strings and hashes never leak into the click target.
  assert.equal(attackViewUrl('https://migraine.example.com/?utm=x'), 'https://migraine.example.com/view');
  assert.equal(attackViewUrl('https://migraine.example.com/#section'), 'https://migraine.example.com/view');
  assert.equal(attackViewUrl('https://migraine.example.com/base/?x=1#s'), 'https://migraine.example.com/base/view');
});

test('config: resolved secrets are never written to the database or export', async (t) => {
  const h = await makeApp({ label: 'reminder-config-secrets' });
  t.after(() => h.close());
  const { db } = h;

  const config = resolveReminderConfig({
    NTFY_URL: FAKE_URL,
    NTFY_TOKEN: FAKE_TOKEN,
    PUBLIC_APP_URL: 'https://migraine.example.com',
  });
  assert.equal(config.enabled, true);

  // Non-secret reminder settings + a low-stock condition so the engine runs.
  rawSetting(db, 'timezone', JSON.stringify(NY));
  rawSetting(db, 'reminders', JSON.stringify({
    ...VALID_REMINDERS, preventive: false, checkIn: false, exercise: false,
  }));
  db.prepare(`INSERT INTO stock_baselines (id,med_id,effective_at,quantity,created_at)
    VALUES ('b1','nurtec','2026-04-01T00:00:00.000Z',1,'2026-04-01T00:00:00.000Z')`).run();

  const logs = [];
  const transport = createNtfyTransport({
    ntfyUrl: config.ntfyUrl,
    ntfyToken: config.ntfyToken,
    publicAppUrl: config.publicAppUrl,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  const engine = createReminderEngine({
    db,
    transport,
    now: () => Date.parse('2026-04-10T14:00:00.000Z'),
    log: (message) => logs.push(message),
  });
  assert.equal((await engine.tick()).sent, 1);

  const persisted = JSON.stringify(collectSettings(db));
  const exported = (await h.app.inject({ method: 'GET', url: '/api/export' })).body;
  for (const text of [persisted, exported, logs.join('\n')]) {
    assert.equal(text.includes(FAKE_TOKEN), false);
    assert.equal(text.includes(FAKE_URL), false);
    assert.equal(text.includes('migraine.example.com'), false);
  }
});

// ── scheduler wrapper ─────────────────────────────────────────────────
function fakeEngine({ onTick, onRecover } = {}) {
  return {
    ticks: 0,
    recoveries: 0,
    tick() {
      this.ticks += 1;
      return onTick ? onTick(this.ticks) : Promise.resolve({ sent: 0, failed: 0 });
    },
    recoverInterrupted() {
      this.recoveries += 1;
      return onRecover ? onRecover() : 0;
    },
  };
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setIntervalFn(fn, ms) {
      const timer = {
        fn, ms, cleared: false, unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      timer.cleared = true;
    },
  };
}

test('scheduler: recovers at startup, unrefs, and does no immediate tick when runImmediately is false', async () => {
  const engine = fakeEngine();
  const timers = fakeTimers();
  const logs = [];
  const scheduler = startReminderScheduler({
    engine,
    intervalMs: 60000,
    log: (message) => logs.push(message),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    runImmediately: false,
  });

  assert.equal(engine.recoveries, 1); // startup recovery ran
  assert.equal(engine.ticks, 0); // ...but no immediate tick
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].ms, 60000);
  assert.equal(timers.timers[0].unrefCalled, true); // does not keep the process alive

  assert.deepEqual(await scheduler.tick(), { sent: 0, failed: 0 });
  assert.equal(engine.ticks, 1);
  assert.deepEqual(logs, []); // zero counts are not logged

  await scheduler.stop();
  assert.equal(timers.timers[0].cleared, true); // injected clearInterval used

  // stopped: no further engine work, no further transport activity
  assert.deepEqual(await scheduler.tick(), { stopped: true });
  assert.deepEqual(await timers.timers[0].fn(), { stopped: true });
  assert.equal(engine.ticks, 1);
});

test('scheduler: runImmediately triggers one startup tick', async () => {
  const engine = fakeEngine({ onTick: async () => ({ sent: 0, failed: 0 }) });
  const timers = fakeTimers();
  const scheduler = startReminderScheduler({
    engine,
    log: () => {},
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    runImmediately: true,
  });
  await scheduler.stop(); // awaits the in-flight startup tick
  assert.equal(engine.ticks, 1);
});

test('scheduler: concurrent ticks share one in-flight engine tick', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const engine = fakeEngine({
    onTick: async () => {
      await gate;
      return { sent: 1, failed: 0 };
    },
  });
  const logs = [];
  const timers = fakeTimers();
  const scheduler = startReminderScheduler({
    engine,
    log: (message) => logs.push(message),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    runImmediately: false,
  });

  const p1 = scheduler.tick();
  const p2 = scheduler.tick();
  assert.equal(p1, p2);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, r2);
  assert.deepEqual(r1, { sent: 1, failed: 0 });
  assert.equal(engine.ticks, 1);
  assert.deepEqual(logs, ['reminders: sent 1, failed 0']); // counts only
  await scheduler.stop();
});

test('scheduler: a rejected engine tick is caught and logged as fixed text', async () => {
  const engine = fakeEngine({
    onTick: () => Promise.reject(new Error(`boom ${FAKE_URL} ${FAKE_TOKEN}`)),
  });
  const logs = [];
  const timers = fakeTimers();
  const scheduler = startReminderScheduler({
    engine,
    log: (message) => logs.push(message),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    runImmediately: false,
  });

  assert.equal(await scheduler.tick(), null);
  assert.deepEqual(logs, ['reminders: tick failed']);
  assert.equal(logs.join(' ').includes(FAKE_URL), false);
  assert.equal(logs.join(' ').includes(FAKE_TOKEN), false);
  await scheduler.stop();
});

test('scheduler: startup recovery failures are logged without details', async () => {
  const engine = {
    tick: async () => ({ sent: 0, failed: 0 }),
    recoverInterrupted() {
      throw new Error(`recovery boom ${FAKE_URL}`);
    },
  };
  const logs = [];
  const timers = fakeTimers();
  const scheduler = startReminderScheduler({
    engine,
    log: (message) => logs.push(message),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    runImmediately: false,
  });

  assert.deepEqual(logs, ['reminders: startup recovery failed']);
  assert.equal(logs.join(' ').includes(FAKE_URL), false);
  await scheduler.stop();
});

test('scheduler: a timer without unref is tolerated; a missing engine throws', async () => {
  const engine = fakeEngine();
  const cleared = [];
  const scheduler = startReminderScheduler({
    engine,
    setIntervalFn: () => ({ id: 1 }), // no unref method
    clearIntervalFn: (timer) => cleared.push(timer),
    runImmediately: false,
  });
  await scheduler.stop();
  assert.equal(cleared.length, 1);

  assert.throws(() => startReminderScheduler({}), /requires an engine/);
});

test('settings: timezone PUT is strict and never stores a non-IANA value', async (t) => {
  const h = await makeApp({ label: 'reminder-timezone-strict' });
  t.after(() => h.close());

  for (const body of ['', 'Mars/Olympus', '  ', 123, null, { zone: 'UTC' }, ['UTC']]) {
    const res = await putJson(h, 'timezone', body);
    assert.equal(res.statusCode, 400, `body ${JSON.stringify(body)} must be rejected`);
    assert.match(res.json().error, /IANA time zone/);
  }
  assert.deepEqual(await getSettings(h), {});

  const ok = await putJson(h, 'timezone', 'America/New_York');
  assert.equal(ok.statusCode, 200);
  assert.equal((await getSettings(h)).timezone, 'America/New_York');
  // The stored value is JSON, not a raw bare string.
  assert.equal(
    h.db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get().value,
    '"America/New_York"',
  );
});

test('scheduler: disabled ntfy config plus a disabled master switch never calls a transport', async (t) => {
  const h = await makeApp({ label: 'reminder-disabled' });
  t.after(() => h.close());
  const { db } = h;

  // Production wiring only creates a scheduler when NTFY_URL resolves.
  const config = resolveReminderConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.reason, 'NTFY_URL is not set');

  // The engine's master switch is an independent second guard.
  rawSetting(db, 'timezone', JSON.stringify(NY));
  rawSetting(db, 'reminders', JSON.stringify({
    ...VALID_REMINDERS, enabled: false, preventive: false, checkIn: false, exercise: false,
  }));
  db.prepare(`INSERT INTO stock_baselines (id,med_id,effective_at,quantity,created_at)
    VALUES ('b1','nurtec','2026-04-01T00:00:00.000Z',1,'2026-04-01T00:00:00.000Z')`).run();

  const calls = [];
  const engine = createReminderEngine({
    db,
    transport: async (message) => {
      calls.push(message);
      return { status: 200 };
    },
    now: () => Date.parse('2026-04-10T14:00:00.000Z'),
    log: () => {},
  });
  assert.deepEqual(await engine.tick(), {
    disabled: true, generated: 0, sent: 0, failed: 0, skipped: 0,
  });
  assert.equal(calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get().n, 0);
});
