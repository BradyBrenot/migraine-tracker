/**
 * Shared date/time helpers for day-key based calendar logic.
 *
 * Conventions:
 * - A `DayKey` is a local calendar day, 'YYYY-MM-DD', in some IANA zone.
 * - All epoch values are milliseconds since the Unix epoch (UTC).
 *
 * This module MUST stay erasable-syntax only (no enums, namespaces, parameter
 * properties, or other code-emitting TypeScript constructs) and
 * double-environment safe: it is bundled by Vite for the browser and also
 * consumed directly by Node 24 via native type-stripping. Relative imports
 * need explicit `.ts` extensions, and only APIs present in BOTH environments
 * (Date, Math, Intl, Map) may be used — no DOM APIs.
 */

export type DayKey = string; // 'YYYY-MM-DD' local calendar day

interface ParsedDayKey {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
}

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_OF_DAY_PATTERN = /^(\d{2}):(\d{2})$/;

/** 'en-CA' formats ISO-like y/m/d parts; we still reassemble manually. */
const dayKeyFormatterCache = new Map<string, Intl.DateTimeFormat>();
/** Full date-time formatter used to derive per-zone UTC offsets. */
const zoneOffsetFormatterCache = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock formatter used to resolve local HH:MM times to instants. */
const wallClockFormatterCache = new Map<string, Intl.DateTimeFormat>();
/** Full wall-clock formatter used to derive local day/time fields. */
const wallDateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

/** True iff `tz` is a time-zone id `Intl.DateTimeFormat` accepts. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * IANA id of the host system's time zone, falling back to 'UTC' when the
 * platform reports nothing (or throws).
 */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function parseDayKey(key: DayKey): ParsedDayKey {
  const match = DAY_KEY_PATTERN.exec(key);
  if (!match) {
    throw new RangeError(`Invalid day key: "${key}" (expected 'YYYY-MM-DD')`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * True iff `key` is a real local calendar day in 'YYYY-MM-DD' form. String
 * arithmetic elsewhere deliberately stays cheap, so date validity belongs
 * here where user-supplied planned dates/imported day states are checked.
 */
export function isValidDayKey(key: string): boolean {
  if (typeof key !== 'string' || !DAY_KEY_PATTERN.test(key)) return false;
  const { year, month, day } = parseDayKey(key);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year
    && d.getUTCMonth() === month - 1
    && d.getUTCDate() === day;
}

function parseTimeOfDay(time: string): { hour: number; minute: number } {
  const match = typeof time === 'string' ? TIME_OF_DAY_PATTERN.exec(time) : null;
  if (!match) throw new RangeError(`Invalid time of day: "${time}" (expected 'HH:MM')`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new RangeError(`Invalid time of day: "${time}" (expected 'HH:MM')`);
  }
  return { hour, minute };
}

function getFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let fmt = cache.get(timeZone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat(locale, { timeZone, ...options });
    cache.set(timeZone, fmt);
  }
  return fmt;
}

/** Numeric calendar fields (year/month/day/hour/...) of an instant in a zone. */
function zonedFields(fmt: Intl.DateTimeFormat, instantMs: number): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const part of fmt.formatToParts(instantMs)) {
    fields[part.type] = Number(part.value);
  }
  return fields;
}

/**
 * Local calendar day ('YYYY-MM-DD') for an epoch-ms instant, in the given
 * IANA zone or the system zone when omitted. Deliberately never uses
 * `toISOString().slice(0, 10)`, which would be the UTC day, not the local one.
 * An invalid `timeZone` lets Intl throw (RangeError) by design.
 */
