/**
 * Derived status document for the read-only `GET /api/status` endpoint
 * (contract: `docs/plans/2026-11-11-home-assistant-integration.md`,
 * handoff: `docs/home-assistant.md`).
 *
 * This module is a PROJECTION, not a second source of truth: it derives
 * everything from the same rows and the same pure rules the app already uses
 * (`attackstats.ts` for the 08:00-to-08:00 attack-day rule, `daystate.ts` for
 * explicit-record precedence, `inventory.ts` for the Nurtec classification).
 * Home Assistant must never have to reimplement those rules.
 *
 * Contract highlights enforced here:
 * - every instant in the document is a canonical `Date#toISOString()` value or
 *   null; raw stored strings stay on `GET /api/attacks`;
 * - `state` is `attack` | `off` | `well` | `no_data` (never `unknown`, which
 *   Home Assistant reserves for a missing entity state);
 * - `activeAttack` is the only activeness signal (`end === null`), so a legacy
 *   explicit `day_states.status = 'attack'` can yield `state: 'attack'` with
 *   `activeAttack: null`;
 * - a stored row can NEVER make the endpoint throw: unparseable and
 *   parseable-but-out-of-domain instants degrade to nulls/absent counts, and
 *   every day-key consumer is guarded.
 *
 * This module MUST stay erasable-syntax only (no enums, namespaces, parameter
 * properties) and double-environment safe: it is bundled by Vite for the
 * browser and consumed directly by Node 24 via native type-stripping. Relative
 * imports need explicit `.ts` extensions, only `import type` may reference
 * `src/` (the Docker runtime copies `shared/` but not `src/`), and only APIs
 * present in BOTH environments (Date, Math, Intl, Map, Set) may be used — no
 * DOM APIs.
 */

import type { DayStateStatus } from '../src/types/index.ts';
import { attackCountsAsAttackDay, parseAttackTimes, type AttackTimes } from './attackstats.ts';
import { effectiveDayState } from './daystate.ts';
import { addDays, diffDayKeys, isValidDayKey, isValidTimeZone, localDayKey } from './datetime.ts';
import { classifyStock, DEFAULT_LOW_STOCK_THRESHOLD, type StockLevel } from './inventory.ts';

/** Contract version of the `GET /api/status` document. Bump on breaking changes. */
export const STATUS_API_VERSION = 1;

/** Display state. `no_data` (not `unknown`) is the "nothing recorded" value. */
export type StatusState = 'attack' | 'off' | 'well' | 'no_data';

/** Where `today.status` came from. */
export type StatusDaySource = 'explicit' | 'inferred' | 'none';

/** Stored/effective day status; `attack` is a legacy explicit value only. */
export type StatusDayStatus = DayStateStatus;

/** Minimal attack row shape this builder reads; unknown extra fields are ignored. */
export interface StatusAttack {
  id: string;
  start: string;
  end: string | null;
  /** Cached peak pain 0-10; -1 (or anything else) means "not recorded". */
  peakPain?: number | null;
  /** Pain check-ins; malformed entries are ignored. */
  painLog?: ReadonlyArray<{ ts: string; level: number }> | null;
  aura?: boolean | null;
}

/** One explicit day record; only `day` and a known `status` are used. */
export interface StatusDayState {
  day: string;
  status: string;
}

/**
 * The Nurtec aggregate computed by the server (`computeNurtecStock`). Only the
 * quantity and threshold are read; `status`/`level`/`low`/`negative` are
 * re-derived with the shared helpers so the status document can never
 * contradict `GET /api/inventory/nurtec`.
 */
export interface StatusNurtecInput {
  quantity?: number | null;
  threshold?: number;
}

export interface StatusActiveAttack {
  id: string;
  /** Normalized stored start, or null when the stored start is unparseable. */
  start: string | null;
  /** 0-10, or null when unknown (stored -1) or invalid. */
  peakPain: number | null;
  /** Pain entry with the greatest parsed `ts`; ties keep the later array element. */
  latestPain: { ts: string; level: number } | null;
  aura: boolean | null;
}

export interface StatusLastAttack {
  id: string;
  /** Normalized start; always parseable because `lastAttack` requires one. */
  start: string;
  /** Normalized end; null when ongoing or when the stored end is unusable. */
  end: string | null;
  /** Stored `end === null` (an empty-string end is NOT ongoing). */
  ongoing: boolean;
  durationMinutes: number | null;
  peakPain: number | null;
}

