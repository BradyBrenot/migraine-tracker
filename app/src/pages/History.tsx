import { useMemo, useState } from 'react';
import { Pencil, Trash2, Plus, Search } from 'lucide-react';
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
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DANGER_ACTION_CLASS } from '@/lib/ui';

const WORKOUT_KIND_LABEL: Record<WorkoutKind, string> = {
  strength: 'Strength',
  cardio: 'Cardio',
  mobility: 'Mobility',
};

/** Nurtec's standard pack size, used as the new-pickup default. */
const NURTEC_PACK_SIZE = '8';

type HistoryTab = 'attacks' | 'meds' | 'refills' | 'workouts';

/** Noun used by the filter hint/empty state for the active tab. */
const TAB_NOUN: Record<HistoryTab, string> = {
  attacks: 'attacks',
  meds: 'medications',
  refills: 'pickups',
  workouts: 'workouts',
};

/** Case-insensitive "any of these fields contains the query" test. */
function matchesQuery(fields: (string | number | null | undefined)[], needle: string): boolean {
  if (!needle) return true;
  return fields
    .filter((field) => field !== null && field !== undefined && field !== '')
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

/** Neutral "nothing matched" state for the active text filter. */
function FilterEmpty({
  noun, query, onClear,
}: { noun: string; query: string; onClear: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-800 px-3 py-8 text-center text-sm text-slate-400">
      <p>No {noun} match “{query.trim()}”.</p>
      <button
        type="button"
        onClick={onClear}
        className="mt-2 inline-flex min-h-11 items-center rounded-lg px-3 text-xs font-semibold text-slate-200 underline underline-offset-2 hover:text-slate-50"
      >
        Clear filter
      </button>
    </div>
  );
}

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
  // Active tab + a cross-field text filter. Counts in the tab bar always come
  // from the full record arrays; the filter only narrows what is listed.
  const [tab, setTab] = useState<HistoryTab>('attacks');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const attacks = useMemo(
    () => [...state.attacks].sort((a, b) => b.start.localeCompare(a.start)),
    [state.attacks],
  );
  const meds = useMemo(
    () => [...state.meds].sort((a, b) => b.ts.localeCompare(a.ts)),
    [state.meds],
  );
  // Medications grouped by linked attack ONCE (newest-first, matching the meds
  // list). Previously every attack row rescanned the whole medication history.
  // A null/non-string attackId can never equal an attack id and is skipped.
  const medsByAttack = useMemo(() => {
    const byAttack = new Map<string, MedEvent[]>();
    for (const med of meds) {
      const attackId = med.attackId;
      if (typeof attackId !== 'string') continue;
      const bucket = byAttack.get(attackId);
      if (bucket) bucket.push(med);
      else byAttack.set(attackId, [med]);
    }
    return byAttack;
  }, [meds]);
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

  // Filters run over the already-sorted arrays, so list order never changes.
  const filteredAttacks = useMemo(() => {
    if (!needle) return attacks;
    return attacks.filter((a) => matchesQuery([
      fmtDateFull(a.start),
      fmtTime(a.start),
      a.notes,
      a.symptoms.join(' '),
      a.triggers.join(' '),
      a.peakPain >= 0 ? `${a.peakPain}/10` : '',
      (medsByAttack.get(a.id) ?? []).map((m) => medName(m.medId)).join(' '),
    ], needle));
  }, [attacks, needle, medsByAttack]);

  const filteredMeds = useMemo(() => {
    if (!needle) return meds;
    return meds.filter((m) => matchesQuery([
      medName(m.medId), m.dose, m.notes, fmtDateFull(m.ts), fmtTime(m.ts),
    ], needle));
  }, [meds, needle]);

  const filteredRefills = useMemo(() => {
    if (!needle) return refills;
    return refills.filter((r) => matchesQuery([
      medName(r.medId), r.notes, r.date, r.quantity,
    ], needle));
  }, [refills, needle]);

  const filteredWorkouts = useMemo(() => {
    if (!needle) return workouts;
    return workouts.filter((w) => matchesQuery([
      WORKOUT_KIND_LABEL[w.kind], w.effort, w.notes,
      fmtDateFull(w.performedAt), fmtTime(w.performedAt), w.durationMinutes,
    ], needle));
  }, [workouts, needle]);

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
      <h1 className="sr-only">History</h1>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as HistoryTab);
          // A filter typed for one tab must never invisibly narrow another.
          setQuery('');
        }}
      >
        {/* Compact labels keep the four tabs readable at phone widths; the
            full wording returns at sm+. Counts stay visible at every size and
            stack under the label at base, where the taller list keeps a
            comfortable ~44px tap target; the compact height returns at sm+. */}
        <TabsList className="grid h-14 w-full grid-cols-4 sm:h-9">
          <TabsTrigger
            value="attacks"
            className="flex-col gap-0 px-1 py-1 text-[11px] leading-tight sm:flex-row sm:gap-1.5 sm:px-2 sm:py-1 sm:text-sm"
          >
            Attacks
            <span className="tabular-nums">({attacks.length})</span>
          </TabsTrigger>
          <TabsTrigger
            value="meds"
            className="flex-col gap-0 px-1 py-1 text-[11px] leading-tight sm:flex-row sm:gap-1.5 sm:px-2 sm:py-1 sm:text-sm"
          >
            <span className="sm:hidden">Meds</span>
            <span className="hidden sm:inline">Medications</span>
            <span className="tabular-nums">({meds.length})</span>
          </TabsTrigger>
          <TabsTrigger
            value="refills"
            className="flex-col gap-0 px-1 py-1 text-[11px] leading-tight sm:flex-row sm:gap-1.5 sm:px-2 sm:py-1 sm:text-sm"
          >
            Pickups
            <span className="tabular-nums">({refills.length})</span>
          </TabsTrigger>
          <TabsTrigger
            value="workouts"
            className="flex-col gap-0 px-1 py-1 text-[11px] leading-tight sm:flex-row sm:gap-1.5 sm:px-2 sm:py-1 sm:text-sm"
          >
            Workouts
            <span className="tabular-nums">({workouts.length})</span>
          </TabsTrigger>
        </TabsList>

        {/* Text filter for the active tab. Tabs/counts above always describe the
            full record sets; this only narrows the list below. */}
        <div role="search" className="mt-3 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
            />
            <Input
              id="history-filter"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={`Filter ${TAB_NOUN[tab]}`}
              placeholder={`Filter ${TAB_NOUN[tab]}…`}
              className="h-11 pl-8"
            />
          </div>
          {query !== '' && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="inline-flex h-11 shrink-0 items-center rounded-lg px-3 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              Clear
            </button>
          )}
        </div>

        <TabsContent value="attacks" className="mt-4 space-y-2">
          {!readOnly && (
            <Button variant="outline" className="mb-2 h-11 w-full gap-2" onClick={() => setNewAttackOpen(true)}>
              <Plus className="h-4 w-4" /> Add past attack
            </Button>
          )}
          {attacks.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No attacks logged yet.</p>
          )}
          {attacks.length > 0 && filteredAttacks.length === 0 && (
            <FilterEmpty noun="attacks" query={query} onClear={() => setQuery('')} />
          )}
          {filteredAttacks.map((a) => {
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
            const attackMeds = medsByAttack.get(a.id) ?? [];
            return (
              <div key={a.id} className="rounded-xl border border-slate-800/70 bg-slate-900/70 p-3">
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
                            className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                            style={{ background: medColor(m.medId), color: textOn(medColor(m.medId)) }}
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
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                        aria-label={`Edit attack ${fmtDateFull(a.start)} at ${fmtTime(a.start)}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setDeleteId(a.id)}
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-950 hover:text-rose-400"
                        aria-label={`Delete attack ${fmtDateFull(a.start)} at ${fmtTime(a.start)}`}
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

        <TabsContent value="meds" className="mt-4">
          {!readOnly && (
            <Button variant="outline" className="mb-2 h-11 w-full gap-2" onClick={() => setNewMedOpen(true)}>
              <Plus className="h-4 w-4" /> Add past medication
            </Button>
          )}
          {meds.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No medications logged yet.</p>
          )}
          {meds.length > 0 && filteredMeds.length === 0 && (
            <FilterEmpty noun="medications" query={query} onClear={() => setQuery('')} />
          )}
          {filteredMeds.length > 0 && (
            <div className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
              {filteredMeds.map((m) => (
                <div key={m.id} className="flex items-center gap-3 px-3 py-2.5">
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
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                        aria-label={`Edit ${medName(m.medId)} ${fmtDateFull(m.ts)} at ${fmtTime(m.ts)}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setDeleteMedId(m.id)}
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-950 hover:text-rose-400"
                        aria-label={`Delete ${medName(m.medId)} ${fmtDateFull(m.ts)} at ${fmtTime(m.ts)}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="refills" className="mt-4 space-y-1.5">
          {!readOnly && (
            <Button
              variant="outline"
              className="mb-2 h-11 w-full gap-2"
              onClick={openNewRefill}
            >
              <Plus className="h-4 w-4" /> Add pickup
            </Button>
          )}
          <p className="text-xs text-slate-400">
            Pharmacy pickups — refill cadence is a good historical signal for
            how bad things were, even in weeks you didn't track.
          </p>
          {refills.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No pickups logged yet.</p>
          )}
          {refills.length > 0 && filteredRefills.length === 0 && (
            <FilterEmpty noun="pickups" query={query} onClear={() => setQuery('')} />
          )}
          {filteredRefills.length > 0 && (
            <div className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
              {filteredRefills.map((r) => {
                const gap = refillGaps.get(r.id);
                const c = medColor(r.medId);
                return (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2.5">
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
                          className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                          aria-label={`Edit ${medName(r.medId)} pickup on ${r.date}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setDeleteRefillId(r.id)}
                          className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-950 hover:text-rose-400"
                          aria-label={`Delete ${medName(r.medId)} pickup on ${r.date}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="workouts" className="mt-4">
          {!readOnly && (
            <Button variant="outline" className="mb-2 h-11 w-full gap-2" onClick={() => setNewWorkoutOpen(true)}>
              <Plus className="h-4 w-4" /> Add past workout
            </Button>
          )}
          {workouts.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No workouts logged yet.</p>
          )}
          {workouts.length > 0 && filteredWorkouts.length === 0 && (
            <FilterEmpty noun="workouts" query={query} onClear={() => setQuery('')} />
          )}
          {filteredWorkouts.length > 0 && (
            <div className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
              {filteredWorkouts.map((w) => (
                <div key={w.id} className="flex items-center gap-3 px-3 py-2.5">
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
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                        aria-label={`Edit ${WORKOUT_KIND_LABEL[w.kind]} workout ${fmtDateFull(w.performedAt)} at ${fmtTime(w.performedAt)}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setDeleteWorkoutId(w.id)}
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-950 hover:text-rose-400"
                        aria-label={`Delete ${WORKOUT_KIND_LABEL[w.kind]} workout ${fmtDateFull(w.performedAt)} at ${fmtTime(w.performedAt)}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
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
                <DialogTitle>{refillEditId ? 'Edit pickup' : 'Add pickup'}</DialogTitle>
                <DialogDescription>
                  {refillEditId
                    ? 'Update the pickup date, tablet count, or notes for this refill.'
                    : 'Record a pharmacy pickup to track refill cadence and Nurtec stock.'}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                {refillEditId ? (
                  <div className="space-y-1.5">
                    <span className="text-sm font-medium">Medication</span>
                    <div className="text-sm font-semibold text-slate-200">{medName(refillMed)}</div>
                  </div>
                ) : (
                  <fieldset className="space-y-1.5">
                    <legend className="text-sm font-medium">Medication</legend>
                    <div className="grid grid-cols-3 gap-1.5">
                      {allMedIds([...state.meds, ...state.refills]).map((id) => (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={refillMed === id}
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
                  </fieldset>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="refill-date">Pickup date</Label>
                  <Input
                    id="refill-date"
                    type="date"
                    value={refillDate}
                    onChange={(e) => setRefillDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="refill-tablets">
                    Tablets <span className="font-normal text-slate-400">(blank = unknown)</span>
                  </Label>
                  <Input
                    id="refill-tablets"
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
                  <Label htmlFor="refill-notes">
                    Notes <span className="font-normal text-slate-400">(pharmacy…)</span>
                  </Label>
                  <Input
                    id="refill-notes"
                    value={refillNotes}
                    onChange={(e) => setRefillNotes(e.target.value)}
                    placeholder="e.g. CVS"
                  />
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
                  className={DANGER_ACTION_CLASS}
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
                  className={DANGER_ACTION_CLASS}
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
                  className={DANGER_ACTION_CLASS}
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
                  className={DANGER_ACTION_CLASS}
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
