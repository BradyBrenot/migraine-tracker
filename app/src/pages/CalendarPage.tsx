import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, AlertTriangle, CalendarPlus } from 'lucide-react';
import { useStore } from '@/lib/store';
import {
  NURTEC_DEFAULT_RULE, PAINKILLER_MED_IDS, daysSinceLast, limitState,
  medUnionDaysInWindowFromIndex, painkillerBreakdownFromIndex,
  painkillerMismatchNote, painkillerRulesDiffer, resolveRule,
  resolveSharedPainkillerRule, usageDaysInWindowFromIndex, type UsageRule,
} from '@/lib/usage';
import { buildMedIndex } from '@/lib/medIndex';
import {
  attackDayKeysForFinished, buildAttackIndex, type FinishedAttack,
} from '@/lib/attackToday';
import { useNow } from '@/lib/clock';
import {
  MED_CATALOG, MED_MAP, allMedIds, medAbbr, medColor, medName,
  painColor, painTint, textOn, STATUS,
} from '@/lib/meds';
import { fmtTime, fmtDuration } from '@/lib/format';
import type { Attack, DayStateStatus, MedEvent, WorkoutKind } from '@/types';
import {
  addDays, addMonths, dayKeyStartMs, localDayKey, monthStartKey, weekdayOf,
  zonedDateTimeToMs, type DayKey,
} from '../../shared/datetime.ts';
import {
  ATTACK_DAY_START_TIME, attackDayKeys, attackOverlapsRange, parseAttackTimes,
  validDurationMs, type AttackTimes,
} from '../../shared/attackstats.ts';
import { effectiveDayState } from '../../shared/daystate.ts';
import { PREVENTIVE_DUE_TIME, preventiveDue } from '../../shared/reminders.ts';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import AttackFormDialog from '@/components/AttackFormDialog';
import { weekBarGeometry } from '@/lib/calendar-bars';

const DAY_MS = 86400000;

/**
 * Configured-zone day-label formatters, keyed by zone + year flag. The keys are
 * bounded by the timezones actually configured, so this replaces the 42
 * `new Intl.DateTimeFormat` constructions per grid redraw without leaking
 * per-cell keys.
 */
const dayLabelFormatters = new Map<string, Intl.DateTimeFormat>();

/** Configured-zone calendar date label for a day key (never browser-local ISO). */
function formatDayLabel(key: DayKey, timeZone: string, withYear = false): string {
  const cacheKey = `${withYear ? 'y' : 'n'}\u0000${timeZone}`;
  let formatter = dayLabelFormatters.get(cacheKey);
  if (formatter === undefined) {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone,
    };
    if (withYear) options.year = 'numeric';
    formatter = new Intl.DateTimeFormat(undefined, options);
    dayLabelFormatters.set(cacheKey, formatter);
  }
  return formatter.format(new Date(dayKeyStartMs(key, timeZone)));
}

const WORKOUT_KIND_LABEL: Record<WorkoutKind, string> = {
  strength: 'Strength',
  cardio: 'Cardio',
  mobility: 'Mobility',
};

const DAY_STATE_LABEL = { well: 'Well', off: 'Off', attack: 'Attack' } as const;
const DAY_STATE_CLASS = {
  well: 'text-emerald-300',
  off: 'text-amber-300',
  attack: 'text-rose-300',
} as const;

interface DayData {
  key: DayKey;            // configured-zone local calendar day
  attacks: Attack[];      // ALL attacks overlapping this day (raw)
  meds: MedEvent[];       // meds taken this day
  /** Raw worst peak of overlapping attacks, for the accessible label. */
  maxPain: number;
  /** Worst peak among attacks that reach 08:00 local; drives the day tint. */
  countedMaxPain: number;
  /**
   * True when this day counts as an attack/migraine day (08:00-to-08:00
   * window), including a pre-08:00 attack from the next calendar day.
   */
  countsAsAttackDay: boolean;
  isToday: boolean;
  inMonth: boolean;
}

/** One attack interval visible in the grid, kept in the source array order. */
interface ParsedAttackEntry {
  attack: Attack;
  times: AttackTimes;
  order: number;
}

/** A continuous attack bar clipped to one week row. */
interface BarSegment {
  attack: Attack;
  from: number; // 0..7, fractional day offset within the week
  to: number;   // 0..7
  lane: number; // vertical stacking lane
  continuesLeft: boolean;
  continuesRight: boolean;
  /** True when a finished attack's usable end precedes its start. */
  endBeforeStart: boolean;
}

/**
 * Concise accessible name for a calendar day cell: keep the configured-zone
 * date, then add the attack/medication counts the visual chips encode. Peak
 * pain and preventive doses are included because the visual chips cannot spell
 * them out.
 */