export interface StatusToday {
  /** Today's local day in the document `timeZone`. */
  day: string;
  status: StatusDayStatus | null;
  source: StatusDaySource;
}

export interface StatusHistory {
  daysSinceLastAttackStart: number | null;
  attacksStartedLast30Days: number;
  attackDaysLast7Days: number;
  attackDaysLast30Days: number;
}

export interface StatusNurtecStock {
  status: 'known' | 'unknown';
  quantity: number | null;
  level: StockLevel;
  low: boolean;
  negative: boolean;
  threshold: number;
}

export interface StatusDocument {
  apiVersion: number;
  generatedAt: string;
  timeZone: string;
  state: StatusState;
  activeAttack: StatusActiveAttack | null;
  today: StatusToday;
  lastAttack: StatusLastAttack | null;
  history: StatusHistory;
  inventory: { nurtec: StatusNurtecStock };
}

export interface StatusInput {
  /** One captured clock read for `generatedAt`, `today`, history, and inventory. */
  nowMs: number;
  /** Configured IANA zone; missing/invalid falls back to `UTC`. */
  timeZone: string;
  attacks?: ReadonlyArray<StatusAttack> | null;
  dayStates?: ReadonlyArray<StatusDayState> | null;
  nurtec?: StatusNurtecInput | null;
}

/** Day keys produced by `localDayKey` for the normal 4-digit-year domain. */
const ISO_DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The largest magnitude `Date`/`Intl` can format (ECMAScript time value). */
const MAX_DATE_MS = 8.64e15;

/** True for the three statuses the API has ever stored. */
function isDayStatus(value: unknown): value is DayStateStatus {
  return value === 'well' || value === 'off' || value === 'attack';
}

/** Parsed instant of a stored string, or null when unusable. */
function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Canonical UTC ISO string for a used instant, or null. */
function canonicalInstant(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  return new Date(ms).toISOString();
}

/** Canonical normalized form of a stored instant string, or null. */
function normalizeInstant(value: unknown): string | null {
  return canonicalInstant(parseInstant(value));
}

/** Cached peak pain: 0-10 passes through, everything else (incl. -1) is null. */
function normalizePeakPain(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10
    ? value
    : null;
}

/** Stored aura: only a real boolean is reported. */
function normalizeAura(value: unknown): boolean | null {
  return value === true || value === false ? value : null;
}

/**
 * Local day key of an instant, or null when the instant cannot be formatted or
 * the resulting key leaves the 4-digit day-key domain (e.g. the parseable
 * `+275760-09-13T00:00:00.000Z`). Guards every day-key consumer below.
 */
function safeLocalDayKey(instantMs: number, timeZone: string): string | null {
  if (!Number.isFinite(instantMs) || Math.abs(instantMs) > MAX_DATE_MS) return null;
  let key: string;
  try {
    key = localDayKey(instantMs, timeZone);
  } catch {
    return null;
  }
  return isRepresentableDayKey(key) ? key : null;
}

/** True for a real, 4-digit calendar day key. */
function isRepresentableDayKey(key: string): boolean {
  return ISO_DAY_KEY.test(key) && isValidDayKey(key);
}

/** Today's local day key as text; never throws (real clocks stay 4-digit). */
function localDayKeyText(instantMs: number, timeZone: string): string {
  try {
    return localDayKey(instantMs, timeZone);
  } catch {
    return '1970-01-01';
  }
}

/** Canonical ordering: parsed start ascending, then id ascending. */
function compareAttacks(a: OrderedAttack, b: OrderedAttack): number {
  if (a.startMs === null && b.startMs === null) return compareIds(a.attack.id, b.attack.id);
  if (a.startMs === null) return 1; // unparseable starts sort last
  if (b.startMs === null) return -1;
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  return compareIds(a.attack.id, b.attack.id);
}

