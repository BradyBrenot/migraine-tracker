import { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { allMedIds, medColor, medName } from '@/lib/meds';
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

  useEffect(() => {
    if (!open) return;
    if (med) {
      setMedId(med.medId);
      setTs(toLocalInput(new Date(med.ts)));
      setDose(med.dose ?? '');
    } else {
      setMedId('nurtec');
      setTs(toLocalInput(new Date()));
      setDose(state.doses['nurtec'] ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, med]);

  function onMedChange(id: string) {
    setMedId(id);
    if (isNew) setDose(state.doses[id] ?? '');
  }

  function save() {
    if (!ts) return;
    if (isNew) {
      store.logMed(medId, new Date(ts), defaultAttackId, dose);
    } else {
      store.updateMed(med!.id, { ts: new Date(ts).toISOString(), dose });
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>{isNew ? 'Add' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
