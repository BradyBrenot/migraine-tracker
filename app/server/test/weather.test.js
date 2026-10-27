// Weather: injected Open-Meteo client, cached polling service, and API routes.
//
// No network, no real clock, no listening port and no real DATA_DIR: a temp
// database plus injected fetch/client/clock only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { buildApp } from '../app.js';
import { makeTempDir, cleanupDir } from './helpers.js';
import { createWeatherClient, createWeatherService } from '../weather.js';
import { collectSettings } from '../snapshot.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-04-10T12:00:00.000Z');

const BOSTON = {
  id: 4930956,
  name: 'Boston',
  admin1: 'Massachusetts',
  country: 'United States',
  latitude: 42.35843,
  longitude: -71.05977,
};

function makeDb(t, label = 'weather') {
  const dir = makeTempDir(`migraine-${label}`);
  const db = openDatabase(join(dir, 'data'), { log: () => {} });
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed by app.close()
    }
    cleanupDir(dir);
  });
  return { db, dir };
}

const setSetting = (db, key, value) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run(key, JSON.stringify(value));

const seedWeather = (db, value) => setSetting(db, 'weather', value);

// Open-Meteo `timeformat=unixtime` reports epoch SECONDS; the client parser
// converts them to epoch ms once, so these fixtures must be realistic seconds.
function forecastPayload(pressures, startMs = NOW) {
  return {
    hourly: {
      time: pressures.map((_, i) => (startMs + i * HOUR) / 1000),
      pressure_msl: pressures,
    },
    current: {
      temperature_2m: 14.2,
      relative_humidity_2m: 61,
      pressure_msl: 1010,
    },
    timezone: 'America/New_York',
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const readyStatus = (overrides = {}) => ({
  status: 'ready',
  stale: false,
  location: BOSTON,
  current: { temperatureC: 14.2, humidityPercent: 61, pressureHpa: 1010 },
  warning: null,
  fetchedAt: new Date(NOW).toISOString(),
  thresholdHpa: 5,
  timeZone: 'America/New_York',
  ...overrides,
});

// ── client ───────────────────────────────────────────────────────────
test('client validates fixed upstream shapes and caps geocode results', async (t) => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/search')) {
      const results = Array.from({ length: 12 }, (_, i) => ({
        id: i + 1,
        name: i === 0 ? 'Boston' : `Place ${i}`,
        admin1: '',
        country: 'US',
        latitude: 40 + i,
        longitude: -70 - i,
        // Extra upstream fields never reach the projection.
        population: 1000,
      }));
      results.push({ id: 'bad', name: 'Bad' });
      return jsonResponse({ results });
    }
    return jsonResponse(forecastPayload([1013, 1008, 1006]));
  };
  const client = createWeatherClient({ fetchImpl });
  t.after(() => {});

  const geocoded = await client.geocode('Boston');
  assert.equal(geocoded.length, 8);
  assert.deepEqual(Object.keys(geocoded[0]).sort(), [
    'admin1', 'country', 'id', 'latitude', 'longitude', 'name',
  ]);
  assert.match(urls[0], /name=Boston/);
  assert.match(urls[0], /count=8/);

  const forecast = await client.forecast({
    latitude: BOSTON.latitude,
    longitude: BOSTON.longitude,
  });
  assert.equal(forecast.series.pressures.length, 3);
  // Parser boundary: unix seconds from the payload become epoch ms.
  assert.deepEqual(forecast.series.times, [NOW, NOW + HOUR, NOW + 2 * HOUR]);
  assert.deepEqual(forecast.current, {
    temperatureC: 14.2,
    humidityPercent: 61,
    pressureHpa: 1010,
  });
  const forecastUrl = urls[1];
  assert.match(forecastUrl, /hourly=pressure_msl/);
  // 26 samples guarantee baseline (possibly the next hour) .. baseline+24h.
  assert.match(forecastUrl, /forecast_hours=26/);
  assert.match(forecastUrl, /timeformat=unixtime/);
  assert.match(forecastUrl, /timezone=auto/);
  // The hourly assessment never depends on current.pressure_msl, but the
  // informational current block is requested separately.
  assert.match(forecastUrl, /current=temperature_2m,relative_humidity_2m,pressure_msl/);
});

