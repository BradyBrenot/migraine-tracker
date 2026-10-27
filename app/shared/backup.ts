/**
 * JSON backup parsing shared by the browser restore UI and POST /api/restore.
 *
 * Two on-disk shapes are accepted:
 * - "envelope": GET /api/export and the nightly dumps —
 *   { schemaVersion, exportedAt, attacks, ..., settings }.
 * - "browser": the flattened TrackerState JSON that Settings → Data
 *   downloads — the six record arrays plus the flattened settings fields and
 *   `seeded` (no schemaVersion/exportedAt/settings).
 *
 * The record rules intentionally mirror server/validate.js. They are
 * duplicated instead of imported because shared/ is bundled for the browser
 * and must not depend on server code; /api/restore still re-validates the
 * normalized payload with the server's own validators before writing.
 *
 * This module MUST stay erasable-syntax only and double-environment safe
 * (Vite bundle + Node 24 native type-stripping), like shared/reminders.ts:
 * explicit `.ts` extensions, no enums/namespaces/parameter properties, and no
 * DOM APIs.
 */

import type {
  Attack, DayState, MedEvent, Refill, ReminderSettings, StockBaseline,
  Workout,
} from '../src/types/index.ts';
import { isValidTimeZone } from './datetime.ts';
import { normalizeReminderSettings, reminderSettingsErrors } from './reminders.ts';

/**
 * Highest schema envelope this build understands. Keep in sync with
 * SCHEMA_VERSION in server/migrations.js (a server test asserts equality):
 * a backup written by a newer build must be rejected instead of partially
 * restored into a schema it predates.
 */
export const MAX_BACKUP_SCHEMA_VERSION = 4;

export type BackupRecordKey =
  | 'attacks' | 'meds' | 'refills' | 'workouts' | 'dayStates' | 'stockBaselines';

/** Only known non-secret settings are restorable; secrets stay environment-only. */
export interface BackupSettings {
  rules?: Record<string, unknown>;
  doses?: Record<string, unknown>;
  planned?: Record<string, unknown>;
  timezone?: string;
  lowStockThreshold?: number;
  lowStockAlert?: { latchedAt: string | null };
  reminders?: ReminderSettings;
}

export interface ParsedBackup {
  format: 'envelope' | 'browser';
  /** envelope schemaVersion when present; null for legacy-missing or browser exports */
  schemaVersion: number | null;
  /** envelope exportedAt when a string; else null */
  exportedAt: string | null;
  attacks: Attack[];
  meds: MedEvent[];
  refills: Refill[];
  workouts: Workout[];
  dayStates: DayState[];
  stockBaselines: StockBaseline[];
  /** only whitelisted keys that were present AND valid */
  settings: BackupSettings;
  /** unknown non-secret settings keys found and deliberately not restored */
  skippedSettingKeys: string[];
  /** browser export only: raw `seeded` when boolean, else null */
  seeded: boolean | null;
  /**
   * per type: how many records were dropped as exact duplicates of an
   * EARLIER record (keep-first). Merge consumers skip them; replace consumers
   * must fail because a replacement has to be exact.
   */
  duplicateCounts: Record<BackupRecordKey, number>;
}

export type BackupParseResult =
  | { ok: true; backup: ParsedBackup }
  | { ok: false; error: string };

// ── shared primitives ─────────────────────────────────────────────────
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
// undefined/null are treated as "absent → default", matching server/validate.js
// (`x ?? default` also accepted JSON null).
const absent = (v: unknown): v is undefined | null => v === undefined || v === null;

const RECORD_KEYS: readonly BackupRecordKey[] = [
  'attacks', 'meds', 'refills', 'workouts', 'dayStates', 'stockBaselines',
];

// Format detection: an envelope is anything carrying version/export metadata
// or the nested settings object. Otherwise a payload counts as a browser
// export when it carries any record array or flattened settings field.
const ENVELOPE_KEYS = ['schemaVersion', 'exportedAt', 'settings'] as const;
const BROWSER_KEYS = [
  ...RECORD_KEYS,
  'rules', 'doses', 'planned', 'timezone', 'lowStockThreshold',
  'lowStockAlertedAt', 'reminders', 'seeded',
] as const;

/** The only restorable non-secret setting keys (server storage names). */
const BACKUP_SETTINGS_KEYS = [
  'rules', 'doses', 'planned', 'timezone', 'lowStockThreshold',
  'lowStockAlert', 'reminders',
] as const;

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key);