export function localDayKey(instantMs: number, timeZone?: string): DayKey {
  const zone = timeZone ?? systemTimeZone();
  const fmt = getFormatter(dayKeyFormatterCache, 'en-CA', zone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const f = zonedFields(fmt, instantMs);
  return `${pad2(f.year)}-${pad2(f.month)}-${pad2(f.day)}`;
}

/**
 * Epoch ms of the local midnight that starts `key`.
 *
 * With an explicit zone this uses the standard offset-guess algorithm: guess
 * UTC midnight, sample the zone offset there, apply it, then re-sample at the
 * result and apply once more (the second pass resolves boundaries where the
 * first guess lands past a DST transition). `hourCycle: 'h23'` is required —
 * `hour12: false` can yield hour '24' in some engines. Throws `RangeError` on
 * keys not matching 'YYYY-MM-DD'.
 */
export function dayKeyStartMs(key: DayKey, timeZone?: string): number {
  const { year, month, day } = parseDayKey(key);
  if (timeZone === undefined) {
    return new Date(year, month - 1, day).getTime();
  }
  const guess = Date.UTC(year, month - 1, day);
  const firstPass = guess - zoneOffsetMs(timeZone, guess);
  return guess - zoneOffsetMs(timeZone, firstPass);
}

/** Zone offset (ms) in effect at `instantMs`: zoned wall time minus instant. */
function zoneOffsetMs(timeZone: string, instantMs: number): number {
  const fmt = getFormatter(zoneOffsetFormatterCache, 'en-US', timeZone, {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const f = zonedFields(fmt, instantMs);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - instantMs;
}

/**
 * Local wall-clock minute of day (0..1439) for an instant in `timeZone`.
 * This is the canonical input for waking-window checks; a repeated hour
 * during a fall-back transition simply appears twice, as the user sees it.
 */
export function localMinuteOfDay(instantMs: number, timeZone?: string): number {
  const zone = timeZone ?? systemTimeZone();
  const fmt = getFormatter(wallClockFormatterCache, 'en-US', zone, {
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  });
  const f = zonedFields(fmt, instantMs);
  return f.hour * 60 + f.minute;
}

/** Wall-clock fields of an instant as a UTC-epoch-like millisecond value. */
function wallTimeMsAt(timeZone: string, instantMs: number): number {
  const fmt = getFormatter(wallDateTimeFormatterCache, 'en-US', timeZone, {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const f = zonedFields(fmt, instantMs);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
}

/**
 * Epoch ms of a local `dayKey` at `time` ('HH:MM') in `timeZone`.
 *
 * DST contract (documented, tested, and relied on by reminders):
 * - Ambiguous fall-back times resolve to the FIRST occurrence (earlier
 *   instant), matching how a person experiences the clock before it repeats.
 * - Nonexistent spring-forward times shift forward by the size of the gap
 *   (e.g. 02:30 in America/New_York becomes 03:30 local, not 01:30).
 * Throws RangeError for malformed day/time or an unknown IANA zone.
 */
export function zonedDateTimeToMs(
  dayKey: DayKey,
  time: string,
  timeZone: string,
): number {
  if (!isValidDayKey(dayKey)) {
    throw new RangeError(`Invalid day key: "${dayKey}" (expected a real 'YYYY-MM-DD')`);
  }
  const { hour, minute } = parseTimeOfDay(time);
  const { year, month, day } = parseDayKey(dayKey);
  const targetWall = Date.UTC(year, month - 1, day, hour, minute);

  // Sampling 26 hours either side straddles any offset change near the target
  // without a long scan. Each candidate is then verified by formatting it
  // back and comparing the wall-clock fields.
  const offsets = new Set<number>([
    zoneOffsetMs(timeZone, targetWall - 26 * 3600000),
    zoneOffsetMs(timeZone, targetWall),
    zoneOffsetMs(timeZone, targetWall + 26 * 3600000),
  ]);
  let first: number | null = null;
  for (const offset of offsets) {
    const candidate = targetWall - offset;
    if (wallTimeMsAt(timeZone, candidate) !== targetWall) continue;
    if (first === null || candidate < first) first = candidate;
  }
  if (first !== null) return first;

  // No valid candidate: a spring-forward gap. Apply the pre-gap offset so the
  // result is the same wall time plus the gap length (first valid time after
  // the skipped interval), never a time before it.
  return targetWall - zoneOffsetMs(timeZone, targetWall - 26 * 3600000);
}

/**
 * Calendar-day arithmetic on the key string. Parses, moves through UTC noon
 * (so DST can never skip or repeat the day), and formats back. Throws
 * `RangeError` on malformed keys.
 */
export function addDays(key: DayKey, n: number): DayKey {
  const { year, month, day } = parseDayKey(key);
  const ts = Date.UTC(year, month - 1, day, 12) + n * 86400000;
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * First day of the month containing `key` ('YYYY-MM-DD' -> 'YYYY-MM-01').
 * Plain string slicing: cheap and total, like the rest of the day-key surface.
 */
export function monthStartKey(key: DayKey): DayKey {
  return `${key.slice(0, 7)}-01`;
}

/**
 * Calendar-month arithmetic on a day key, returning the first day of the
 * target month: never fixed 86400000 ms across a month, and the UTC-noon
 * anchor keeps it DST-independent. Throws `RangeError` on malformed keys.
 */
export function addMonths(key: DayKey, n: number): DayKey {
  const { year, month } = parseDayKey(key);
  const d = new Date(Date.UTC(year, month - 1 + n, 1, 12));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`;
}

/**
 * Whole calendar-day difference `later - earlier` between two day keys.
 *
 * Both keys are parsed and resolved to UTC noon before subtracting. Noon keeps
 * the arithmetic timezone-free and DST-independent: a UTC calendar date can
 * never be skipped or repeated by an offset change, so the result is always a
 * whole number of days regardless of the local zone's transitions. The result
 * is negative when `later` precedes `earlier` (never clamped). Throws
 * `RangeError` on malformed keys, consistent with `parseDayKey`.
 */
export function diffDayKeys(later: DayKey, earlier: DayKey): number {
  const l = parseDayKey(later);
  const e = parseDayKey(earlier);
  const laterMs = Date.UTC(l.year, l.month - 1, l.day, 12);
  const earlierMs = Date.UTC(e.year, e.month - 1, e.day, 12);
  return (laterMs - earlierMs) / 86400000;
}

/** Day of week of `key`: 0=Sunday..6=Saturday. Throws on malformed keys. */
export function weekdayOf(key: DayKey): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

/**
 * The Sunday on-or-before `key`: the identity key of the Sunday-start week
 * containing it. Pure string/UTC arithmetic, so DST is irrelevant.
 */
export function sundayWeekStart(key: DayKey): DayKey {
  return addDays(key, -weekdayOf(key));
}

/** True iff `a` and `b` belong to the same Sunday-start week. */
export function sameSundayWeek(a: DayKey, b: DayKey): boolean {
  return sundayWeekStart(a) === sundayWeekStart(b);
}

/**
 * Epoch-ms half-open bounds [startMs, endMs) of the Sunday-start week
 * containing `key`. The length is NOT always 604800000 ms — weeks that
 * contain a DST transition are an hour shorter or longer. That is intentional
 * and must not be "fixed": bounds must align with local midnights.
 */
export function sundayWeekBounds(
  key: DayKey,
  timeZone?: string,
): { startMs: number; endMs: number } {
  const start = sundayWeekStart(key);
  return {
    startMs: dayKeyStartMs(start, timeZone),
    endMs: dayKeyStartMs(addDays(start, 7), timeZone),
  };
}
