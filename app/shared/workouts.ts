/**
 * Weekly workout-goal helpers (Sunday–Saturday calendar weeks).
 *
 * Conventions:
 * - Weeks are the same Sunday-start weeks used by the calendar/day pages.
 * - Weekly strength/cardio goals count DISTINCT configured-local days per
 *   kind, at most one of each per local day. Duplicate rows (legacy imports,
 *   repeated History entries) therefore cannot inflate a goal, matching Home's
 *   one-highest-effort-session-per-day model. Historical records are never
 *   deleted or merged by this rule.
 * - `mobility` sessions are tracked separately, count individually, and NEVER
 *   satisfy the strength or cardio goals.
 * - Dirty timestamps must not crash reports: unparseable `performedAt` values
 *   are skipped rather than throwing.
 *
 * This module MUST stay erasable-syntax only (no enums, namespaces, parameter
 * properties, or other code-emitting TypeScript constructs) and
 * double-environment safe: it is bundled by Vite for the browser and also
 * consumed directly by Node 24 via native type-stripping. Relative imports
 * need explicit `.ts` extensions, and only APIs present in BOTH environments
 * (Date, Math, Intl, Map) may be used — no DOM APIs.
 */

import type { WorkoutKind } from '../src/types/index.ts';
import { localDayKey, sundayWeekBounds, type DayKey } from './datetime.ts';

/** Minimum distinct strength days per Sunday–Saturday week. */
export const WEEKLY_STRENGTH_GOAL = 2;
/** Minimum distinct cardio days per Sunday–Saturday week. */
export const WEEKLY_CARDIO_GOAL = 3;

export interface WorkoutWeekCounts {
  strength: number;
  cardio: number;
  mobility: number;
}

/**
 * Epoch ms of a workout's `performedAt`, or null when it cannot be parsed.
 * Defensive against dirty data: never throws, just reports "unknown".
 */
export function workoutInstantMs(performedAt: string): number | null {
  if (typeof performedAt !== 'string') return null;
  const ms = Date.parse(performedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Count workouts whose instant falls inside the Sunday-start week containing
 * `anyDayKey`, in `timeZone`. Week bounds are half-open [startMs, endMs) and
 * come from `sundayWeekBounds`, so DST-shortened/lengthened weeks stay aligned
 * with local midnights. Workouts with unparseable timestamps are skipped.
 *
 * Strength and cardio each contribute at most ONE count per configured-local
 * day, no matter how many same-kind rows share that day. That keeps duplicate
 * legacy/imported/History rows from inflating goals or wrongly suppressing
 * reminders without touching the records themselves. Mobility is unchanged:
 * every mobility session counts.
 */
export function countWorkoutsInWeek(
  workouts: { performedAt: string; kind: WorkoutKind }[],
  anyDayKey: DayKey,
  timeZone: string,
): WorkoutWeekCounts {
  const bounds = sundayWeekBounds(anyDayKey, timeZone);
  const counts: WorkoutWeekCounts = { strength: 0, cardio: 0, mobility: 0 };
  const goalDays: Record<'strength' | 'cardio', Set<DayKey>> = {
    strength: new Set<DayKey>(),
    cardio: new Set<DayKey>(),
  };
  for (const workout of workouts) {
    const instantMs = workoutInstantMs(workout.performedAt);
    if (instantMs === null) continue;
    if (instantMs < bounds.startMs || instantMs >= bounds.endMs) continue;
    // Unknown kinds are ignored rather than miscounted as strength/cardio.
    if (workout.kind === 'strength') goalDays.strength.add(localDayKey(instantMs, timeZone));
    else if (workout.kind === 'cardio') goalDays.cardio.add(localDayKey(instantMs, timeZone));
    else if (workout.kind === 'mobility') counts.mobility += 1;
  }
  counts.strength = goalDays.strength.size;
  counts.cardio = goalDays.cardio.size;
  return counts;
}

/** Whether the week met both goals; both are minimums, mobility never helps. */
export function weekGoalStatus(
  counts: WorkoutWeekCounts,
): { strengthMet: boolean; cardioMet: boolean } {
  return {
    strengthMet: counts.strength >= WEEKLY_STRENGTH_GOAL,
    cardioMet: counts.cardio >= WEEKLY_CARDIO_GOAL,
  };
}