/**
 * Reserved delivery/secret names, normalized case- and
 * separator-insensitively. This is the SAME policy as
 * server/validate.js isReservedSettingsKey, duplicated so the browser can
 * fail closed without importing server code. A server test asserts the two
 * agree, so a drift in either copy breaks the suite.
 */
const RESERVED_SETTINGS_PATTERNS = [
  /^ntfyurl$/, /^ntfytoken$/, /^publicappurl$/,
  /^ntfyattackurl$/, /^ntfyattacktoken$/,
  /ntfyurl/, /ntfytoken/, /publicappurl/,
  /ntfyattackurl/, /ntfyattacktoken/,
  /token/, /secret/, /password/, /passwd/, /apikey/, /authorization/,
  /bearer/, /credential/,
];

export function isReservedBackupSettingsKey(key: unknown): boolean {
  if (!isString(key)) return false;
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return RESERVED_SETTINGS_PATTERNS.some((pattern) => pattern.test(normalized));
}

const isRestorableSettingKey = (key: string): boolean =>
  (BACKUP_SETTINGS_KEYS as readonly string[]).includes(key);

// ── record rules (mirror of server/validate.js, full/POST semantics) ──
const INSTANT_MSG = 'must be a full ISO 8601 instant with an explicit timezone '
  + '(e.g. 2026-03-01T07:00:00.000Z)';

// Full ISO 8601 instant with an explicit timezone: date-only values,
// timezone-less local datetimes, and arbitrary strings are rejected so a typo
// can never silently poison ordering columns. Canonical new records use
// `YYYY-MM-DDTHH:mm:ss.sssZ`; other legitimate backup forms with explicit
// offsets (±HH:MM, basic-format ±HHMM, optional fractional seconds, lowercase
// 't'/'z' per RFC 3339) stay importable.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:?\d{2})$/;
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A real calendar date in 'YYYY-MM-DD' form. The round-trip check rejects
 * shapes the regex accepts but the calendar does not (2026-02-30, month 13,
 * month 00, day 00), exactly like server/validate.js isValidDay.
 */
function isValidCalendarDay(value: unknown): value is string {
  if (!isString(value)) return false;
  const match = CALENDAR_DAY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/** Component ranges are checked explicitly; leap seconds and hour 24 fail. */
function isValidIsoInstant(value: unknown): value is string {
  if (!isString(value)) return false;
  const match = ISO_INSTANT.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi, s, , tz] = match;
  if (!isValidCalendarDay(`${y}-${mo}-${d}`)) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return false;
  if (tz[0] !== 'Z' && tz[0] !== 'z') {
    if (Number(tz.slice(1, 3)) > 23 || Number(tz.slice(-2)) > 59) return false;
  }
  return true;
}

function idErrors(errors: string[], value: unknown): void {
  // Any string is accepted (including '' → the server generates an id).
  if (!absent(value) && !isString(value)) errors.push('id must be a string');
}

function stringListErrors(errors: string[], value: unknown, label: string): void {
  if (absent(value)) return;
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  value.forEach((item, i) => {
    if (!isString(item)) errors.push(`${label}[${i}] must be a string`);
  });
}

function painLogErrors(errors: string[], value: unknown): void {
  if (absent(value)) return;
  if (!Array.isArray(value)) {
    errors.push('painLog must be an array');
    return;
  }
  value.forEach((p, i) => {
    if (!isPlainObject(p)) {
      errors.push(`painLog[${i}] must be an object with ts and level`);
      return;
    }
    if (!isString(p.ts)) errors.push(`painLog[${i}].ts must be a string`);
    if (typeof p.level !== 'number' || !Number.isFinite(p.level)) {
      errors.push(`painLog[${i}].level must be a number`);
    }
  });
}

// Nullable tablet count. Absent/null = UNKNOWN (legacy rows and free-text
// doses keep meaning "unknown" — never zero, never inferred).
function quantityErrors(errors: string[], value: unknown): void {
  if (absent(value)) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    errors.push('quantity must be an integer >= 0 or null (unknown)');
  }
}

