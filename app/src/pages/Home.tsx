import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Play, Square, Gauge, Pill, PenLine, History as HistoryIcon } from 'lucide-react';
import { useStore } from '@/lib/store';
import {
  NURTEC_DEFAULT_RULE, PAINKILLER_MED_IDS, limitState, medUnionDaysInWindow,
  resolveRule, resolveSharedPainkillerRule, usageDaysInWindow, type LimitState,
} from '@/lib/usage';
import { nurtecInventory, type NurtecInventory } from '@/lib/inventory';
import { useNow } from '@/lib/clock';
import { MED_CATALOG, painColor, medColor, medName, textOn } from '@/lib/meds';
import { fmtDuration, fmtTime, fmtDateFull } from '@/lib/format';
import type { MedEvent } from '@/types';
import AttackFormDialog from '@/components/AttackFormDialog';
import MedFormDialog from '@/components/MedFormDialog';
import DayCheckIn from '@/components/DayCheckIn';
import WorkoutQuickLog from '@/components/WorkoutQuickLog';
import WeatherCard from '@/components/WeatherCard';
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
      className: 'bg-slate-800 text-slate-300',
      title: 'No starting count recorded — add one in Settings.',
    };
  }
  if (stock.level === 'negative') {
    return {
      text: `−${Math.abs(stock.quantity)} stock`,
      className: 'bg-red-950 text-red-300',
      title: 'Recorded stock is negative — correct it in Settings.',
    };
  }
  return {
    text: `${stock.quantity} left`,
    className:
      stock.level === 'low' ? 'bg-amber-950 text-amber-300' : 'bg-slate-800 text-slate-300',
    title: 'Optimistic count from this device — the server inventory count is authoritative.',
  };
}

/**
 * Rolling-use pill shared by the Nurtec and combined-painkiller chips, so both
 * groups carry the same ok/near/over colours.
 */
