/**
 * Shared attack-time statistics: parsed instants, local calendar days that
 * count as attack/migraine days, half-open range overlap, and the single
 * duration definition used by averages.
 *
 * Conventions (see `datetime.ts` for the day-key machinery):
 * - An attack is the half-open interval `[startMs, endMs)`. An attack ending
 *   exactly at a range start does not overlap that range.
 * - A local migraine day runs from 08:00 to 08:00 the next day; a day counts
 *   when the attack overlaps that window (`attackCountsAsAttackDay`). A night
 *   attack that ended while the user slept (e.g. 22:00 -> 06:00) therefore does
 *   NOT mark the following day, while an early-morning attack (e.g. 01:00-02:00
 *   on Nov 2) counts the PREVIOUS day (Nov 1). An attack crossing 08:00 counts
 *   both adjacent days.
 * - A degenerate attack (`endMs <= startMs`, or an unparseable end) is reduced
 *   to its start instant, so the same pre-/post-08:00 attribution applies.
 *   It never produces a negative duration; negative durations are not averaged.
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
  addDays, diffDayKeys, isValidDayKey, localDayKey, localMinuteOfDay,
  zonedDateTimeToMs, type DayKey,
} from './datetime.ts';

/**
 * Parsed instants of one attack, with `nowMs` already substituted for an
 * ongoing end. Produced ONLY by `parseAttackTimes`; do not build this shape
 * from `parseAttackInterval` (whose ongoing `endMs` is deliberately null).
 */
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
 * Parsed interval BEFORE any clock substitution. This is intentionally a
 * different type from `AttackTimes`: an ongoing attack has `endMs: null` and
 * `ongoing: true`, never `endMs: nowMs`. Consumers must combine it with a
 * reference instant before duration/day/overlap queries.
 *
 * `ongoing` is the raw `attack.end === null` flag. An unparseable end on a
 * finished attack keeps `ongoing: false` with `endMs: null`, so it degrades
 * to the start instant exactly like `parseAttackTimes`.
 */
