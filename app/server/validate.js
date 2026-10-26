// Small explicit payload validators for the existing write endpoints.
//
// Rules of thumb:
// - "Valid current frontend payloads" must pass: type checks follow
//   app/src/types/index.ts, plus the null/missing tolerance the original
//   server had (`x ?? default` also accepted JSON null).
// - Structured JSON columns (pain_log, symptoms, triggers) are protected:
//   non-arrays are rejected with 400 instead of being stringified into a
//   column that later fails to parse back into the documented shape.
// - Timestamp/date *formats* are not enforced on the legacy record types
//   (attacks, meds, refills): those payloads only ever promised strings, and
//   rejecting formats could break valid old data. Schema v2 records (workout
//   performedAt, imported day-state updatedAt) DO enforce full ISO instants —
//   see the "instants" section below.
// - Unknown keys are ignored (the original spread-into-mapper did the same).

import { SCHEMA_VERSION } from './migrations.js';

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v) => typeof v === 'string';
const isBoolean = (v) => typeof v === 'boolean';

// undefined/null are treated as "absent → default", matching `x ?? default`.
const absent = (v) => v === undefined || v === null;

function idErrors(errors, value) {
  // Any string is accepted (including '' → an id is generated); other
  // types would have been coerced/lost by the old mapper.
  if (!absent(value) && !isString(value)) errors.push('id must be a string');
}

function stringListErrors(errors, value, label) {
  if (absent(value)) return;
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  value.forEach((item, i) => {
    if (!isString(item)) errors.push(`${label}[${i}] must be a string`);
  });
}

function painLogErrors(errors, value) {
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

export function attackErrors(a, { partial = false } = {}) {
  const errors = [];
  // In patch (partial) mode, JSON key *presence* matters: an explicit null
  // must stay valid (the mapper's `x ?? default` then applies), while a
  // missing key keeps the stored value. JSON cannot carry undefined.
  const present = (k) => !partial || Object.hasOwn(a, k);

  idErrors(errors, a.id);

  if (present('start')) {
    if (!isString(a.start) || a.start === '') errors.push('start must be a non-empty string');
  } else if (!partial) {
    errors.push('start is required');
  }

  if (present('end') && !absent(a.end) && !isString(a.end)) {
    errors.push('end must be a string or null');
  }
  if (present('painLog')) painLogErrors(errors, a.painLog);
  if (present('peakPain')) {
    if (!absent(a.peakPain)) {
      if (typeof a.peakPain !== 'number' || !Number.isInteger(a.peakPain)
        || a.peakPain < -1 || a.peakPain > 10) {
        errors.push('peakPain must be an integer between -1 and 10');
      }
    }
  }
  if (present('symptoms')) stringListErrors(errors, a.symptoms, 'symptoms');
  if (present('triggers')) stringListErrors(errors, a.triggers, 'triggers');
  if (present('aura') && !absent(a.aura) && !isBoolean(a.aura)) {
    errors.push('aura must be a boolean or null');
  }
  if (present('notes') && !absent(a.notes) && !isString(a.notes)) {
    errors.push('notes must be a string');
  }
  if (present('source') && !absent(a.source) && !isString(a.source)) {
    errors.push('source must be a string');
  }
  return errors;
}

export function medErrors(m, { partial = false, allowEmptyMedId = false } = {}) {
  const errors = [];
  const present = (k) => !partial || Object.hasOwn(m, k);

  idErrors(errors, m.id);

  if (present('medId')) {
    // The bulk-import path allows medId: '' — the CSV importer can emit it
    // for custom non-Latin medication names, and the original import stored
    // it. Direct writes still require a usable key.
    const emptyAllowed = allowEmptyMedId && m.medId === '';
    if (!emptyAllowed && (!isString(m.medId) || m.medId === '')) {
      errors.push('medId must be a non-empty string');
    }
  } else if (!partial) {
    errors.push('medId is required');
  }

  if (present('ts') && !absent(m.ts) && !isString(m.ts)) errors.push('ts must be a string');
  if (present('dose') && !absent(m.dose) && !isString(m.dose)) errors.push('dose must be a string');
  if (present('quantity')) quantityErrors(errors, m.quantity);
  if (present('attackId') && !absent(m.attackId) && !isString(m.attackId)) {
    errors.push('attackId must be a string or null');
  }
  if (present('notes') && !absent(m.notes) && !isString(m.notes)) errors.push('notes must be a string');
  if (present('source') && !absent(m.source) && !isString(m.source)) errors.push('source must be a string');
  return errors;
}

// ── structured quantity (schema v3) ───────────────────────────────────
// Nullable tablet count. Absent/null = UNKNOWN (legacy rows and free-text
// doses keep meaning "unknown" — never zero, never inferred). An explicit
// number must be a whole nonnegative tablet count: halves or negatives
// would silently corrupt stock arithmetic.
const QUANTITY_MSG = 'quantity must be an integer >= 0 or null (unknown)';
export function quantityErrors(errors, value) {
  if (absent(value)) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    errors.push(QUANTITY_MSG);
  }
}

