import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Play, Square, Gauge, Pill, PenLine, History as HistoryIcon } from 'lucide-react';
import { useStore } from '@/lib/store';
import { usageDaysInWindow } from '@/lib/usage';
import { nurtecInventory, type NurtecInventory } from '@/lib/inventory';
import { useNow } from '@/lib/clock';
import { MED_CATALOG, painColor, medColor, medName, textOn } from '@/lib/meds';
import { fmtDuration, fmtTime, fmtDateFull } from '@/lib/format';
import type { MedEvent } from '@/types';
import AttackFormDialog from '@/components/AttackFormDialog';
import MedFormDialog from '@/components/MedFormDialog';
import DayCheckIn from '@/components/DayCheckIn';
import WorkoutQuickLog from '@/components/WorkoutQuickLog';
import { addDays, dayKeyStartMs, localDayKey } from '../../shared/datetime.ts';
import { effectiveDayState } from '../../shared/daystate.ts';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * Compact remaining-stock badge shown beside the rolling-use badge on the
 * Nurtec quick-log button. Wording/colors only — the numbers come from the
 * shared calculation via `nurtecInventory`.
 */
function nurtecStockBadge(stock: NurtecInventory): {
  text: string;
  className: string;
  title: string;
} {
  if (stock.level === 'unknown' || stock.quantity === null) {
    return {
      // Short enough for a 61px card at 360px; the `title` carries the detail.
      text: 'no count',
      className: 'bg-slate-800 text-slate-400',
      title: 'No starting count recorded — add one in Settings.',
    };
  }
  if (stock.level === 'negative') {
    return {
      text: `−${Math.abs(stock.quantity)} stock`,
      className: 'bg-rose-950 text-rose-300',
      title: 'Recorded stock is negative — correct it in Settings.',
    };
  }
  return {
    text: `${stock.quantity} left`,
    className:
      stock.level === 'low' ? 'bg-amber-950 text-amber-300' : 'bg-slate-800 text-slate-400',
    title: 'Optimistic count from this device — the server inventory count is authoritative.',
  };
}

/**
 * A same-med dose is "recent" for two hours. This is purely informational
 * context on the quick-log grid — it never blocks, warns, or disables logging.
 */
const RECENT_DOSE_WINDOW_MS = 2 * 60 * 60 * 1000;
/**
 * The render clock (`useNow`) is deliberately coarse (~15s) and an optimistic
 * `logMed` can land a few milliseconds after the last tick, so a freshly
 * logged timestamp may look slightly "in the future". This tolerance absorbs
 * that skew without ever showing a timestamp that is genuinely ahead.
 */
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/** Latest parseable timestamp (epoch ms) for one med, or null. Invalid `ts`
 * values (empty, malformed, unparseable) are ignored rather than compared. */
