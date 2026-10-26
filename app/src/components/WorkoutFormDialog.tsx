import { useEffect, useState, type ReactNode } from 'react';
import type { Workout, WorkoutEffort, WorkoutKind } from '@/types';
import { useStore } from '@/lib/store';
import { toLocalInput } from '@/lib/format';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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

function Toggle({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors active:scale-95 ${
        active
          ? 'border-transparent bg-white text-slate-950'
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
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Kind</Label>
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
          </div>

          <div className="space-y-1.5">
            <Label>Effort</Label>
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
          </div>

          <div className="space-y-1.5">
            <Label>Performed at</Label>
            <Input
              type="datetime-local"
              value={form.performedAt}
              onChange={(e) => setForm((f) => ({ ...f, performedAt: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label>
              Duration <span className="font-normal text-slate-500">(minutes, optional)</span>
            </Label>
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              aria-label="Duration in minutes"
              aria-invalid={!duration.valid}
              placeholder="—"
              value={form.duration}
              onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))}
            />
            {!duration.valid && (
              <p role="alert" className="text-xs text-rose-300">
                Duration must be a positive whole number of minutes, or leave blank.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Input
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Anything worth remembering…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!canSave}>{workout ? 'Save changes' : 'Add workout'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
