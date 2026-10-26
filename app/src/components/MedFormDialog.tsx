import { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { allMedIds, medColor, medName } from '@/lib/meds';
import { parseTabletQuantity } from '@/lib/inventory';
import { toLocalInput } from '@/lib/format';
import type { MedEvent } from '@/types';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
  const canSave = ts !== '' && quantity.valid;

  function save() {
    if (!canSave) return;
    // Only Nurtec has a structured tablet count; other meds stay null.
    const tablets = isNurtec ? quantity.quantity : null;
    if (isNew) {
      store.logMed(medId, new Date(ts), defaultAttackId, dose, '', tablets);
    } else {
      store.updateMed(med!.id, { ts: new Date(ts).toISOString(), dose, quantity: tablets });
    }
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add past medication' : `Edit ${medName(medId)}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {isNew && (
            <div className="space-y-1.5">
              <Label>Medication</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {allMedIds(state.meds).map((id) => (
                  <button
                    key={id}
                    type="button"
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
            </div>
          )}
          <div className="space-y-1.5">
            <Label>When</Label>
            <Input type="datetime-local" value={ts} onChange={(e) => setTs(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Dose</Label>
            <Input value={dose} onChange={(e) => setDose(e.target.value)} placeholder="e.g. 75 mg" />
          </div>
          {isNurtec && (
            <div className="space-y-1.5">
              <Label>
                Tablets <span className="font-normal text-slate-500">(blank = unknown)</span>
              </Label>
              <Input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                aria-label="Tablets"
                aria-invalid={!quantity.valid}
                placeholder="—"
                value={quantityText}
                onChange={(e) => setQuantityText(e.target.value)}
              />
              {!quantity.valid && (
                <p role="alert" className="text-xs text-rose-300">
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
