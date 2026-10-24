import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, AlertTriangle, CalendarPlus } from 'lucide-react';
import { useStore, usageDaysInWindow, daysSinceLast } from '@/lib/store';
import {
  MED_CATALOG, MED_MAP, allMedIds, medAbbr, medColor, medName,
  painColor, painTint, textOn, STATUS,
} from '@/lib/meds';
import { dayKey, fmtDateFull, fmtTime, fmtDuration } from '@/lib/format';
import type { Attack, MedEvent } from '@/types';
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

const DAY_MS = 86400000;

interface DayData {
  attacks: Attack[];      // attacks overlapping this day
  meds: MedEvent[];       // meds taken this day
  maxPain: number;        // peak pain of attacks overlapping this day
  isToday: boolean;
  inMonth: boolean;
  date: Date;
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
  const rule = state.rules[medId];
  if (!rule) return null;
  const used = usageDaysInWindow(state.meds, medId, rule.windowDays);
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
      <div className="mt-1 text-[11px] text-slate-500">
        rolling {rule.windowDays} days
        {over && <span className="ml-1 font-semibold" style={{ color: STATUS.danger }}>— overuse risk!</span>}
      </div>
    </div>
  );
}

function PreventiveCard({ medId, onSchedule }: { medId: string; onSchedule: (medId: string) => void }) {
  const { state } = useStore();
  const def = MED_MAP[medId];
  const days = daysSinceLast(state.meds, medId);
  const interval = def?.intervalDays ?? 30;
  const plannedDate = state.planned[medId] ?? null;

  // next due: manual appointment if set, else last dose + interval
  const lastTs = (() => {
    const events = state.meds.filter((m) => m.medId === medId);
    return events.length ? Math.max(...events.map((m) => new Date(m.ts).getTime())) : null;
  })();
  const autoDue = lastTs !== null ? new Date(lastTs + interval * DAY_MS) : null;
  const nextDate = plannedDate ? new Date(plannedDate + 'T09:00:00') : autoDue;
  const daysUntil = nextDate
    ? Math.ceil((nextDate.getTime() - Date.now()) / DAY_MS)
    : null;
  const due = daysUntil !== null && daysUntil <= 0;
  const pct = days === null ? 0 : Math.min(100, (days / interval) * 100);

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
          <button
            onClick={() => onSchedule(medId)}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            title="Schedule next dose / appointment"
            aria-label={`Schedule next ${medName(medId)}`}
          >
            <CalendarPlus className="h-4 w-4" />
          </button>
        </span>
      </div>
      {nextDate && (
        <div className="mt-1.5 text-xs">
          <span className={due ? 'font-semibold' : ''} style={due ? { color: STATUS.danger } : undefined}>
            {due
              ? `due since ${nextDate.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
              : `next: ${nextDate.toLocaleDateString([], { month: 'short', day: 'numeric' })} (in ${daysUntil}d)`}
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
          <div className="mt-1 text-[11px] text-slate-500">
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
  const { state } = store;
  const [cursor, setCursor] = useState(() => {
    const d = new Date(); d.setDate(1); return d;
  });
  const [selected, setSelected] = useState<string | null>(null); // dayKey
  const [editAttack, setEditAttack] = useState<Attack | null>(null);
  const [scheduleMed, setScheduleMed] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState('');

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const weeks = useMemo(() => {
    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7; // Monday-first
    const gridStart = new Date(year, month, 1 - startOffset);
    gridStart.setHours(0, 0, 0, 0);
    const todayKey = dayKey(new Date());
    const out: { days: DayData[]; bars: BarSegment[]; weekStart: Date }[] = [];

    for (let w = 0; w < 6; w++) {
      const weekStart = new Date(gridStart.getTime() + w * 7 * DAY_MS);
      const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
      const days: DayData[] = [];

      for (let d = 0; d < 7; d++) {
        const date = new Date(weekStart.getTime() + d * DAY_MS);
        const dayStart = date.getTime();
        const dayEnd = dayStart + DAY_MS;
        const attacks = state.attacks.filter((a) => {
          const s = new Date(a.start).getTime();
          const e = a.end ? new Date(a.end).getTime() : Date.now();
          return s < dayEnd && e > dayStart;
        });
        days.push({
          date,
          inMonth: date.getMonth() === month,
          isToday: dayKey(date) === todayKey,
          attacks,
          meds: state.meds.filter((m) => dayKey(new Date(m.ts)) === dayKey(date)),
          maxPain: attacks.length ? Math.max(...attacks.map((a) => a.peakPain)) : -1,
        });
      }

      // continuous bars for attacks overlapping this week
      const overlapping = state.attacks
        .filter((a) => {
          const s = new Date(a.start).getTime();
          const e = a.end ? new Date(a.end).getTime() : Date.now();
          return s < weekEnd.getTime() && e > weekStart.getTime();
        })
        .sort((a, b) => a.start.localeCompare(b.start));
      const raw = overlapping.map((a) => {
        const s = new Date(a.start).getTime();
        const e = a.end ? new Date(a.end).getTime() : Date.now();
        let from = (s - weekStart.getTime()) / DAY_MS;
        let to = (e - weekStart.getTime()) / DAY_MS;
        from = Math.max(0, from);
        to = Math.min(7, to);
        if (to - from < 0.18) to = Math.min(7, from + 0.18); // keep short attacks visible
        return {
          attack: a, from, to,
          continuesLeft: s < weekStart.getTime(),
          continuesRight: e > weekEnd.getTime(),
        };
      });

      out.push({ days, bars: assignLanes(raw), weekStart });
    }
    return out;
  }, [year, month, state.attacks, state.meds]);

  const selData = useMemo(() => {
    if (!selected) return null;
    for (const w of weeks) for (const d of w.days) if (dayKey(d.date) === selected) return d;
    return null;
  }, [selected, weeks]);

  const monthName = cursor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const overuseFlags = Object.entries(state.rules).filter(
    ([id, r]) => usageDaysInWindow(state.meds, id, r.windowDays) >= r.limit - 3,
  );

  // "X attack days out of Y" for the visible month — the metric most
  // migraine questionnaires (MIDAS, diaries) ask about.
  const monthStats = useMemo(() => {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const attackDays = new Set<string>();
    let attackCount = 0;
    for (const a of state.attacks) {
      const s = new Date(a.start).getTime();
      const e = a.end ? new Date(a.end).getTime() : Date.now();
      const monthStart = new Date(year, month, 1).getTime();
      const monthEnd = new Date(year, month + 1, 1).getTime();
      if (s >= monthEnd || e < monthStart) continue;
      attackCount++;
      for (
        let t = Math.max(s, monthStart);
        t < Math.min(e, monthEnd);
        t += DAY_MS
      ) {
        const d = new Date(t);
        if (d.getMonth() === month) attackDays.add(dayKey(d));
      }
    }
    return { attackDays: attackDays.size, daysInMonth, attackCount };
  }, [state.attacks, year, month]);

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
              onSchedule={(id) => {
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
            onClick={() => setCursor(new Date(year, month - 1, 1))}
            className="rounded-lg p-2 text-slate-300 hover:bg-slate-800"
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
            onClick={() => setCursor(new Date(year, month + 1, 1))}
            className="rounded-lg p-2 text-slate-300 hover:bg-slate-800"
            aria-label="Next month"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase text-slate-500">
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
                  const key = dayKey(d.date);
                  return (
                    <button
                      key={key}
                      onClick={() => setSelected(key)}
                      className={`relative flex min-h-[70px] flex-col bg-slate-950 p-1 text-left transition-colors hover:bg-slate-800 sm:min-h-[88px] ${
                        d.inMonth ? '' : 'opacity-35'
                      } ${d.isToday ? 'z-10 ring-2 ring-inset ring-sky-400' : ''}`}
                      style={d.maxPain >= 0 ? { background: painTint(d.maxPain) } : undefined}
                    >
                      <span
                        className={`text-xs font-semibold tabular-nums ${
                          d.isToday
                            ? 'flex h-5 w-5 items-center justify-center rounded-full bg-sky-400 text-slate-950'
                            : 'text-slate-400'
                        }`}
                      >
                        {d.date.getDate()}
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
                            <span className="text-[9px] leading-none text-slate-500">
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
                      title={`Attack, peak ${bar.attack.peakPain >= 0 ? `${bar.attack.peakPain}/10` : '?'}`}
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
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <span>pain</span>
            <span
              className="h-2.5 w-32 rounded-full"
              style={{
                background: `linear-gradient(to right, ${[0, 2, 4, 6, 8, 10]
                  .map((l) => painColor(l))
                  .join(', ')})`,
              }}
            />
            <span className="text-slate-500">mild → severe</span>
            <span className="ml-3">day tint = worst attack that day</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            {allMedIds(state.meds)
              // catalog meds always shown; custom (imported) meds only when
              // they actually appear in the visible month
              .filter((id) => {
                if (MED_MAP[id]) return true;
                const mStart = new Date(year, month, 1).getTime();
                const mEnd = new Date(year, month + 1, 1).getTime();
                return state.meds.some((e) => {
                  const t = new Date(e.ts).getTime();
                  return e.medId === id && t >= mStart && t < mEnd;
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
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto rounded-t-2xl sm:mx-auto sm:max-w-lg">
          {selData && (
            <>
              <SheetHeader>
                <SheetTitle>{fmtDateFull(selData.date.toISOString())}</SheetTitle>
              </SheetHeader>
              <div className="space-y-4 py-4">
                {selData.attacks.length === 0 && selData.meds.length === 0 && (
                  <p className="py-6 text-center text-sm text-slate-500">
                    Nothing logged this day 🎉
                  </p>
                )}
                {selData.attacks.map((a) => {
                  const dur = (a.end ? new Date(a.end).getTime() : Date.now()) - new Date(a.start).getTime();
                  const c = painColor(a.peakPain);
                  return (
                    <button
                      key={a.id}
                      onClick={() => setEditAttack(a)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-900 p-3 text-left shadow-sm"
                    >
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
                            <span className="ml-2 text-xs font-normal text-slate-500">
                              {fmtDuration(dur)}
                            </span>
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
                    </button>
                  );
                })}
                {selData.meds.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
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
                            {m.dose && <span className="text-slate-500">{m.dose}</span>}
                            <span className="ml-auto text-xs tabular-nums text-slate-500">{fmtTime(m.ts)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

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
    </div>
  );
}
