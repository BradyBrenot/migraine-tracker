// Weather support: a small injected Open-Meteo client plus a cached,
// single-flight polling service.
//
// Rules this module owns:
// - Disabled or unconfigured settings perform ZERO upstream forecast fetches.
// - Forecast data comes from one Open-Meteo hourly pressure_msl series;
//   `current` values are informational only and never trigger warnings.
// - Upstream URLs, response bodies, and error details are never logged. The
//   geocoding route is a POST from the browser so the searched city never
//   appears in Fastify's request log (req.url).
// - A failed refresh keeps the last good values but marks them stale; a
//   settings change invalidates cached data immediately so an old location is
//   never served.
// - Runtime forecast/episode data is never exported or backed up.

import { collectSettings } from './snapshot.js';
import {
  DEFAULT_PRESSURE_DROP_THRESHOLD_HPA,
  assessPressureDrop,
  emptyWeatherStatus,
  hourlyPressureSeries,
  normalizeWeatherLocation,
  normalizeWeatherSettings,
  parseCurrentWeather,
  weatherSignature,
} from '../shared/weather.ts';

export const WEATHER_REFRESH_MS = 15 * 60 * 1000;
export const WEATHER_REQUEST_TIMEOUT_MS = 10 * 1000;
export const GEOCODE_RESULT_LIMIT = 8;

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Fixed failure categories only. Anything upstream (URL, body, parser text)
 * stays inside the client and is never surfaced or logged.
 */
export class WeatherError extends Error {
  constructor(category) {
    super(category);
    this.name = 'WeatherError';
    this.category = category;
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function safeTimeZone(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) return null;
  return CONTROL_CHARS.test(value) ? null : value;
}

function coordinate(value) {
  return Number.isFinite(value) ? Number(value).toFixed(4) : null;
}

/**
 * Build the Open-Meteo client. `fetchImpl` and `now` are injectable so tests
 * never touch the network or the wall clock.
 */
export function createWeatherClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = WEATHER_REQUEST_TIMEOUT_MS,
  forecastUrl = FORECAST_URL,
  geocodeUrl = GEOCODING_URL,
} = {}) {
  async function getJson(url) {
    if (typeof fetchImpl !== 'function') throw new WeatherError('unavailable');
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error && typeof error.name === 'string' ? error.name : '';
      throw new WeatherError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'fetch',
      );
    }
    if (!response || response.ok !== true) throw new WeatherError('http');
    try {
      // Read/parse only; the body is never logged or echoed.
      return await response.json();
    } catch {
      throw new WeatherError('shape');
    }
  }

  return {
    /** City search. Returns at most GEOCODE_RESULT_LIMIT safe projections. */
    async geocode(query) {
      const url = `${geocodeUrl}?name=${encodeURIComponent(query)}`
        + `&count=${GEOCODE_RESULT_LIMIT}&language=en&format=json`;
      const body = await getJson(url);
      const raw = isPlainObject(body) && Array.isArray(body.results) ? body.results : [];
      const results = [];
      for (const item of raw) {
        const location = normalizeWeatherLocation(item);
        if (!location) continue;
        results.push(location);
        if (results.length >= GEOCODE_RESULT_LIMIT) break;
      }
      return results;
    },

    /** Forecast for one validated location. Shape errors throw WeatherError. */
    async forecast({ latitude, longitude }) {
      const lat = coordinate(latitude);
      const lon = coordinate(longitude);
      if (lat === null || lon === null) throw new WeatherError('shape');
      const url = `${forecastUrl}?latitude=${lat}&longitude=${lon}`
        + '&hourly=pressure_msl'
        + '&current=temperature_2m,relative_humidity_2m,pressure_msl'
        // The baseline is the first sample at/after now, which can be the NEXT
        // hourly point, so 26 samples are needed to always cover the full
        // baseline..baseline+24h inclusive window. The pure assessment still
        // only considers that window.
        + '&forecast_hours=26&timeformat=unixtime&timezone=auto';
      const body = await getJson(url);
      if (!isPlainObject(body)) throw new WeatherError('shape');
      const series = hourlyPressureSeries(body.hourly);
      if (!series) throw new WeatherError('shape');
      return {
        series,
        current: parseCurrentWeather(body.current),
        timeZone: safeTimeZone(body.timezone),
      };
    },
  };
}

function warningFromAssessment(assessment) {
  if (assessment.state !== 'warning') return null;
  if (
    assessment.baselineHpa === null
    || assessment.targetHpa === null
    || assessment.targetTimeMs === null
    || assessment.dropHpa === null
  ) {
    return null;
  }
  return {
    baselineHpa: assessment.baselineHpa,
    targetHpa: assessment.targetHpa,
    dropHpa: assessment.dropHpa,
    targetTimeMs: assessment.targetTimeMs,
    thresholdHpa: assessment.thresholdHpa,
  };
}

/**
 * Cached polling service. GUI needs it even without ntfy, so the wire-up
 * always starts it; disabled settings simply mean no fetch/timer work.
 */