test('client fails closed on malformed forecast and missing fetch', async () => {
  const client = createWeatherClient({
    fetchImpl: async () => jsonResponse({ hourly: { time: [1], pressure_msl: [] } }),
  });
  await assert.rejects(
    () => client.forecast({ latitude: 1, longitude: 2 }),
    (error) => error.category === 'shape',
  );

  const noFetch = createWeatherClient({ fetchImpl: null });
  await assert.rejects(
    () => noFetch.forecast({ latitude: 1, longitude: 2 }),
    (error) => error.category === 'unavailable',
  );
});

// ── service ──────────────────────────────────────────────────────────
test('service performs zero fetches while disabled or unconfigured', async (t) => {
  const { db } = makeDb(t, 'weather-disabled');
  let calls = 0;
  const client = {
    forecast: async () => {
      calls += 1;
      return { series: { times: [NOW], pressures: [1010] }, current: null, timeZone: null };
    },
  };
  const service = createWeatherService({ db, client, now: () => NOW });

  assert.equal(service.getStatus().status, 'disabled');
  await service.refresh();
  assert.equal(calls, 0);

  seedWeather(db, { enabled: true, location: null, pressureDropThresholdHpa: 5 });
  await service.refresh();
  assert.equal(calls, 0);
  assert.equal(service.getStatus().status, 'unconfigured');
  assert.equal(service.getStatus().location, null);

  await service.stop();
});

test('service caches a ready status, single-flights, and reports the drop', async (t) => {
  const { db } = makeDb(t, 'weather-ready');
  seedWeather(db, { enabled: true, location: BOSTON, pressureDropThresholdHpa: 5 });
  const pending = deferred();
  let calls = 0;
  const client = {
    forecast: async () => {
      calls += 1;
      return pending.promise;
    },
  };
  let refreshes = 0;
  const service = createWeatherService({
    db, client, now: () => NOW, onRefresh: () => { refreshes += 1; },
  });

  const first = service.refresh();
  const second = service.refresh();
  assert.equal(first, second, 'concurrent refresh joins the same flight');
  pending.resolve({
    series: { times: [NOW, NOW + HOUR], pressures: [1013, 1008] },
    current: { temperatureC: 10, humidityPercent: 50, pressureHpa: 1010 },
    timeZone: 'America/New_York',
  });
  await first;
  assert.equal(calls, 1);
  assert.equal(refreshes, 1);

  const status = service.getStatus();
  assert.equal(status.status, 'ready');
  assert.equal(status.stale, false);
  assert.equal(status.location.name, 'Boston');
  assert.equal(status.warning.targetHpa, 1008);
  assert.equal(status.warning.dropHpa, 5);
  assert.equal(status.timeZone, 'America/New_York');
  await service.stop();
});

test('service keeps last good data as stale on failure and recovers', async (t) => {
  const { db } = makeDb(t, 'weather-stale');
  seedWeather(db, { enabled: true, location: BOSTON, pressureDropThresholdHpa: 5 });
  let fail = false;
  const client = {
    forecast: async () => {
      if (fail) throw new Error('upstream detail must not leak');
      return {
        series: { times: [NOW, NOW + HOUR], pressures: [1013, 1008] },
        current: { temperatureC: 10, humidityPercent: 50, pressureHpa: 1010 },
        timeZone: 'UTC',
      };
    },
  };
  const logs = [];
  const service = createWeatherService({
    db, client, now: () => NOW, log: (line) => logs.push(line),
  });
  await service.refresh();
  assert.equal(service.getStatus().status, 'ready');
  const fetchedAt = service.getStatus().fetchedAt;

  fail = true;
  await service.refresh();
  const stale = service.getStatus();
  assert.equal(stale.status, 'error');
  assert.equal(stale.stale, true);
  assert.equal(stale.warning.dropHpa, 5, 'last good warning retained');
  assert.equal(stale.fetchedAt, fetchedAt);
  // Fixed log text only.
  assert.deepEqual(logs, ['weather: refresh failed']);

  fail = false;
  await service.refresh();
  const recovered = service.getStatus();
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.stale, false);
  await service.stop();
});