export function refillErrors(r, { partial = false } = {}) {
  const errors = [];
  const present = (k) => !partial || Object.hasOwn(r, k);

  idErrors(errors, r.id);

  if (present('medId')) {
    if (!isString(r.medId) || r.medId === '') errors.push('medId must be a non-empty string');
  } else if (!partial) {
    errors.push('medId is required');
  }

  if (present('date')) {
    if (!isString(r.date) || r.date === '') errors.push('date must be a non-empty string');
  } else if (!partial) {
    errors.push('date is required');
  }

  if (present('quantity')) quantityErrors(errors, r.quantity);
  if (present('notes') && !absent(r.notes) && !isString(r.notes)) errors.push('notes must be a string');
  if (present('source') && !absent(r.source) && !isString(r.source)) errors.push('source must be a string');
  return errors;
}

// ── stock baselines (schema v3) ───────────────────────────────────────
// Dated ABSOLUTE stock counts (initial stock + later corrections). Unlike
// the legacy record types, these are new-format records: effectiveAt must
// be a full ISO instant (ordering column, like workout performedAt) and
// quantity is a required nonnegative integer (NOT NULL column, so an
// explicit null is rejected in both POST and PATCH). createdAt is
// server-managed on the routes; the import path format-checks it when
// present and falls back to "now" otherwise.
export function baselineErrors(b, { partial = false } = {}) {
  const errors = [];
  const present = (k) => !partial || Object.hasOwn(b, k);

  idErrors(errors, b.id);

  if (present('medId')) {
    if (!isString(b.medId) || b.medId === '') errors.push('medId must be a non-empty string');
  } else if (!partial) {
    errors.push('medId is required');
  }

  if (present('effectiveAt')) {
    if (!isValidIsoInstant(b.effectiveAt)) {
      errors.push(`effectiveAt ${INSTANT_MSG}`);
    }
  } else if (!partial) {
    errors.push('effectiveAt is required');
  }

  if (present('quantity')) {
    if (absent(b.quantity) || typeof b.quantity !== 'number'
      || !Number.isInteger(b.quantity) || b.quantity < 0) {
      errors.push('quantity must be an integer >= 0');
    }
  } else if (!partial) {
    errors.push('quantity is required');
  }

  if (present('notes') && !absent(b.notes) && !isString(b.notes)) errors.push('notes must be a string');
  if (present('source') && !absent(b.source) && !isString(b.source)) errors.push('source must be a string');
  return errors;
}

// Frontend keys are rules/doses/planned/reminders; anything reasonably
// key-like is fine EXCEPT reserved environment-only/secret names. Comparison
// is case- and separator-insensitive so ntfyUrl / NTFY_URL / ntfy-token all
// fail closed, plus obvious token/secret/password names for defense in depth.
const SETTINGS_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const RESERVED_SETTINGS_PATTERNS = [
  /^ntfyurl$/, /^ntfytoken$/, /^publicappurl$/,
  /^ntfyattackurl$/, /^ntfyattacktoken$/,
  /ntfyurl/, /ntfytoken/, /publicappurl/,
  /ntfyattackurl/, /ntfyattacktoken/,
  /token/, /secret/, /password/, /passwd/, /apikey/, /authorization/,
  /bearer/, /credential/,
];

