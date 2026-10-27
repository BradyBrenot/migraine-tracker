/**
 * Weather pressure-drop domain rules shared by the browser (Home card,
 * Settings) and the server (Open-Meteo client/service and reminder engine).
 *
 * Everything here is pure/injectable: no clock, network, storage, DOM, or
 * database access. This module MUST stay erasable-syntax only and
 * double-environment safe (Vite bundle + Node 24 native type-stripping), like
 * shared/reminders.ts.
 *
 * Scope rules:
 * - Only pressure DROPS are assessed. No rise alerts, no temperature or
 *   humidity alerts, and no composite "migraine risk" score.
 * - A warning means: baseline mean-sea-level pressure minus any subsequent
 *   hourly pressure sample inside the next 24 hours is >= the configured
 *   threshold. Everything is computed from ONE hourly pressure_msl series;
 *   `current.pressure_msl` is never mixed into the assessment.
 * - 5 hPa is a configurable starting point, not a validated clinical cutoff.
 */

export type WeatherRuntimeState =
  | 'disabled' | 'unconfigured' | 'loading' | 'ready' | 'error';

/** The fixed, non-secret location projection for Open-Meteo results. */
export interface WeatherLocation {
  /** Open-Meteo geocoding id (non-negative integer). */
  id: number;
  name: string;
  /** First-level administrative area; may be an empty string. */
  admin1: string;
  /** Country; may be an empty string. */
  country: string;
  latitude: number;
  longitude: number;
}

export interface WeatherSettings {
  /** Optional feature: disabled by default. */
  enabled: boolean;
  location: WeatherLocation | null;
  /** Pressure drop that warns, in hPa (1..25, UI step 0.5). */
  pressureDropThresholdHpa: number;
}

export interface WeatherCurrent {
  temperatureC: number | null;
  humidityPercent: number | null;
  pressureHpa: number | null;
}

/** Warning details returned by the pure assessment (for UI/ntfy). */
export interface PressureWarning {
  /** Baseline hourly pressure at/after "now". */
  baselineHpa: number;
  /** Lowest subsequent hourly pressure inside the 24h window. */
  targetHpa: number;
  /** baselineHpa - targetHpa. */
  dropHpa: number;
  /** Epoch ms of the target sample. */
  targetTimeMs: number;
  thresholdHpa: number;
}

/** Safe runtime status returned by GET /api/weather (no upstream details). */
export interface WeatherStatus {
  status: WeatherRuntimeState;
  location: WeatherLocation | null;
  current: WeatherCurrent | null;
  warning: PressureWarning | null;
  /** ISO instant of the last successful forecast (null when never fetched). */
  fetchedAt: string | null;
  /** True when the last refresh failed and old data is retained. */
  stale: boolean;
  thresholdHpa: number;
  /** Location time zone reported by Open-Meteo, when usable. */
  timeZone: string | null;
}

export const DEFAULT_WEATHER_SETTINGS: WeatherSettings = {
  enabled: false,
  location: null,
  pressureDropThresholdHpa: 5,
};

export const DEFAULT_PRESSURE_DROP_THRESHOLD_HPA = 5;
export const MIN_PRESSURE_DROP_THRESHOLD_HPA = 1;
export const MAX_PRESSURE_DROP_THRESHOLD_HPA = 25;
export const PRESSURE_DROP_THRESHOLD_STEP_HPA = 0.5;

/** Assessment window: the 24 hours after the baseline sample, inclusive. */
export const PRESSURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Cautious wording shared by the Home card and ntfy. Never stronger claims. */
export const WEATHER_WARNING_TITLE = 'Pressure drop forecast';
export const WEATHER_WARNING_LEAD =
  'Pressure drop forecast — a possible trigger for some people.';

const MAX_LOCATION_FIELD_LENGTH = 120;
const MAX_GEOCODE_QUERY_LENGTH = 100;
const MIN_GEOCODE_QUERY_LENGTH = 2;
// Mean-sea-level pressure outside this range is not a usable forecast sample
// (the record extremes are roughly 870-1085 hPa). Out-of-range values are
// treated like missing data instead of inventing an alert.
const MIN_PLAUSIBLE_PRESSURE_HPA = 800;
const MAX_PLAUSIBLE_PRESSURE_HPA = 1100;
// Float subtraction can leave e.g. 5.000000000000114 for "exactly" 5 hPa.
const DROP_EPSILON_HPA = 1e-6;