function compareIds(a: unknown, b: unknown): number {
  const left = typeof a === 'string' ? a : '';
  const right = typeof b === 'string' ? b : '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

interface OrderedAttack {
  attack: StatusAttack;
  startMs: number | null;
  times: AttackTimes;
}

/**
 * Parse one attack's interval with `nowMs` substituted for an ongoing end,
 * tolerating non-string legacy values without ever throwing.
 */
function attackTimes(attack: StatusAttack, nowMs: number): AttackTimes {
  const start = typeof attack.start === 'string' ? attack.start : '';
  const end = typeof attack.end === 'string' ? attack.end : '';
  // `end === null` is the ONLY ongoing marker (an empty string is a finished
  // attack with an unusable end, exactly like the shared parser).
  return parseAttackTimes({ start, end: attack.end === null ? null : end }, nowMs);
}

/** Greatest parsed pain-log instant; ties keep the later array element. */
function latestPainEntry(painLog: unknown): { ts: string; level: number } | null {
  if (!Array.isArray(painLog)) return null;
  let best: { ts: string; level: number } | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const entry of painLog) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { ts, level } = entry as { ts?: unknown; level?: unknown };
    if (typeof ts !== 'string' || typeof level !== 'number' || !Number.isFinite(level)) continue;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) continue;
    // `>=` (not `>`) deliberately keeps the later element on an exact tie.
    if (best === null || ms >= bestMs) {
      best = { ts: new Date(ms).toISOString(), level };
      bestMs = ms;
    }
  }
  return best;
}

function activeAttackOf(attack: StatusAttack): StatusActiveAttack {
  return {
    id: typeof attack.id === 'string' ? attack.id : '',
    start: normalizeInstant(attack.start),
    peakPain: normalizePeakPain(attack.peakPain),
    latestPain: latestPainEntry(attack.painLog),
    aura: normalizeAura(attack.aura),
  };
}

function lastAttackOf({ attack, startMs, times }: OrderedAttack): StatusLastAttack {
  // `startMs` is non-null by construction: only parseable starts are eligible.
  const parsedStart = startMs === null ? Number.NaN : startMs;
  const ongoing = attack.end === null;
  // `times.endMs` is `nowMs` while ongoing, so it is never a finished end.
  const endMs = ongoing ? null : times.endMs;
  // A parseable end is reported even when it precedes the start (a corrected
  // legacy row); only the duration is suppressed for a negative interval.
  return {
    id: typeof attack.id === 'string' ? attack.id : '',
    start: new Date(parsedStart).toISOString(),
    end: canonicalInstant(endMs),
    ongoing,
    durationMinutes: endMs !== null && endMs >= parsedStart
      ? Math.round((endMs - parsedStart) / 60000)
      : null,
    peakPain: normalizePeakPain(attack.peakPain),
  };
}

/** True when any attack overlaps `dayKey`'s 08:00-to-08:00 local window. */
function dayCountsAsAttackDay(timesList: AttackTimes[], dayKey: string, timeZone: string): boolean {
  for (const times of timesList) {
    if (attackCountsAsAttackDay(times.startMs, times.endMs, dayKey, timeZone)) return true;
  }
  return false;
}

/**
 * `count` local days ending at `todayKey`, newest first, with calendar
 * arithmetic (`addDays`), so DST transitions cannot skip or repeat a day.
 * Enumeration stops instead of throwing at the edge of the 4-digit key domain.
 */
function trailingDayKeys(todayKey: string, count: number): string[] {
  const keys: string[] = [];
  let key = todayKey;
  for (let i = 0; i < count; i++) {
    if (!isRepresentableDayKey(key)) break;
    keys.push(key);
    if (i === count - 1) break;
    try {
      key = addDays(key, -1);
    } catch {
      break;
    }
  }
  return keys;
}

function countAttackDays(timesList: AttackTimes[], dayKeys: string[], timeZone: string): number {
  let count = 0;
  for (const key of dayKeys) {
    if (dayCountsAsAttackDay(timesList, key, timeZone)) count++;
  }
  return count;
}

/** Attack records whose START local day is in the trailing `days` window. */
function countStartedAttacks(
  ordered: OrderedAttack[],
  todayKey: string,
  days: number,
  timeZone: string,
): number {
  let count = 0;
  for (const { startMs } of ordered) {
    if (startMs === null) continue;
    const startKey = safeLocalDayKey(startMs, timeZone);
    if (startKey === null) continue;
    const diff = diffDayKeys(todayKey, startKey);
    // Future starts produce a negative diff and are excluded.
    if (diff >= 0 && diff < days) count++;
  }
  return count;
}

function daysSinceStart(
  ordered: OrderedAttack[],
  lastIndex: number,
  todayKey: string | null,
  timeZone: string,
): number | null {
  if (lastIndex < 0 || todayKey === null) return null;
  const { startMs } = ordered[lastIndex];
  if (startMs === null) return null;
  const startKey = safeLocalDayKey(startMs, timeZone);
  if (startKey === null) return null;
  return Math.max(0, diffDayKeys(todayKey, startKey));
}

