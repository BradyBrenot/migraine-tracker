import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Play, Square, Gauge, Pill, PenLine, History as HistoryIcon, Zap } from 'lucide-react';
import { useStore, usageDaysInWindow } from '@/lib/store';
import { MED_CATALOG, painColor, medColor, medName, textOn } from '@/lib/meds';
import { fmtDuration, fmtTime, fmtDateFull } from '@/lib/format';
import AttackFormDialog from '@/components/AttackFormDialog';
import MedFormDialog from '@/components/MedFormDialog';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function Home() {
  const store = useStore();
  const { activeAttack, state } = store;
  const now = useNow(15000);

  const [painOpen, setPainOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [pastMedOpen, setPastMedOpen] = useState(false);

  const todaysMeds = useMemo(() => {
    const today = new Date().toDateString();
    return state.meds.filter((m) => new Date(m.ts).toDateString() === today)
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }, [state.meds]);

  // Nurtec usage badge for the quick grid
  const nurtecDays = usageDaysInWindow(state.meds, 'nurtec', 30);

  function handleStart() {
    store.startAttack();
    toast.success('Attack started — hang in there 💜', {
      description: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    });
    setPainOpen(true);
  }

  function handleEnd() {
    if (!activeAttack) return;
    store.endAttack(activeAttack.id);
    toast.success('Attack ended — logged.', {
      description: `Duration: ${fmtDuration(Date.now() - new Date(activeAttack.start).getTime())}`,
    });
  }

  function handlePain(level: number) {
    if (activeAttack) {
      store.logPain(activeAttack.id, level);
      toast.success(`Pain logged: ${level}/10`);
    } else {
      const a = store.startAttack();
      store.logPain(a.id, level);
      toast.success(`Attack started at ${level}/10`);
    }
    setPainOpen(false);
  }

  function handleMed(medId: string) {
    const entry = store.logMed(medId, new Date(), activeAttack?.id ?? null, state.doses[medId] ?? '');
    toast.success(`${medName(medId)} logged`, {
      description: `${state.doses[medId] ? state.doses[medId] + ' · ' : ''}${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
      action: {
        label: 'Undo',
        onClick: () => store.deleteMed(entry.id),
      },
    });
  }

  const acuteMeds = MED_CATALOG.filter((m) => m.kind !== 'preventive');
  const preventives = MED_CATALOG.filter((m) => m.kind === 'preventive');

  return (
    <div className="mx-auto max-w-xl space-y-6">
      {/* ── Active attack banner / start button ─────────────────── */}
      {activeAttack ? (
        <section className="overflow-hidden rounded-2xl border border-rose-900 bg-gradient-to-br from-rose-950 to-slate-950 shadow-sm">
          <div className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-rose-300">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-600" />
                </span>
                Attack in progress
              </div>
              <button
                onClick={() => setEditOpen(true)}
                className="flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-200"
              >
                <PenLine className="h-3.5 w-3.5" /> details
              </button>
            </div>
            <div className="mt-2 text-4xl font-black tabular-nums tracking-tight text-slate-100">
              {fmtDuration(now - new Date(activeAttack.start).getTime())}
            </div>
            <div className="mt-1 text-sm text-slate-400">
              started {fmtDateFull(activeAttack.start)} at {fmtTime(activeAttack.start)}
              {activeAttack.peakPain >= 0 && (
                <>
                  {' · '}peak{' '}
                  <span className="font-bold" style={{ color: painColor(activeAttack.peakPain) }}>
                    {activeAttack.peakPain}/10
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x border-t border-rose-900">
            <button
              onClick={() => setPainOpen(true)}
              className="flex items-center justify-center gap-2 bg-slate-900/60 py-4 text-base font-semibold text-slate-200 transition-colors hover:bg-slate-900"
            >
              <Gauge className="h-5 w-5 text-rose-500" />
              Log pain
            </button>
            <button
              onClick={handleEnd}
              className="flex items-center justify-center gap-2 bg-slate-900/60 py-4 text-base font-semibold text-slate-200 transition-colors hover:bg-slate-900"
            >
              <Square className="h-5 w-5 text-emerald-400" />
              Attack ended
            </button>
          </div>
        </section>
      ) : (
        <button
          onClick={handleStart}
          className="group flex w-full items-center justify-center gap-3 rounded-2xl bg-red-600 py-8 text-xl font-bold text-white shadow-lg shadow-red-950 transition-colors hover:bg-red-500 active:scale-[0.98]"
        >
          <Play className="h-7 w-7 transition-transform group-hover:scale-110" />
          Attack started
        </button>
      )}

      {/* ── Medications ─────────────────────────────────────────── */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-400">
            <Pill className="h-4 w-4" /> Took a med
          </h2>
          <span className="text-xs text-slate-400">one tap = logged now</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {acuteMeds.map((m) => (
            <button
              key={m.id}
              onClick={() => handleMed(m.id)}
              className="relative rounded-xl border bg-slate-900 p-3 text-left shadow-sm transition-all hover:shadow active:scale-[0.97]"
            >
              <span
                className="mb-1.5 block h-1.5 w-8 rounded-full"
                style={{ background: m.color }}
              />
              <div className="font-semibold leading-tight">{m.name}</div>
              <div className="text-[11px] text-slate-400">{m.kindLabel}</div>
              {m.id === 'nurtec' && (
                <span
                  className={`absolute right-2 top-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    nurtecDays >= 13
                      ? 'bg-rose-950 text-rose-300'
                      : nurtecDays >= 10
                        ? 'bg-amber-950 text-amber-300'
                        : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {nurtecDays}/15
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {preventives.map((m) => (
            <button
              key={m.id}
              onClick={() => handleMed(m.id)}
              className="flex items-center gap-3 rounded-xl border bg-slate-900 p-3 text-left shadow-sm transition-all hover:shadow active:scale-[0.97]"
            >
              <span className="h-8 w-1.5 rounded-full" style={{ background: m.color }} />
              <span>
                <span className="block font-semibold leading-tight">{m.name}</span>
                <span className="block text-[11px] text-slate-400">{m.kindLabel}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ── Today's meds ────────────────────────────────────────── */}
      {todaysMeds.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">
            Today
          </h2>
          <div className="space-y-1.5">
            {todaysMeds.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 rounded-lg border bg-slate-900 px-3 py-2 text-sm"
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: medColor(m.medId) }} />
                <span className="font-medium">{medName(m.medId)}</span>
                {m.dose && <span className="text-slate-400">{m.dose}</span>}
                <span className="ml-auto text-xs tabular-nums text-slate-400">{fmtTime(m.ts)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Secondary actions ───────────────────────────────────── */}
      <section className="grid grid-cols-3 gap-2">
        <Button variant="outline" className="h-12 gap-1.5 px-2" onClick={() => setNewOpen(true)}>
          <HistoryIcon className="h-4 w-4 shrink-0" />
          <span className="text-xs sm:text-sm">Past attack</span>
        </Button>
        <Button variant="outline" className="h-12 gap-1.5 px-2" onClick={() => setPastMedOpen(true)}>
          <Pill className="h-4 w-4 shrink-0" />
          <span className="text-xs sm:text-sm">Past med</span>
        </Button>
        <Button
          variant="outline"
          className="h-12 gap-1.5 px-2"
          onClick={() => (activeAttack ? setEditOpen(true) : setPainOpen(true))}
        >
          <Zap className="h-4 w-4 shrink-0" />
          <span className="text-xs sm:text-sm">{activeAttack ? 'Edit details' : 'Log pain'}</span>
        </Button>
      </section>

      {!state.seeded && state.attacks.length === 0 && (
        <div className="rounded-xl border border-dashed bg-slate-900 p-4 text-center text-sm text-slate-400">
          <p>No data yet. This demo stores everything in your browser only.</p>
          <button
            onClick={() => {
              store.loadDemoData();
              toast.success('Demo data loaded — check the Calendar & Reports tabs');
            }}
            className="mt-2 font-semibold text-slate-100 underline underline-offset-2"
          >
            Load 75 days of demo data
          </button>
        </div>
      )}

      {/* ── Pain quick-log dialog ───────────────────────────────── */}
      <Dialog open={painOpen} onOpenChange={setPainOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>How bad is it right now?</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-4 gap-2 py-2">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <button
                key={n}
                onClick={() => handlePain(n)}
                className="rounded-xl py-4 text-xl font-black shadow-sm transition-transform active:scale-95"
                style={{ background: painColor(n), color: textOn(painColor(n)) }}
              >
                {n}
              </button>
            ))}
            <button
              onClick={() => handlePain(0)}
              className="col-span-2 rounded-xl bg-slate-700 py-4 text-xl font-black text-slate-300 transition-transform active:scale-95"
            >
              0
            </button>
          </div>
          <p className="text-center text-xs text-slate-400">
            {activeAttack
              ? 'Logged against your current attack'
              : 'No active attack — this will start one'}
          </p>
        </DialogContent>
      </Dialog>

      <AttackFormDialog
        attack={activeAttack}
        open={editOpen}
        onClose={() => setEditOpen(false)}
      />
      <AttackFormDialog
        attack={null}
        open={newOpen}
        onClose={() => setNewOpen(false)}
      />
      <MedFormDialog
        med={null}
        open={pastMedOpen}
        onClose={() => setPastMedOpen(false)}
        defaultAttackId={activeAttack?.id ?? null}
      />
    </div>
  );
}
