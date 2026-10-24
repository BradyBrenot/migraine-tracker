import { useMemo, useState } from 'react';
import { Pencil, Trash2, Plus } from 'lucide-react';
import { useStore } from '@/lib/store';
import { allMedIds, medColor, medName, painColor, textOn } from '@/lib/meds';
import { fmtDateFull, fmtDuration, fmtTime } from '@/lib/format';
import type { Attack, MedEvent } from '@/types';
import AttackFormDialog from '@/components/AttackFormDialog';
import MedFormDialog from '@/components/MedFormDialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function History() {
  const store = useStore();
  const { state } = store;
  const [editAttack, setEditAttack] = useState<Attack | null>(null);
  const [newAttackOpen, setNewAttackOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteMedId, setDeleteMedId] = useState<string | null>(null);
  const [editMed, setEditMed] = useState<MedEvent | null>(null);
  const [newMedOpen, setNewMedOpen] = useState(false);
  const [refillOpen, setRefillOpen] = useState(false);
  const [refillMed, setRefillMed] = useState('nurtec');
  const [refillDate, setRefillDate] = useState('');
  const [refillNotes, setRefillNotes] = useState('');
  const [deleteRefillId, setDeleteRefillId] = useState<string | null>(null);

  const attacks = useMemo(
    () => [...state.attacks].sort((a, b) => b.start.localeCompare(a.start)),
    [state.attacks],
  );
  const meds = useMemo(
    () => [...state.meds].sort((a, b) => b.ts.localeCompare(a.ts)),
    [state.meds],
  );
  const refills = useMemo(
    () => [...state.refills].sort((a, b) => b.date.localeCompare(a.date)),
    [state.refills],
  );

  // days since previous pickup of the same med (for refill cadence display)
  const refillGaps = useMemo(() => {
    const gaps = new Map<string, number>();
    const asc = [...state.refills].sort((a, b) => a.date.localeCompare(b.date));
    const lastByMed = new Map<string, string>();
    for (const r of asc) {
      const prev = lastByMed.get(r.medId);
      if (prev) {
        gaps.set(r.id, Math.round(
          (new Date(r.date + 'T00:00:00').getTime() - new Date(prev + 'T00:00:00').getTime()) / 86400000));
      }
      lastByMed.set(r.medId, r.date);
    }
    return gaps;
  }, [state.refills]);

  return (
    <div className="mx-auto max-w-2xl">
      <Tabs defaultValue="attacks">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="attacks">Attacks ({attacks.length})</TabsTrigger>
          <TabsTrigger value="meds">Medications ({meds.length})</TabsTrigger>
          <TabsTrigger value="refills">Rx pickups ({refills.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="attacks" className="mt-4 space-y-2">
          <Button variant="outline" className="mb-2 w-full gap-2" onClick={() => setNewAttackOpen(true)}>
            <Plus className="h-4 w-4" /> Add past attack
          </Button>
          {attacks.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No attacks logged yet.</p>
          )}
          {attacks.map((a) => {
            const dur = (a.end ? new Date(a.end).getTime() : Date.now()) - new Date(a.start).getTime();
            const attackMeds = meds.filter((m) => m.attackId === a.id);
            return (
              <div key={a.id} className="rounded-xl border bg-slate-900 p-3 shadow-sm">
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-base font-black"
                    style={{ background: painColor(a.peakPain), color: textOn(painColor(a.peakPain)) }}
                  >
                    {a.peakPain >= 0 ? a.peakPain : '–'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">
                      {fmtDateFull(a.start)} · {fmtTime(a.start)}
                      {!a.end && (
                        <span className="ml-2 rounded-full bg-rose-950 px-2 py-0.5 text-[10px] font-bold text-rose-300">
                          ONGOING
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">
                      {fmtDuration(dur)}
                      {a.symptoms.length > 0 && ` · ${a.symptoms.slice(0, 3).join(', ')}`}
                    </div>
                    {attackMeds.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {attackMeds.map((m) => (
                          <span
                            key={m.id}
                            className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                            style={{ background: medColor(m.medId) }}
                          >
                            {medName(m.medId)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setEditAttack(a)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-700"
                    aria-label="Edit"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setDeleteId(a.id)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-rose-950 hover:text-rose-400"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {a.notes && (
                  <p className="mt-2 border-l-2 border-slate-700 pl-2 text-xs italic text-slate-400">
                    {a.notes}
                  </p>
                )}
              </div>
            );
          })}
        </TabsContent>

        <TabsContent value="meds" className="mt-4 space-y-1.5">
          <Button variant="outline" className="mb-2 w-full gap-2" onClick={() => setNewMedOpen(true)}>
            <Plus className="h-4 w-4" /> Add past medication
          </Button>
          {meds.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No medications logged yet.</p>
          )}
          {meds.map((m) => (
            <div key={m.id} className="flex items-center gap-3 rounded-lg border bg-slate-900 px-3 py-2">
              <span className="h-3 w-3 rounded-full" style={{ background: medColor(m.medId) }} />
              <div className="flex-1">
                <span className="text-sm font-semibold">{medName(m.medId)}</span>
                {m.dose && <span className="ml-2 text-xs text-slate-400">{m.dose}</span>}
                <div className="text-xs text-slate-400">
                  {fmtDateFull(m.ts)} at {fmtTime(m.ts)}
                  {m.attackId && ' · linked to attack'}
                </div>
              </div>
              <button
                onClick={() => setEditMed(m)}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-700"
                aria-label="Edit"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={() => setDeleteMedId(m.id)}
                className="rounded-lg p-2 text-slate-400 hover:bg-rose-950 hover:text-rose-400"
                aria-label="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="refills" className="mt-4 space-y-1.5">
          <Button
            variant="outline"
            className="mb-2 w-full gap-2"
            onClick={() => {
              setRefillOpen(true);
              setRefillMed('nurtec');
              setRefillDate(new Date().toISOString().slice(0, 10));
              setRefillNotes('');
            }}
          >
            <Plus className="h-4 w-4" /> Add Rx pickup
          </Button>
          <p className="text-xs text-slate-500">
            Gepant refill pickups — refill cadence is a good historical signal for
            how bad things were, even in weeks you didn't track.
          </p>
          {refills.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No pickups logged yet.</p>
          )}
          {refills.map((r) => {
            const gap = refillGaps.get(r.id);
            const c = medColor(r.medId);
            return (
              <div key={r.id} className="flex items-center gap-3 rounded-lg border bg-slate-900 px-3 py-2">
                <span
                  className="flex h-[18px] min-w-[18px] items-center justify-center rounded px-1 text-[10px] font-black leading-none"
                  style={{ background: c, color: textOn(c) }}
                >
                  {r.medId.slice(0, 2).replace(/^./, (x) => x.toUpperCase())}
                </span>
                <div className="flex-1">
                  <span className="text-sm font-semibold">{medName(r.medId)}</span>
                  {r.notes && <span className="ml-2 text-xs text-slate-400">{r.notes}</span>}
                  <div className="text-xs text-slate-400">
                    {new Date(r.date + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                    {gap !== undefined && (
                      <span className="ml-2 font-semibold text-slate-300">+{gap}d since last</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setDeleteRefillId(r.id)}
                  className="rounded-lg p-2 text-slate-400 hover:bg-rose-950 hover:text-rose-400"
                  aria-label="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </TabsContent>
      </Tabs>

      {/* edit attack */}
      <AttackFormDialog
        attack={editAttack}
        open={!!editAttack}
        onClose={() => setEditAttack(null)}
      />

      {/* add past attack */}
      <AttackFormDialog
        attack={null}
        open={newAttackOpen}
        onClose={() => setNewAttackOpen(false)}
      />

      {/* add / edit med */}
      <MedFormDialog
        med={editMed}
        open={!!editMed || newMedOpen}
        onClose={() => { setEditMed(null); setNewMedOpen(false); }}
      />

      {/* add refill pickup */}
      <Dialog open={refillOpen} onOpenChange={(o) => !o && setRefillOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Rx pickup</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Medication</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {allMedIds([...state.meds, ...state.refills]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setRefillMed(id)}
                    className={`rounded-lg border px-2 py-2 text-xs font-semibold transition-colors ${
                      refillMed === id
                        ? 'border-transparent text-slate-950'
                        : 'border-slate-700 text-slate-300 hover:border-slate-500'
                    }`}
                    style={refillMed === id ? { background: medColor(id) } : undefined}
                  >
                    {medName(id)}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Pickup date</Label>
              <Input type="date" value={refillDate} onChange={(e) => setRefillDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Notes <span className="font-normal text-slate-500">(quantity, pharmacy…)</span></Label>
              <Input value={refillNotes} onChange={(e) => setRefillNotes(e.target.value)} placeholder="e.g. 8 tablets" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefillOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                if (refillDate) store.addRefill(refillMed, refillDate, refillNotes);
                setRefillOpen(false);
              }}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete refill confirm */}
      <AlertDialog open={!!deleteRefillId} onOpenChange={(o) => !o && setDeleteRefillId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this pickup?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteRefillId) store.deleteRefill(deleteRefillId); setDeleteRefillId(null); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* delete attack confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this attack?</AlertDialogTitle>
            <AlertDialogDescription>
              Linked medications will be kept but unlinked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteId) store.deleteAttack(deleteId); setDeleteId(null); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* delete med confirm */}
      <AlertDialog open={!!deleteMedId} onOpenChange={(o) => !o && setDeleteMedId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this medication entry?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteMedId) store.deleteMed(deleteMedId); setDeleteMedId(null); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
