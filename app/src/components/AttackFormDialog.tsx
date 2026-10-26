import { useEffect, useState } from 'react';
import type { Attack } from '@/types';
import { useStore } from '@/lib/store';
import { SYMPTOM_OPTIONS, TRIGGER_OPTIONS, painColor, textOn } from '@/lib/meds';
import { toLocalInput } from '@/lib/format';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function Chip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'border-slate-900 bg-white text-slate-950'
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

  function save() {
    const startDate = new Date(start);
    const endDate = !ongoing && end ? new Date(end) : null;
    if (isNew) {
      const a = startAttack(startDate);
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
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add attack' : 'Edit attack'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* times */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Started</Label>
              <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center justify-between">
                Ended
                <label className="flex items-center gap-1 text-xs font-normal text-slate-400">
                  <input
                    type="checkbox"
                    checked={ongoing}
                    onChange={(e) => setOngoing(e.target.checked)}
                    className="accent-slate-900"
                  />
                  ongoing
                </label>
              </Label>
              <Input
                type="datetime-local"
                value={end}
                disabled={ongoing}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>

          {/* pain */}
          <div className="space-y-2">
            <Label>
              Peak pain:{' '}
              {painSet ? (
                <span className="font-bold" style={{ color: painColor(pain) }}>{pain}/10</span>
              ) : (
                <span className="text-slate-400">not set</span>
              )}
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => { setPain(n); setPainSet(true); }}
                  className={`h-9 w-9 rounded-lg border text-sm font-bold transition-all ${
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
          </div>

          {/* symptoms */}
          <div className="space-y-2">
            <Label>Symptoms</Label>
            <div className="flex flex-wrap gap-1.5">
              {SYMPTOM_OPTIONS.map((s) => (
                <Chip key={s} active={symptoms.includes(s)} onClick={() => setSymptoms(toggle(symptoms, s))}>
                  {s}
                </Chip>
              ))}
            </div>
          </div>

          {/* triggers */}
          <div className="space-y-2">
            <Label>Potential triggers</Label>
            <div className="flex flex-wrap gap-1.5">
              {TRIGGER_OPTIONS.map((t) => (
                <Chip key={t} active={triggers.includes(t)} onClick={() => setTriggers(toggle(triggers, t))}>
                  {t}
                </Chip>
              ))}
            </div>
          </div>

          {/* aura */}
          <div className="space-y-2">
            <Label>Aura</Label>
            <div className="flex gap-1.5">
              <Chip active={aura === true} onClick={() => setAura(aura === true ? null : true)}>Yes</Chip>
              <Chip active={aura === false} onClick={() => setAura(aura === false ? null : false)}>No</Chip>
            </div>
          </div>

          {/* notes */}
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything else worth remembering…"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>{isNew ? 'Add attack' : 'Save changes'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
