import { useMemo, useState } from 'react';
import { Pencil, Trash2, Plus } from 'lucide-react';
import { useStore } from '@/lib/store';
import { allMedIds, medColor, medName, painColor, textOn } from '@/lib/meds';
import { parseTabletQuantity } from '@/lib/inventory';
import { useNow } from '@/lib/clock';
import { diffDayKeys, isValidDayKey, localDayKey } from '../../shared/datetime.ts';
import { parseAttackTimes } from '../../shared/attackstats.ts';
import { fmtDateFull, fmtDuration, fmtTime } from '@/lib/format';
import type { Attack, MedEvent, Refill, Workout, WorkoutKind } from '@/types';
import AttackFormDialog from '@/components/AttackFormDialog';
import MedFormDialog from '@/components/MedFormDialog';
import WorkoutFormDialog from '@/components/WorkoutFormDialog';
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

const WORKOUT_KIND_LABEL: Record<WorkoutKind, string> = {
  strength: 'Strength',
  cardio: 'Cardio',
  mobility: 'Mobility',
};

/** Nurtec's standard pack size, used as the new-pickup default. */
const NURTEC_PACK_SIZE = '8';

export default function History() {
  const store = useStore();
  const { state, readOnly } = store;
  const now = useNow();
  const [editAttack, setEditAttack] = useState<Attack | null>(null);
  const [newAttackOpen, setNewAttackOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteMedId, setDeleteMedId] = useState<string | null>(null);
  const [editMed, setEditMed] = useState<MedEvent | null>(null);
  const [newMedOpen, setNewMedOpen] = useState(false);
  const [editWorkout, setEditWorkout] = useState<Workout | null>(null);
  const [newWorkoutOpen, setNewWorkoutOpen] = useState(false);
  const [deleteWorkoutId, setDeleteWorkoutId] = useState<string | null>(null);
  const [refillOpen, setRefillOpen] = useState(false);
  const [refillEditId, setRefillEditId] = useState<string | null>(null);
  const [refillMed, setRefillMed] = useState('nurtec');
  const [refillDate, setRefillDate] = useState('');
  const [refillNotes, setRefillNotes] = useState('');
  const [refillQuantity, setRefillQuantity] = useState('');
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
  const workouts = useMemo(
    () => [...state.workouts].sort((a, b) => b.performedAt.localeCompare(a.performedAt)),
    [state.workouts],
  );

  // Days since the previous pickup of the same med (for refill cadence
  // display). Calendar-day arithmetic on valid 'YYYY-MM-DD' keys, so DST and
  // the browser zone cannot skew the gap. Server validation only requires a
  // non-empty string, so a malformed legacy date is skipped: it produces no
  // gap and never becomes the baseline for the next pickup.
  const refillGaps = useMemo(() => {
    const gaps = new Map<string, number>();
    const asc = [...state.refills].sort((a, b) => a.date.localeCompare(b.date));
    const lastByMed = new Map<string, string>();
    for (const r of asc) {
      if (!isValidDayKey(r.date)) continue;
      const prev = lastByMed.get(r.medId);
      if (prev !== undefined) gaps.set(r.id, diffDayKeys(r.date, prev));
      lastByMed.set(r.medId, r.date);
    }
    return gaps;
  }, [state.refills]);

  const refillQuantityParsed = parseTabletQuantity(refillQuantity);
  const canSaveRefill = refillDate !== '' && refillQuantityParsed.valid;

  function openNewRefill() {
    setRefillEditId(null);
    setRefillMed('nurtec');
    // A new pickup defaults to the CONFIGURED LOCAL day, never the UTC day:
    // near midnight the two differ, and this day key drives stock and
    // refill-cadence math. Date.now() is fine here — this is an event
    // handler, not a render.
    setRefillDate(localDayKey(Date.now(), state.timezone));
    setRefillNotes('');
    setRefillQuantity(NURTEC_PACK_SIZE);
    setRefillOpen(true);
  }

  function openEditRefill(r: Refill) {
    setRefillEditId(r.id);
    setRefillMed(r.medId);
    setRefillDate(r.date);
    setRefillNotes(r.notes);
    // Legacy pickups have null quantity — blank means unknown, never 0.
    setRefillQuantity(r.quantity != null ? String(r.quantity) : '');
    setRefillOpen(true);
  }

  function closeRefill() {
    setRefillOpen(false);
    setRefillEditId(null);
  }

  function selectRefillMed(id: string) {
    if (id === refillMed) return;
    setRefillMed(id);
    // Pack-size defaults apply only while creating a new pickup.
    if (refillEditId === null) setRefillQuantity(id === 'nurtec' ? NURTEC_PACK_SIZE : '');
  }

  function saveRefill() {
    if (!canSaveRefill) return;
    if (refillEditId) {
      store.updateRefill(refillEditId, {
        date: refillDate,
        notes: refillNotes,
        quantity: refillQuantityParsed.quantity,
      });
    } else {
      store.addRefill(refillMed, refillDate, refillNotes, refillQuantityParsed.quantity);
    }
    closeRefill();
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Tabs defaultValue="attacks">
        {/* Compact labels keep the four tabs readable at phone widths; the
            full wording returns at sm+. Counts stay visible at every size. The
            list is taller on mobile so the padded triggers stay ~41px tap targets; the desktop height
            at sm+. */}
        <TabsList className="grid h-12 w-full grid-cols-4 sm:h-9">
          <TabsTrigger value="attacks" className="gap-1 px-1 text-[11px] sm:gap-1.5 sm:px-2 sm:text-sm">
            Attacks
            <span className="tabular-nums">({attacks.length})</span>
          </TabsTrigger>
          <TabsTrigger value="meds" className="gap-1 px-1 text-[11px] sm:gap-1.5 sm:px-2 sm:text-sm">
            <span className="sm:hidden">Meds</span>
            <span className="hidden sm:inline">Medications</span>
            <span className="tabular-nums">({meds.length})</span>
          </TabsTrigger>
          <TabsTrigger value="refills" className="gap-1 px-1 text-[11px] sm:gap-1.5 sm:px-2 sm:text-sm">
            <span className="sm:hidden">Rx</span>
            <span className="hidden sm:inline">Rx pickups</span>
            <span className="tabular-nums">({refills.length})</span>
          </TabsTrigger>
          <TabsTrigger value="workouts" className="gap-1 px-1 text-[11px] sm:gap-1.5 sm:px-2 sm:text-sm">
            Workouts
            <span className="tabular-nums">({workouts.length})</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="attacks" className="mt-4 space-y-2">
          {!readOnly && (
            <Button variant="outline" className="mb-2 w-full gap-2" onClick={() => setNewAttackOpen(true)}>
              <Plus className="h-4 w-4" /> Add past attack
            </Button>
          )}
          {attacks.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No attacks logged yet.</p>
          )}
          {attacks.map((a) => {
            const times = parseAttackTimes(a, now);
            // A valid finished end earlier than a valid start is surfaced as a
            // warning, but never blocked, hidden, or silently repaired. An
            // ongoing attack (no end) can never be end-before-start.
            const endBeforeStart = a.end !== null
              && times.startMs !== null
              && times.endMs !== null
              && times.endMs < times.startMs;
            const elapsed = times.startMs !== null && times.endMs !== null
              ? times.endMs - times.startMs
              : null;
            // Never show a negative/garbage duration as if it were elapsed time.
            // Ongoing attacks still show elapsed-so-far (bounded by `now`).
            const durLabel = elapsed !== null && elapsed >= 0 && !endBeforeStart
              ? fmtDuration(elapsed)
              : '—';
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
                      {endBeforeStart && (
                        <span
                          role="status"
                          className="ml-2 rounded-full bg-amber-950 px-2 py-0.5 text-[10px] font-bold text-amber-300"
                        >
                          End is before start
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">
                      {durLabel}
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
                  {!readOnly && (
                    <>
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
                    </>
                  )}
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
          {!readOnly && (
            <Button variant="outline" className="mb-2 w-full gap-2" onClick={() => setNewMedOpen(true)}>
              <Plus className="h-4 w-4" /> Add past medication
            </Button>
          )}
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
              {!readOnly && (
                <>
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
                </>
              )}
            </div>
          ))}
        </TabsContent>

        <TabsContent value="refills" className="mt-4 space-y-1.5">
          {!readOnly && (
            <Button
              variant="outline"
              className="mb-2 w-full gap-2"
              onClick={openNewRefill}
            >
              <Plus className="h-4 w-4" /> Add Rx pickup
            </Button>
          )}
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
                  {r.quantity != null && (
                    <span className="ml-2 text-xs text-slate-400">{r.quantity} tabs</span>
                  )}
                  <div className="text-xs text-slate-400">
                    {new Date(r.date + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                    {gap !== undefined && (
                      <span className="ml-2 font-semibold text-slate-300">+{gap}d since last</span>
                    )}
                  </div>
                </div>
                {!readOnly && (
                  <>
                    <button
                      onClick={() => openEditRefill(r)}
                      className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-700"
                      aria-label="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeleteRefillId(r.id)}
                      className="rounded-lg p-2 text-slate-400 hover:bg-rose-950 hover:text-rose-400"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </TabsContent>

        <TabsContent value="workouts" className="mt-4 space-y-1.5">
          {!readOnly && (
            <Button variant="outline" className="mb-2 w-full gap-2" onClick={() => setNewWorkoutOpen(true)}>
              <Plus className="h-4 w-4" /> Add past workout
            </Button>
          )}
          {workouts.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No workouts logged yet.</p>
          )}
          {workouts.map((w) => (
            <div key={w.id} className="flex items-center gap-3 rounded-lg border bg-slate-900 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">
                  {WORKOUT_KIND_LABEL[w.kind]} · {w.effort}
                </div>
                <div className="text-xs text-slate-400">
                  {fmtDateFull(w.performedAt)} at {fmtTime(w.performedAt)}
                  {w.durationMinutes !== null && ` · ${w.durationMinutes}m`}
                </div>
                {w.notes && (
                  <p className="mt-1 border-l-2 border-slate-700 pl-2 text-xs italic text-slate-400">
                    {w.notes}
                  </p>
                )}
              </div>
              {!readOnly && (
                <>
                  <button
                    onClick={() => setEditWorkout(w)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-700"
                    aria-label="Edit"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setDeleteWorkoutId(w.id)}
                    className="rounded-lg p-2 text-slate-400 hover:bg-rose-950 hover:text-rose-400"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
          ))}
        </TabsContent>
      </Tabs>

      {!readOnly && (
        <>
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

          {/* add / edit workout */}
          <WorkoutFormDialog
            workout={editWorkout}
            open={!!editWorkout || newWorkoutOpen}
            onClose={() => { setEditWorkout(null); setNewWorkoutOpen(false); }}
          />

          {/* add / edit refill pickup */}
          <Dialog open={refillOpen} onOpenChange={(o) => !o && closeRefill()}>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>{refillEditId ? 'Edit Rx pickup' : 'Add Rx pickup'}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div className="space-y-1.5">
                  <Label>Medication</Label>
                  {refillEditId ? (
                    <div className="text-sm font-semibold text-slate-200">{medName(refillMed)}</div>
                  ) : (
                    <div className="grid grid-cols-3 gap-1.5">
                      {allMedIds([...state.meds, ...state.refills]).map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => selectRefillMed(id)}
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
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Pickup date</Label>
                  <Input type="date" value={refillDate} onChange={(e) => setRefillDate(e.target.value)} />
                </div>
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
                    aria-invalid={!refillQuantityParsed.valid}
                    placeholder="—"
                    value={refillQuantity}
                    onChange={(e) => setRefillQuantity(e.target.value)}
                  />
                  {!refillQuantityParsed.valid && (
                    <p role="alert" className="text-xs text-rose-300">
                      Tablets must be a whole number (0 or more), or leave blank.
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Notes <span className="font-normal text-slate-500">(pharmacy…)</span></Label>
                  <Input value={refillNotes} onChange={(e) => setRefillNotes(e.target.value)} placeholder="e.g. CVS" />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={closeRefill}>Cancel</Button>
                <Button onClick={saveRefill} disabled={!canSaveRefill}>
                  {refillEditId ? 'Save' : 'Add'}
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

          {/* delete workout confirm */}
          <AlertDialog open={!!deleteWorkoutId} onOpenChange={(o) => !o && setDeleteWorkoutId(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this workout?</AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => { if (deleteWorkoutId) store.deleteWorkout(deleteWorkoutId); setDeleteWorkoutId(null); }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
