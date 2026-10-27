import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, AlertTriangle, CalendarPlus } from 'lucide-react';
import { useStore } from '@/lib/store';
import { usageDaysInWindow, daysSinceLast } from '@/lib/usage';
import { useNow } from '@/lib/clock';
import {
  MED_CATALOG, MED_MAP, allMedIds, medAbbr, medColor, medName,
  painColor, painTint, textOn, STATUS,
} from '@/lib/meds';
import { fmtTime, fmtDuration } from '@/lib/format';
import type { Attack, MedEvent, WorkoutKind } from '@/types';
import {
  addDays, addMonths, dayKeyStartMs, localDayKey, monthStartKey, weekdayOf, type DayKey,
} from '../../shared/datetime.ts';
import {
  attackOverlapsRange, parseAttackTimes, validDurationMs,
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

/** Configured-zone calendar date label for a day key (never browser-local ISO). */
function formatDayLabel(key: DayKey, timeZone: string, withYear = false): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  };
  if (withYear) options.year = 'numeric';
  return new Intl.DateTimeFormat(undefined, options)
    .format(new Date(dayKeyStartMs(key, timeZone)));
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
  attacks: Attack[];      // attacks overlapping this day
  meds: MedEvent[];       // meds taken this day
  maxPain: number;        // peak pain of attacks overlapping this day
  isToday: boolean;
  inMonth: boolean;
}

/** A continuous attack bar clipped to one week row. */
interface BarSegment {
  attack: Attack;
  from: number; // 0..7, fractional day offset within the week
  to: number;   // 0..7
  lane: number; // vertical stacking lane
  continuesLeft: boolean;
  continuesRight: boolean;
}

function MedLimitBar({ medId }: { medId: string }) {
  const { state } = useStore();
  const now = useNow();
  const rule = state.rules[medId];
  if (!rule) return null;
  const used = usageDaysInWindow(state.meds, medId, rule.windowDays, now, state.timezone);
  const pct = Math.min(100, (used / rule.limit) * 100);
  const over = used > rule.limit;
  const near = !over && used >= rule.limit - 3;
  const barColor = over ? STATUS.danger : near ? STATUS.warn : STATUS.ok;
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
        <span className="text-sm font-bold tabular-nums" style={{ color: over || near ? barColor : '#94a3b8' }}>
          {used} / {rule.limit} days
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: barColor }}
        />
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        rolling {rule.windowDays} days
        {over && <span className="ml-1 font-semibold" style={{ color: STATUS.danger }}>— overuse risk!</span>}
      </div>
    </div>
  );
}

