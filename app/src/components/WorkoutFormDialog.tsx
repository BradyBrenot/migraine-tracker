import { useEffect, useState, type ReactNode } from 'react';
import type { Workout, WorkoutEffort, WorkoutKind } from '@/types';
import { useStore } from '@/lib/store';
import { toLocalInput } from '@/lib/format';
import { localDayKey } from '../../shared/datetime.ts';
import { workoutInstantMs } from '../../shared/workouts.ts';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const PERFORMED_ID = 'workout-performed-at';
const DURATION_ID = 'workout-duration';
const DURATION_ERROR_ID = 'workout-duration-error';
const NOTES_ID = 'workout-notes';

const KINDS: { value: WorkoutKind; label: string }[] = [
  { value: 'strength', label: 'Strength' },
  { value: 'cardio', label: 'Cardio' },
  { value: 'mobility', label: 'Mobility' },
];

const EFFORTS: { value: WorkoutEffort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

interface FormState {
  kind: WorkoutKind | null;
  effort: WorkoutEffort | null;
  performedAt: string;
  duration: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  kind: null,
  effort: null,
  performedAt: '',
  duration: '',
  notes: '',
};

/**
 * Blank means "not recorded" (null). Anything non-blank must be a positive
 * whole number of minutes; invalid input is never silently coerced to null.
 */
function parseDurationInput(raw: string): { valid: boolean; minutes: number | null } {
  const trimmed = raw.trim();
  if (trimmed === '') return { valid: true, minutes: null };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) return { valid: false, minutes: null };
  return { valid: true, minutes: value };
}

function kindLabel(kind: WorkoutKind): string {
  return KINDS.find(({ value }) => value === kind)?.label ?? kind;
}

/**
 * First OTHER goal-kind record on the same configured-local day as
 * `instantMs`, or null.
 *
 * Only strength/cardio matter: weekly goals count those once per day, while
 * mobility duplicates never affect a goal, so mobility is exempt. The record
 * being edited (by id) never counts as its own duplicate. Invalid stored
 * timestamps are ignored, never thrown on.
 */
function findSameDayGoalWorkout(
  workouts: Workout[],
  kind: WorkoutKind | null,
  instantMs: number,
  timeZone: string,
  excludeId: string | null,
): Workout | null {
  if (kind !== 'strength' && kind !== 'cardio') return null;
  const dayKey = localDayKey(instantMs, timeZone);
  for (const other of workouts) {
    if (other.kind !== kind) continue;
    if (excludeId !== null && other.id === excludeId) continue;
    const otherMs = workoutInstantMs(other.performedAt);
    if (otherMs === null) continue;
    if (localDayKey(otherMs, timeZone) === dayKey) return other;
  }
  return null;
}

function Toggle({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors active:scale-95 ${
        active
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
      }`}
    >
      {children}
    </button>
  );
}

export default function WorkoutFormDialog({
  workout, open, onClose,
}: {
  /** null = creating a new workout */
  workout: Workout | null;
  open: boolean;
  onClose: () => void;
}) {
  const store = useStore();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    if (!open) return;
    // One-shot reset when the dialog opens: edit mode re-syncs to the record.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(
      workout
        ? {
            kind: workout.kind,
            effort: workout.effort,
            performedAt: toLocalInput(new Date(workout.performedAt)),
            duration: workout.durationMinutes === null ? '' : String(workout.durationMinutes),
            notes: workout.notes,
          }
        : {
            kind: null,
            effort: null,
            performedAt: toLocalInput(new Date()),
            duration: '',
            notes: '',
          },
    );
  }, [open, workout]);

  const performedMs = Date.parse(form.performedAt);
  const duration = parseDurationInput(form.duration);
  const canSave = form.kind !== null
    && form.effort !== null
    && Number.isFinite(performedMs)
    && duration.valid;
  const duplicateWorkout = open && Number.isFinite(performedMs)
    ? findSameDayGoalWorkout(
      store.state.workouts,
      form.kind,
      performedMs,
      store.state.timezone,
      workout?.id ?? null,
    )
    : null;
  // Persistent live region content: empty string keeps the same <p> mounted so
  // assistive tech treats it as a stable status region that toggles text.
  const duplicateWarning = duplicateWorkout !== null && form.kind !== null
    ? `This day already has a ${kindLabel(form.kind)} workout. Weekly goals count each day once, so this won't add another day — you can still save it.`
    : '';

  function save() {
    if (!canSave || form.kind === null || form.effort === null) return;
    const durationMinutes = duration.minutes;
    const performedAt = new Date(performedMs).toISOString();
    const notes = form.notes.trim();
    if (workout) {
      store.updateWorkout(workout.id, { performedAt, kind: form.kind, effort: form.effort, durationMinutes, notes });
    } else {
      store.addWorkout({ performedAt, kind: form.kind, effort: form.effort, durationMinutes, notes });
    }
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{workout ? 'Edit workout' : 'Add workout'}</DialogTitle>
          <DialogDescription>
            {workout
              ? 'Update when this workout happened, the kind of effort, or its details.'
              : 'Record a workout you did earlier. Kind and effort are required.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Kind</legend>
            <div className="flex flex-wrap gap-1.5">
              {KINDS.map(({ value, label }) => (
                <Toggle
                  key={value}
                  active={form.kind === value}
                  onClick={() => setForm((f) => ({ ...f, kind: value }))}
                >
                  {label}
                </Toggle>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Effort</legend>
            <div className="flex flex-wrap gap-1.5">
              {EFFORTS.map(({ value, label }) => (
                <Toggle
                  key={value}
                  active={form.effort === value}
                  onClick={() => setForm((f) => ({ ...f, effort: value }))}
                >
                  {label}
                </Toggle>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor={PERFORMED_ID}>Performed at</Label>
            <Input
              id={PERFORMED_ID}
              type="datetime-local"
              value={form.performedAt}
              onChange={(e) => setForm((f) => ({ ...f, performedAt: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={DURATION_ID}>
              Duration <span className="font-normal text-slate-400">(minutes, optional)</span>
            </Label>
            <Input
              id={DURATION_ID}
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              aria-label="Duration in minutes"
              aria-invalid={!duration.valid}
              aria-describedby={!duration.valid ? DURATION_ERROR_ID : undefined}
              placeholder="—"
              value={form.duration}
              onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))}
            />
            {!duration.valid && (
              <p id={DURATION_ERROR_ID} role="alert" className="text-xs text-rose-300">
                Duration must be a positive whole number of minutes, or leave blank.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={NOTES_ID}>Notes</Label>
            <Input
              id={NOTES_ID}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Anything worth remembering…"
            />
          </div>

          {/* Always mounted while the dialog is open (stable polite live
              region); `empty:!m-0` keeps the blank state from adding the
              space-y gap, so the layout is unchanged without a warning. */}
          <p role="status" aria-live="polite" className="text-xs text-amber-200 empty:!m-0">
            {duplicateWarning}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!canSave}>{workout ? 'Save changes' : 'Add workout'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