function nurtecStock(input: StatusNurtecInput | null | undefined): StatusNurtecStock {
  const rawQuantity = input?.quantity;
  const quantity = typeof rawQuantity === 'number' && Number.isFinite(rawQuantity)
    ? rawQuantity
    : null;
  const rawThreshold = input?.threshold;
  const threshold = typeof rawThreshold === 'number' && Number.isInteger(rawThreshold)
    && rawThreshold >= 0
    ? rawThreshold
    : DEFAULT_LOW_STOCK_THRESHOLD;
  // Derived, not copied: with the shared stock calculation `known` and a
  // usable quantity are the same condition, so the document can never claim a
  // count it does not have (or a negative/invalid one).
  const status = quantity === null ? 'unknown' : 'known';
  return {
    status,
    quantity,
    // Same shared classification the inventory route uses (negative > low).
    level: classifyStock(quantity, threshold),
    low: quantity !== null && quantity <= threshold,
    negative: quantity !== null && quantity < 0,
    threshold,
  };
}

/**
 * Build the apiVersion-1 status document. Pure: the caller supplies the single
 * `nowMs`, the effective `timeZone`, and the current rows/aggregates.
 */
export function buildStatus(input: StatusInput): StatusDocument {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const timeZone = typeof input.timeZone === 'string' && isValidTimeZone(input.timeZone)
    ? input.timeZone
    : 'UTC';
  const attacks = Array.isArray(input.attacks) ? input.attacks : [];
  const dayStates = Array.isArray(input.dayStates) ? input.dayStates : [];

  const ordered: OrderedAttack[] = attacks
    .map((attack) => ({
      attack,
      startMs: parseInstant(attack.start),
      times: attackTimes(attack, nowMs),
    }))
    .sort(compareAttacks);
  const timesList = ordered.map(({ times }) => times);

  // Ongoing = stored `end === null`. Multiple ongoing rows are reachable (the
  // writer offers "Log another attack"); the canonical order picks one.
  const activeIndex = ordered.findIndex(({ attack }) => attack.end === null);
  const activeAttack = activeIndex === -1 ? null : activeAttackOf(ordered[activeIndex].attack);

  // `lastAttack` is the last attack WITH a parseable start in canonical order,
  // ongoing or finished; null when no attack has a parseable start.
  let lastIndex = -1;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].startMs !== null) lastIndex = i;
  }
  const lastAttack = lastIndex === -1 ? null : lastAttackOf(ordered[lastIndex]);

  const todayDay = localDayKeyText(nowMs, timeZone);
  const todayKey = isRepresentableDayKey(todayDay) ? todayDay : null;

  let explicitRecord: { status: DayStateStatus } | null = null;
  if (todayKey !== null) {
    const record = dayStates.find((entry) => entry && entry.day === todayKey);
    // A damaged/imported unknown status is ignored rather than echoed: the
    // document only ever exposes well/off/attack/null.
    if (record && isDayStatus(record.status)) explicitRecord = { status: record.status };
  }

  const inferredAttackDay = todayKey !== null
    && dayCountsAsAttackDay(timesList, todayKey, timeZone);
  const todayStatus = effectiveDayState(explicitRecord, inferredAttackDay);
  const today: StatusToday = {
    day: todayDay,
    status: todayStatus,
    source: explicitRecord ? 'explicit' : inferredAttackDay ? 'inferred' : 'none',
  };

  const windowKeys = todayKey === null ? [] : trailingDayKeys(todayKey, 30);
  const attackDaysLast30Days = countAttackDays(timesList, windowKeys, timeZone);
  const attackDaysLast7Days = countAttackDays(timesList, windowKeys.slice(0, 7), timeZone);

  const history: StatusHistory = {
    daysSinceLastAttackStart: daysSinceStart(ordered, lastIndex, todayKey, timeZone),
    attacksStartedLast30Days: todayKey === null
      ? 0
      : countStartedAttacks(ordered, todayKey, 30, timeZone),
    attackDaysLast7Days,
    attackDaysLast30Days,
  };

  return {
    apiVersion: STATUS_API_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    timeZone,
    // `state` is a display convenience: `activeAttack` is the activeness signal.
    state: activeAttack !== null ? 'attack' : todayStatus ?? 'no_data',
    activeAttack,
    today,
    lastAttack,
    history,
    inventory: { nurtec: nurtecStock(input.nurtec) },
  };
}