export function isReservedSettingsKey(key) {
  if (!isString(key)) return false;
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return RESERVED_SETTINGS_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isValidSettingsKey(key) {
  return isString(key) && SETTINGS_KEY.test(key) && !isReservedSettingsKey(key);
}

// ── workouts ──────────────────────────────────────────────────────────
const WORKOUT_KINDS = ['strength', 'cardio', 'mobility'];
const WORKOUT_EFFORTS = ['low', 'medium', 'hard'];

/**
 * Validates a workout payload. POST requires performedAt/kind/effort; PATCH
 * (partial) validates only supplied keys, so missing keys keep stored values.
 * performedAt/kind/effort are NOT NULL columns, so an explicit null is
 * rejected in both modes. performedAt must be a full ISO 8601 instant with an
 * explicit timezone (canonical `...sssZ` or an explicit offset); date-only,
 * timezone-less, and arbitrary strings are rejected so the ordering column
 * stays trustworthy. durationMinutes may be absent/null (cleared) or an
 * integer >= 0; non-integers and negatives are rejected instead of being
 * silently coerced.
 */
export function workoutErrors(w, { partial = false } = {}) {
  const errors = [];
  const present = (k) => !partial || Object.hasOwn(w, k);

  idErrors(errors, w.id);

  if (present('performedAt')) {
    if (!isValidIsoInstant(w.performedAt)) {
      errors.push(`performedAt ${INSTANT_MSG}`);
    }
  } else if (!partial) {
    errors.push('performedAt is required');
  }

  if (present('kind')) {
    if (!isString(w.kind) || !WORKOUT_KINDS.includes(w.kind)) {
      errors.push("kind must be 'strength', 'cardio', or 'mobility'");
    }
  } else if (!partial) {
    errors.push('kind is required');
  }

  if (present('effort')) {
    if (!isString(w.effort) || !WORKOUT_EFFORTS.includes(w.effort)) {
      errors.push("effort must be 'low', 'medium', or 'hard'");
    }
  } else if (!partial) {
    errors.push('effort is required');
  }

  if (present('durationMinutes') && !absent(w.durationMinutes)) {
    if (typeof w.durationMinutes !== 'number' || !Number.isInteger(w.durationMinutes)
      || w.durationMinutes < 0) {
      errors.push('durationMinutes must be an integer >= 0 or null');
    }
  }

  if (present('notes') && !absent(w.notes) && !isString(w.notes)) {
    errors.push('notes must be a string');
  }
  if (present('source') && !absent(w.source) && !isString(w.source)) {
    errors.push('source must be a string');
  }
  return errors;
}

// ── instants (schema v2 record types) ─────────────────────────────────
// Full ISO 8601 instant with an explicit timezone: date-only values,
// timezone-less local datetimes, and arbitrary strings are rejected, so a
// typo can never silently poison ordering/sorting columns. Canonical new
// records use `YYYY-MM-DDTHH:mm:ss.sssZ`; other legitimate backup forms with
// explicit offsets (±HH:MM, basic-format ±HHMM, optional fractional seconds,
// lowercase 't'/'z' per RFC 3339) stay importable.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * True when `value` is a string of the accepted grammar whose components
 * denote exactly one real, finite instant. Component ranges are checked
 * explicitly instead of relying on `new Date()`, whose fallback parser is
 * lenient beyond the spec. With the calendar date real and hour/minute/
 * second/offset all in range, the instant is always representable (JS Date
 * covers years ±275760), so no engine parsing is involved. Leap seconds
 * (`:60`) and hour 24 are rejected, matching what JS can parse back.
 * (Reuses isValidDay from the day-states section below; hoisted.)
 */
export function isValidIsoInstant(value) {
  if (!isString(value)) return false;
  const match = ISO_INSTANT.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi, s, , tz] = match;
  if (!isValidDay(`${y}-${mo}-${d}`)) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return false;
  if (tz[0] !== 'Z' && tz[0] !== 'z') {
    if (Number(tz.slice(1, 3)) > 23 || Number(tz.slice(-2)) > 59) return false;
  }
  return true;
}

const INSTANT_MSG = 'must be a full ISO 8601 instant with an explicit timezone (e.g. 2026-03-01T07:00:00.000Z)';

// ── day states ────────────────────────────────────────────────────────
const DAY_STATE_STATUSES = ['well', 'off', 'attack'];
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A real calendar date in 'YYYY-MM-DD' form. The round-trip check rejects
 * shapes the regex accepts but the calendar does not (2026-02-30, month 13,
 * month 00, day 00) instead of letting SQLite store a bogus primary key.
 */
