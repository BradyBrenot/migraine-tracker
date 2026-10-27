import { useEffect, useState } from 'react';
import type { Attack } from '@/types';
import { useStore } from '@/lib/store';
import { SYMPTOM_OPTIONS, TRIGGER_OPTIONS, painColor, textOn } from '@/lib/meds';
import { toLocalInput } from '@/lib/format';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const START_ID = 'attack-start';
const END_ID = 'attack-end';
const ONGOING_ID = 'attack-ongoing';
const NOTES_ID = 'attack-notes';
const TIME_ERROR_ID = 'attack-time-error';

function Chip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center rounded-full border px-3 text-sm font-medium transition-colors ${
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-slate-600 bg-slate-900 text-slate-300 hover:border-slate-400'
      }`}
    >
      {children}
    </button>
  );
}

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export default function AttackFormDialog({
  attack, open, onClose,
}: {
  /** null = creating a new (past) attack */
  attack: Attack | null;
  open: boolean;
  onClose: () => void;
}) {
  const { updateAttack, startAttack, endAttack, logPain } = useStore();
  const isNew = attack === null;

  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [ongoing, setOngoing] = useState(false);
  const [pain, setPain] = useState(5);
  const [painSet, setPainSet] = useState(false);
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [triggers, setTriggers] = useState<string[]>([]);
  const [aura, setAura] = useState<boolean | null>(null);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) return;
    if (attack) {
      // Intentional one-shot form initialization on dialog open: the fields
      // must re-sync to the edited attack. This is a controlled reset that
      // runs once per open, not render-derived state cascading every render.
      // `toLocalInput` returns '' for an invalid Date, so a corrupt legacy
      // start/end opens blank instead of "NaN-NaN-NaN…" and can be repaired.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStart(toLocalInput(new Date(attack.start)));
      setEnd(attack.end ? toLocalInput(new Date(attack.end)) : '');
      setOngoing(attack.end === null);
      setPain(attack.peakPain >= 0 ? attack.peakPain : 5);
      setPainSet(attack.peakPain >= 0);
      setSymptoms(attack.symptoms);
      setTriggers(attack.triggers);
      setAura(attack.aura);
      setNotes(attack.notes);
    } else {
      const now = new Date();
      setStart(toLocalInput(now));
      setEnd('');
      setOngoing(true);
      setPain(5);
      setPainSet(false);
      setSymptoms([]);
      setTriggers([]);
      setAura(null);
      setNotes('');
    }
  }, [open, attack]);

  // Date.parse is used (rather than `new Date(...)`) so the validity check and
  // the saved instant share one reading of the same local datetime string.
  // An intentional end-before-start is NOT rejected: those records stay
  // editable and are surfaced as a warning elsewhere.
  const startMs = start.trim() === '' ? Number.NaN : Date.parse(start);
  const endMs = end.trim() === '' ? Number.NaN : Date.parse(end);
  const startInvalid = !Number.isFinite(startMs);
  const endInvalid = !ongoing && !Number.isFinite(endMs);
  const timeError = startInvalid
    ? 'Enter a valid start date and time.'
    : endInvalid
      ? 'Enter a valid end date and time, or mark the attack as ongoing.'
      : '';
  const canSave = timeError === '';

  function save() {
    if (!canSave) return;
    const startDate = new Date(startMs);
    const endDate = !ongoing && Number.isFinite(endMs) ? new Date(endMs) : null;
    if (isNew) {
      // The attack-day rule applies only to a current ongoing attack: a
      // backfilled ended attack or a future start must never rewrite today.
      const currentOngoing = endDate === null && startMs <= Date.now();
      const a = currentOngoing ? startAttack(startDate, true) : startAttack(startDate);
      if (endDate) endAttack(a.id, endDate);
      if (painSet) logPain(a.id, pain, startDate);
      updateAttack(a.id, { symptoms, triggers, aura, notes });
    } else {
      updateAttack(attack!.id, {
        start: startDate.toISOString(),
        end: endDate ? endDate.toISOString() : null,
        symptoms, triggers, aura, notes,
        // Save the chosen peak directly; no synthetic pain-log entry.
        ...(painSet ? { peakPain: pain } : {}),
      });
    }
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="grid max-h-[calc(100dvh-1rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-h-[92vh] sm:max-w-lg">
        {/* p-0 removes DialogContent's default padding, so the header reserves
            the absolutely positioned close-button gutter with pr-16. */}
        <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-16">
          <DialogTitle>{isNew ? 'Add attack' : 'Edit attack'}</DialogTitle>
          <DialogDescription>
            {isNew
              ? 'Record when the attack started, how bad it got, and anything that may have triggered it.'
              : 'Update the times, pain, symptoms, triggers, or notes for this attack.'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          <div className="space-y-5">
            {/* times */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={START_ID}>Started</Label>
                <Input
                  id={START_ID}
                  type="datetime-local"
                  value={start}
                  aria-invalid={startInvalid}
                  aria-describedby={startInvalid ? TIME_ERROR_ID : undefined}
                  onChange={(e) => setStart(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={END_ID}>Ended</Label>
                  {/* Separate label/control pair (no nested <label>): the
                      checkbox names the ongoing state, the Ended label names
                      the datetime input. */}
                  <span className="flex items-center gap-1 text-xs font-normal text-slate-400">
                    <input
                      id={ONGOING_ID}
                      type="checkbox"
                      checked={ongoing}
                      onChange={(e) => setOngoing(e.target.checked)}
                      className="accent-slate-900"
                    />
                    <label htmlFor={ONGOING_ID} className="cursor-pointer">
                      ongoing
                    </label>
                  </span>
                </div>
                <Input
                  id={END_ID}
                  type="datetime-local"
                  value={end}
                  disabled={ongoing}
                  aria-invalid={endInvalid}
                  aria-describedby={endInvalid ? TIME_ERROR_ID : undefined}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </div>
            </div>
            {timeError && (
              <p id={TIME_ERROR_ID} role="alert" className="text-xs text-rose-300">
                {timeError}
              </p>
            )}

            {/* pain */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                Peak pain:{' '}
                {painSet ? (
                  <span className="font-bold" style={{ color: painColor(pain) }}>{pain}/10</span>
                ) : (
                  <span className="text-slate-400">not set</span>
                )}
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={painSet && pain === n}
                    onClick={() => { setPain(n); setPainSet(true); }}
                    className={`h-11 w-11 rounded-lg border text-sm font-bold transition-all ${
                      painSet && pain === n
                        ? 'scale-110 border-transparent shadow'
                        : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-400'
                    }`}
                    style={painSet && pain === n ? { background: painColor(n), color: textOn(painColor(n)) } : undefined}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </fieldset>

            {/* symptoms */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Symptoms</legend>
              <div className="flex flex-wrap gap-1.5">
                {SYMPTOM_OPTIONS.map((s) => (
                  <Chip key={s} active={symptoms.includes(s)} onClick={() => setSymptoms(toggle(symptoms, s))}>
                    {s}
                  </Chip>
                ))}
              </div>
            </fieldset>

            {/* triggers */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Potential triggers</legend>
              <div className="flex flex-wrap gap-1.5">
                {TRIGGER_OPTIONS.map((t) => (
                  <Chip key={t} active={triggers.includes(t)} onClick={() => setTriggers(toggle(triggers, t))}>
                    {t}
                  </Chip>
                ))}
              </div>
            </fieldset>

            {/* aura */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Aura</legend>
              <div className="flex gap-1.5">
                <Chip active={aura === true} onClick={() => setAura(aura === true ? null : true)}>Yes</Chip>
                <Chip active={aura === false} onClick={() => setAura(aura === false ? null : false)}>No</Chip>
              </div>
            </fieldset>

            {/* notes */}
            <div className="space-y-1.5">
              <Label htmlFor={NOTES_ID}>Notes</Label>
              <Textarea
                id={NOTES_ID}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything else worth remembering…"
                rows={3}
              />
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-slate-800 px-5 py-3">
          <Button variant="outline" className="h-11" onClick={onClose}>Cancel</Button>
          <Button className="h-11" onClick={save} disabled={!canSave}>{isNew ? 'Add attack' : 'Save changes'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