function dayCellLabel(day: DayData, timeZone: string): string {
  const label = formatDayLabel(day.key, timeZone, true);
  const details: string[] = [];
  if (day.attacks.length > 0) {
    // The tint uses countedMaxPain; announce the same peak so the accessible
    // name cannot contradict the visible colour when the worst attack belongs
    // to an attributed next-day early-morning attack.
    const peakValue = day.countsAsAttackDay && day.countedMaxPain >= 0
      ? day.countedMaxPain
      : day.maxPain;
    const peak = peakValue >= 0 ? `, peak ${peakValue} of 10` : '';
    details.push(`${day.attacks.length} attack${day.attacks.length === 1 ? '' : 's'}${peak}`);
  } else if (day.countsAsAttackDay) {
    // Early-morning attack attributed from the next calendar day: the cell is
    // tinted and the sheet explains it, so the accessible name must not claim
    // "no attacks".
    const peak = day.countedMaxPain >= 0 ? `, peak ${day.countedMaxPain} of 10` : '';
    details.push(`attack day${peak}`);
  }
  if (day.attacks.some((a) => a.end === null)) {
    // Ongoing has no motion cue, so the accessible name must say it.
    details.push('attack ongoing');
  }
  if (day.meds.length > 0) {
    details.push(`${day.meds.length} medication${day.meds.length === 1 ? '' : 's'}`);
  }
  const preventives = day.meds.filter((m) => MED_MAP[m.medId]?.kind === 'preventive');
  if (preventives.length > 0) {
    const names = [...new Set(preventives.map((m) => medName(m.medId)))].join(', ');
    details.push(`preventive: ${names}`);
  }
  return `${label}, ${details.length > 0 ? details.join(', ') : 'no attacks or medications'}`;
}

/**
 * Four slots (including any "+n" indicator) fit a phone-width day cell in two
 * rows. Preventive chips are always kept, so
 * truncation can never hide a scheduled preventive dose.
 */
const MAX_DAY_CHIPS = 4;

/**
 * The two compact decision cards that sit below the month grid. They are always
 * side by side in ONE row (even at 360px) and are promoted with a coral ring
 * while an attack is active.
 */
function DecisionCard({
  medId, name, used, rule, detail, over, near, promoted, title,
}: {
  medId: string | null;
  name: string;
  used: number;
  rule: UsageRule;
  detail: string;
  over: boolean;
  near: boolean;
  promoted: boolean;
  title: string;
}) {
  // A zero limit means "any use is already over": an unused bar stays empty
  // instead of showing a full, healthy-looking track.
  const pct = rule.limit > 0
    ? Math.min(100, (used / rule.limit) * 100)
    : used > 0
      ? 100
      : 0;
  const barColor = over ? STATUS.danger : near ? STATUS.warn : STATUS.ok;
  // The visible number/bar is compact by design (the detail line truncates), so
  // the full state is exposed to assistive tech on the group itself.
  const statusText = over ? 'over limit' : near ? 'near limit' : 'within limit';
  return (
    <div
      role="group"
      aria-label={`${name}: ${used} of ${rule.limit} allowed days in the last ${rule.windowDays} days, ${statusText}`}
      title={title}
      className={`min-w-0 rounded-xl border bg-slate-900 p-2.5 ${
        promoted ? 'border-attack-border ring-1 ring-attack-border/70' : 'border-slate-800'
      }`}
    >
      <div className="flex items-center gap-1.5">
        {medId ? (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-black"
            style={{ background: medColor(medId), color: textOn(medColor(medId)) }}
          >
            {medAbbr(medId)}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-slate-700 text-[10px] font-black text-slate-100"
          >
            PK
          </span>
        )}
        <span className="truncate text-xs font-semibold text-slate-200">{name}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-black leading-none tabular-nums text-slate-100">
          {used}
        </span>
        <span className="text-xs tabular-nums text-slate-400">/ {rule.limit} days</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div
          data-decision-bar=""
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: barColor }}
        />
      </div>
      <div className="mt-1 truncate text-[11px] text-slate-400" title={detail}>
        {detail}
      </div>
      {over && (
        <div className="mt-0.5 text-[11px] font-semibold" style={{ color: STATUS.danger }}>
          over limit
        </div>
      )}
    </div>
  );
}