export function isValidDay(value) {
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

/**
 * Validates a day-state body. `day` itself is the route/primary key and is
 * validated by the caller (isValidDay). status is required and case-sensitive
 * and may not be null (NOT NULL column); notes is optional and an explicit
 * null means "clear to ''".
 */
export function dayStateErrors(ds, { partial = false } = {}) {
  const errors = [];
  const present = (k) => !partial || Object.hasOwn(ds, k);

  if (present('status')) {
    if (!isString(ds.status) || !DAY_STATE_STATUSES.includes(ds.status)) {
      errors.push("status must be 'well', 'off', or 'attack'");
    }
  } else if (!partial) {
    errors.push('status is required');
  }

  if (present('notes') && !absent(ds.notes) && !isString(ds.notes)) {
    errors.push('notes must be a string');
  }
  return errors;
}

/**
 * Validates a bulk import body. Accepts legacy unversioned payloads
 * ({ attacks, meds, refills }, including backup-shaped envelopes with
 * exportedAt/settings), explicit null schemaVersion, and any integer
 * schemaVersion from 1 through SCHEMA_VERSION (older versions stay
 * importable). Non-integers and versions below 1 or above SCHEMA_VERSION
 * (written by a newer build) are rejected. Unknown keys (including
 * settings, which import has never restored) are ignored.
 * workouts/dayStates/stockBaselines are optional additive record types
 * (added in v2/v3); legacy payloads simply omit them. Records with absent
 * `quantity` (all pre-v3 meds/refills) stay valid and map to null.
 * Returns { ok: true, value } with the original item objects, or
 * { ok: false, error }.
 */
export function validateImportBody(body) {
  if (body === undefined || body === null) {
    return {
      ok: true,
      value: { attacks: [], meds: [], refills: [], workouts: [], dayStates: [], stockBaselines: [] },
    };
  }
  if (!isPlainObject(body)) return { ok: false, error: 'body must be a JSON object' };

  const { schemaVersion } = body;
  if (schemaVersion !== undefined && schemaVersion !== null) {
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > SCHEMA_VERSION) {
      return {
        ok: false,
        error: `unsupported schemaVersion: expected an integer between 1 and ${SCHEMA_VERSION} (or absent/null for legacy payloads), got ${JSON.stringify(schemaVersion)}`,
      };
    }
  }

  for (const key of ['attacks', 'meds', 'refills', 'workouts', 'dayStates', 'stockBaselines']) {
    if (body[key] !== undefined && !Array.isArray(body[key])) {
      return { ok: false, error: `${key} must be an array` };
    }
  }

  const validateItems = (key, validate) => {
    const items = body[key] ?? [];
    for (let i = 0; i < items.length; i++) {
      if (!isPlainObject(items[i])) return `${key}[${i}] must be an object`;
      const errors = validate(items[i]);
      if (errors.length) return `${key}[${i}]: ${errors.join('; ')}`;
    }
    return null;
  };
  // dayStates carry their primary key in the payload (unlike the PUT route,
  // where it comes from the URL), so the day itself is validated here.
  // updatedAt stays optional (the mapper defaults absent values to now, so
  // legacy/current payloads may omit it) but is format-checked when present.
  // The PUT route is deliberately untouched: it always generates updatedAt
  // server-side and ignores any client value.
  const dayStateItemErrors = (item) => [
    ...(isValidDay(item.day) ? [] : ['day must be a real calendar date in YYYY-MM-DD form']),
    ...dayStateErrors(item),
    ...(!absent(item.updatedAt) && !isValidIsoInstant(item.updatedAt)
      ? [`updatedAt ${INSTANT_MSG}, or be absent`]
      : []),
  ];
  // stockBaselines carry their whole primary key + createdAt in the payload:
  // effectiveAt must be a full instant (ordering column) and createdAt is
  // format-checked when present (the import mapper defaults it to now).
  const baselineItemErrors = (item) => [
    ...baselineErrors(item),
    ...(!absent(item.createdAt) && !isValidIsoInstant(item.createdAt)
      ? [`createdAt ${INSTANT_MSG}, or be absent`]
      : []),
  ];
  const itemError = validateItems('attacks', attackErrors)
    ?? validateItems('meds', (item) => medErrors(item, { allowEmptyMedId: true }))
    ?? validateItems('refills', refillErrors)
    ?? validateItems('workouts', workoutErrors)
    ?? validateItems('dayStates', dayStateItemErrors)
    ?? validateItems('stockBaselines', baselineItemErrors);
  if (itemError) return { ok: false, error: itemError };

  return {
    ok: true,
    value: {
      attacks: body.attacks ?? [],
      meds: body.meds ?? [],
      refills: body.refills ?? [],
      workouts: body.workouts ?? [],
      dayStates: body.dayStates ?? [],
      stockBaselines: body.stockBaselines ?? [],
    },
  };
}
