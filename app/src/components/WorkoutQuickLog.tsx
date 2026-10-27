import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from '@/lib/store';
import { useNow } from '@/lib/clock';
import { addDays, dayKeyStartMs, localDayKey } from '../../shared/datetime.ts';
import {
  WEEKLY_STRENGTH_GOAL, WEEKLY_CARDIO_GOAL, countWorkoutsInWeek, weekGoalStatus,
  workoutInstantMs,
} from '../../shared/workouts.ts';
import type { Workout, WorkoutEffort, WorkoutKind } from '@/types';

type QuickKind = 'strength' | 'cardio';

const QUICK_KINDS: { kind: QuickKind; label: string }[] = [
  { kind: 'strength', label: 'Strength' },
  { kind: 'cardio', label: 'Cardio' },
];

const EFFORTS: { effort: WorkoutEffort; label: string }[] = [
  { effort: 'low', label: 'Low' },
  { effort: 'medium', label: 'Medium' },
  { effort: 'hard', label: 'Hard' },
];

const KIND_LABEL: Record<WorkoutKind, string> = {
  strength: 'Strength',
  cardio: 'Cardio',
  mobility: 'Mobility',
};

const EFFORT_LABEL: Record<WorkoutEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  hard: 'Hard',
};

/** Effort ordering: only a strictly higher rank may replace today's record. */
const EFFORT_RANK: Record<WorkoutEffort, number> = { low: 0, medium: 1, hard: 2 };

/**
 * Deterministic "current" record for one kind within one configured local day.
 *
 * Duplicate policy (existing/imported duplicates are NEVER deleted or merged by
 * the UI — only the current record is displayed and updated):
 *   1. highest effort wins (low < medium < hard);
 *   2. tie -> latest valid `performedAt` instant wins;
 *   3. final tie -> the later position in `state.workouts` wins (the store keeps
 *      that array sorted by `performedAt` ascending, so this is a stable
 *      last-writer choice).
 * Records with an unparseable `performedAt`, or outside [dayStartMs, dayEndMs),
 * never qualify as today's record.
 */
function currentRecordForDay(
  workouts: readonly Workout[],
  kind: QuickKind,
  dayStartMs: number,
  dayEndMs: number,
): Workout | null {
  let current: Workout | null = null;
  let currentRank = -1;
  let currentInstant = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < workouts.length; index += 1) {
    const workout = workouts[index];
    if (workout.kind !== kind) continue;
    const instant = workoutInstantMs(workout.performedAt);
    if (instant === null || instant < dayStartMs || instant >= dayEndMs) continue;
    const rank = EFFORT_RANK[workout.effort];
    // `>=` on the instant keeps the later array position for exact ties, since
    // this loop walks the array forwards.
    if (rank > currentRank || (rank === currentRank && instant >= currentInstant)) {
      current = workout;
      currentRank = rank;
      currentInstant = instant;
    }
  }
  return current;
}

/**
 * Two-tap exercise logging: kind, then effort. Nothing else required. One
 * Strength and one Cardio are allowed per configured local day: an equal or
 * lower effort is refused with feedback, a strictly higher effort updates the
 * existing record in place, and Undo after an upgrade restores the previous
 * effort (it never deletes the session). The weekly tallies share the button
 * row (wrapping below it on very narrow screens) and stay visible while an
 * effort is being chosen; "This week" stays available to assistive tech and as
 * a tooltip so the compact line keeps its meaning. Mobility is counted
 * separately and never satisfies either goal.
 */