function usagePillClass(usage: LimitState): string {
  return `whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${
    usage === 'over'
      ? 'bg-red-950 text-red-300'
      : usage === 'near'
        ? 'bg-amber-950 text-amber-300'
        : 'bg-slate-800 text-slate-200'
  }`;
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

/**
 * Attack-day guidance. The Log page deliberately keeps wellness and movement
 * available during an attack (the user explicitly overrode the old
 * hide-everything state), so the copy must never claim exercise is impossible
 * while the movement controls are on screen. It is guidance, not a rule.
 */
const ATTACK_GUIDANCE = 'Rest if you need to — movement is optional.';

export default function Home() {
  const store = useStore();
  const { activeAttack, state, serverMode } = store;
  const now = useNow();

  const [painOpen, setPainOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [pastMedOpen, setPastMedOpen] = useState(false);

  /**
   * Latest committed state for deferred callbacks. Toast actions are created
   * during an event and can fire much later; reading the render closure would
   * act on a stale snapshot (e.g. an Undo that reopens the previous attack
   * after a new one has started).
   */
  const latestStateRef = useRef(state);
  useEffect(() => {
    latestStateRef.current = state;
  }, [state]);

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

  // Nurtec usage badge for the quick grid. The configured rule (not a hardcoded
  // 15/30) drives the denominator and the window; a partial imported rule falls
  // back per field instead of rendering NaN or "undefinedd".
  const nurtecRule = resolveRule(state.rules.nurtec, NURTEC_DEFAULT_RULE);
  const nurtecDays = usageDaysInWindow(
    state.meds, 'nurtec', nurtecRule.windowDays, now, state.timezone,
  );
  // Shared severity rule: over only past the limit; near needs a used day, so
  // an untouched low limit never warns.
  const nurtecUsage = limitState(nurtecDays, nurtecRule.limit);
  // Optimistic stock count next to it (server GET /api/inventory/nurtec is authoritative).
  const nurtecStock = nurtecInventory(state, now);
  const nurtecBadge = nurtecStockBadge(nurtecStock);

  // Tylenol, Ibuprofen and Naproxen share ONE MOH day budget, so all three
  // cards show the same combined chip (distinct configured-zone days across the
  // three). Nurtec keeps its own independent rule.
  const painkillerRule = resolveSharedPainkillerRule(state.rules);
  const painkillerDays = medUnionDaysInWindow(
    state.meds, PAINKILLER_MED_IDS, painkillerRule.windowDays, now, state.timezone,
  );
  const painkillerUsage = limitState(painkillerDays, painkillerRule.limit);
  const painkillerUsageText =
    painkillerUsage === 'over'
      ? 'over limit'
      : painkillerUsage === 'near'
        ? 'near limit'
        : 'within limit';
  const painkillerChipLabel =
    `Painkillers combined: ${painkillerDays} of ${painkillerRule.limit} allowed days in the last ${painkillerRule.windowDays} days, ${painkillerUsageText}`;
  const painkillerChipTitle =
    `Painkillers combined (Tylenol, Ibuprofen, Naproxen): ${painkillerDays} of ${painkillerRule.limit} allowed days in the last ${painkillerRule.windowDays} days`;

  // Informational "last dose" hints for the acute quick-log cards, keyed by
  // medId. Recomputed on clock ticks and after optimistic log/undo so the hint
  // appears/disappears without delaying the one-tap log. Preventive cards are
  // excluded — this context belongs to the acute grid only.
  //
  // One pass over the medication history builds the latest usable instant per
  // medId (previously each acute card rescanned the whole history). Invalid
  // timestamps are ignored rather than compared; the latest usable event wins
  // regardless of attackId, notes, or dose.
  const recentDoseHints = useMemo(() => {
    const latestByMed = new Map<string, number>();
    for (const med of state.meds) {
      const ms = Date.parse(med.ts);
      if (!Number.isFinite(ms)) continue;
      const latest = latestByMed.get(med.medId);
      if (latest === undefined || ms > latest) latestByMed.set(med.medId, ms);
    }
    const hints = new Map<string, string>();
    for (const m of MED_CATALOG) {
      if (m.kind === 'preventive') continue;
      const latest = latestByMed.get(m.id);
      if (latest === undefined) continue;
      const ageMs = now - latest;
      if (ageMs > RECENT_DOSE_WINDOW_MS || ageMs < -CLOCK_SKEW_TOLERANCE_MS) continue;
      hints.set(m.id, `Last ${doseAgeText(Math.max(0, ageMs))} ago`);
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

  // An explicit Well/Off record still wins over the attack-day inference; with
  // no record an attack overlapping today infers Off (attack days are days off).
  // While an attack is active the card's display override shows Attack instead.
  const todayState = useMemo(
    () => effectiveDayState(todayRecord, attackOverlapsToday),
    [todayRecord, attackOverlapsToday],
  );

  // Short guidance for the wellness card. The status pill already names the
  // day, so these describe what the status means instead of repeating it. An
  // active attack wins for guidance (an earlier explicit Well record must not
  // read "Normal routine today" under an active-attack banner).
  const guidanceState = activeAttack ? 'attack' : todayState;
  const wellnessGuidance =
    guidanceState === 'well'
      ? 'Normal routine today.'
      : guidanceState === 'off'
        ? 'Easy day — a 10-min walk counts (Cardio · Low).'
        : guidanceState === 'attack'
          ? ATTACK_GUIDANCE
          : 'How was today?';

  function handleStart() {
    // `markDayOff` is the real current-attack transition (event-driven, never a
    // mount effect): today becomes Off while an active attack is displayed.
    // The store keeps in-memory provenance for the replaced record, so the
    // toast Undo (a plain deleteAttack) can restore it exactly once.
    const attack = store.startAttack(new Date(), true);
    toast.success('Attack started — hang in there 💜', {
      description: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      action: {
        label: 'Undo',
        onClick: () => store.deleteAttack(attack.id),
      },
    });
    setPainOpen(true);
  }

  function handleEnd() {
    if (!activeAttack) return;
    const { id } = activeAttack;
    // `markDayOff` covers attacks that were already active without rewriting
    // today (a restored session): ending them now still leaves the day Off.
    store.endAttack(id, new Date(), true);
    toast.success('Attack ended — logged.', {
      description: `Duration: ${fmtDuration(Date.now() - new Date(activeAttack.start).getTime())}`,
      action: {
        // Reopening is a normal end-patch through the same queue, so undo keeps
        // the offline/dirty bookkeeping identical to any other write. It must
        // never run while a DIFFERENT attack is active: the user may have
        // started attack B after this toast appeared, and reopening A would
        // leave two open attacks and divert later dose association.
        label: 'Undo',
        onClick: () => {
          const latest = latestStateRef.current;
          const otherActive = latest.attacks.find((a) => a.end === null && a.id !== id);
          if (otherActive) {
            toast.warning('Another attack is in progress', {
              description: 'End the current attack before reopening the earlier one.',
            });
            return;
          }
          store.updateAttack(id, { end: null });
        },
      },
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
      <h1 className="sr-only">Migraine log</h1>

      {/* ── Active attack / start ───────────────────────────────── */}
      {activeAttack ? (
        <section
          aria-labelledby="active-attack-title"
          className="overflow-hidden rounded-xl border border-attack-border bg-gradient-to-br from-attack-muted to-slate-950 shadow-sm"
        >
          <div className="p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-attack">
                <span className="h-2.5 w-2.5 rounded-full bg-attack" aria-hidden="true" />
                <h2 id="active-attack-title">Attack in progress</h2>
              </div>
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-900/60 hover:text-slate-100"
              >
                <PenLine className="h-3.5 w-3.5" /> details
              </button>
            </div>
            <div className="mt-1.5 text-4xl font-black tabular-nums tracking-tight text-slate-50">
              {fmtDuration(now - new Date(activeAttack.start).getTime())}
            </div>
            <div className="mt-1 text-sm text-slate-300">
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

          {/* Same action row: pain is primary; ending stays smaller and secondary. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-attack-border/70 p-3">
            <button
              type="button"
              onClick={() => setPainOpen(true)}
              className="flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-lg bg-attack text-base font-bold text-attack-foreground transition-colors hover:bg-attack/90 active:scale-[0.99]"
            >
              <Gauge className="h-5 w-5" />
              Log pain
            </button>
            <Button
              variant="outline"
              onClick={handleEnd}
              className="h-12 gap-1.5 border-slate-700 bg-slate-900/70 px-3 text-sm text-slate-300 hover:bg-slate-800 hover:text-slate-50"
            >
              <Square className="h-4 w-4 text-emerald-400" />
              Attack ended
            </Button>
          </div>
        </section>
      ) : (
        <button
          onClick={handleStart}
          className="group flex min-h-14 w-full items-center justify-center gap-3 rounded-xl bg-attack py-4 text-lg font-bold text-attack-foreground transition-colors hover:bg-attack/90 active:scale-[0.99] sm:min-h-20 sm:py-6 sm:text-xl"
        >
          <Play className="h-6 w-6 transition-transform group-hover:scale-110" />
          {attackOverlapsToday ? 'Log another attack' : 'Start attack now'}
        </button>
      )}

      {/* ── Medications (immediately after the attack controls) ─── */}
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
              className="flex min-h-20 flex-col rounded-xl border border-slate-800 bg-slate-900 p-2.5 text-left shadow-sm transition-colors hover:border-slate-700 active:scale-[0.97] sm:p-3"
            >
              <span
                className="mb-1.5 block h-1.5 w-8 rounded-full"
                style={{ background: m.color }}
              />
              <span className="break-words text-sm font-semibold leading-tight text-slate-100 sm:text-base">
                {m.name}
              </span>
              <span
                className="truncate text-xs text-slate-400"
                title={m.kindLabel}
              >
                {m.kindLabel}
              </span>
              {recentDoseHints.has(m.id) && (
                <span className="block break-words text-xs leading-tight tabular-nums text-slate-400">
                  {recentDoseHints.get(m.id)}
                </span>
              )}
              {m.id === 'nurtec' && (
                <span className="mt-auto flex flex-wrap items-center gap-1 pt-1.5">
                  <span
                    className={usagePillClass(nurtecUsage)}
                    title={`Nurtec: ${nurtecDays} of ${nurtecRule.limit} allowed days in the last ${nurtecRule.windowDays} days`}
                  >
                    {nurtecDays}/{nurtecRule.limit}
                  </span>
                  <span
                    className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-bold ${nurtecBadge.className}`}
                    title={nurtecBadge.title}
                  >
                    {nurtecBadge.text}
                  </span>
                </span>
              )}
              {PAINKILLER_MED_IDS.includes(m.id as (typeof PAINKILLER_MED_IDS)[number]) && (
                <span className="mt-auto flex items-center pt-1.5">
                  <span
                    role="img"
                    aria-label={painkillerChipLabel}
                    title={painkillerChipTitle}
                    className={usagePillClass(painkillerUsage)}
                  >
                    {painkillerDays}/{painkillerRule.limit}
                  </span>
                </span>
              )}
            </button>
          ))}
        </div>
      </section>

      {/* ── Today's wellness + movement (kept during an attack, never hidden) */}
      <section className="rounded-xl border border-slate-800 bg-slate-900">
        <div className="p-2.5">
          <DayCheckIn
            key={todayKey}
            guidance={wellnessGuidance}
            effectiveStatus={todayState}
            displayOverride={activeAttack ? 'attack' : null}
            locked={!!activeAttack}
          />
        </div>
        {/* Movement stays on one compact wrapping row: label + controls. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-800/70 px-2.5 py-2">
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Movement
          </span>
          <div className="min-w-0 flex-1">
            <WorkoutQuickLog />
          </div>
        </div>
      </section>

      {/* ── Preventive medication (after wellness, always visible) ── */}
      <section aria-labelledby="preventive-heading">
        <h2
          id="preventive-heading"
          className="mb-1.5 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-400"
        >
          <Pill className="h-4 w-4" /> Preventive
        </h2>
        <div className="grid grid-cols-2 gap-1.5 sm:gap-2">
          {preventives.map((m) => (
            <button
              key={m.id}
              onClick={() => handleMed(m.id)}
              className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-2.5 text-left shadow-sm transition-colors hover:border-slate-700 active:scale-[0.97] sm:p-3"
            >
              <span className="h-8 w-1.5 rounded-full" style={{ background: m.color }} />
              <span className="min-w-0">
                <span className="block truncate font-semibold leading-tight text-slate-100">
                  {m.name}
                </span>
                <span className="block truncate text-xs text-slate-400">{m.kindLabel}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ── Weather (optional, non-blocking, after primary controls) ── */}
      <WeatherCard />

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
                className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm"
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
      <section className="grid grid-cols-2 gap-2" aria-label="Other logging">
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
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900 p-4 text-center text-sm text-slate-400">
          <p>No data yet. This demo stores everything in your browser only.</p>
          <button
            onClick={() => {
              store.loadDemoData();
              toast.success('Demo data loaded — check the Calendar & Reports tabs');
            }}
            className="mt-2 inline-flex min-h-11 items-center font-semibold text-slate-100 underline underline-offset-2"
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
                className="min-h-12 rounded-xl py-3 text-xl font-black shadow-sm transition-transform active:scale-95"
                style={{ background: painColor(n), color: textOn(painColor(n)) }}
              >
                {n}
              </button>
            ))}
            <button
              onClick={() => handlePain(0)}
              className="col-span-2 min-h-12 rounded-xl bg-slate-700 py-3 text-xl font-black text-slate-100 transition-transform active:scale-95"
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
