import {
  addDays, dayKeyStartMs, diffDayKeys, localDayKey, type DayKey,
} from '../../shared/datetime.ts';

/**
 * Minimum on-screen width of an attack bar, in week-column units (7 columns =
 * one week). Short attacks would otherwise be invisible.
 */
export const MIN_BAR_WIDTH_DAYS = 0.18;

/** Position of one attack bar inside a rendered week. */
export interface WeekBarGeometry {
  /** Left edge in week-column units (0 = Monday 00:00 local, 7 = next Monday). */
  from: number;
  /** Right edge in week-column units, always `>= from`. */
  to: number;
  /** The attack started before this week. */
  continuesLeft: boolean;
  /** The attack ends after this week. */
  continuesRight: boolean;
}

export interface WeekBarInput {
  startMs: number;
  endMs: number;
  /** Monday-first week start day key (grid column 0). */
  weekStartKey: DayKey;
  /** Day key exactly 7 local days after `weekStartKey`. */
  weekEndKey: DayKey;
  timeZone: string;
  /** Override for tests; defaults to `MIN_BAR_WIDTH_DAYS`. */
  minWidth?: number;
}

/**
 * Position an attack inside a week of seven equal-width local-day columns.
 *
 * Unlike a fixed `86400000` normalization, each day's fraction comes from the
 * real configured-zone midnights, so a 23h/25h DST day still fills exactly one
 * column.
 *
 * The minimum-width padding is clamped to the attack's START day: it may never
 * make a same-day bar spill into the next local day (the Oct 13 3h-bar bug).
 * When the natural end already crosses midnight the bar keeps its true
 * geometry — only the padding is forbidden from inventing a crossing.
 */
export function weekBarGeometry({
  startMs, endMs, weekStartKey, weekEndKey, timeZone, minWidth = MIN_BAR_WIDTH_DAYS,
}: WeekBarInput): WeekBarGeometry {
  const weekStartMs = dayKeyStartMs(weekStartKey, timeZone);
  const weekEndMs = dayKeyStartMs(weekEndKey, timeZone);
  const totalDays = diffDayKeys(weekEndKey, weekStartKey);

  /** Fractional column position of an instant, clamped to the week. */
  const position = (ms: number): number => {
    if (ms <= weekStartMs) return 0;
    if (ms >= weekEndMs) return totalDays;
    const key = localDayKey(ms, timeZone);
    const dayIndex = diffDayKeys(key, weekStartKey);
    const dayStart = dayKeyStartMs(key, timeZone);
    const dayEnd = dayKeyStartMs(addDays(key, 1), timeZone);
    const dayLength = dayEnd - dayStart;
    const fraction = dayLength > 0 ? (ms - dayStart) / dayLength : 0;
    return dayIndex + fraction;
  };

  // Degenerate attacks (zero/negative duration, unparseable end already
  // collapsed by the caller) render at their start instant, never backwards.
  const barStartMs = Math.min(startMs, weekEndMs);
  const barEndMs = Math.max(barStartMs, Math.min(endMs, weekEndMs));
  const startDayKey = localDayKey(
    Math.min(Math.max(barStartMs, weekStartMs), weekEndMs - 1),
    timeZone,
  );
  const startDayIndex = diffDayKeys(startDayKey, weekStartKey);
  const startDayEnd = Math.min(startDayIndex + 1, totalDays);

  let from = position(barStartMs);
  let to = position(barEndMs);

  // Only pad a bar that stays inside its start day. A real cross-midnight
  // attack is allowed to cross; padding an attack is not.
  const crossesIntoNextDay = barEndMs > barStartMs && position(barEndMs) > startDayEnd;
  if (!crossesIntoNextDay && to - from < minWidth) {
    to = Math.min(from + minWidth, startDayEnd);
    // Floating-point slack: an exact fit must not trigger the backwards pull.
    if (to - from < minWidth - 1e-9) {
      // Very late start: grow backwards so the whole bar stays in the day.
      from = Math.max(startDayIndex, to - minWidth);
    }
  }

  return {
    from,
    to,
    continuesLeft: startMs < weekStartMs,
    continuesRight: endMs > weekEndMs,
  };
}