export default function WorkoutQuickLog() {
  const store = useStore();
  const { state } = store;
  const now = useNow();
  const todayKey = localDayKey(now, state.timezone);
  const dayStartMs = dayKeyStartMs(todayKey, state.timezone);
  const dayEndMs = dayKeyStartMs(addDays(todayKey, 1), state.timezone);

  const [pendingKind, setPendingKind] = useState<QuickKind | null>(null);
  const counts = countWorkoutsInWeek(state.workouts, todayKey, state.timezone);
  const goals = weekGoalStatus(counts);
  const todayByKind = useMemo(
    () => ({
      strength: currentRecordForDay(state.workouts, 'strength', dayStartMs, dayEndMs),
      cardio: currentRecordForDay(state.workouts, 'cardio', dayStartMs, dayEndMs),
    }),
    [state.workouts, dayStartMs, dayEndMs],
  );

  function log(effort: WorkoutEffort) {
    if (pendingKind === null) return;
    const kind = pendingKind;
    const label = KIND_LABEL[kind];
    const current = todayByKind[kind];
    setPendingKind(null);

    // No record for this kind today: the original add flow, unchanged.
    if (current === null) {
      const workout = store.addWorkout({ kind, effort });
      toast.success(`${label} logged`, {
        action: { label: 'Undo', onClick: () => store.deleteWorkout(workout.id) },
      });
      return;
    }

    // Strictly higher effort: patch only the effort so the id, performedAt,
    // notes and duration survive. Undo restores the previous effort.
    if (EFFORT_RANK[effort] > EFFORT_RANK[current.effort]) {
      const previousEffort = current.effort;
      store.updateWorkout(current.id, { effort });
      toast.success(`${label} effort updated to ${EFFORT_LABEL[effort]}`, {
        description: `Was ${EFFORT_LABEL[previousEffort]}.`,
        action: {
          label: 'Undo',
          onClick: () => store.updateWorkout(current.id, { effort: previousEffort }),
        },
      });
      return;
    }

    // Equal or lower effort: a no-op with clear, non-destructive feedback.
    // No store call, no POST/PATCH, and no Undo (nothing changed).
    toast.warning(`${label} · ${EFFORT_LABEL[current.effort]} kept`, {
      description: "Only a higher effort replaces today's session.",
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {pendingKind !== null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            {KIND_LABEL[pendingKind]} effort
          </span>
          {EFFORTS.map(({ effort, label }) => (
            <button
              key={effort}
              type="button"
              aria-pressed={todayByKind[pendingKind]?.effort === effort}
              onClick={() => log(effort)}
              className={`min-h-11 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors active:scale-95 sm:min-h-10 border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500 ${
                todayByKind[pendingKind]?.effort === effort ? 'ring-1 ring-emerald-600' : ''
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPendingKind(null)}
            className="min-h-11 rounded-lg px-2 text-xs font-medium text-slate-400 transition-colors hover:text-slate-200 sm:min-h-8"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          {QUICK_KINDS.map(({ kind, label }) => {
            const current = todayByKind[kind];
            return (
              <button
                key={kind}
                type="button"
                onClick={() => setPendingKind(kind)}
                title={
                  current
                    ? `${label} logged today: ${EFFORT_LABEL[current.effort]} — tap to log a higher effort`
                    : undefined
                }
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors active:scale-95 border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500 sm:min-h-10"
              >
                {label}
                {current && (
                  <span className="rounded-full bg-emerald-950 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
                    {EFFORT_LABEL[current.effort]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <p
        className="ml-auto text-[11px] tabular-nums text-slate-400"
        title="This week's goal progress (weeks start Sunday)"
      >
        <span className="sr-only">This week: </span>
        Strength{' '}
        <span className={goals.strengthMet ? 'font-semibold text-emerald-400' : 'text-slate-300'}>
          {counts.strength}/{WEEKLY_STRENGTH_GOAL}
        </span>
        {' · '}Cardio{' '}
        <span className={goals.cardioMet ? 'font-semibold text-emerald-400' : 'text-slate-300'}>
          {counts.cardio}/{WEEKLY_CARDIO_GOAL}
        </span>
        {counts.mobility > 0 && (
          <>
            {' · '}Mobility <span className="text-slate-300">{counts.mobility}</span>
          </>
        )}
      </p>
    </div>
  );
}