export interface AttackInterval {
  startMs: number | null;
  endMs: number | null;
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

/**
 * Fixed product rule: a local migraine day runs from 08:00 to 08:00 the next
 * day. A day counts when an attack overlaps that window.
 *
 * This attributes a migraine that occurs only in the early morning (e.g.
 * 01:00-02:00 on Nov 2) to the PREVIOUS day (Nov 1), so it never silently
 * disappears. A migraine that ended before 08:00 no longer marks the following
 * day, and an attack that crosses 08:00 can count both adjacent days.
 *
 * Independent of the reminder `wakingStart` time — it is a hard-coded reporting
 * rule, not a user setting.
 *
 * KEEP IN SYNC: `ATTACK_DAY_START_TIME` feeds `zonedDateTimeToMs`, while
 * `ATTACK_DAY_START_MINUTE` is the cheap local-wall-clock comparison.
 */
export const ATTACK_DAY_START_TIME = '08:00';
export const ATTACK_DAY_START_MINUTE = 8 * 60;

/** True when `ms` is a finite instant Intl can format without throwing. */
function isFormattableInstant(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;
}

/**
 * The only valid 4-digit day key whose next day leaves the day-key domain.
 * Keeping this as an explicit constant lets the hot predicate preserve the
 * documented fail-open without paying `addDays` on every far-away attack.
 * If the day-key domain ever widens, this must be revisited together with
 * `attackCountsAsAttackDay`'s `nextKey` guard.
 */
const LAST_REPRESENTABLE_DAY_KEY: DayKey = '9999-12-31';

/**
 * Cheap, Intl-free UTC bounds that contain a local day's 08:00-to-08:00
 * window for any real IANA offset.
 *
 * The true window is within ±16h of UTC midnight historically (modern offsets
 * are -12h..+14h, historical LMT within ±16h). `[utcStart - 24h,
 * utcStart + 72h]` therefore contains it with ample margin, and an attack
 * outside these bounds cannot overlap the exact window. The exact
 * `zonedDateTimeToMs` bounds still decide every coarse hit.
 */
function coarseDayWindowMs(dayKey: DayKey): { startMs: number; endMs: number } {
  // `dayKey` is ISO-shaped here; Date.UTC arithmetic is deliberately used
  // instead of dayKeyStartMs (which would resolve the zone via Intl).
  const utcStart = Date.UTC(
    Number(dayKey.slice(0, 4)),
    Number(dayKey.slice(5, 7)) - 1,
    Number(dayKey.slice(8, 10)),
  );
  return {
    startMs: utcStart - 24 * 3600000,
    endMs: utcStart + 72 * 3600000,
  };
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
export function parseAttackInterval(
  attack: { start: string; end: string | null },
): AttackInterval {
  const startMs = Date.parse(attack.start);
  if (!Number.isFinite(startMs)) {
    // Nothing about the interval is usable. Preserve the raw ongoing flag,
    // but never substitute a clock instant (this type has no `nowMs`).
    return { startMs: null, endMs: null, ongoing: attack.end === null };
  }
  if (attack.end === null) return { startMs, endMs: null, ongoing: true };
  const endMs = Date.parse(attack.end);
  return { startMs, endMs: Number.isFinite(endMs) ? endMs : null, ongoing: false };
}

/**
 * Parse an attack's `start`/`end` strings into epoch ms with `nowMs`
 * substituted for an ongoing end.
 *
 * - `end === null` means ongoing: `endMs` becomes `nowMs`, `ongoing` is true,
 *   and the attack is excluded from duration averages.
 * - An unparseable start yields `{ startMs: null, endMs: null, ongoing }`
 *   (nothing about the attack is usable, so no day can be attributed). An
 *   ongoing attack with an unparseable start still reports `endMs: null`, not
 *   `nowMs`, matching the historical contract.
 * - An unparseable end string keeps the start and reports `endMs: null`; the
 *   attack then behaves as degenerate (start day only).
 */
export function parseAttackTimes(
  attack: { start: string; end: string | null },
  nowMs: number,
): AttackTimes {
  const { startMs, endMs, ongoing } = parseAttackInterval(attack);
  if (startMs === null) return { startMs: null, endMs: null, ongoing };
  if (ongoing) return { startMs, endMs: nowMs, ongoing: true };
  return { startMs, endMs, ongoing: false };
}

/**
 * True iff `[startMs, endMs)` counts as an attack/migraine day on `dayKey`
 * (see `ATTACK_DAY_START_TIME`): the attack must overlap the half-open local
 * window `[08:00 on dayKey, 08:00 on the next local day)`.
 *
 * - False for a missing/unformattable start or a non-ISO `dayKey`; this helper
 *   never throws, even for garbage keys.
 * - A day at the edge of the 4-digit key domain (e.g. '9999-12-31', whose next
 *   key is '10000-01-01') has no representable next window end, so it degrades
 *   by keeping the day rather than throwing. This is an accepted fail-open: the
 *   interval is not checked on that final representable day.
 * - Half-open inheritance comes from `attackOverlapsRange`: an attack ending
 *   exactly at 08:00 counts the PREVIOUS day, not the day whose window starts
 *   there, and degenerate/negative/unparseable-end attacks are reduced to their
 *   start instant. An ongoing attack uses the caller's `endMs` (which
 *   `parseAttackTimes` sets to `nowMs`).
 * - PERFORMANCE: an Intl-free coarse window rejects attacks far from `dayKey`
 *   before resolving the two 08:00 boundaries. This matters for callers that
 *   scan all history on a timer (Home/PartnerHome); it only skips work, never
 *   changes a hit. `timeZone` is therefore only resolved/validated when the
 *   attack falls inside the coarse bounds.
 */
export function attackCountsAsAttackDay(
  startMs: number | null,
  endMs: number | null,
  dayKey: DayKey,
  timeZone: string,
): boolean {
  if (startMs === null || !isFormattableInstant(startMs)) return false;
  if (!ISO_DAY_KEY.test(dayKey)) return false;
  // Preserve the documented fail-open at the edge of the key domain BEFORE the
  // coarse filter, so a far-away attack on that day still returns true.
  if (dayKey === LAST_REPRESENTABLE_DAY_KEY) return true;
  // Cheap early exit before isValidDayKey/addDays/Intl. An ISO-shaped but
  // impossible date (e.g. '2026-02-30') may pass or fail this coarse test, but
  // is rejected by isValidDayKey immediately afterwards.
  const coarse = coarseDayWindowMs(dayKey);
  if (!attackOverlapsRange(startMs, endMs, coarse.startMs, coarse.endMs)) return false;
  // Guard before the day-key helpers, which throw on malformed keys.
  if (!isValidDayKey(dayKey)) return false;
  const nextKey = addDays(dayKey, 1);
  // Defensive: a future key-domain change could add another edge day.
  if (!ISO_DAY_KEY.test(nextKey)) return true;
  const windowStartMs = zonedDateTimeToMs(dayKey, ATTACK_DAY_START_TIME, timeZone);
  const windowEndMs = zonedDateTimeToMs(nextKey, ATTACK_DAY_START_TIME, timeZone);
  if (windowStartMs >= windowEndMs) return false;
  return attackOverlapsRange(startMs, endMs, windowStartMs, windowEndMs);
}

/**
 * Local calendar days of `[startMs, endMs)` in `timeZone` that count as
 * attack/migraine days, ascending, with no duplicates.
 *
 * A day is the local window `[08:00, 08:00 the next day)`. This is NOT "every
 * day the attack touches":
 * - an attack starting before 08:00 also counts the PREVIOUS day (e.g.
 *   01:00-02:00 on Nov 2 counts Nov 1);
 * - an attack that ended before 08:00 does not mark the following day;
 * - an attack crossing 08:00 counts both adjacent days.
 *
 * - Half-open: an attack ending exactly at 08:00 counts the previous day, not
 *   the day whose window starts at 08:00.
 * - Degenerate intervals (zero duration, negative duration, or a
 *   null/unparseable end) are reduced to their start instant, so they use the
 *   same pre-/post-08:00 attribution.
 * - `startMs === null` yields `[]`.
 * - Pathological instants outside the 4-digit day-key domain degrade to the
 *   start day instead of throwing inside report generation.
 */
export function attackDayKeys(
  startMs: number | null,
  endMs: number | null,
  timeZone: string,
): DayKey[] {
  if (startMs === null || !isFormattableInstant(startMs)) return [];
  const first = localDayKey(startMs, timeZone);
  // Pathological starts outside the 4-digit key domain cannot be evaluated by
  // the date helpers, so they keep the historical start-day fallback.
  if (!ISO_DAY_KEY.test(first)) return [first];

  // A start before 08:00 local also overlaps the previous day's window.
  const previous = localMinuteOfDay(startMs, timeZone) < ATTACK_DAY_START_MINUTE
    ? addDays(first, -1)
    : null;

  let covered: DayKey[];
  if (endMs === null || endMs <= startMs) {
    covered = [first];
  } else if (!isFormattableInstant(endMs - 1)) {
    // The attack continues past the formattable Date range; the start day is
    // certainly inside its own 08:00-to-08:00 window.
    covered = [first];
  } else {
    // `endMs - 1` makes a midnight end belong to the day that just finished.
    const last = localDayKey(endMs - 1, timeZone);
    if (!ISO_DAY_KEY.test(last)) {
      // Pathological end outside the 4-digit day-key domain: keep the start
      // day, but still fall through so a pre-08:00 start keeps its previous day.
      covered = [first];
    } else {
      const total = diffDayKeys(last, first);
      if (!Number.isFinite(total) || total < 0) {
        covered = [first];
      } else {
        const count = Math.min(total + 1, MAX_ENUMERATED_DAYS);
        covered = [];
        for (let i = 0; i < count; i++) covered.push(addDays(first, i));
      }
    }
  }

  const out: DayKey[] = [];
  if (previous !== null && ISO_DAY_KEY.test(previous)) out.push(previous);
  if (covered.length === 1) {
    if (attackCountsAsAttackDay(startMs, endMs, covered[0], timeZone)) {
      out.push(covered[0]);
    }
    return out;
  }
  // A multi-day attack always overlaps the 08:00-to-08:00 window of its first
  // day and every full middle day. Only the last (possibly pre-08:00 tail) day
  // needs the predicate. Historical whole-day-skips (e.g. Pacific/Apia
  // 2011-12-30) are an accepted exception: a nonexistent middle key can survive
  // because it is not re-tested.
  out.push(...covered.slice(0, -1));
  const lastDay = covered[covered.length - 1];
  if (attackCountsAsAttackDay(startMs, endMs, lastDay, timeZone)) out.push(lastDay);
  return out;
}

/**
 * Attack day keys (08:00 rule) clipped to one calendar month (`monthKey` is
 * 'YYYY-MM'). Days of a multi-day attack that fall in other months are
 * excluded, so summing per-month counts never double-counts a day.
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