function attackItemErrors(a: Record<string, unknown>): string[] {
  const errors: string[] = [];
  idErrors(errors, a.id);
  if (!isString(a.start) || a.start === '') errors.push('start must be a non-empty string');
  if (!absent(a.end) && !isString(a.end)) errors.push('end must be a string or null');
  painLogErrors(errors, a.painLog);
  if (!absent(a.peakPain)) {
    if (typeof a.peakPain !== 'number' || !Number.isInteger(a.peakPain)
      || a.peakPain < -1 || a.peakPain > 10) {
      errors.push('peakPain must be an integer between -1 and 10');
    }
  }
  stringListErrors(errors, a.symptoms, 'symptoms');
  stringListErrors(errors, a.triggers, 'triggers');
  if (!absent(a.aura) && typeof a.aura !== 'boolean') {
    errors.push('aura must be a boolean or null');
  }
  if (!absent(a.notes) && !isString(a.notes)) errors.push('notes must be a string');
  if (!absent(a.source) && !isString(a.source)) errors.push('source must be a string');
  return errors;
}

function medItemErrors(m: Record<string, unknown>): string[] {
  const errors: string[] = [];
  idErrors(errors, m.id);
  // The bulk-import path allows medId: '' — the CSV importer can emit it for
  // custom non-Latin medication names, and the original import stored it.
  const emptyAllowed = m.medId === '';
  if (!emptyAllowed && (!isString(m.medId) || m.medId === '')) {
    errors.push('medId must be a non-empty string');
  }
  if (!absent(m.ts) && !isString(m.ts)) errors.push('ts must be a string');
  if (!absent(m.dose) && !isString(m.dose)) errors.push('dose must be a string');
  quantityErrors(errors, m.quantity);
  if (!absent(m.attackId) && !isString(m.attackId)) {
    errors.push('attackId must be a string or null');
  }
  if (!absent(m.notes) && !isString(m.notes)) errors.push('notes must be a string');
  if (!absent(m.source) && !isString(m.source)) errors.push('source must be a string');
  return errors;
}

function refillItemErrors(r: Record<string, unknown>): string[] {
  const errors: string[] = [];
  idErrors(errors, r.id);
  if (!isString(r.medId) || r.medId === '') errors.push('medId must be a non-empty string');
  if (!isString(r.date) || r.date === '') errors.push('date must be a non-empty string');
  quantityErrors(errors, r.quantity);
  if (!absent(r.notes) && !isString(r.notes)) errors.push('notes must be a string');
  if (!absent(r.source) && !isString(r.source)) errors.push('source must be a string');
  return errors;
}

const WORKOUT_KINDS = ['strength', 'cardio', 'mobility'];
const WORKOUT_EFFORTS = ['low', 'medium', 'hard'];

function workoutItemErrors(w: Record<string, unknown>): string[] {
  const errors: string[] = [];
  idErrors(errors, w.id);
  if (!isValidIsoInstant(w.performedAt)) errors.push(`performedAt ${INSTANT_MSG}`);
  if (!isString(w.kind) || !WORKOUT_KINDS.includes(w.kind)) {
    errors.push("kind must be 'strength', 'cardio', or 'mobility'");
  }
  if (!isString(w.effort) || !WORKOUT_EFFORTS.includes(w.effort)) {
    errors.push("effort must be 'low', 'medium', or 'hard'");
  }
  if (!absent(w.durationMinutes)) {
    if (typeof w.durationMinutes !== 'number' || !Number.isInteger(w.durationMinutes)
      || w.durationMinutes < 0) {
      errors.push('durationMinutes must be an integer >= 0 or null');
    }
  }
  if (!absent(w.notes) && !isString(w.notes)) errors.push('notes must be a string');
  if (!absent(w.source) && !isString(w.source)) errors.push('source must be a string');
  return errors;
}

const DAY_STATE_STATUSES = ['well', 'off', 'attack'];

function dayStateItemErrors(d: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isValidCalendarDay(d.day)) {
    errors.push('day must be a real calendar date in YYYY-MM-DD form');
  }
  if (!isString(d.status) || !DAY_STATE_STATUSES.includes(d.status)) {
    errors.push("status must be 'well', 'off', or 'attack'");
  }
  if (!absent(d.notes) && !isString(d.notes)) errors.push('notes must be a string');
  // Optional: the server mapper defaults an absent updatedAt to "now", but a
  // present value must be a real instant so ordering stays trustworthy.
  if (!absent(d.updatedAt) && !isValidIsoInstant(d.updatedAt)) {
    errors.push(`updatedAt ${INSTANT_MSG}, or be absent`);
  }
  return errors;
}

