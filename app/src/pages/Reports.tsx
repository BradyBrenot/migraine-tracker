import { useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  ComposedChart, Line, Legend,
} from 'recharts';
import { Download, Clock, Activity, TrendingUp, CalendarX, ChevronLeft, ChevronRight } from 'lucide-react';
import { useStore } from '@/lib/store';
import { usageDaysInWindow, daysSinceLast } from '@/lib/usage';
import { useNow } from '@/lib/clock';
import { MED_CATALOG, allMedIds, medColor, medName, painColor } from '@/lib/meds';
import { fmtDuration } from '@/lib/format';
import { buildMonthlyTrend, buildReportLines } from '@/lib/report';
import {
  addMonths, dayKeyStartMs, localDayKey, monthStartKey, type DayKey,
} from '../../shared/datetime.ts';
import {
  attackDayKeysInMonth, attackOverlapsRange, parseAttackTimes, validDurationMs,
} from '../../shared/attackstats.ts';
import { Button } from '@/components/ui/button';

const TOOLTIP_STYLE = {
  background: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: 8,
};

function StatCard({
  icon: Icon, label, value, sub,
}: { icon: React.ElementType; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border bg-slate-900 p-4 shadow-sm">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-1 text-2xl font-black tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

export default function Reports() {
  const { state, readOnly } = useStore();
  const now = useNow();
  const timeZone = state.timezone;
  // exact-month view for on-screen stats: a configured-zone month key, so the
  // label, window bounds, and day buckets all agree with Calendar.
  const [cursor, setCursor] = useState<DayKey>(() => monthStartKey(localDayKey(now, timeZone)));
  const [reportSpan, setReportSpan] = useState<'3' | '6' | '12' | 'all'>('12');

  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: 'long', year: 'numeric', timeZone,
  }).format(new Date(dayKeyStartMs(cursor, timeZone)));

  const data = useMemo(() => {
    const monthPrefix = cursor.slice(0, 7);
    const mStart = dayKeyStartMs(cursor, timeZone);
    const mEnd = dayKeyStartMs(addMonths(cursor, 1), timeZone);

    const parsed = state.attacks.map((a) => ({
      attack: a,
      times: parseAttackTimes(a, now),
    }));
    // attacks counted by overlap (multi-day attacks count into this month),
    // but listed/counted once by their start month
    const overlap = parsed.filter(({ times }) => attackOverlapsRange(
      times.startMs, times.endMs, mStart, mEnd,
    ));
    const attacks = overlap.map(({ attack }) => attack);
    // Med days are bucketed in the configured zone, never by UTC slice.
    const meds = state.meds.filter((m) => {
      const t = Date.parse(m.ts);
      return Number.isFinite(t) && t >= mStart && t < mEnd;
    });

    // Only the shared duration definition feeds the average: ongoing,
    // unparseable, and negative-duration attacks are excluded, zero counts as 0.
    const durations = overlap
      .map(({ times }) => validDurationMs(times))
      .filter((d): d is number => d !== null);
    const avgMs = durations.length
      ? durations.reduce((s, d) => s + d, 0) / durations.length
      : null;
    const withPain = attacks.filter((a) => a.peakPain >= 0);
    const avgPain = withPain.length
      ? withPain.reduce((s, a) => s + a.peakPain, 0) / withPain.length
      : null;

    // distinct days with any attack (clipped to this month, half-open)
    const daysLost = new Set<string>();
    for (const { times } of overlap) {
      for (const key of attackDayKeysInMonth(times.startMs, times.endMs, monthPrefix, timeZone)) {
        daysLost.add(key);
      }
    }

    // pain distribution
    const painDist = Array.from({ length: 10 }, (_, i) => ({
      level: `${i + 1}`, count: 0,
    }));
    for (const a of withPain) {
      if (a.peakPain >= 1) painDist[a.peakPain - 1].count++;
    }

    // med usage days (catalog + custom imported meds)
    const medUsage = allMedIds(meds).map((id) => ({
      id,
      name: medName(id),
      days: new Set(
        meds.filter((e) => e.medId === id)
          .map((e) => localDayKey(Date.parse(e.ts), timeZone)),
      ).size,
      doses: meds.filter((e) => e.medId === id).length,
      color: medColor(id),
    })).filter((m) => m.doses > 0);

    // top triggers / symptoms
    const count = (items: string[][]) => {
      const c = new Map<string, number>();
      for (const list of items) for (const x of list) c.set(x, (c.get(x) ?? 0) + 1);
      return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    };
    const triggers = count(attacks.map((a) => a.triggers));
    const symptoms = count(attacks.map((a) => a.symptoms));

    // An attack (even a zero/negative-duration one) or any med makes the month
    // known; otherwise 0 days would look like a confirmed clear month.
    const hasData = attacks.length > 0 || meds.length > 0;

    return {
      attacks, meds, avgMs, avgPain, daysLost: daysLost.size, hasData, painDist, medUsage, triggers, symptoms,
    };
  }, [state.attacks, state.meds, cursor, timeZone, now]);

  // Monthly trend buckets — last 12 configured-zone calendar months, independent
  // of the month picker. This is the view that matches "how many migraine days
  // per month" from medical questionnaires.
  const monthly = useMemo(() => buildMonthlyTrend({
    attacks: state.attacks,
    meds: state.meds,
    timeZone,
    nowMs: now,
  }), [state.attacks, state.meds, timeZone, now]);

  /** Build a month-by-month Markdown report. */
  function downloadReport() {
    const lines = buildReportLines({
      attacks: state.attacks,
      meds: state.meds,
      timeZone,
      span: reportSpan,
      nowMs: Date.now(),
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `migraine-report-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* month picker + export -- wraps to separate rows at phone widths */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCursor((c) => addMonths(c, -1))}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="min-w-32 text-center text-base font-bold text-slate-100">
            {monthLabel}
          </span>
          <button
            onClick={() => setCursor((c) => addMonths(c, 1))}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800"
            aria-label="Next month"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-1.5">
            <div className="flex gap-1 rounded-lg border bg-slate-900 p-1">
              {(['3', '6', '12', 'all'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setReportSpan(s)}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                    reportSpan === s ? 'bg-white text-slate-950' : 'text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  {s === 'all' ? 'All' : `${s}mo`}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={downloadReport}>
              <Download className="h-4 w-4" /> Report
            </Button>
          </div>
        )}
      </div>

      {/* summary cards */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard
          icon={Activity}
          label="Attacks"
          value={data.hasData ? String(data.attacks.length) : '—'}
          sub={data.hasData ? undefined : 'no data this month'}
        />
        <StatCard
          icon={CalendarX}
          label="Days affected"
          value={data.hasData ? String(data.daysLost) : '—'}
          sub={data.hasData ? undefined : 'no data this month'}
        />
        <StatCard
          icon={Clock}
          label="Avg duration"
          value={data.avgMs !== null ? fmtDuration(data.avgMs) : '—'}
        />
        <StatCard
          icon={TrendingUp}
          label="Avg peak pain"
          value={data.avgPain !== null ? data.avgPain.toFixed(1) : '—'}
          sub={data.avgPain !== null ? 'out of 10' : undefined}
        />
      </div>

      {/* attack days per month — the MIDAS-style questionnaire metric */}
      <section className="rounded-2xl border bg-slate-900 p-4 shadow-sm">
        <h3 className="mb-1 text-sm font-bold">Attack days per month</h3>
        <p className="mb-3 text-xs text-slate-400">
          Last 12 months — the "how many migraine days per month" number from medical questionnaires
        </p>
        <ResponsiveContainer width="100%" height={210}>
          <ComposedChart data={monthly}>
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} />
            <YAxis yAxisId="left" allowDecimals={false} width={24} tick={{ fontSize: 11, fill: '#94a3b8' }} />
            <YAxis yAxisId="right" orientation="right" domain={[0, 10]} width={24} tick={{ fontSize: 11, fill: '#94a3b8' }} />
            <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#e2e8f0' }} />
            <Legend wrapperStyle={{ fontSize: 11, color: '#cbd5e1' }} />
            <Bar yAxisId="left" dataKey="attackDays" name="Attack days" fill="#56B4E9" radius={[6, 6, 0, 0]} />
            <Line
              yAxisId="right"
              dataKey="avgPain"
              name="Avg peak pain"
              stroke="#fde737"
              strokeWidth={2}
              dot={{ r: 2, fill: '#fde737' }}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </section>

      {/* medication days per month, stacked by med */}
      <section className="rounded-2xl border bg-slate-900 p-4 shadow-sm">
        <h3 className="mb-1 text-sm font-bold">Medication days per month</h3>
        <p className="mb-3 text-xs text-slate-400">
          Distinct days each med was used — spot overuse patterns at a glance
        </p>
        <ResponsiveContainer width="100%" height={210}>
          <BarChart data={monthly}>
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} />
            <YAxis allowDecimals={false} width={24} tick={{ fontSize: 11, fill: '#94a3b8' }} />
            <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#e2e8f0' }} />
            <Legend wrapperStyle={{ fontSize: 11, color: '#cbd5e1' }} />
            {allMedIds(state.meds).map((id) => (
              <Bar key={id} dataKey={id} name={medName(id)} stackId="meds" fill={medColor(id)} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* pain distribution */}
        <section className="rounded-2xl border bg-slate-900 p-4 shadow-sm">
          <h3 className="mb-1 text-sm font-bold">Peak pain distribution</h3>
          <p className="mb-2 text-xs text-slate-400">
            {monthLabel}
          </p>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={data.painDist}>
              <XAxis dataKey="level" tick={{ fontSize: 11, fill: '#94a3b8' }} />
              <YAxis allowDecimals={false} width={24} tick={{ fontSize: 11, fill: '#94a3b8' }} />
              <Tooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }}
                labelStyle={{ color: '#e2e8f0' }}
              />
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {data.painDist.map((_, i) => (
                  <Cell key={i} fill={painColor(i + 1)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>

        {/* med usage */}
        <section className="rounded-2xl border bg-slate-900 p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-bold">Medication days</h3>
          {data.medUsage.length ? (
            <div className="space-y-3">
              {data.medUsage.map((m) => {
                const rule = state.rules[m.id];
                const windowUsed = rule
                  ? usageDaysInWindow(state.meds, m.id, rule.windowDays, now, state.timezone)
                  : null;
                return (
                  <div key={m.name}>
                    <div className="flex justify-between text-sm">
                      <span className="font-medium">{m.name}</span>
                      <span className="tabular-nums text-slate-400">
                        {m.days} days · {m.doses} doses
                        {rule && windowUsed !== null && (
                          <span
                            className={`ml-1 font-semibold ${
                              windowUsed >= rule.limit ? 'text-rose-400' : ''
                            }`}
                          >
                            ({windowUsed}/{rule.limit} in 30d)
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full"
                        style={{
                          background: m.color,
                          width: `${Math.min(100, (m.days / Math.max(1, ...data.medUsage.map((x) => x.days))) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-slate-400">No meds logged this month</p>
          )}
        </section>
      </div>

      {/* preventives timing */}
      <section className="rounded-2xl border bg-slate-900 p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-bold">Preventive timing</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {MED_CATALOG.filter((m) => m.kind === 'preventive').map((m) => {
            const d = daysSinceLast(state.meds, m.id, now, state.timezone);
            const interval = m.intervalDays ?? 30;
            return (
              <div key={m.id} className="flex items-center gap-3 rounded-lg bg-slate-800 p-3">
                <span className="h-8 w-1.5 rounded-full" style={{ background: m.color }} />
                <div className="flex-1">
                  <div className="text-sm font-semibold">{m.name}</div>
                  <div className="text-xs text-slate-400">
                    {d === null
                      ? 'never logged'
                      : d >= interval
                        ? `${d} days since last dose — overdue (every ~${interval}d)`
                        : `${d} days since last dose — next in ~${interval - d}d`}
                  </div>
                </div>
                {d !== null && d >= interval && (
                  <span className="rounded-full bg-rose-950 px-2 py-0.5 text-[10px] font-bold text-rose-300">
                    DUE
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* triggers & symptoms */}
      <div className="grid gap-4 sm:grid-cols-2">
        {[
          { title: 'Top triggers', items: data.triggers },
          { title: 'Top symptoms', items: data.symptoms },
        ].map(({ title, items }) => (
          <section key={title} className="rounded-2xl border bg-slate-900 p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-bold">{title}</h3>
            {items.length ? (
              <div className="space-y-2">
                {items.map(([name, n]) => (
                  <div key={name} className="flex items-center gap-2 text-sm">
                    <span className="w-32 truncate">{name}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-slate-700"
                        style={{ width: `${(n / items[0][1]) * 100}%` }}
                      />
                    </div>
                    <span className="w-6 text-right text-xs tabular-nums text-slate-400">{n}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-slate-400">None recorded</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
