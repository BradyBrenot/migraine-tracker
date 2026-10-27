import { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { allMedIds, medColor, medName } from '@/lib/meds';
import { parseTabletQuantity } from '@/lib/inventory';
import { toLocalInput } from '@/lib/format';
import type { MedEvent } from '@/types';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const WHEN_ID = 'med-form-when';
const DOSE_ID = 'med-form-dose';
const TABLETS_ID = 'med-form-tablets';
const TIME_ERROR_ID = 'med-form-time-error';
const TABLETS_ERROR_ID = 'med-form-tablets-error';

export default function MedFormDialog({
  med, open, onClose, defaultAttackId = null,
}: {
  /** null = creating a new entry */
  med: MedEvent | null;
  open: boolean;
  onClose: () => void;
  /** when creating, link to this attack (e.g. the active one) */
  defaultAttackId?: string | null;
}) {
  const store = useStore();
  const { state } = store;
  const isNew = med === null;

  const [medId, setMedId] = useState('nurtec');
  const [ts, setTs] = useState('');
  const [dose, setDose] = useState('');
  const [quantityText, setQuantityText] = useState('1');

  useEffect(() => {
    if (!open) return;
    if (med) {
      setMedId(med.medId);
      setTs(toLocalInput(new Date(med.ts)));
      setDose(med.dose ?? '');
      // Legacy records have null quantity: blank means "unknown", never 0.
      setQuantityText(med.quantity != null ? String(med.quantity) : '');
    } else {
      setMedId('nurtec');
      setTs(toLocalInput(new Date()));
      setDose(state.doses['nurtec'] ?? '');
      setQuantityText('1');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, med]);

  function onMedChange(id: string) {
    setMedId(id);
    if (isNew) {
      setDose(state.doses[id] ?? '');
      setQuantityText(id === 'nurtec' ? '1' : '');
    }
  }

  const isNurtec = medId === 'nurtec';
  const quantity = parseTabletQuantity(quantityText);
  // A blank datetime-local value must never reach `new Date(...)`: a corrupt
  // legacy timestamp opens blank and blocks saving until it is repaired.
  const tsMs = ts.trim() === '' ? Number.NaN : Date.parse(ts);
  const tsInvalid = !Number.isFinite(tsMs);
  const canSave = !tsInvalid && quantity.valid;

  function save() {
    if (!canSave || !Number.isFinite(tsMs)) return;
    // Only Nurtec has a structured tablet count; other meds stay null.
    const tablets = isNurtec ? quantity.quantity : null;
    const when = new Date(tsMs);
    if (isNew) {
      store.logMed(medId, when, defaultAttackId, dose, '', tablets);
    } else {
      store.updateMed(med!.id, { ts: when.toISOString(), dose, quantity: tablets });
    }
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add past medication' : `Edit ${medName(medId)}`}</DialogTitle>
          <DialogDescription>
            {isNew
              ? 'Log a dose you took earlier and link it to the active attack when relevant.'
              : 'Adjust when this dose was taken, the dose text, or the tablet count.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {isNew && (
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Medication</legend>
              <div className="grid grid-cols-3 gap-1.5">
                {allMedIds(state.meds).map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={medId === id}
                    onClick={() => onMedChange(id)}
                    className={`flex items-center gap-1.5 rounded-lg border px-2 py-2 text-left text-xs font-semibold transition-colors ${
                      medId === id
                        ? 'border-transparent text-slate-950'
                        : 'border-slate-700 text-slate-300 hover:border-slate-500'
                    }`}
                    style={medId === id ? { background: medColor(id) } : undefined}
                  >
                    {medName(id)}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={WHEN_ID}>When</Label>
            <Input
              id={WHEN_ID}
              type="datetime-local"
              value={ts}
              aria-invalid={tsInvalid}
              aria-describedby={tsInvalid ? TIME_ERROR_ID : undefined}
              onChange={(e) => setTs(e.target.value)}
            />
            {tsInvalid && (
              <p id={TIME_ERROR_ID} role="alert" className="text-xs text-rose-300">
                Enter a valid date and time.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={DOSE_ID}>Dose</Label>
            <Input
              id={DOSE_ID}
              value={dose}
              onChange={(e) => setDose(e.target.value)}
              placeholder="e.g. 75 mg"
            />
          </div>
          {isNurtec && (
            <div className="space-y-1.5">
              <Label htmlFor={TABLETS_ID}>
                Tablets <span className="font-normal text-slate-400">(blank = unknown)</span>
              </Label>
              <Input
                id={TABLETS_ID}
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                aria-label="Tablets"
                aria-invalid={!quantity.valid}
                aria-describedby={!quantity.valid ? TABLETS_ERROR_ID : undefined}
                placeholder="—"
                value={quantityText}
                onChange={(e) => setQuantityText(e.target.value)}
              />
              {!quantity.valid && (
                <p id={TABLETS_ERROR_ID} role="alert" className="text-xs text-rose-300">
                  Tablets must be a whole number (0 or more), or leave blank.
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!canSave}>{isNew ? 'Add' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