function PreventiveCard({ medId, onSchedule }: { medId: string; onSchedule?: (medId: string) => void }) {
  const { state } = useStore();
  const now = useNow();
  const def = MED_MAP[medId];
  // One med's history is tiny; filtering once per data change keeps the
  // per-tick daysSinceLast/preventiveDue scans proportional to that med only.
  const medsForCard = useMemo(
    () => state.meds.filter((m) => m.medId === medId),
    [state.meds, medId],
  );
  const days = daysSinceLast(medsForCard, medId, now, state.timezone);
  const interval = def?.intervalDays ?? 30;

  // Shared with the server scheduler: planned dates override the automatic
  // local-day + interval calculation, and both resolve to 09:00 configured
  // local time (calendar days, not fixed 24h arithmetic).
  const dueInfo = preventiveDue({
    medId,
    intervalDays: interval,
    meds: medsForCard,
    planned: state.planned,
    now,
    timeZone: state.timezone,
    dueTime: PREVENTIVE_DUE_TIME,
  });
  const nextDate = dueInfo.dueMs !== null ? dueInfo.dueMs : null;
  const daysUntil = nextDate !== null ? Math.ceil((nextDate - now) / DAY_MS) : null;
  const due = dueInfo.status === 'due';
  const plannedDate = dueInfo.planned ? dueInfo.dueDay : null;
  const pct = days === null ? 0 : Math.min(100, (days / interval) * 100);
  const dueLabel = useMemo(() => {
    if (dueInfo.dueDay === null) return '';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', timeZone: state.timezone,
    }).format(new Date(dayKeyStartMs(dueInfo.dueDay, state.timezone)));
  }, [dueInfo.dueDay, state.timezone]);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-200">
          <span
            className="flex h-4 w-4 items-center justify-center rounded text-[9px] font-black"
            style={{ background: medColor(medId), color: textOn(medColor(medId)) }}
          >
            {medAbbr(medId)}
          </span>
          {medName(medId)}
        </span>
        <span className="flex items-center gap-2">
          <span className="text-sm font-bold tabular-nums" style={{ color: due ? STATUS.danger : '#94a3b8' }}>
            {days === null && !plannedDate ? 'never logged' : `${days ?? '?'}d ago`}
          </span>
          {onSchedule && (
            <button
              onClick={() => onSchedule(medId)}
              className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              title="Schedule next dose / appointment"
              aria-label={`Schedule next ${medName(medId)}`}
            >
              <CalendarPlus className="h-4 w-4" />
            </button>
          )}
        </span>
      </div>
      {nextDate !== null && (
        <div className="mt-1.5 text-xs">
          <span className={due ? 'font-semibold' : ''} style={due ? { color: STATUS.danger } : undefined}>
            {due
              ? `due since ${dueLabel}`
              : `next: ${dueLabel} (in ${daysUntil}d)`}
          </span>
          {plannedDate && (
            <span className="ml-1.5 rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
              scheduled
            </span>
          )}
        </div>
      )}
      {days !== null && (
        <>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full"
              style={{ width: `${pct}%`, background: due ? STATUS.danger : STATUS.ok }}
            />
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            ~every {interval}d
            {plannedDate ? ' · schedule overrides auto-date' : ''}
          </div>
        </>
      )}
    </div>
  );
}

/** Assign vertical lanes so overlapping bars in one week don't collide. */
function assignLanes(segments: Omit<BarSegment, 'lane'>[]): BarSegment[] {
  const lanes: number[] = []; // lane → occupied-until (float day)
  return segments.map((seg) => {
    let lane = lanes.findIndex((until) => until <= seg.from);
    if (lane === -1) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = seg.to;
    return { ...seg, lane };
  });
}

