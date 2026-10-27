import { useMemo } from 'react';
import { Activity, Clock, Dumbbell, Package, Pill } from 'lucide-react';
import { useStore } from '@/lib/store';
import { useNow } from '@/lib/clock';
import { NURTEC_DEFAULT_RULE, resolveRule, usageDaysInWindow } from '@/lib/usage';
import { nurtecInventory } from '@/lib/inventory';
import { medColor, medName, painColor } from '@/lib/meds';
import { fmtDateFull, fmtDuration, fmtTime } from '@/lib/format';
import { addDays, dayKeyStartMs, localDayKey } from '../../shared/datetime.ts';
import { effectiveDayState } from '../../shared/daystate.ts';
import type { DayStateStatus, MedEvent, WorkoutKind } from '@/types';

const DAY_STATE_LABEL: Record<DayStateStatus, string> = {
  well: 'Well',
  off: 'Off',
  attack: 'Attack',
};

const DAY_STATE_CLASS: Record<DayStateStatus, string> = {
  well: 'text-emerald-300',
  off: 'text-amber-300',
  attack: 'text-rose-300',
};

const WORKOUT_KIND_LABEL: Record<WorkoutKind, string> = {
  strength: 'Strength',
  cardio: 'Cardio',
  mobility: 'Mobility',
};

/** Shared read-only row content for logged medications (Today and attack-linked). */
function MedRowContent({ med, time }: { med: MedEvent; time: string }) {
  return (
    <>
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: medColor(med.medId) }}
      />
      <span className="font-medium text-slate-200">{medName(med.medId)}</span>
      {med.dose && <span className="text-slate-400">{med.dose}</span>}
      {med.quantity != null && (
        <span className="text-xs text-slate-400">{med.quantity} tab</span>
      )}
      <span className="ml-auto text-xs tabular-nums text-slate-400">{time}</span>
    </>
  );
}

/**
 * Read-only "Now" page for the partner viewer.
 *
 * It renders current state only — active attack, today's wellness/meds/workouts,
 * and Nurtec stock/use — with no buttons, dialogs, or store mutations at all.
 */