test('service treats short data as a failed refresh, never an invented alert', async (t) => {
  const { db } = makeDb(t, 'weather-short');
  seedWeather(db, { enabled: true, location: BOSTON, pressureDropThresholdHpa: 5 });
  const service = createWeatherService({
    db,
    client: {
      forecast: async () => ({
        series: { times: [NOW], pressures: [1013] },
        current: null,
        timeZone: null,
      }),
    },
    now: () => NOW,
  });
  await service.refresh();
  const status = service.getStatus();
  assert.equal(status.status, 'error');
  assert.equal(status.stale, true);
  assert.equal(status.warning, null);
  await service.stop();
});

test('service never serves the previous location after a settings change', async (t) => {
  const { db } = makeDb(t, 'weather-invalidate');
  seedWeather(db, { enabled: true, location: BOSTON, pressureDropThresholdHpa: 5 });
  const pending = deferred();
  let calls = 0;
  const client = {
    forecast: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          series: { times: [NOW, NOW + HOUR], pressures: [1013, 1000] },
          current: null,
          timeZone: 'UTC',
        };
      }
      return pending.promise;
    },
  };
  const service = createWeatherService({ db, client, now: () => NOW });
  await service.refresh();
  assert.equal(service.getStatus().location.name, 'Boston');

  const salem = { ...BOSTON, id: 2, name: 'Salem', latitude: 42.52 };
  seedWeather(db, { enabled: true, location: salem, pressureDropThresholdHpa: 5 });
  const refresh = service.invalidate();
  // Invalidation clears synchronously: no old city/forecast is served while
  // the new location is loading.
  const loading = service.getStatus();
  assert.equal(loading.status, 'loading');
  assert.equal(loading.location, null);
  assert.equal(loading.warning, null);

  pending.resolve({
    series: { times: [NOW, NOW + HOUR], pressures: [1013, 1011] },
    current: null,
    timeZone: 'UTC',
  });
  await refresh;
  assert.equal(calls, 2);
  assert.equal(service.getStatus().location.name, 'Salem');
  await service.stop();
});

test('service clears cached data when disabled or unconfigured', async (t) => {
  const { db } = makeDb(t, 'weather-disable');
  let calls = 0;
  const client = {
    forecast: async () => {
      calls += 1;
      return {
        series: { times: [NOW, NOW + HOUR], pressures: [1013, 1000] },
        current: null,
        timeZone: 'UTC',
      };
    },
  };
  seedWeather(db, { enabled: true, location: BOSTON, pressureDropThresholdHpa: 5 });
  const service = createWeatherService({ db, client, now: () => NOW });
  await service.refresh();
  assert.equal(calls, 1);

  seedWeather(db, { enabled: false, location: BOSTON, pressureDropThresholdHpa: 5 });
  await service.invalidate();
  assert.equal(service.getStatus().status, 'disabled');
  assert.equal(service.getStatus().location, null);
  assert.equal(calls, 1);

  seedWeather(db, { enabled: true, location: null, pressureDropThresholdHpa: 5 });
  await service.invalidate();
  assert.equal(service.getStatus().status, 'unconfigured');
  assert.equal(calls, 1);
  await service.stop();
});

// ── routes ───────────────────────────────────────────────────────────
async function makeWeatherApp(t, { weather, onWeatherChange } = {}) {
  const dir = makeTempDir('migraine-weather-app');
  const db = openDatabase(join(dir, 'data'), { log: () => {} });
  const app = await buildApp({ db, logger: false, weather, onWeatherChange });
  t.after(async () => {
    await app.close();
    cleanupDir(dir);
  });
  return { app, db };
}