function latestDoseMs(meds: MedEvent[], medId: string): number | null {
  let latest: number | null = null;
  for (const m of meds) {
    if (m.medId !== medId) continue;
    const ms = Date.parse(m.ts);
    if (!Number.isFinite(ms)) continue;
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}

/**
 * Age of the most recent same-med dose in ms, or null when it is not usable.
 *
 * Rule: the latest usable event for a medId wins (max parsed timestamp),
 * regardless of attackId, notes, dose, or configured day. The result is only
 * non-null when `ageMs <= RECENT_DOSE_WINDOW_MS` and
 * `ageMs >= -CLOCK_SKEW_TOLERANCE_MS`; display age is clamped to >= 0.
 */
function recentDoseAgeMs(meds: MedEvent[], medId: string, now: number): number | null {
  const latest = latestDoseMs(meds, medId);
  if (latest === null) return null;
  const ageMs = now - latest;
  if (ageMs > RECENT_DOSE_WINDOW_MS || ageMs < -CLOCK_SKEW_TOLERANCE_MS) return null;
  return Math.max(0, ageMs);
}

/** "25m" / "1h 5m" / "<1m" — the age part of a last-dose label. */
function doseAgeText(ageMs: number): string {
  return ageMs < 60_000 ? '<1m' : fmtDuration(ageMs);
}

export default function Home() {
  const store = useStore();
  const { activeAttack, state, serverMode } = store;
  const now = useNow();

  const [painOpen, setPainOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [pastMedOpen, setPastMedOpen] = useState(false);

  // Today is the configured-zone local day (same rule as PartnerHome and the
  // weekly workout goals), not the browser's day. Invalid timestamps are
  // skipped instead of producing an "Invalid Date" comparison.
  const todayKey = localDayKey(now, state.timezone);
  const todaysMeds = useMemo(() => {
    return state.meds.filter((m) => {
      const ms = Date.parse(m.ts);
      return Number.isFinite(ms) && localDayKey(ms, state.timezone) === todayKey;
    }).sort((a, b) => b.ts.localeCompare(a.ts));
  }, [state.meds, state.timezone, todayKey]);

  // Nurtec usage badge for the quick grid
  const nurtecDays = usageDaysInWindow(state.meds, 'nurtec', 30, now, state.timezone);
  // Optimistic stock count next to it (server GET /api/inventory/nurtec is authoritative).
  const nurtecStock = nurtecInventory(state, now);
  const nurtecBadge = nurtecStockBadge(nurtecStock);

  // Informational "last dose" hints for the acute quick-log cards, keyed by
  // medId. Recomputed on clock ticks and after optimistic log/undo so the hint
  // appears/disappears without delaying the one-tap log. Preventive cards are
  // excluded — this context belongs to the acute grid only.
  const recentDoseHints = useMemo(() => {
    const hints = new Map<string, string>();
    for (const m of MED_CATALOG) {
      if (m.kind === 'preventive') continue;
      const ageMs = recentDoseAgeMs(state.meds, m.id, now);
      if (ageMs !== null) hints.set(m.id, `Last ${doseAgeText(ageMs)} ago`);
    }
    return hints;
  }, [state.meds, now]);

  // ── Today's wellness state ─────────────────────────────────
  const todayRecord = state.dayStates.find((d) => d.day === todayKey) ?? null;
  // Does any real attack (active or ended) overlap today's local day? An active
  // attack always counts — it is still ongoing.
  const attackOverlapsToday = useMemo(() => {
    if (activeAttack) return true;
    const dayStart = dayKeyStartMs(todayKey, state.timezone);
    const dayEnd = dayKeyStartMs(addDays(todayKey, 1), state.timezone);
    return state.attacks.some((a) => {
      const start = Date.parse(a.start);
      if (!Number.isFinite(start)) return false;
      const end = a.end ? Date.parse(a.end) : now;
      return Number.isFinite(end) && start < dayEnd && end > dayStart;
    });
  }, [todayKey, state.timezone, state.attacks, activeAttack, now]);

  // An explicit Well/Off record still wins over an inferred (or ended) attack
  // day; without a record, an attack overlapping today means Attack/Rest.
  const todayState = useMemo(
    () => effectiveDayState(todayRecord, attackOverlapsToday),
    [todayRecord, attackOverlapsToday],
  );

  // Short guidance for the wellness card. The status pill already names the
  // day, so these describe what the status means instead of repeating it.
  const wellnessGuidance =
    todayState === 'well'
      ? 'Normal routine today.'
      : todayState === 'off'
        ? 'Easy day — a 10-min walk counts (Cardio · Low).'
        : todayState === 'attack'
          ? 'Rest — no exercise needed.'
          : 'How was today?';

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
    // The dialog is only reachable from the active-attack UI or the start CTA,
    // so there is always a real attack to log against.
    if (!activeAttack) {
      setPainOpen(false);
      return;
    }
    store.logPain(activeAttack.id, level);
    toast.success(`Pain logged: ${level}/10`);
    setPainOpen(false);
  }

  function handleMed(medId: string) {
    // Capture one instant: the stored `ts` and the toast time must agree, and
    // the previous-dose context must describe state BEFORE this new entry.
    const when = new Date();
    const previousAgeMs = recentDoseAgeMs(state.meds, medId, when.getTime());
    // New Nurtec doses are one tablet by default; other meds keep dose text only.
    const quantity = medId === 'nurtec' ? 1 : null;
    const entry = store.logMed(
      medId, when, activeAttack?.id ?? null, state.doses[medId] ?? '', '', quantity,
    );
    // Previous-dose context is additive: the configured dose prefix and the
    // logged time always stay, and the Undo action is unchanged.
    const description = [
      state.doses[medId] ?? '',
      when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      previousAgeMs !== null ? `last dose ${doseAgeText(previousAgeMs)} ago` : '',
    ].filter((part) => part !== '').join(' · ');
    toast.success(`${medName(medId)} logged`, {
      description,
      action: {
        label: 'Undo',
        onClick: () => store.deleteMed(entry.id),
      },
    });
  }

  const acuteMeds = MED_CATALOG.filter((m) => m.kind !== 'preventive');
  const preventives = MED_CATALOG.filter((m) => m.kind === 'preventive');

  // Demo seeding replaces local records, so it may only be offered while every
  // local record array is empty — an attack-free med/workout/refill/day-state/
  // baseline history is still real data and must not be overwritten.
  const hasAnyRecords =
    state.attacks.length > 0
    || state.meds.length > 0
    || state.refills.length > 0
    || state.workouts.length > 0
    || state.dayStates.length > 0
    || state.stockBaselines.length > 0;

  return (
    <div className="mx-auto max-w-xl space-y-4 sm:space-y-5">
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
            {/* Rest guidance lives here because the wellness card is hidden
                while an attack is active (it can never re-enable exercise). */}
            <p className="mt-2 text-xs text-slate-400">Rest — no exercise needed.</p>
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
          className="group flex w-full items-center justify-center gap-3 rounded-2xl bg-red-600 py-5 text-xl font-bold text-white transition-colors hover:bg-red-500 active:scale-[0.98] sm:py-8"
        >
          <Play className="h-7 w-7 transition-transform group-hover:scale-110" />
          {attackOverlapsToday ? 'Log another attack' : 'Start attack now'}
        </button>
      )}

      {/* ── Today's wellness ────────────────────────────────────── */}
      {/* Hidden during an active attack: the banner owns guidance then, and an
          earlier Well/Off record must never re-enable exercise logging. */}
      {!activeAttack && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 shadow-sm">
          <div className="p-3">
            <DayCheckIn guidance={wellnessGuidance} effectiveStatus={todayState} />
          </div>
          {todayState !== 'attack' && (
            <div className="border-t border-slate-800/70 px-3 py-2.5">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Movement
              </p>
              <WorkoutQuickLog />
            </div>
          )}
        </section>
      )}

      {/* ── Medications ─────────────────────────────────────────── */}
      <section>
        <div className="mb-1.5 flex items-center justify-between sm:mb-2">
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
              className="flex flex-col rounded-xl border bg-slate-900 p-2.5 text-left shadow-sm transition-all hover:shadow active:scale-[0.97] sm:p-3"
            >
              <span
                className="mb-1.5 block h-1 w-6 rounded-full sm:h-1.5 sm:w-8"
                style={{ background: m.color }}
              />
              <span className="break-words text-sm font-semibold leading-tight sm:text-base">
                {m.name}
              </span>
              <span
                className="truncate text-[10px] text-slate-400 sm:text-[11px]"
                title={m.kindLabel}
              >
                {m.kindLabel}
              </span>
              {recentDoseHints.has(m.id) && (
                <span className="block break-words text-[10px] leading-tight tabular-nums text-slate-400 sm:text-[11px]">
                  {recentDoseHints.get(m.id)}
                </span>
              )}
              {m.id === 'nurtec' && (
                <span className="mt-auto flex flex-wrap items-center gap-1 pt-1.5">
                  <span
                    className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                      nurtecDays >= 13
                        ? 'bg-rose-950 text-rose-300'
                        : nurtecDays >= 10
                          ? 'bg-amber-950 text-amber-300'
                          : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {nurtecDays}/15
                  </span>
                  <span
                    className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold ${nurtecBadge.className}`}
                    title={nurtecBadge.title}
                  >
                    {nurtecBadge.text}
                  </span>
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5 sm:gap-2">
          {preventives.map((m) => (
            <button
              key={m.id}
              onClick={() => handleMed(m.id)}
              className="flex items-center gap-3 rounded-xl border bg-slate-900 p-2.5 text-left shadow-sm transition-all hover:shadow active:scale-[0.97] sm:p-3"
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
      <section className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          className="h-11 gap-1.5 border-slate-800 bg-slate-900/40 px-2 text-slate-300 hover:bg-slate-900 hover:text-slate-100"
          onClick={() => setNewOpen(true)}
        >
          <HistoryIcon className="h-4 w-4 shrink-0" />
          <span className="text-xs sm:text-sm">Past attack</span>
        </Button>
        <Button
          variant="outline"
          className="h-11 gap-1.5 border-slate-800 bg-slate-900/40 px-2 text-slate-300 hover:bg-slate-900 hover:text-slate-100"
          onClick={() => setPastMedOpen(true)}
        >
          <Pill className="h-4 w-4 shrink-0" />
          <span className="text-xs sm:text-sm">Past med</span>
        </Button>
      </section>

      {/* Local-only demo seeding. The server import is additive
          (`INSERT OR IGNORE`), so in confirmed server mode this action would
          silently append demo records to canonical server data. Gate on
          `serverMode` (a backend was confirmed reachable via hydration), not
          on hydration completion: before the first `/api/export` resolves
          this is still local mode. It also requires an entirely empty local
          state because `loadDemoData` would replace any existing records. */}
      {!serverMode && !state.seeded && !hasAnyRecords && (
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
            <DialogTitle>How bad is the pain right now?</DialogTitle>
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
            Logged against your current attack
          </p>
          <p className="text-center text-xs text-slate-400">
            0 = no pain, but still an attack.
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