/**
 * Reject C0 control characters and DEL without a regex: eslint's
 * no-control-regex cannot express this intent, and a code-point check is
 * explicit about exactly which characters are refused.
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Secret/delivery configuration is environment-only. A weather object carrying
 * any such field is rejected, and normalization never copies unknown fields.
 */
const RESERVED_WEATHER_KEY =
  /(ntfy|token|secret|password|passwd|apikey|authorization|bearer|credential|publicappurl)/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const safeText = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string'
  && value === value.trim()
  && value.length >= min
  && value.length <= max
  && !hasControlChar(value);

const optionalText = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length <= MAX_LOCATION_FIELD_LENGTH
  && !hasControlChar(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** NaN/Infinity/null never count as a forecast sample. */
const isUsablePressure = (value: unknown): value is number =>
  isFiniteNumber(value)
  && value >= MIN_PLAUSIBLE_PRESSURE_HPA
  && value <= MAX_PLAUSIBLE_PRESSURE_HPA;

export function reservedWeatherSettingKeys(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  const reserved = Object.keys(value)
    .filter((key) => RESERVED_WEATHER_KEY.test(key.replace(/[^A-Za-z0-9]/g, '')));
  if (isPlainObject(value.location)) {
    for (const key of Object.keys(value.location)) {
      if (RESERVED_WEATHER_KEY.test(key.replace(/[^A-Za-z0-9]/g, ''))) {
        reserved.push(`location.${key}`);
      }
    }
  }
  return reserved;
}

/** Validation for one fixed location projection. Returns [] when valid. */
export function weatherLocationErrors(value: unknown): string[] {
  if (!isPlainObject(value)) return ['location must be an object or null'];
  const errors: string[] = [];
  if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 0) {
    errors.push('location.id must be a non-negative integer');
  }
  if (!safeText(value.name, 1, MAX_LOCATION_FIELD_LENGTH)) {
    errors.push('location.name must be a non-empty string of at most 120 characters');
  }
  // admin1/country are optional in projection terms: absent becomes '' when
  // normalized, but a present value must be a control-free string.
  if (value.admin1 !== undefined && !optionalText(value.admin1)) {
    errors.push('location.admin1 must be a string of at most 120 characters');
  }
  if (value.country !== undefined && !optionalText(value.country)) {
    errors.push('location.country must be a string of at most 120 characters');
  }
  if (!isFiniteNumber(value.latitude) || value.latitude < -90 || value.latitude > 90) {
    errors.push('location.latitude must be a finite number from -90 to 90');
  }
  if (!isFiniteNumber(value.longitude) || value.longitude < -180 || value.longitude > 180) {
    errors.push('location.longitude must be a finite number from -180 to 180');
  }
  return errors;
}

/**
 * Strict projection: only the six known fields survive. Returns null for any
 * malformed location, so a bad legacy row can only mean "no city", never a
 * partially trusted coordinate.
 */
export function normalizeWeatherLocation(value: unknown): WeatherLocation | null {
  if (weatherLocationErrors(value).length) return null;
  const location = value as Record<string, unknown>;
  return {
    id: location.id as number,
    name: location.name as string,
    admin1: typeof location.admin1 === 'string' ? location.admin1 : '',
    country: typeof location.country === 'string' ? location.country : '',
    latitude: location.latitude as number,
    longitude: location.longitude as number,
  };
}

function thresholdValid(value: unknown): value is number {
  return isFiniteNumber(value)
    && value >= MIN_PRESSURE_DROP_THRESHOLD_HPA
    && value <= MAX_PRESSURE_DROP_THRESHOLD_HPA;
}