export default function PartnerHome() {
  const { state, activeAttack, serverMode, sync } = useStore();
  const now = useNow();

  const todayKey = localDayKey(now, state.timezone);
  const todayRecord = state.dayStates.find((d) => d.day === todayKey) ?? null;

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
  }, [activeAttack, todayKey, state.timezone, state.attacks, now]);

  // Display precedence only: while an attack is actually active, the partner
  // "Now" page must never read "Well" or "Normal routine today." even if an
  // explicit day record for today says so. `effectiveDayState` keeps its own
  // explicit-wins semantics for every other consumer.
  const todayState: DayStateStatus | null = activeAttack
    ? 'attack'
    : effectiveDayState(todayRecord, attackOverlapsToday);

  const todaysMeds = useMemo(() => {
    return state.meds
      .filter((m) => {
        const ms = Date.parse(m.ts);
        return Number.isFinite(ms) && localDayKey(ms, state.timezone) === todayKey;
      })
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }, [state.meds, state.timezone, todayKey]);

  const todaysWorkouts = useMemo(
    () => state.workouts
      .filter((w) => {
        const ms = Date.parse(w.performedAt);
        return Number.isFinite(ms) && localDayKey(ms, state.timezone) === todayKey;
      })
      .sort((a, b) => b.performedAt.localeCompare(a.performedAt)),
    [state.workouts, state.timezone, todayKey],
  );

  const attackMeds: Array<{ med: MedEvent; ms: number | null }> = useMemo(() => {
    if (!activeAttack) return [];
    return state.meds
      .filter((m) => m.attackId === activeAttack.id)
      .map((med) => {
        const ms = Date.parse(med.ts);
        return { med, ms: Number.isFinite(ms) ? ms : null };
      })
      // Newest first; unparseable timestamps sort last and render without a time.
      .sort((a, b) => {
        if (a.ms === null || b.ms === null) {
          return a.ms === null ? (b.ms === null ? 0 : 1) : -1;
        }
        return b.ms - a.ms;
      });
  }, [activeAttack, state.meds]);

  const lastEndedAttack = useMemo(
    () => [...state.attacks]
      .filter((a) => a.end !== null)
      .sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''))[0] ?? null,
    [state.attacks],
  );

  const nurtecStock = nurtecInventory(state, now);
  // Same resolved rule the writer's Home and the Calendar use: a partial or
  // malformed imported rule falls back per field instead of printing NaN.
  const nurtecRule = resolveRule(state.rules.nurtec, NURTEC_DEFAULT_RULE);
  const nurtecUse = usageDaysInWindow(
    state.meds, 'nurtec', nurtecRule.windowDays, now, state.timezone,
  );

  const startMs = activeAttack ? Date.parse(activeAttack.start) : Number.NaN;
  const durationMs = Number.isFinite(startMs) ? Math.max(0, now - startMs) : null;
  const latestPain = activeAttack && activeAttack.painLog.length > 0
    ? [...activeAttack.painLog].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)?.level ?? null
    : null;

  const initialLoading = !serverMode && sync.status !== 'error';
  const unavailable = !serverMode && sync.status === 'error';
  const stale = serverMode && sync.status === 'error';

  const stockLabel = nurtecStock.quantity === null
    ? 'No count recorded'
    : `${nurtecStock.quantity} tablet${Math.abs(nurtecStock.quantity) === 1 ? '' : 's'}`;

  if (unavailable) {
    return (
      <div className="mx-auto max-w-xl">
        <section className="rounded-2xl border border-rose-900 bg-rose-950/40 p-5 text-center">
          <h1 className="text-lg font-bold text-rose-200">Current status unavailable</h1>
          <p className="mt-1 text-sm text-slate-300">
            The server could not be reached. This view retries automatically.
          </p>
        </section>
      </div>
    );
  }

  if (initialLoading) {
    return (
      <div className="mx-auto max-w-xl">
        <section
          aria-live="polite"
          className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-center"
        >
          <p className="text-sm font-semibold text-slate-200">Loading current status…</p>
          <p className="mt-1 text-xs text-slate-400">Fetching the latest update from the server.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 sm:space-y-5">
      {stale && (
        <div
          role="status"
          className="rounded-xl border border-amber-900 bg-amber-950/50 px-3 py-2 text-xs font-medium text-amber-300"
        >
          Showing the last data received — reconnecting automatically.
        </div>
      )}

      {/* ── Active attack or calm state ─────────────────────────── */}
      {activeAttack ? (
        <section className="overflow-hidden rounded-2xl border border-rose-900 bg-gradient-to-br from-rose-950 to-slate-950 shadow-sm">
          <div className="p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-rose-300">
              <span className="h-2.5 w-2.5 rounded-full bg-attack" aria-hidden="true" />
              Attack in progress
            </div>
            <div className="mt-2 text-4xl font-black tabular-nums tracking-tight text-slate-100">
              {durationMs === null ? '—' : fmtDuration(durationMs)}
            </div>
            <div className="mt-1 text-sm text-slate-400">
              started {fmtDateFull(activeAttack.start)} at {fmtTime(activeAttack.start)}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-slate-300">
              <span>
                Peak{' '}
                <span
                  className="font-bold"
                  style={{ color: painColor(activeAttack.peakPain) }}
                >
                  {activeAttack.peakPain >= 0 ? `${activeAttack.peakPain}/10` : 'not recorded'}
                </span>
              </span>
              {latestPain !== null && (
                <span>
                  Latest pain{' '}
                  <span className="font-bold" style={{ color: painColor(latestPain) }}>
                    {latestPain}/10
                  </span>
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-300">Rest if you need to — recovery comes first.</p>

            {/* Attack-linked medications only — distinct from all meds today. */}
            <div className="mt-4 border-t border-rose-900/60 pt-3">
              <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-rose-200">
                <Pill className="h-3.5 w-3.5" /> Medications for this attack
              </h2>
              {attackMeds.length === 0 ? (
                <p className="mt-1 text-sm text-slate-400">
                  No medication linked to this attack.
                </p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {attackMeds.map(({ med, ms }) => (
                    <li key={med.id} className="flex items-center gap-2 text-sm">
                      <MedRowContent med={med} time={ms === null ? '—' : fmtTime(med.ts)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-sm">
          <h1 className="flex items-center gap-2 text-lg font-bold text-slate-100">
            <Activity className="h-5 w-5 text-emerald-400" /> No active attack
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            No attack is in progress right now.
          </p>
          {lastEndedAttack && (
            <p className="mt-2 text-xs text-slate-400">
              Last attack ended {fmtDateFull(lastEndedAttack.end!)}{' '}
              at {fmtTime(lastEndedAttack.end!)}
              {Number.isFinite(Date.parse(lastEndedAttack.start))
                && Number.isFinite(Date.parse(lastEndedAttack.end!)) && (
                  <> · lasted {fmtDuration(
                    Date.parse(lastEndedAttack.end!) - Date.parse(lastEndedAttack.start),
                  )}</>
                )}
            </p>
          )}
        </section>
      )}

      {/* ── Today ───────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">Today</h2>
          <span
            className={`text-sm font-semibold ${
              todayState === null ? 'text-slate-400' : DAY_STATE_CLASS[todayState]
            }`}
          >
            {todayState === null
              ? 'Not logged'
              : todayState === 'attack' && !todayRecord
                ? 'Attack (from attacks)'
                : DAY_STATE_LABEL[todayState]}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          {todayState === 'well'
            ? 'Normal routine today.'
            : todayState === 'off'
              ? 'Easy day — resting and taking it slow.'
              : todayState === 'attack'
                ? 'Rest if you need to — recovery comes first.'
                : 'No check-in yet today.'}
        </p>

        <div className="mt-4 border-t border-slate-800/70 pt-3">
          <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
            <Pill className="h-3.5 w-3.5" /> Medications
          </h3>
          {todaysMeds.length === 0 ? (
            <p className="mt-1 text-sm text-slate-400">None logged today.</p>
          ) : (
            <div className="mt-1.5 space-y-1.5">
              {todaysMeds.map((m) => (
                <div key={m.id} className="flex items-center gap-2 text-sm">
                  <MedRowContent med={m} time={fmtTime(m.ts)} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 border-t border-slate-800/70 pt-3">
          <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
            <Dumbbell className="h-3.5 w-3.5" /> Workouts
          </h3>
          {todaysWorkouts.length === 0 ? (
            <p className="mt-1 text-sm text-slate-400">None logged today.</p>
          ) : (
            <div className="mt-1.5 space-y-1.5">
              {todaysWorkouts.map((w) => (
                <div key={w.id} className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-slate-200">
                    {WORKOUT_KIND_LABEL[w.kind]} · {w.effort}
                  </span>
                  {w.durationMinutes !== null && (
                    <span className="text-xs text-slate-400">{w.durationMinutes}m</span>
                  )}
                  <span className="ml-auto text-xs tabular-nums text-slate-400">
                    {fmtTime(w.performedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Nurtec stock/use (read-only) ────────────────────────── */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
        <h2 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-slate-400">
          <Package className="h-4 w-4" /> Nurtec
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className={`text-lg font-bold ${nurtecStock.level === 'low' ? 'text-amber-300' : nurtecStock.level === 'negative' ? 'text-rose-300' : 'text-slate-100'}`}>
            {stockLabel}
          </span>
          <span className="flex items-center gap-1 text-xs text-slate-400">
            <Clock className="h-3.5 w-3.5" />
            {nurtecUse} / {nurtecRule.limit} days used in the last {nurtecRule.windowDays}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Estimated from logged doses, refills, and stock corrections. Alert level: {state.lowStockThreshold}.
        </p>
      </section>

      <p className="pb-2 text-center text-[11px] text-slate-400">
        This view refreshes automatically and cannot change any data.
      </p>
    </div>
  );
}