function baselineItemErrors(b: Record<string, unknown>): string[] {
  const errors: string[] = [];
  idErrors(errors, b.id);
  if (!isString(b.medId) || b.medId === '') errors.push('medId must be a non-empty string');
  if (!isValidIsoInstant(b.effectiveAt)) errors.push(`effectiveAt ${INSTANT_MSG}`);
  if (absent(b.quantity) || typeof b.quantity !== 'number'
    || !Number.isInteger(b.quantity) || b.quantity < 0) {
    errors.push('quantity must be an integer >= 0');
  }
  if (!absent(b.notes) && !isString(b.notes)) errors.push('notes must be a string');
  if (!absent(b.source) && !isString(b.source)) errors.push('source must be a string');
  if (!absent(b.createdAt) && !isValidIsoInstant(b.createdAt)) {
    errors.push(`createdAt ${INSTANT_MSG}, or be absent`);
  }
  return errors;
}

const RECORD_VALIDATORS: Record<
  BackupRecordKey,
  (item: Record<string, unknown>) => string[]
> = {
  attacks: attackItemErrors,
  meds: medItemErrors,
  refills: refillItemErrors,
  workouts: workoutItemErrors,
  dayStates: dayStateItemErrors,
  stockBaselines: baselineItemErrors,
};

// ── settings ──────────────────────────────────────────────────────────
type SettingsResult =
  | { ok: true; settings: BackupSettings; skipped: string[] }
  | { ok: false; error: string };

const isPositiveInteger = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1;

/**
 * `rules[med].limit` allows zero ("no allowed days"): PUT /api/settings/rules
 * stores the raw JSON and only the UI clamps input, so a real stored value of
 * 0 must stay restorable.
 */
const isNonNegativeInteger = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * A user-keyed lookup object (`rules`/`doses`/`planned`) entry name may not be
 * a reserved delivery/secret name: those are environment-only, so a backup
 * must not smuggle one into the settings table under a familiar key.
 */
function reservedEntryKeyError(label: string, entryKey: string): string | null {
  return isReservedBackupSettingsKey(entryKey)
    ? `${label} entry '${entryKey}' must not be a reserved secret name`
    : null;
}

/**
 * Per-key shape check; returns the reason or null when the value is usable.
 *
 * `rules`/`doses`/`planned` are lookup objects the UI owns rather than
 * versioned record types, but their VALUES still feed stock/usage arithmetic
 * and dated schedules after a restore, so they are validated strictly: a
 * malformed entry would otherwise be stored and then crash or silently
 * mis-render. Extra NON-reserved keys inside a `rules` entry are not validated
 * but are kept verbatim (mirrors the record tolerance), while a reserved
 * nested key fails the whole parse instead of being dropped.
 */
function settingValueError(key: string, value: unknown, label: string): string | null {
  if (key === 'rules') {
    if (!isPlainObject(value)) return `${label} must be an object`;
    for (const [entryKey, entry] of Object.entries(value)) {
      const reserved = reservedEntryKeyError(label, entryKey);
      if (reserved) return reserved;
      if (!isPlainObject(entry)) return `${label}[${entryKey}] must be an object`;
      for (const nestedKey of Object.keys(entry)) {
        if (isReservedBackupSettingsKey(nestedKey)) {
          return `${label} entry '${entryKey}' must not contain '${nestedKey}'`;
        }
      }
      if (!isNonNegativeInteger(entry.limit)) {
        return `${label}[${entryKey}].limit must be an integer >= 0`;
      }
      if (!isPositiveInteger(entry.windowDays)) {
        return `${label}[${entryKey}].windowDays must be an integer >= 1`;
      }
    }
    return null;
  }
  if (key === 'doses') {
    if (!isPlainObject(value)) return `${label} must be an object`;
    for (const [entryKey, entry] of Object.entries(value)) {
      const reserved = reservedEntryKeyError(label, entryKey);
      if (reserved) return reserved;
      if (!isString(entry)) return `${label}[${entryKey}] must be a string`;
    }
    return null;
  }
  if (key === 'planned') {
    if (!isPlainObject(value)) return `${label} must be an object`;
    for (const [entryKey, entry] of Object.entries(value)) {
      const reserved = reservedEntryKeyError(label, entryKey);
      if (reserved) return reserved;
      if (!isValidCalendarDay(entry)) return `${label}[${entryKey}] must be a YYYY-MM-DD date`;
    }
    return null;
  }
  if (key === 'timezone') {
    return isString(value) && isValidTimeZone(value)
      ? null : `${label} must be a valid IANA time zone`;
  }
  if (key === 'lowStockThreshold') {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? null : `${label} must be an integer >= 0`;
  }
  if (key === 'lowStockAlert') {
    if (!isPlainObject(value)) return `${label} must be an object`;
    // Fail closed on nested secret-looking keys for the same reason as the
    // top-level reserved check; other extra nested keys keep being dropped.
    for (const nestedKey of Object.keys(value)) {
      if (isReservedBackupSettingsKey(nestedKey)) {
        return `${label} must not contain '${nestedKey}'`;
      }
    }
    const latchedAt = value.latchedAt;
    return absent(latchedAt) || isValidIsoInstant(latchedAt)
      ? null : `${label}.latchedAt must be a full ISO 8601 instant or null`;
  }
  if (key === 'reminders') {
    // Strict shared shape first (rejects nested delivery secrets), then the
    // defensive normalizer the server scheduler also uses.
    const errors = reminderSettingsErrors(value);
    return errors.length ? `${label}: ${errors.join('; ')}` : null;
  }
  return null;
}

