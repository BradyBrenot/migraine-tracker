import { useState } from 'react';
import { toast } from 'sonner';
import { useStore } from '@/lib/store';
import { useNow } from '@/lib/clock';
import { localDayKey } from '../../shared/datetime.ts';
import {
  WEEKLY_STRENGTH_GOAL, WEEKLY_CARDIO_GOAL, countWorkoutsInWeek, weekGoalStatus,
} from '../../shared/workouts.ts';
import type { WorkoutEffort, WorkoutKind } from '@/types';

const QUICK_KINDS: { kind: WorkoutKind; label: string }[] = [
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

/** Two-tap exercise logging: kind, then effort. Nothing else required. */
export default function WorkoutQuickLog() {
  const store = useStore();
  const { state } = store;
  const now = useNow();
  const todayKey = localDayKey(now, state.timezone);

  const [pendingKind, setPendingKind] = useState<WorkoutKind | null>(null);
  const counts = countWorkoutsInWeek(state.workouts, todayKey, state.timezone);
  const goals = weekGoalStatus(counts);

  function log(effort: WorkoutEffort) {
    if (pendingKind === null) return;
    const kind = pendingKind;
    const workout = store.addWorkout({ kind, effort });
    setPendingKind(null);
    toast.success(`${KIND_LABEL[kind]} logged`, {
      action: { label: 'Undo', onClick: () => store.deleteWorkout(workout.id) },
    });
  }

  return (
    <div className="space-y-1.5">
      {pendingKind !== null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {KIND_LABEL[pendingKind]} effort
          </span>
          {EFFORTS.map(({ effort, label }) => (
            <button
              key={effort}
              type="button"
              onClick={() => log(effort)}
              className="rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors active:scale-95 border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500"
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPendingKind(null)}
            className="rounded-lg px-2 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-slate-200"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          {QUICK_KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              onClick={() => setPendingKind(kind)}
              className="rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors active:scale-95 border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500"
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <p className="text-xs tabular-nums text-slate-400">
        This week: Strength{' '}
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