/** Strict validation for PUT /api/settings/weather and Settings. */
export function weatherSettingsErrors(value: unknown): string[] {
  if (!isPlainObject(value)) return ['weather settings must be an object'];
  const errors: string[] = [];
  for (const key of reservedWeatherSettingKeys(value)) {
    errors.push(`weather settings must not contain ${key}`);
  }
  if (typeof value.enabled !== 'boolean') errors.push('enabled must be true or false');
  if (value.location !== null && value.location !== undefined) {
    errors.push(...weatherLocationErrors(value.location));
  }
  if (!thresholdValid(value.pressureDropThresholdHpa)) {
    errors.push(
      `pressureDropThresholdHpa must be a number from `
      + `${MIN_PRESSURE_DROP_THRESHOLD_HPA} to ${MAX_PRESSURE_DROP_THRESHOLD_HPA}`,
    );
  }
  return errors;
}

/**
 * Defensive merge for localStorage/server reads: every invalid field falls
 * back independently, unknown/secret-like fields are dropped, and the result
 * contains only the three known keys.
 */
export function normalizeWeatherSettings(value: unknown): WeatherSettings {
  const out: WeatherSettings = { ...DEFAULT_WEATHER_SETTINGS };
  if (!isPlainObject(value)) return out;
  if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
  out.location = normalizeWeatherLocation(value.location);
  if (thresholdValid(value.pressureDropThresholdHpa)) {
    out.pressureDropThresholdHpa = value.pressureDropThresholdHpa;
  }
  return out;
}

/**
 * City-search input: trimmed, 2..100 characters, no control characters.
 * Returns the trimmed query or null. Search terms and coordinates leave this
 * server for Open-Meteo, so this is also the only string ever forwarded.
 */
export function normalizeGeocodeQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < MIN_GEOCODE_QUERY_LENGTH || trimmed.length > MAX_GEOCODE_QUERY_LENGTH) {
    return null;
  }
  if (hasControlChar(trimmed)) return null;
  return trimmed;
}

/** "Boston, Massachusetts, United States" (empty parts skipped). */
export function formatWeatherLocation(location: WeatherLocation | null): string {
  if (!location) return '';
  return [location.name, location.admin1, location.country]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(', ');
}

/**
 * Episode identity: rounded location + threshold + drop direction. Re-selecting
 * identical settings is stable; changing the city or threshold deliberately
 * rearms and may alert for the newly configured condition.
 */
export function weatherSignature(settings: WeatherSettings): string {
  if (!settings.location) return 'none';
  const lat = settings.location.latitude.toFixed(3);
  const lon = settings.location.longitude.toFixed(3);
  return `drop:${lat},${lon}:${settings.pressureDropThresholdHpa}`;
}

/** Stable occurrence key for one warning episode. */
export function weatherOccurrenceKey(signature: string, episodeKey: string): string {
  return `weather:${signature}:${episodeKey}`;
}

/** Empty safe status used when no weather service is wired (e.g. tests). */
export function emptyWeatherStatus(): WeatherStatus {
  return {
    status: 'disabled',
    location: null,
    current: null,
    warning: null,
    fetchedAt: null,
    stale: false,
    thresholdHpa: DEFAULT_PRESSURE_DROP_THRESHOLD_HPA,
    timeZone: null,
  };
}

// ── Open-Meteo hourly series + pure assessment ────────────────────────
export interface HourlyPressureSeries {
  /**
   * Epoch ms samples. Open-Meteo `timeformat=unixtime` returns epoch SECONDS,
   * so the parser converts them at this boundary; NaN when the upstream entry
   * was not a finite number.
   */
  times: number[];
  /** Mean-sea-level pressure samples (NaN when not a number). */
  pressures: number[];
}

/**
 * Project the upstream `hourly` object without trusting it. Only
 * hourly.time / hourly.pressure_msl are read (never `current`); arrays of
 * different lengths are malformed and return null.
 *
 * Unix timestamps arrive in seconds (the client always requests
 * `timeformat=unixtime`) and are converted here, once, so everything
 * downstream (`assessPressureDrop`, target times, UI, ntfy) is epoch ms.
 */
export function hourlyPressureSeries(hourly: unknown): HourlyPressureSeries | null {
  if (!isPlainObject(hourly)) return null;
  const times = hourly.time;
  const pressures = hourly.pressure_msl;
  if (!Array.isArray(times) || !Array.isArray(pressures)) return null;
  if (times.length !== pressures.length) return null;
  return {
    times: times.map((value) => {
      if (!isFiniteNumber(value)) return Number.NaN;
      const ms = value * 1000;
      return Number.isFinite(ms) ? ms : Number.NaN;
    }),
    pressures: pressures.map((value) => (isFiniteNumber(value) ? value : Number.NaN)),
  };
}

