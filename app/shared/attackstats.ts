/**
 * Shared attack-time statistics: parsed instants, local calendar days covered
 * by an attack, half-open range overlap, and the single duration definition
 * used by averages.
 *
 * Conventions (see `datetime.ts` for the day-key machinery):
 * - An attack is the half-open interval `[startMs, endMs)`. An attack ending
 *   exactly at local midnight therefore does NOT count the new day, and an
 *   attack ending exactly at a range start does not overlap that range.
 * - A degenerate attack (`endMs <= startMs`, or an unparseable end) counts its
 *   start day only. It is never dropped from counts and never produces a
 *   negative duration; negative durations are simply not averaged.
 * - Days are enumerated with calendar arithmetic (`addDays`), never by
 *   stepping epoch ms by 86400000, so DST transitions cannot skip or repeat a
 *   day.
 *
 * This module MUST stay erasable-syntax only (no enums, namespaces, parameter
 * properties) and double-environment safe: it is bundled by Vite for the
 * browser and consumed directly by Node 24 via native type-stripping. Relative
 * imports need explicit `.ts` extensions, and only APIs present in BOTH
 * environments (Date, Math, Intl, Map, Set) may be used — no DOM APIs.
 */

import {
  addDays, diffDayKeys, localDayKey, type DayKey,
} from './datetime.ts';

/** Parsed instants of one attack. `null` means missing/unparseable. */
export interface AttackTimes {
  /** Parsed start instant, or null when the start string is unusable. */
  startMs: number | null;
  /** Parsed end instant, `nowMs` while ongoing, or null when unusable. */
  endMs: number | null;
  /**
   * True when the attack has no end (`attack.end === null`). `endMs` is then
   * the reference `nowMs`, which is right for day/overlap purposes but is NOT
   * a finished duration — `validDurationMs` excludes ongoing attacks.
   */
  ongoing: boolean;
}

/**
 * Safety cap for day enumeration. Real attacks span days, not centuries; a
 * garbage timestamp must not make report generation allocate forever.
 */
const MAX_ENUMERATED_DAYS = 100000;

/** Day keys produced by `localDayKey` for the normal 4-digit-year domain. */
const ISO_DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The largest magnitude `Date`/`Intl` can format (ECMAScript time value). */
const MAX_DATE_MS = 8.64e15;

/** True when `ms` is a finite instant Intl can format without throwing. */
function isFormattableInstant(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;
}

/**
 * Parse an attack's `start`/`end` strings into epoch ms.
 *
 * - `end === null` means ongoing: `endMs` becomes `nowMs`, `ongoing` is true,
 *   and the attack is excluded from duration averages.
 * - An unparseable start yields `{ startMs: null, endMs: null, ongoing }`
 *   (nothing about the attack is usable, so no day can be attributed).
 * - An unparseable end string keeps the start and reports `endMs: null`; the
 *   attack then behaves as degenerate (start day only).
 */
export function parseAttackTimes(
  attack: { start: string; end: string | null },
  nowMs: number,
): AttackTimes {
  const startMs = Date.parse(attack.start);
  if (!Number.isFinite(startMs)) {
    return { startMs: null, endMs: null, ongoing: attack.end === null };
  }
  if (attack.end === null) return { startMs, endMs: nowMs, ongoing: true };
  const endMs = Date.parse(attack.end);
  return { startMs, endMs: Number.isFinite(endMs) ? endMs : null, ongoing: false };
}

/**
 * Local calendar days covered by `[startMs, endMs)` in `timeZone`, ascending,
 * with no duplicates.
 *
 * Half-open: an end exactly at local midnight ends the previous day and does
 * NOT include the new one. Degenerate intervals (zero duration, negative
 * duration, or a null/unparseable end) cover exactly the start day.
 * `startMs === null` yields `[]`.
 */
export function attackDayKeys(
  startMs: number | null,
  endMs: number | null,
  timeZone: string,
): DayKey[] {
  if (startMs === null || !isFormattableInstant(startMs)) return [];
  const first = localDayKey(startMs, timeZone);
  if (endMs === null || endMs <= startMs) {
    return [first];
  }
  // An end past the formatable Date range cannot be bucketed; keep the start.
  if (!isFormattableInstant(endMs - 1)) return [first];
  // `endMs - 1` makes a midnight end belong to the day that just finished.
  const last = localDayKey(endMs - 1, timeZone);
  // Pathological instants (e.g. year 275760, still parseable but outside the
  // 4-digit day-key domain) cannot be walked: degrade to the start day rather
  // than throwing inside report generation.
  if (!ISO_DAY_KEY.test(first) || !ISO_DAY_KEY.test(last)) return [first];
  const total = diffDayKeys(last, first);
  if (!Number.isFinite(total) || total < 0) return [first];
  const count = Math.min(total + 1, MAX_ENUMERATED_DAYS);
  const days: DayKey[] = [];
  for (let i = 0; i < count; i++) days.push(addDays(first, i));
  return days;
}

/**
 * Attack day keys clipped to one calendar month (`monthKey` is 'YYYY-MM').
 * Days of a multi-day attack that fall in other months are excluded, so
 * summing per-month counts never double-counts a day.
 */
export function attackDayKeysInMonth(
  startMs: number | null,
  endMs: number | null,
  monthKey: string,
  timeZone: string,
): DayKey[] {
  return attackDayKeys(startMs, endMs, timeZone)
    .filter((key) => key.slice(0, 7) === monthKey);
}

/**
 * True iff the attack intersects the half-open range `[rangeStartMs, rangeEndMs)`.
 *
 * Normal attacks use strict half-open overlap: an attack ending exactly at the
 * range start or starting exactly at the range end does not count. Degenerate
 * attacks (zero/negative duration, missing end) are reduced to their start
 * instant and count when that instant falls inside the range.
 */
export function attackOverlapsRange(
  startMs: number | null,
  endMs: number | null,
  rangeStartMs: number,
  rangeEndMs: number,
): boolean {
  if (startMs === null || !Number.isFinite(startMs)) return false;
  if (endMs === null || !Number.isFinite(endMs) || endMs <= startMs) {
    return startMs >= rangeStartMs && startMs < rangeEndMs;
  }
  return startMs < rangeEndMs && endMs > rangeStartMs;
}

/**
 * Duration in ms usable for averages: null when ongoing, unparseable, or
 * negative (end before start); `0` for a zero-duration attack; otherwise the
 * positive elapsed time. This is the ONLY duration definition reports may
 * average.
 */
export function validDurationMs(times: AttackTimes): number | null {
  const { startMs, endMs, ongoing } = times;
  if (ongoing) return null;
  if (startMs === null || endMs === null) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return endMs >= startMs ? endMs - startMs : null;
}