export default function CalendarPage() {
  const store = useStore();
  const { state, readOnly } = store;
  const now = useNow();
  // Month cursor is a configured-zone local month, not a browser-local Date.
  const [cursor, setCursor] = useState<DayKey>(() => monthStartKey(localDayKey(now, state.timezone)));
  const [selected, setSelected] = useState<DayKey | null>(null);
  const [editAttack, setEditAttack] = useState<Attack | null>(null);
  const [scheduleMed, setScheduleMed] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState('');

  // cursor is always 'YYYY-MM-01'; these are 1-based calendar fields.
  const year = Number(cursor.slice(0, 4));
  const month = Number(cursor.slice(5, 7));
  const monthKey = cursor.slice(0, 7);
  const todayKey = localDayKey(now, state.timezone);

  // Valid medications bucketed by configured-zone day ONCE per data/timezone
  // change. Previously each of the 42 cells rescanned every medication and
  // rebuilt its day key. Invalid timestamps are skipped exactly as before and
  // every bucket keeps the input (state) order.
  const medsByDay = useMemo(() => {
    const byDay = new Map<DayKey, MedEvent[]>();
    for (const med of state.meds) {
      const ms = Date.parse(med.ts);
      if (!Number.isFinite(ms)) continue;
      const key = localDayKey(ms, state.timezone);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(med);
      else byDay.set(key, [med]);
    }
    return byDay;
  }, [state.meds, state.timezone]);

  const medIndex = useMemo(() => buildMedIndex(state.meds), [state.meds]);
  const medIds = useMemo(() => allMedIds(state.meds), [state.meds]);

  // Finished attacks are parsed once per data change; only ongoing attacks
  // change with `now`. The index also lets the grid ignore history far outside
  // the visible six weeks.
  const attackIndex = useMemo(() => buildAttackIndex(state.attacks), [state.attacks]);

  // Visible grid bounds, Monday-first. The last visible day's 08:00-to-08:00
  // window ends at 08:00 the following local day; use that exact bound so an
  // attack starting before then still attributes the last visible day.
  const gridStartKey = useMemo(
    () => addDays(cursor, -((weekdayOf(cursor) + 6) % 7)),
    [cursor],
  );
  const lastVisibleKey = useMemo(
    () => addDays(gridStartKey, 41),
    [gridStartKey],
  );
  const gridStartMs = useMemo(
    () => dayKeyStartMs(gridStartKey, state.timezone),
    [gridStartKey, state.timezone],
  );
  const gridWindowEndMs = useMemo(
    () => zonedDateTimeToMs(
      addDays(lastVisibleKey, 1),
      ATTACK_DAY_START_TIME,
      state.timezone,
    ),
    [lastVisibleKey, state.timezone],
  );

  // Cheap arithmetic filter: only attacks that can affect this grid survive.
  const visibleFinished = useMemo(
    () => attackIndex.finished.filter((entry) => attackOverlapsRange(
      entry.startMs, entry.endMs, gridStartMs, gridWindowEndMs,
    )),
    [attackIndex, gridStartMs, gridWindowEndMs],
  );

  const visibleParsed = useMemo<ParsedAttackEntry[]>(() => {
    const entries: ParsedAttackEntry[] = visibleFinished.map((entry) => ({
      attack: entry.attack,
      times: { startMs: entry.startMs, endMs: entry.endMs, ongoing: false },
      order: entry.order,
    }));
    for (const entry of attackIndex.ongoing) {
      entries.push({
        attack: entry.attack,
        times: { startMs: entry.startMs, endMs: now, ongoing: true },
        order: entry.order,
      });
    }
    // Preserve the store's attack order for the day sheet and bar lanes.
    entries.sort((a, b) => a.order - b.order);
    return entries;
  }, [visibleFinished, attackIndex.ongoing, now]);

  // Counted days/pain for the visible grid only. Finished day keys come from
  // the per-attack cache; ongoing attacks are recomputed per tick.
  const { countedDays, countedPain } = useMemo(() => {
    const days = new Set<DayKey>();
    const pain = new Map<DayKey, number>();
    for (const { attack, times } of visibleParsed) {
      const keys = times.ongoing
        ? attackDayKeys(times.startMs, times.endMs, state.timezone)
        : attackDayKeysForFinished(attack as FinishedAttack, state.timezone);
      for (const key of keys) {
        // The index may include days outside the visible grid for a long
        // attack; only grid days are needed by the cells/month header.
        if (key < gridStartKey || key > lastVisibleKey) continue;
        days.add(key);
        const current = pain.get(key) ?? -1;
        if (attack.peakPain > current) pain.set(key, attack.peakPain);
      }
    }
    return { countedDays: days, countedPain: pain };
  }, [visibleParsed, state.timezone, gridStartKey, lastVisibleKey]);

  const weeks = useMemo(() => {
    const out: {
      days: DayData[];
      bars: BarSegment[];
      weekStartMs: number;
      weekEndMs: number;
    }[] = [];

    for (let w = 0; w < 6; w++) {
      const weekStartKey = addDays(gridStartKey, w * 7);
      // Configured-zone local midnights: DST weeks are not exactly 7 × DAY_MS.
      const weekStartMs = dayKeyStartMs(weekStartKey, state.timezone);
      const weekEndMs = dayKeyStartMs(addDays(weekStartKey, 7), state.timezone);
      const days: DayData[] = [];

      for (let d = 0; d < 7; d++) {
        const key = addDays(weekStartKey, d);
        const dayStart = dayKeyStartMs(key, state.timezone);
        const dayEnd = dayKeyStartMs(addDays(key, 1), state.timezone);
        const attacks = visibleParsed
          .filter(({ times }) => (
            // Degenerate (zero/negative-duration) attacks count on their start
            // day instead of vanishing; half-open otherwise.
            attackOverlapsRange(times.startMs, times.endMs, dayStart, dayEnd)
          ))
          .map(({ attack }) => attack);
        days.push({
          key,
          inMonth: key.slice(0, 7) === monthKey,
          isToday: key === todayKey,
          // Raw overlap feeds the sheet list, bars, and accessible name. Only a
          // day whose attacks reach 08:00 is tinted/counted, so a tail-only day
          // intentionally shows an attack bar/list with no tint.
          attacks,
          meds: medsByDay.get(key) ?? [],
          maxPain: attacks.length ? Math.max(...attacks.map((a) => a.peakPain)) : -1,
          countedMaxPain: countedPain.get(key) ?? -1,
          countsAsAttackDay: countedDays.has(key),
        });
      }

      // continuous bars for attacks overlapping this week
      const overlapping = visibleParsed
        .filter(({ times }) => attackOverlapsRange(times.startMs, times.endMs, weekStartMs, weekEndMs))
        .sort((a, b) => a.attack.start.localeCompare(b.attack.start));
      const weekEndKey = addDays(weekStartKey, 7);
      const raw = overlapping.map(({ attack, times }) => {
        // Overlap filtering guarantees a usable start.
        const s = times.startMs as number;
        return {
          attack,
          // An ongoing attack has no end: `now` before a future start is not
          // an inconsistent finished interval. Evaluated here from the parsed
          // interval so the bar render never re-parses.
          endBeforeStart: attack.end !== null
            && times.startMs !== null
            && times.endMs !== null
            && times.endMs < times.startMs,
          ...weekBarGeometry({
            startMs: s,
            endMs: times.endMs ?? s,
            weekStartKey,
            weekEndKey,
            timeZone: state.timezone,
          }),
        };
      });

      out.push({ days, bars: assignLanes(raw), weekStartMs, weekEndMs });
    }
    return out;
  }, [
    gridStartKey, monthKey, visibleParsed, countedDays, countedPain,
    medsByDay, state.timezone, todayKey,
  ]);

  const selData = useMemo(() => {
    if (!selected) return null;
    for (const w of weeks) for (const d of w.days) if (d.key === selected) return d;
    return null;
  }, [selected, weeks]);

  // Day state + workouts for the open sheet, bucketed in state.timezone. The
  // sheet still lists every raw attack, but inference uses only days that
  // count as attack days (an attack reaching 08:00 local).
  const selectedWellness = useMemo(() => {
    if (!selected) return null;
    const record = state.dayStates.find((d) => d.day === selected) ?? null;
    const workouts = state.workouts
      .filter((w) => {
        const ms = Date.parse(w.performedAt);
        return Number.isFinite(ms) && localDayKey(ms, state.timezone) === selected;
      })
      .sort((a, b) => b.performedAt.localeCompare(a.performedAt));
    // Today while an attack is active reads Attack, even over an earlier
    // explicit Well/Off record (same display override as Home/partner view).
    // Every other day follows the shared helper, where a record-less counted
    // attack day infers Off.
    const status: DayStateStatus | null =
      selected === todayKey && store.activeAttack
        ? 'attack'
        : effectiveDayState(record, countedDays.has(selected));
    return { record, status, workouts };
  }, [
    selected, state.dayStates, state.timezone, state.workouts,
    countedDays, todayKey, store.activeAttack,
  ]);

  const monthNameFormatter = useMemo(
    () => new Intl.DateTimeFormat(undefined, {
      month: 'long', year: 'numeric', timeZone: state.timezone,
    }),
    [state.timezone],
  );
  const monthName = monthNameFormatter.format(new Date(dayKeyStartMs(cursor, state.timezone)));

  // Decision-card numbers. Both med groups resolve their persisted rules the
  // same way every other screen does, so a partial import cannot produce NaN
  // or an unexplained badge. Painkillers are a single MOH day budget: different
  // painkillers on one day count once.
  const nurtecRule = resolveRule(state.rules.nurtec, NURTEC_DEFAULT_RULE);
  const nurtecUsed = usageDaysInWindowFromIndex(
    medIndex, 'nurtec', nurtecRule.windowDays, now, state.timezone,
  );
  const painkillerRule = resolveSharedPainkillerRule(state.rules);
  const painkillerUsed = medUnionDaysInWindowFromIndex(
    medIndex, PAINKILLER_MED_IDS, painkillerRule.windowDays, now, state.timezone,
  );
  const painkillerNames = painkillerBreakdownFromIndex(
    medIndex, painkillerRule.windowDays, now, state.timezone,
  ).map((entry) => medName(entry.medId));
  const painkillerDetail = painkillerNames.length > 0
    ? `last ${painkillerRule.windowDays}d · ${painkillerNames.join(' + ')}`
    : `last ${painkillerRule.windowDays}d · none logged`;
  const painkillerRulesMismatch = painkillerRulesDiffer(state.rules);
  const nurtecUsage = limitState(nurtecUsed, nurtecRule.limit);
  const painkillerUsage = limitState(painkillerUsed, painkillerRule.limit);
  const nurtecOver = nurtecUsage === 'over';
  const nurtecNear = nurtecUsage === 'near';
  const painkillerOver = painkillerUsage === 'over';
  const painkillerNear = painkillerUsage === 'near';
  const intakeWatch = nurtecOver || nurtecNear || painkillerOver || painkillerNear;

  const monthBounds = useMemo(() => ({
    startMs: dayKeyStartMs(cursor, state.timezone),
    endMs: dayKeyStartMs(addMonths(cursor, 1), state.timezone),
  }), [cursor, state.timezone]);

  // Custom (imported) med legend entries, computed once per data/month change
  // instead of rescanning history for every custom id on every render.
  const visibleCustomMedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const med of state.meds) {
      if (MED_MAP[med.medId]) continue;
      const t = Date.parse(med.ts);
      if (Number.isFinite(t) && t >= monthBounds.startMs && t < monthBounds.endMs) {
        ids.add(med.medId);
      }
    }
    return ids;
  }, [state.meds, monthBounds]);

  // "X attack days out of Y" for the visible configured-zone month — the
  // metric most migraine questionnaires (MIDAS, diaries) ask about. Days use
  // the counted 08:00-to-08:00 set (a pre-08:00 start can add the previous
  // month's last day); attacks use raw month overlap (so a tail-only attack
  // still counts once as an attack but adds no attack day).
  const monthStats = useMemo(() => {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const attackCount = visibleParsed
      .filter(({ times }) => attackOverlapsRange(
        times.startMs, times.endMs, monthBounds.startMs, monthBounds.endMs,
      ))
      .length;
    let attackDays = 0;
    for (const key of countedDays) {
      if (key.slice(0, 7) === monthKey) attackDays++;
    }
    return { attackDays, daysInMonth, attackCount };
  }, [visibleParsed, countedDays, monthKey, year, month, monthBounds]);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Calendar</h1>
      {/* ── month grid ──────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-3 shadow-sm sm:p-4">
        <div className="mb-3 flex items-center justify-between">
          <button
            onClick={() => setCursor((c) => addMonths(c, -1))}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-800"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="text-center">
            <h2 className="text-lg font-bold text-slate-100">{monthName}</h2>
            <p className="text-xs tabular-nums text-slate-400">
              <span className="font-bold text-slate-200">{monthStats.attackDays}</span>
              {' '}attack day{monthStats.attackDays === 1 ? '' : 's'} of {monthStats.daysInMonth}
              {' · '}{monthStats.attackCount} attack{monthStats.attackCount === 1 ? '' : 's'}
            </p>
          </div>
          <button
            onClick={() => setCursor((c) => addMonths(c, 1))}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-800"
            aria-label="Next month"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase text-slate-400">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d} className="py-1">{d}</div>
          ))}
        </div>

        <div className="space-y-px">
          {weeks.map((week, wi) => (
            <div key={wi} className="relative">
              {/* day cells */}
              <div className="grid grid-cols-7 gap-px bg-slate-800">
                {week.days.map((d) => {
                  const key = d.key;
                  return (
                    <button
                      key={key}
                      data-day={key}
                      aria-label={dayCellLabel(d, state.timezone)}
                      onClick={() => setSelected(key)}
                      className={`relative flex min-h-[70px] flex-col p-1 text-left transition-colors hover:bg-slate-800 sm:min-h-[88px] ${
                        d.inMonth ? 'bg-slate-950' : 'bg-slate-900'
                      } ${
                        d.isToday ? 'z-10 ring-2 ring-inset ring-sky-400' : ''
                      }`}
                      style={
                        d.inMonth && d.countedMaxPain >= 0
                          ? { background: painTint(d.countedMaxPain) }
                          : undefined
                      }
                    >
                      <span
                        className={`text-xs font-semibold tabular-nums ${
                          d.isToday
                            ? 'flex h-5 w-5 items-center justify-center rounded-full bg-sky-400 text-slate-950'
                            : d.inMonth
                              ? 'text-slate-100'
                              : 'text-slate-400'
                        }`}
                      >
                        {Number(key.slice(8, 10))}
                      </span>

                      {/* med letter chips — preventive doses are pinned ahead
                          of acute chips so truncation never hides them */}
                      {d.meds.length > 0 && (() => {
                        const preventiveChips = d.meds.filter(
                          (m) => MED_MAP[m.medId]?.kind === 'preventive',
                        );
                        const acuteChips = d.meds.filter(
                          (m) => MED_MAP[m.medId]?.kind !== 'preventive',
                        );
                        const prioritized = [...preventiveChips, ...acuteChips];
                        // The overflow indicator consumes one of the four slots.
                        // A fixed two-column grid keeps chips + "+n" to two rows,
                        // even in the ~35px content width of a 360px day cell.
                        const shown = prioritized.slice(
                          0,
                          prioritized.length > MAX_DAY_CHIPS
                            ? MAX_DAY_CHIPS - 1
                            : MAX_DAY_CHIPS,
                        );
                        const hidden = prioritized.length - shown.length;
                        return (
                          <div
                            data-med-chip-grid
                            className="mt-auto grid w-full grid-cols-2 gap-0.5 pt-0.5"
                          >
                            {shown.map((m) => {
                              const c = medColor(m.medId);
                              return (
                                <span
                                  key={m.id}
                                  className="flex h-5 min-w-0 items-center justify-center rounded text-xs font-bold leading-none"
                                  style={{ background: c, color: textOn(c) }}
                                  title={medName(m.medId)}
                                >
                                  {medAbbr(m.medId)}
                                </span>
                              );
                            })}
                            {hidden > 0 && (
                              <span className="flex h-5 min-w-0 items-center justify-center text-xs leading-none text-slate-400">
                                +{hidden}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </button>
                  );
                })}
              </div>

              {/* continuous attack bars across the week */}
              <div className="pointer-events-none absolute inset-x-0 top-[26px]">
                {week.bars.map((bar) => {
                  const color = painColor(bar.attack.peakPain);
                  const widthPct = ((bar.to - bar.from) / 7) * 100;
                   return (
                    <div
                      key={bar.attack.id + wi}
                      // No motion is used for "ongoing" (it can last days), so a
                      // bright inset ring marks a still-running bar.
                      className={`absolute h-2.5 ${bar.attack.end === null ? 'ring-2 ring-inset ring-slate-100/90' : ''} ${
                        bar.continuesLeft ? '' : 'rounded-l-full'} ${
                        bar.continuesRight ? '' : 'rounded-r-full'}`}
                      style={{
                        left: `${(bar.from / 7) * 100}%`,
                        width: `${widthPct}%`,
                        top: `${bar.lane * 13}px`,
                        background: color,
                      }}
                      title={`Attack, peak ${bar.attack.peakPain >= 0 ? `${bar.attack.peakPain}/10` : '?'}${
                        bar.attack.end === null ? ' — ongoing' : ''
                      }${bar.endBeforeStart ? ' — end before start' : ''}`}
                    >
                      {widthPct >= 4 && bar.attack.peakPain >= 0 && (
                        <span
                          className="absolute inset-0 flex items-center justify-center text-[9px] font-black"
                          style={{ color: textOn(color) }}
                        >
                          {bar.attack.peakPain}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* legend */}
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
            <span className="flex items-center gap-2">
              <span>pain</span>
              <span
                className="h-2.5 w-24 rounded-full sm:w-32"
                style={{
                  background: `linear-gradient(to right, ${[0, 2, 4, 6, 8, 10]
                    .map((l) => painColor(l))
                    .join(', ')})`,
                }}
              />
              <span className="text-slate-400">mild → severe</span>
            </span>
            <span className="text-slate-400">day tint = worst attack (08:00–08:00)</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            {medIds
              // catalog meds always shown; custom (imported) meds only when
              // they actually appear in the visible month
              .filter((id) => MED_MAP[id] !== undefined || visibleCustomMedIds.has(id))
              .map((id) => {
              const c = medColor(id);
              return (
                <span key={id} className="flex items-center gap-1">
                  <span
                    className="flex h-[15px] min-w-[15px] items-center justify-center rounded px-0.5 text-[9px] font-black leading-none"
                    style={{ background: c, color: textOn(c) }}
                  >
                    {medAbbr(id)}
                  </span>
                  {medName(id)}
                </span>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── two compact decision cards, one row, below the grid ── */}
      <section>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wide text-slate-400">
            Medication limits
          </h2>
          {intakeWatch && (
            <span
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold normal-case"
              style={{ background: '#E69F0022', color: STATUS.warn }}
            >
              <AlertTriangle className="h-3 w-3" /> watch your intake
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <DecisionCard
            medId="nurtec"
            name="Nurtec"
            used={nurtecUsed}
            rule={nurtecRule}
            detail={`last ${nurtecRule.windowDays}d · rolling`}
            over={nurtecOver}
            near={nurtecNear}
            promoted={!!store.activeAttack}
            title={`Nurtec: ${nurtecUsed} of ${nurtecRule.limit} allowed days in the last ${nurtecRule.windowDays} days`}
          />
          <DecisionCard
            medId={null}
            name="Painkillers"
            used={painkillerUsed}
            rule={painkillerRule}
            detail={painkillerDetail}
            over={painkillerOver}
            near={painkillerNear}
            promoted={!!store.activeAttack}
            title={`Painkillers (Tylenol, Ibuprofen, Naproxen): ${painkillerUsed} of ${painkillerRule.limit} allowed days in the last ${painkillerRule.windowDays} days`}
          />
        </div>
        {painkillerRulesMismatch && (
          <p className="mt-1.5 text-[11px] leading-snug text-slate-400">
            {painkillerMismatchNote(readOnly, painkillerRule)}
          </p>
        )}
      </section>

      {/* ── preventive schedule (below the grid and limits, not collapsible) ── */}
      <section>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">
          Preventive schedule
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {MED_CATALOG.filter((m) => m.kind === 'preventive').map((m) => (
            <PreventiveCard
              key={m.id}
              medId={m.id}
              onSchedule={readOnly ? undefined : (id) => {
                setScheduleMed(id);
                setScheduleDate(state.planned[id] ?? '');
              }}
            />
          ))}
        </div>
      </section>

      {/* ── day detail sheet ────────────────────────────────── */}
      <Sheet open={!!selData} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto rounded-t-2xl pb-[calc(4rem_+_env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg lg:pb-4"
        >
          {selData && (
            <>
              <SheetHeader>
                <SheetTitle>{formatDayLabel(selData.key, state.timezone)}</SheetTitle>
              </SheetHeader>
              <div className="space-y-4 py-4">
                {selectedWellness && (
                  <div className="rounded-lg border border-slate-800 bg-slate-900">
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-xs font-bold uppercase tracking-wide text-slate-400">
                        Day state
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          selectedWellness.status === null
                            ? 'text-slate-400'
                            : DAY_STATE_CLASS[selectedWellness.status]
                        }`}
                      >
                        {selectedWellness.status === null
                          ? '—'
                          : selectedWellness.record
                            ? DAY_STATE_LABEL[selectedWellness.status]
                            : `${DAY_STATE_LABEL[selectedWellness.status]} (from attacks)`}
                      </span>
                    </div>
                    {selectedWellness.record?.notes && (
                      <p className="border-t border-slate-800 px-3 py-2 text-xs italic text-slate-400">
                        {selectedWellness.record.notes}
                      </p>
                    )}
                  </div>
                )}
                {selData.countsAsAttackDay && selData.attacks.length === 0 && (
                  <p className="py-2 text-center text-sm text-slate-400">
                    Attack day: an early-morning attack from the next day counts for this day.
                  </p>
                )}
                {selData.attacks.length === 0 && selData.meds.length === 0
                  && (selectedWellness?.workouts.length ?? 0) === 0
                  && !selData.countsAsAttackDay && (
                  <p className="py-6 text-center text-sm text-slate-400">
                    Nothing logged this day.
                  </p>
                )}
                {selData.attacks.map((a) => {
                  const times = parseAttackTimes(a, now);
                  const duration = validDurationMs(times);
                  // Only a finished attack can have an end before its start; for
                  // an ongoing attack `endMs` is just `now`.
                  const endBeforeStart = a.end !== null
                    && times.startMs !== null
                    && times.endMs !== null
                    && times.endMs < times.startMs;
                  // Ongoing attacks still show elapsed-so-far; a finished attack
                  // with a negative/unusable duration shows an em dash. A future
                  // start (end = now < start) must not render negative elapsed.
                  const durLabel = a.end === null
                    ? times.startMs !== null
                      && times.endMs !== null
                      && times.endMs >= times.startMs
                      ? fmtDuration(times.endMs - times.startMs)
                      : '—'
                    : duration !== null ? fmtDuration(duration) : '—';
                  const c = painColor(a.peakPain);
                  const body = (
                    <>
                      <div className="flex items-center gap-2">
                        <span
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-black"
                          style={{ background: c, color: textOn(c) }}
                        >
                          {a.peakPain >= 0 ? a.peakPain : '–'}
                        </span>
                        <div>
                          <div className="text-sm font-semibold text-slate-200">
                            {fmtTime(a.start)} → {a.end ? fmtTime(a.end) : 'ongoing'}
                            <span className="ml-2 text-xs font-normal text-slate-400">
                              {durLabel}
                            </span>
                            {endBeforeStart && (
                              <span
                                role="status"
                                className="ml-2 rounded-full bg-amber-950 px-2 py-0.5 text-[10px] font-bold text-amber-300"
                              >
                                End is before start
                              </span>
                            )}
                          </div>
                          {a.symptoms.length > 0 && (
                            <div className="mt-0.5 text-xs text-slate-400">
                              {a.symptoms.join(' · ')}
                            </div>
                          )}
                        </div>
                      </div>
                      {a.notes && (
                        <p className="mt-2 border-l-2 border-slate-700 pl-2 text-xs italic text-slate-400">
                          {a.notes}
                        </p>
                      )}
                    </>
                  );
                  const cardClass = 'w-full rounded-xl border border-slate-800 bg-slate-900 p-3 text-left shadow-sm';
                  // The viewer must not expose a focusable edit control: render
                  // the same attack summary as a plain element.
                  return readOnly ? (
                    <div key={a.id} className={cardClass}>{body}</div>
                  ) : (
                    <button
                      key={a.id}
                      onClick={() => setEditAttack(a)}
                      className={cardClass}
                    >
                      {body}
                    </button>
                  );
                })}
                {selData.meds.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
                      Medications
                    </h3>
                    <div className="space-y-1">
                      {selData.meds.map((m) => {
                        const c = medColor(m.medId);
                        return (
                          <div key={m.id} className="flex items-center gap-2 text-sm text-slate-200">
                            <span
                              className="flex h-[18px] min-w-[18px] items-center justify-center rounded px-1 text-[10px] font-black leading-none"
                              style={{ background: c, color: textOn(c) }}
                            >
                              {medAbbr(m.medId)}
                            </span>
                            <span className="font-medium">{medName(m.medId)}</span>
                            {m.dose && <span className="text-slate-400">{m.dose}</span>}
                            <span className="ml-auto text-xs tabular-nums text-slate-400">{fmtTime(m.ts)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {(selectedWellness?.workouts.length ?? 0) > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
                      Workouts
                    </h3>
                    <div className="space-y-1">
                      {selectedWellness!.workouts.map((w) => (
                        <div
                          key={w.id}
                          className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-200">
                              {WORKOUT_KIND_LABEL[w.kind]} · {w.effort}
                            </span>
                            <span className="ml-auto text-xs tabular-nums text-slate-400">
                              {fmtTime(w.performedAt)}
                            </span>
                          </div>
                          {w.durationMinutes !== null && (
                            <div className="text-xs text-slate-400">{w.durationMinutes}m</div>
                          )}
                          {w.notes && (
                            <p className="mt-1 border-l-2 border-slate-700 pl-2 text-xs italic text-slate-400">
                              {w.notes}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {!readOnly && (
        <>
          <AttackFormDialog
            attack={editAttack}
            open={!!editAttack}
            onClose={() => setEditAttack(null)}
          />

          {/* schedule next preventive dose / appointment */}
          <Dialog open={!!scheduleMed} onOpenChange={(o) => !o && setScheduleMed(null)}>
            <DialogContent className="sm:max-w-xs">
              <DialogHeader>
                <DialogTitle>
                  Schedule next {scheduleMed ? medName(scheduleMed) : ''}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-1.5 py-2">
                <Label htmlFor="calendar-schedule-date">Date</Label>
                <Input
                  id="calendar-schedule-date"
                  type="date"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                />
                {state.planned[scheduleMed ?? ''] && (
                  <button
                    type="button"
                    className="text-xs text-slate-400 underline underline-offset-2 hover:text-slate-200"
                    onClick={() => {
                      if (scheduleMed) store.setPlannedDose(scheduleMed, null);
                      setScheduleMed(null);
                    }}
                  >
                    Clear scheduled date (back to auto)
                  </button>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setScheduleMed(null)}>Cancel</Button>
                <Button
                  onClick={() => {
                    if (scheduleMed && scheduleDate) store.setPlannedDose(scheduleMed, scheduleDate);
                    setScheduleMed(null);
                  }}
                >
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