export interface PressureAssessment {
  /** 'unknown' means the data cannot support any conclusion (never alerts). */
  state: 'warning' | 'clear' | 'unknown';
  baselineHpa: number | null;
  targetHpa: number | null;
  targetTimeMs: number | null;
  dropHpa: number | null;
  thresholdHpa: number;
  windowEndMs: number | null;
}

/**
 * Exact pressure-drop rule.
 *
 * - Baseline = the first usable hourly sample with time >= nowMs.
 * - Candidates = later usable samples with time <= baseline + 24h (inclusive).
 * - The candidate with the largest drop (lowest pressure) is reported; a
 *   warning needs drop >= threshold. Rises are simply smaller/negative drops.
 * - Missing/NaN entries are skipped; mismatched arrays, an invalid threshold,
 *   no baseline, or no later sample within the window return 'unknown' so no
 *   alert is ever invented and an existing episode is not cleared on bad data.
 */
export function assessPressureDrop(input: {
  times: readonly unknown[];
  pressures: readonly unknown[];
  nowMs: number;
  thresholdHpa: number;
}): PressureAssessment {
  const { times, pressures, nowMs, thresholdHpa } = input;
  const unknown: PressureAssessment = {
    state: 'unknown',
    baselineHpa: null,
    targetHpa: null,
    targetTimeMs: null,
    dropHpa: null,
    thresholdHpa,
    windowEndMs: null,
  };
  if (!Array.isArray(times) || !Array.isArray(pressures)) return unknown;
  if (times.length !== pressures.length) return unknown;
  if (!isFiniteNumber(nowMs) || !thresholdValid(thresholdHpa)) return unknown;

  const points: { timeMs: number; pressureHpa: number }[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const timeMs = times[i];
    const pressureHpa = pressures[i];
    if (!isFiniteNumber(timeMs) || !isUsablePressure(pressureHpa)) continue;
    points.push({ timeMs, pressureHpa });
  }
  if (points.length === 0) return unknown;
  points.sort((a, b) => a.timeMs - b.timeMs);

  const baselineIndex = points.findIndex((point) => point.timeMs >= nowMs);
  if (baselineIndex < 0) return unknown;
  const baseline = points[baselineIndex];
  const windowEndMs = baseline.timeMs + PRESSURE_WINDOW_MS;

  let target: { timeMs: number; pressureHpa: number } | null = null;
  for (let i = baselineIndex + 1; i < points.length; i += 1) {
    const point = points[i];
    if (point.timeMs > windowEndMs) break;
    if (target === null || point.pressureHpa < target.pressureHpa) target = point;
  }
  if (target === null) {
    return {
      ...unknown,
      baselineHpa: baseline.pressureHpa,
      windowEndMs,
    };
  }

  const dropHpa = baseline.pressureHpa - target.pressureHpa;
  return {
    state: dropHpa + DROP_EPSILON_HPA >= thresholdHpa ? 'warning' : 'clear',
    baselineHpa: baseline.pressureHpa,
    targetHpa: target.pressureHpa,
    targetTimeMs: target.timeMs,
    dropHpa,
    thresholdHpa,
    windowEndMs,
  };
}

/**
 * Neutral informational `current` values. These never trigger warnings and
 * each field independently becomes null when unusable.
 */
export function parseCurrentWeather(value: unknown): WeatherCurrent | null {
  if (!isPlainObject(value)) return null;
  const temperature = value.temperature_2m;
  const humidity = value.relative_humidity_2m;
  const pressure = value.pressure_msl;
  return {
    temperatureC: isFiniteNumber(temperature) && temperature >= -100 && temperature <= 70
      ? temperature : null,
    humidityPercent: isFiniteNumber(humidity) && humidity >= 0 && humidity <= 100
      ? humidity : null,
    pressureHpa: isUsablePressure(pressure) ? pressure : null,
  };
}