export function createWeatherService({
  db,
  client,
  now = () => Date.now(),
  refreshMs = WEATHER_REFRESH_MS,
  log = () => {},
  onRefresh = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!db) throw new Error('weather service requires a database');
  if (!client || typeof client.forecast !== 'function') {
    throw new Error('weather service requires a client');
  }

  let epoch = 0;
  let inflight = null;
  let data = null;
  let status = 'disabled';
  let stale = false;
  let timer = null;
  let stopped = false;

  function readSettings() {
    try {
      return normalizeWeatherSettings(collectSettings(db).weather);
    } catch {
      // A corrupted settings row must not break polling or the API.
      return normalizeWeatherSettings(null);
    }
  }

  function getStatus() {
    const settings = readSettings();
    const thresholdHpa = settings.pressureDropThresholdHpa;
    if (!settings.enabled) {
      return { ...emptyWeatherStatus(), thresholdHpa };
    }
    if (!settings.location) {
      return { ...emptyWeatherStatus(), status: 'unconfigured', thresholdHpa };
    }
    const signature = weatherSignature(settings);
    // Never serve a location that no longer matches the saved settings, even
    // if a write bypassed the invalidation callback.
    if (data && data.signature !== signature) {
      return {
        ...emptyWeatherStatus(),
        status: 'loading',
        thresholdHpa,
        stale: false,
      };
    }
    return {
      status,
      location: data ? data.location : null,
      current: data ? data.current : null,
      warning: data ? data.warning : null,
      fetchedAt: data ? data.fetchedAt : null,
      stale,
      thresholdHpa,
      timeZone: data ? data.timeZone : null,
    };
  }

  function applyDisabledOrUnconfigured(settings, myEpoch) {
    if (epoch !== myEpoch) return;
    data = null;
    stale = false;
    status = settings.enabled ? 'unconfigured' : 'disabled';
  }

  async function doRefresh(myEpoch) {
    const settings = readSettings();
    if (!settings.enabled || !settings.location) {
      applyDisabledOrUnconfigured(settings, myEpoch);
      return getStatus();
    }

    const signature = weatherSignature(settings);
    // A changed city/threshold must never be served from the old cache.
    if (data && data.signature !== signature) {
      data = null;
      stale = false;
    }
    if (epoch !== myEpoch) return getStatus();
    status = data ? 'ready' : 'loading';
    const location = settings.location;

    try {
      const forecast = await client.forecast({
        latitude: location.latitude,
        longitude: location.longitude,
      });
      if (epoch !== myEpoch || stopped) return getStatus();
      const nowMs = now();
      const assessment = assessPressureDrop({
        times: forecast.series.times,
        pressures: forecast.series.pressures,
        nowMs,
        thresholdHpa: settings.pressureDropThresholdHpa,
      });
      // Short/incomplete data cannot support a conclusion: treat it as a
      // failed refresh (retain last good data as stale) instead of clearing a
      // real episode with invented "clear" data.
      if (assessment.state === 'unknown') throw new WeatherError('shape');
      data = {
        signature,
        location,
        current: forecast.current,
        warning: warningFromAssessment(assessment),
        fetchedAt: new Date(nowMs).toISOString(),
        timeZone: forecast.timeZone,
      };
      status = 'ready';
      stale = false;
      try {
        onRefresh?.();
      } catch {
        // A scheduler tick must never affect the weather service.
      }
    } catch {
      if (epoch !== myEpoch || stopped) return getStatus();
      // Fixed text only: no URL, body, parser message, or error detail.
      status = 'error';
      stale = true;
      log('weather: refresh failed');
    }
    return getStatus();
  }

  function refresh() {
    if (stopped) return Promise.resolve(getStatus());
    if (inflight && inflight.epoch === epoch) return inflight.promise;
    const myEpoch = epoch;
    const promise = doRefresh(myEpoch).finally(() => {
      if (inflight && inflight.promise === promise) inflight = null;
    });
    inflight = { epoch: myEpoch, promise };
    return promise;
  }

  /**
   * Invalidate cached data immediately (settings changed / reset / restore),
   * then rebuild from the new settings. Never awaited by route handlers.
   */
  function invalidate() {
    epoch += 1;
    inflight = null;
    data = null;
    stale = false;
    const settings = readSettings();
    status = !settings.enabled
      ? 'disabled'
      : settings.location ? 'loading' : 'unconfigured';
    return refresh();
  }

  function start() {
    if (timer || stopped) return;
    void refresh();
    timer = setIntervalFn(() => {
      void refresh();
    }, refreshMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function stop() {
    stopped = true;
    epoch += 1;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    try {
      await inflight?.promise;
    } catch {
      // never throw on shutdown
    }
    inflight = null;
  }

  return {
    start,
    stop,
    refresh,
    invalidate,
    getStatus,
    /** City search (used by POST /api/weather/geocode). */
    geocode: (query) => client.geocode(query),
    /** Exposed for tests/diagnostics; contains no upstream details. */
    refreshMs,
    defaultThresholdHpa: DEFAULT_PRESSURE_DROP_THRESHOLD_HPA,
  };
}