test('GET /api/weather returns safe runtime status (disabled without a service)', async (t) => {
  const { app } = await makeWeatherApp(t);
  const response = await app.inject({ method: 'GET', url: '/api/weather' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, 'disabled');
  assert.equal(body.location, null);
  assert.equal(body.warning, null);
  assert.equal(body.stale, false);
});

test('POST /api/weather/geocode keeps the query in the JSON body', async (t) => {
  const received = [];
  const weather = {
    getStatus: () => readyStatus(),
    geocode: async (query) => {
      received.push(query);
      return [BOSTON];
    },
  };
  const { app } = await makeWeatherApp(t, { weather });

  const ok = await app.inject({
    method: 'POST',
    url: '/api/weather/geocode',
    payload: { query: '  Boston  ' },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { results: [BOSTON] });
  assert.deepEqual(received, ['Boston']);

  for (const query of ['a', 'x'.repeat(101), 'Bad\tCity', 42, null]) {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/weather/geocode',
      payload: { query },
    });
    assert.equal(bad.statusCode, 400, `query ${JSON.stringify(query)} is rejected`);
    assert.match(bad.json().error, /query must be 2 to 100 characters/);
  }

  // A GET route does not exist: the city can never travel in a logged URL.
  const get = await app.inject({ method: 'GET', url: '/api/weather/geocode?query=Boston' });
  assert.equal(get.statusCode, 404);
});

test('geocode route hides upstream failure details', async (t) => {
  const weather = {
    getStatus: () => readyStatus(),
    geocode: async () => {
      throw new Error('https://upstream.example/?name=Boston token=secret');
    },
  };
  const { app } = await makeWeatherApp(t, { weather });
  const response = await app.inject({
    method: 'POST',
    url: '/api/weather/geocode',
    payload: { query: 'Boston' },
  });
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), { error: 'weather search unavailable' });
});

test('weather settings PUT is strict, normalized, and invalidates the cache', async (t) => {
  let changes = 0;
  const { app, db } = await makeWeatherApp(t, { onWeatherChange: () => { changes += 1; } });

  const invalid = await app.inject({
    method: 'PUT',
    url: '/api/settings/weather',
    payload: { enabled: true, location: BOSTON, pressureDropThresholdHpa: 0 },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(changes, 0);

  const secret = await app.inject({
    method: 'PUT',
    url: '/api/settings/weather',
    payload: { ...BOSTON, enabled: true, pressureDropThresholdHpa: 5, ntfyToken: 'x' },
  });
  assert.equal(secret.statusCode, 400);
  assert.equal(changes, 0);

  const valid = await app.inject({
    method: 'PUT',
    url: '/api/settings/weather',
    payload: {
      enabled: true,
      location: { ...BOSTON, extra: 'dropped' },
      pressureDropThresholdHpa: 6.5,
      provider: 'dropped',
    },
  });
  assert.equal(valid.statusCode, 200);
  assert.equal(changes, 1);
  assert.deepEqual(collectSettings(db).weather, {
    enabled: true,
    location: BOSTON,
    pressureDropThresholdHpa: 6.5,
  });

  const settings = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.deepEqual(settings.json().weather, {
    enabled: true,
    location: BOSTON,
    pressureDropThresholdHpa: 6.5,
  });

  const reset = await app.inject({ method: 'POST', url: '/api/reset' });
  assert.equal(reset.statusCode, 200);
  assert.equal(changes, 2);
  assert.equal(collectSettings(db).weather, undefined);
});

test('restore persists weather settings and invalidates the cache', async (t) => {
  let changes = 0;
  const { app, db } = await makeWeatherApp(t, { onWeatherChange: () => { changes += 1; } });
  const response = await app.inject({
    method: 'POST',
    url: '/api/restore',
    payload: {
      schemaVersion: 4,
      attacks: [],
      settings: {
        weather: {
          enabled: true,
          location: BOSTON,
          pressureDropThresholdHpa: 5.5,
        },
      },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(changes, 1);
  assert.deepEqual(response.json().settings.weather, {
    enabled: true,
    location: BOSTON,
    pressureDropThresholdHpa: 5.5,
  });
  assert.deepEqual(collectSettings(db).weather, {
    enabled: true,
    location: BOSTON,
    pressureDropThresholdHpa: 5.5,
  });
});

test('a wired weather service powers GET /api/weather', async (t) => {
  const warning = {
    baselineHpa: 1013,
    targetHpa: 1005,
    dropHpa: 8,
    targetTimeMs: NOW + 2 * HOUR,
    thresholdHpa: 5,
  };
  const weather = { getStatus: () => readyStatus({ warning }), geocode: async () => [] };
  const { app } = await makeWeatherApp(t, { weather });
  const response = await app.inject({ method: 'GET', url: '/api/weather' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().warning, warning);
  assert.equal(response.json().location.name, 'Boston');
});