function assignSetting(out: BackupSettings, key: string, value: unknown): void {
  switch (key) {
    case 'rules':
      out.rules = value as Record<string, unknown>;
      break;
    case 'doses':
      out.doses = value as Record<string, unknown>;
      break;
    case 'planned':
      out.planned = value as Record<string, unknown>;
      break;
    case 'timezone':
      out.timezone = value as string;
      break;
    case 'lowStockThreshold':
      out.lowStockThreshold = value as number;
      break;
    case 'lowStockAlert': {
      // Only the known latch survives: any extra nested key is dropped instead
      // of being persisted into the settings table.
      const latchedAt = (value as Record<string, unknown>).latchedAt;
      out.lowStockAlert = { latchedAt: isString(latchedAt) ? latchedAt : null };
      break;
    }
    case 'reminders':
      out.reminders = normalizeReminderSettings(value);
      break;
    default:
      break;
  }
}

/** Envelope: the nested `settings` object. Unknown keys are counted, not stored. */
function collectEnvelopeSettings(raw: Record<string, unknown>): SettingsResult {
  const settings: BackupSettings = {};
  const skipped: string[] = [];
  for (const key of Object.keys(raw)) {
    // Fail closed: a backup carrying delivery credentials is not a backup of
    // user data, and silently dropping them would hide a leaked secret.
    if (isReservedBackupSettingsKey(key)) {
      return { ok: false, error: `backup settings must not contain '${key}'` };
    }
    if (!isRestorableSettingKey(key)) {
      skipped.push(key);
      continue;
    }
    const error = settingValueError(key, raw[key], key);
    if (error) return { ok: false, error };
    assignSetting(settings, key, raw[key]);
  }
  return { ok: true, settings, skipped };
}

/**
 * Browser export: settings are flattened TrackerState fields, and
 * `lowStockAlertedAt` maps onto the stored `lowStockAlert` object.
 */
function collectBrowserSettings(raw: Record<string, unknown>): SettingsResult {
  const settings: BackupSettings = {};
  const skipped: string[] = [];
  for (const key of Object.keys(raw)) {
    if ((RECORD_KEYS as readonly string[]).includes(key) || key === 'seeded') continue;
    if (isReservedBackupSettingsKey(key)) {
      return { ok: false, error: `backup settings must not contain '${key}'` };
    }
    if (key === 'lowStockAlertedAt') {
      // Same latch rule as envelope `settings.lowStockAlert.latchedAt`: the
      // flattened browser field maps onto that stored value, so it must be a
      // real instant (or null) or the settings table would hold a timestamp
      // the UI cannot compare.
      const latchedAt = raw[key];
      if (!absent(latchedAt) && !isValidIsoInstant(latchedAt)) {
        return { ok: false, error: 'lowStockAlertedAt must be a full ISO 8601 instant or null' };
      }
      settings.lowStockAlert = { latchedAt: isString(latchedAt) ? latchedAt : null };
      continue;
    }
    if (!isRestorableSettingKey(key)) {
      // Any other top-level field of a browser state is an unknown (newer)
      // setting this build deliberately does not restore.
      skipped.push(key);
      continue;
    }
    const error = settingValueError(key, raw[key], key);
    if (error) return { ok: false, error };
    assignSetting(settings, key, raw[key]);
  }
  return { ok: true, settings, skipped };
}

// ── parse ─────────────────────────────────────────────────────────────
const fail = (error: string): BackupParseResult => ({ ok: false, error });