function PreventiveCard({ medId, onSchedule }: { medId: string; onSchedule?: (medId: string) => void }) {
  const { state } = useStore();
  const now = useNow();
  const def = MED_MAP[medId];
  const days = daysSinceLast(state.meds, medId, now, state.timezone);
  const interval = def?.intervalDays ?? 30;

  // Shared with the server scheduler: planned dates override the automatic
  // local-day + interval calculation, and both resolve to 09:00 configured
  // local time (calendar days, not fixed 24h arithmetic).
  const dueInfo = preventiveDue({
    medId,
    intervalDays: interval,
    meds: state.meds,
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
  const dueLabel = dueInfo.dueDay === null
    ? ''
    : new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', timeZone: state.timezone,
    }).format(new Date(dayKeyStartMs(dueInfo.dueDay, state.timezone)));

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

  const weeks = useMemo(() => {
    const todayKey = localDayKey(now, state.timezone);
    const startOffset = (weekdayOf(cursor) + 6) % 7; // Monday-first
    const gridStartKey = addDays(cursor, -startOffset);
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
        const attacks = state.attacks.filter((a) => {
          const { startMs, endMs } = parseAttackTimes(a, now);
          // Degenerate (zero/negative-duration) attacks count on their start
          // day instead of vanishing; half-open otherwise.
          return attackOverlapsRange(startMs, endMs, dayStart, dayEnd);
        });
        days.push({
          key,
          inMonth: key.slice(0, 7) === monthKey,
          isToday: key === todayKey,
          attacks,
          meds: state.meds.filter((m) => {
            const t = Date.parse(m.ts);
            return Number.isFinite(t) && localDayKey(t, state.timezone) === key;
          }),
          maxPain: attacks.length ? Math.max(...attacks.map((a) => a.peakPain)) : -1,
        });
      }

      // continuous bars for attacks overlapping this week
      const overlapping = state.attacks
        .filter((a) => {
          const { startMs, endMs } = parseAttackTimes(a, now);
          return attackOverlapsRange(startMs, endMs, weekStartMs, weekEndMs);
        })
        .sort((a, b) => a.start.localeCompare(b.start));
      const weekEndKey = addDays(weekStartKey, 7);
      const raw = overlapping.map((a) => {
        const { startMs, endMs } = parseAttackTimes(a, now);
        // Overlap filtering guarantees a usable start.
        const s = startMs as number;
        return {
          attack: a,
          ...weekBarGeometry({
            startMs: s,
            endMs: endMs ?? s,
            weekStartKey,
            weekEndKey,
            timeZone: state.timezone,
          }),
        };
      });

      out.push({ days, bars: assignLanes(raw), weekStartMs, weekEndMs });
    }
    return out;
  }, [cursor, monthKey, state.attacks, state.meds, state.timezone, now]);

  const selData = useMemo(() => {
    if (!selected) return null;
    for (const w of weeks) for (const d of w.days) if (d.key === selected) return d;
    return null;
  }, [selected, weeks]);

  // Day state + workouts for the open sheet, bucketed in state.timezone.
  const selectedWellness = useMemo(() => {
    if (!selected) return null;
    const record = state.dayStates.find((d) => d.day === selected) ?? null;
    const dayStart = dayKeyStartMs(selected, state.timezone);
    const dayEnd = dayKeyStartMs(addDays(selected, 1), state.timezone);
    const hasAttack = state.attacks.some((a) => {
      const { startMs, endMs } = parseAttackTimes(a, now);
      return attackOverlapsRange(startMs, endMs, dayStart, dayEnd);
    });
    const workouts = state.workouts
      .filter((w) => {
        const ms = Date.parse(w.performedAt);
        return Number.isFinite(ms) && localDayKey(ms, state.timezone) === selected;
      })
      .sort((a, b) => b.performedAt.localeCompare(a.performedAt));
    return { record, status: effectiveDayState(record, hasAttack), workouts };
  }, [selected, state.dayStates, state.timezone, state.attacks, state.workouts, now]);

  const monthName = new Intl.DateTimeFormat(undefined, {
    month: 'long', year: 'numeric', timeZone: state.timezone,
  }).format(new Date(dayKeyStartMs(cursor, state.timezone)));

  const overuseFlags = Object.entries(state.rules).filter(
    ([id, r]) => usageDaysInWindow(state.meds, id, r.windowDays, now, state.timezone) >= r.limit - 3,
  );

  const monthBounds = useMemo(() => ({
    startMs: dayKeyStartMs(cursor, state.timezone),
    endMs: dayKeyStartMs(addMonths(cursor, 1), state.timezone),
  }), [cursor, state.timezone]);

  // "X attack days out of Y" for the visible configured-zone month — the
  // metric most migraine questionnaires (MIDAS, diaries) ask about. Days are
  // bucketed with the same local-midnight bounds as the grid cells.
  const monthStats = useMemo(() => {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const intervals = state.attacks.map((a) => parseAttackTimes(a, now));
    const attackCount = intervals
      .filter(({ startMs, endMs }) => attackOverlapsRange(
        startMs, endMs, monthBounds.startMs, monthBounds.endMs,
      ))
      .length;
    let attackDays = 0;
    for (let d = 0; d < daysInMonth; d++) {
      const key = addDays(cursor, d);
      const dayStart = dayKeyStartMs(key, state.timezone);
      const dayEnd = dayKeyStartMs(addDays(key, 1), state.timezone);
      if (intervals.some(({ startMs, endMs }) => attackOverlapsRange(
        startMs, endMs, dayStart, dayEnd,
      ))) attackDays++;
    }
    return { attackDays, daysInMonth, attackCount };
  }, [state.attacks, cursor, year, month, monthBounds, state.timezone, now]);

  return (
    <div className="space-y-6">
      {/* ── med usage strip ─────────────────────────────────── */}
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-400">
          Medication limits
          {overuseFlags.length > 0 && (
            <span
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold normal-case"
              style={{ background: '#E69F0022', color: STATUS.warn }}
            >
              <AlertTriangle className="h-3 w-3" /> watch your intake
            </span>
          )}
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {MED_CATALOG.filter((m) => m.defaultRule).map((m) => (
            <MedLimitBar key={m.id} medId={m.id} />
          ))}
        </div>
        <h2 className="mb-2 mt-4 text-sm font-bold uppercase tracking-wide text-slate-400">
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

      {/* ── month grid ──────────────────────────────────────── */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-3 shadow-sm sm:p-4">
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
                      aria-label={formatDayLabel(key, state.timezone, true)}
                      onClick={() => setSelected(key)}
                      className={`relative flex min-h-[70px] flex-col p-1 text-left transition-colors hover:bg-slate-800 sm:min-h-[88px] ${
                        d.inMonth ? 'bg-slate-950' : 'bg-slate-900'
                      } ${
                        d.isToday ? 'z-10 ring-2 ring-inset ring-sky-400' : ''
                      }`}
                      style={
                        d.inMonth && d.maxPain >= 0
                          ? { background: painTint(d.maxPain) }
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

                      {/* med letter chips */}
                      {d.meds.length > 0 && (
                        <div className="mt-auto flex flex-wrap gap-0.5 pt-0.5">
                          {d.meds.slice(0, 5).map((m) => {
                            const c = medColor(m.medId);
                            return (
                              <span
                                key={m.id}
                                className="flex h-[15px] min-w-[15px] items-center justify-center rounded px-0.5 text-[9px] font-black leading-none"
                                style={{ background: c, color: textOn(c) }}
                                title={medName(m.medId)}
                              >
                                {medAbbr(m.medId)}
                              </span>
                            );
                          })}
                          {d.meds.length > 5 && (
                            <span className="text-[9px] leading-none text-slate-400">
                              +{d.meds.length - 5}
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* continuous attack bars across the week */}
              <div className="pointer-events-none absolute inset-x-0 top-[26px]">
                {week.bars.map((bar) => {
                  const color = painColor(bar.attack.peakPain);
                  const widthPct = ((bar.to - bar.from) / 7) * 100;
                  const barTimes = parseAttackTimes(bar.attack, now);
                  // An ongoing attack has no end: `now` before a future start is
                  // not an inconsistent finished interval.
                  const barEndBeforeStart = bar.attack.end !== null
                    && barTimes.startMs !== null
                    && barTimes.endMs !== null
                    && barTimes.endMs < barTimes.startMs;
                  return (
                    <div
                      key={bar.attack.id + wi}
                      className={`absolute h-2.5 ${bar.attack.end === null ? 'animate-pulse' : ''} ${
                        bar.continuesLeft ? '' : 'rounded-l-full'
                      } ${bar.continuesRight ? '' : 'rounded-r-full'}`}
                      style={{
                        left: `${(bar.from / 7) * 100}%`,
                        width: `${widthPct}%`,
                        top: `${bar.lane * 13}px`,
                        background: color,
                      }}
                      title={`Attack, peak ${bar.attack.peakPain >= 0 ? `${bar.attack.peakPain}/10` : '?'}${
                        barEndBeforeStart ? ' — end before start' : ''
                      }`}
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
            <span className="text-slate-400">day tint = worst attack</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            {allMedIds(state.meds)
              // catalog meds always shown; custom (imported) meds only when
              // they actually appear in the visible month
              .filter((id) => {
                if (MED_MAP[id]) return true;
                return state.meds.some((e) => {
                  const t = Date.parse(e.ts);
                  return e.medId === id
                    && Number.isFinite(t)
                    && t >= monthBounds.startMs
                    && t < monthBounds.endMs;
                });
              })
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

      {/* ── day detail sheet ────────────────────────────────── */}
      <Sheet open={!!selData} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto rounded-t-2xl pb-[calc(4rem_+_env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg md:pb-4"
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
                            ? DAY_STATE_LABEL[selectedWellness.record.status]
                            : 'attack (from attacks)'}
                      </span>
                    </div>
                    {selectedWellness.record?.notes && (
                      <p className="border-t border-slate-800 px-3 py-2 text-xs italic text-slate-400">
                        {selectedWellness.record.notes}
                      </p>
                    )}
                  </div>
                )}
                {selData.attacks.length === 0 && selData.meds.length === 0
                  && (selectedWellness?.workouts.length ?? 0) === 0 && (
                  <p className="py-6 text-center text-sm text-slate-400">
                    Nothing logged this day 🎉
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
                <Label>Date</Label>
                <Input
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