export function parseBackup(json: unknown): BackupParseResult {
  if (!isPlainObject(json)) return fail('backup must be a JSON object');

  const isEnvelope = ENVELOPE_KEYS.some((key) => hasOwn(json, key));
  const isBrowser = BROWSER_KEYS.some((key) => hasOwn(json, key));
  // `{}` (and any unrelated object) is invalid on purpose: an empty restore
  // body must never be read as "wipe everything".
  if (!isEnvelope && !isBrowser) return fail('unrecognized backup format');
  const format: ParsedBackup['format'] = isEnvelope ? 'envelope' : 'browser';

  let schemaVersion: number | null = null;
  const rawSchemaVersion = json.schemaVersion;
  if (rawSchemaVersion !== undefined && rawSchemaVersion !== null) {
    // Mirrors /api/import: legacy absence and explicit null are tolerated,
    // every known integer version is accepted, and anything else (including a
    // version written by a newer build) is rejected rather than down-converted.
    if (!Number.isInteger(rawSchemaVersion)
      || (rawSchemaVersion as number) < 1
      || (rawSchemaVersion as number) > MAX_BACKUP_SCHEMA_VERSION) {
      return fail(
        'unsupported schemaVersion: expected an integer between 1 and '
        + `${MAX_BACKUP_SCHEMA_VERSION} (or absent/null for legacy payloads), got `
        + `${JSON.stringify(rawSchemaVersion)}`,
      );
    }
    schemaVersion = rawSchemaVersion as number;
  }

  const exportedAt = format === 'envelope' && isString(json.exportedAt)
    ? json.exportedAt : null;
  const seeded = format === 'browser' && typeof json.seeded === 'boolean'
    ? json.seeded : null;

  const duplicateCounts: Record<BackupRecordKey, number> = {
    attacks: 0, meds: 0, refills: 0, workouts: 0, dayStates: 0, stockBaselines: 0,
  };
  const records: Record<BackupRecordKey, Record<string, unknown>[]> = {
    attacks: [], meds: [], refills: [], workouts: [], dayStates: [], stockBaselines: [],
  };

  for (const key of RECORD_KEYS) {
    const value = json[key];
    // Absent arrays are optional (legacy backups predate workouts/day states);
    // an explicit null is a present non-array value and fails, like /api/import.
    if (value !== undefined && !Array.isArray(value)) {
      return fail(`${key} must be an array`);
    }
    const items: unknown[] = value ?? [];
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!isPlainObject(item)) return fail(`${key}[${i}] must be an object`);
      const errors = RECORD_VALIDATORS[key](item);
      if (errors.length) return fail(`${key}[${i}]: ${errors.join('; ')}`);
      // Duplicate keys: record ids only when explicitly present and non-empty
      // (the server generates ids for blank ones), day states by `day`.
      const duplicateKey = key === 'dayStates'
        ? (isString(item.day) ? item.day : null)
        : (isString(item.id) && item.id !== '' ? item.id : null);
      if (duplicateKey !== null) {
        if (seen.has(duplicateKey)) {
          // Keep-first: later duplicates are dropped and counted, never
          // repaired. parseBackup itself does not fail — merge skips them and
          // the replace route turns a non-zero count into a 400.
          duplicateCounts[key] += 1;
          continue;
        }
        seen.add(duplicateKey);
      }
      records[key].push(item);
    }
  }

  let settingsResult: SettingsResult;
  if (format === 'envelope') {
    const rawSettings = json.settings;
    if (absent(rawSettings)) {
      settingsResult = { ok: true, settings: {}, skipped: [] };
    } else if (!isPlainObject(rawSettings)) {
      return fail('settings must be an object');
    } else {
      settingsResult = collectEnvelopeSettings(rawSettings);
    }
  } else {
    settingsResult = collectBrowserSettings(json);
  }
  if (!settingsResult.ok) return fail(settingsResult.error);

  return {
    ok: true,
    backup: {
      format,
      schemaVersion,
      exportedAt,
      // The validated items keep their original (extra) fields: the server
      // mappers own defaults, so the parser never rewrites record content.
      attacks: records.attacks as unknown as Attack[],
      meds: records.meds as unknown as MedEvent[],
      refills: records.refills as unknown as Refill[],
      workouts: records.workouts as unknown as Workout[],
      dayStates: records.dayStates as unknown as DayState[],
      stockBaselines: records.stockBaselines as unknown as StockBaseline[],
      settings: settingsResult.settings,
      skippedSettingKeys: settingsResult.skipped,
      seeded,
      duplicateCounts,
    },
  };
}
