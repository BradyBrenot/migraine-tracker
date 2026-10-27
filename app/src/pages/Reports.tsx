import { useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  ComposedChart, Line, Legend,
} from 'recharts';
import { Download, Clock, Activity, TrendingUp, CalendarX, ChevronLeft, ChevronRight } from 'lucide-react';
import { useStore } from '@/lib/store';
import {
  PAINKILLER_DEFAULT_RULE, PAINKILLER_MED_IDS, limitState, medUnionDaysInWindow,
  painkillerRulesDiffer, resolveRule, resolveSharedPainkillerRule, usageDaysInWindow,
} from '@/lib/usage';
import { useNow } from '@/lib/clock';
import { MED_MAP, allMedIds, medColor, medName, painColor } from '@/lib/meds';
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
  fontSize: 12,
  color: '#e2e8f0',
};

/** A chart axis/legend label size that stays legible without crowding ticks. */
const AXIS_TICK = { fontSize: 12, fill: '#94a3b8' } as const;
const LEGEND_STYLE = { fontSize: 12, color: '#cbd5e1' } as const;

function StatCard({
  icon: Icon, label, value, sub,
}: { icon: React.ElementType; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-1 text-2xl font-black tabular-nums text-slate-100">{value}</div>
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

  // An ongoing attack's end is `now`; every finished attack ignores the render
  // clock. Anchoring finished-only derivations to a stable instant keeps the
  // chart/stat data identical across 15s ticks while ongoing attacks still
  // track `now` exactly.
  const hasOngoingAttack = useMemo(
    () => state.attacks.some((attack) => attack.end === null),
    [state.attacks],
  );

  const monthLabelFormatter = useMemo(
    () => new Intl.DateTimeFormat(undefined, {
      month: 'long', year: 'numeric', timeZone,
    }),
    [timeZone],
  );
  const monthLabel = monthLabelFormatter.format(new Date(dayKeyStartMs(cursor, timeZone)));

  // Selected-month start, stable for as long as the picker stays put.
  const cursorStartMs = useMemo(
    () => dayKeyStartMs(cursor, timeZone),
    [cursor, timeZone],
  );
  const dataNow = hasOngoingAttack ? now : cursorStartMs;

  const data = useMemo(() => {
    const monthPrefix = cursor.slice(0, 7);
    const mStart = dayKeyStartMs(cursor, timeZone);
    const mEnd = dayKeyStartMs(addMonths(cursor, 1), timeZone);

    const parsed = state.attacks.map((a) => ({
      attack: a,
      times: parseAttackTimes(a, dataNow),
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

    // med usage days (catalog + custom imported meds): one pass over this
    // month's medications instead of one full scan per med id.
    const perMed = new Map<string, { days: Set<string>; doses: number }>();
    for (const med of meds) {
      const entry = perMed.get(med.medId) ?? { days: new Set<string>(), doses: 0 };
      entry.days.add(localDayKey(Date.parse(med.ts), timeZone));
      entry.doses++;
      perMed.set(med.medId, entry);
    }
    const medUsage = allMedIds(meds)
      .map((id) => {
        const entry = perMed.get(id);
        return {
          id,
          name: medName(id),
          days: entry ? entry.days.size : 0,
          doses: entry ? entry.doses : 0,
          color: medColor(id),
        };
      })
      .filter((m) => m.doses > 0);
    // Longest bar in the med-usage panel, so the render loop does not rebuild
    // the max for every row.
    const medUsageMax = medUsage.reduce((max, m) => Math.max(max, m.days), 0);

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
      attacks, meds, avgMs, avgPain, daysLost: daysLost.size, hasData, painDist,
      medUsage, medUsageMax, triggers, symptoms,
    };
  }, [state.attacks, state.meds, cursor, timeZone, dataNow]);

  // Monthly trend buckets — last 12 configured-zone calendar months, independent
  // of the month picker. This is the view that matches "how many migraine days
  // per month" from medical questionnaires.
  //
  // Only the current month and ongoing attacks depend on the clock, so anchor
  // the finished-history chart to the current month's first instant: the chart
  // data keeps its identity across 15s ticks and rebuilds at month rollover.
  const currentMonthKey = monthStartKey(localDayKey(now, timeZone));
  const currentMonthStartMs = useMemo(
    () => dayKeyStartMs(currentMonthKey, timeZone),
    [currentMonthKey, timeZone],
  );
  const trendNow = hasOngoingAttack ? now : currentMonthStartMs;
  const monthly = useMemo(() => buildMonthlyTrend({
    attacks: state.attacks,
    meds: state.meds,
    timeZone,
    nowMs: trendNow,
  }), [state.attacks, state.meds, timeZone, trendNow]);

  // Shared painkiller (MOH) budget: ONE rolling count for Tylenol + Ibuprofen +
  // Naproxen, resolved exactly like Calendar/Home so mismatched or partial
  // imported rules cannot render NaN/undefined.
  const painkillerRule = resolveSharedPainkillerRule(state.rules);
  const painkillerRulesMismatch = painkillerRulesDiffer(state.rules);
  const painkillerUsed = medUnionDaysInWindow(
    state.meds, PAINKILLER_MED_IDS, painkillerRule.windowDays, now, timeZone,
  );
  const painkillerUsage = limitState(painkillerUsed, painkillerRule.limit);
  const painkillerOver = painkillerUsage === 'over';
  const painkillerNear = painkillerUsage === 'near';
  const painkillerThisMonth = data.medUsage.some(
    (m) => PAINKILLER_MED_IDS.includes(m.id as (typeof PAINKILLER_MED_IDS)[number]),
  );
  const showPainkillerSummary = painkillerThisMonth || painkillerUsed > 0;
  const painkillerSummaryText =
    `${painkillerUsed} / ${painkillerRule.limit} days in the last ${painkillerRule.windowDays} days`;

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
    <div className="space-y-5">
      <h1 className="sr-only">Reports</h1>

      {/* ── Report download: the range belongs to the file, not the charts ── */}
      {!readOnly && (
        <section
          aria-labelledby="report-download-title"
          className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm"
        >
          <h2 id="report-download-title" className="text-sm font-bold">
            Report download
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Choose how much history the downloaded Markdown report covers. This range
            applies only to the file — the charts below keep their own fixed windows.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Report range (download only)"
              className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1"
            >
              {(['3', '6', '12', 'all'] as const).map((s) => (
                <button
                  key={s}
                  aria-pressed={reportSpan === s}
                  onClick={() => setReportSpan(s)}
                  className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-md px-2.5 text-xs font-semibold transition-colors ${
                    reportSpan === s
                      ? 'bg-primary text-primary-foreground'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {s === 'all' ? 'All' : `${s}mo`}
                </button>
              ))}
            </div>
            <Button size="sm" className="h-10 gap-1.5" onClick={downloadReport}>
              <Download className="h-4 w-4" /> Download report
            </Button>
          </div>
        </section>
      )}

      {/* ── Monthly summary ────────────────────────────────────── */}
      <section aria-labelledby="report-month-title" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="report-month-title"
            className="text-sm font-bold uppercase tracking-wide text-slate-400"
          >
            Monthly summary
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCursor((c) => addMonths(c, -1))}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-800"
              aria-label="Previous month"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="min-w-32 text-center text-base font-bold text-slate-100">
              {monthLabel}
            </span>
            <button
              onClick={() => setCursor((c) => addMonths(c, 1))}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-800"
              aria-label="Next month"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
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

        <div className="grid gap-3 lg:grid-cols-2">
          {/* pain distribution */}
          <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
            <h3 className="mb-1 text-sm font-bold">Peak pain distribution</h3>
            <p className="mb-2 text-xs text-slate-400">
              {monthLabel}
            </p>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={data.painDist}>
                <XAxis dataKey="level" tick={AXIS_TICK} />
                <YAxis allowDecimals={false} width={24} tick={AXIS_TICK} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#e2e8f0' }} />
                <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                  {data.painDist.map((_, i) => (
                    <Cell key={i} fill={painColor(i + 1)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </section>

          {/* med usage */}
          <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-bold">Medication days</h3>
            {showPainkillerSummary && (
              <div
                role="group"
                aria-label="Painkillers medication-overuse summary"
                className="mb-3 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2"
              >
                <p className="text-xs text-slate-300">
                  <span className="font-semibold text-slate-100">Painkillers combined</span>{' '}
                  <span
                    className={
                      painkillerOver
                        ? 'font-semibold text-red-400'
                        : painkillerNear
                          ? 'font-semibold text-amber-300'
                          : 'tabular-nums text-slate-300'
                    }
                  >
                    {painkillerSummaryText}
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
                  Tylenol, Ibuprofen and Naproxen share one limit; different meds on
                  one day count once.
                </p>
                {painkillerRulesMismatch && (
                  <p className="mt-0.5 text-[11px] leading-snug text-amber-300">
                    Saved painkiller rules differ — using the lowest limit and widest
                    window.
                  </p>
                )}
              </div>
            )}
            {data.medUsage.length ? (
              <div className="space-y-3">
                {data.medUsage.map((m) => {
                  // Legacy/imported rules can be partial. Resolve each field
                  // against the catalog default so a `{ limit: 15 }` rule still
                  // gets a real window instead of printing NaN/undefined.
                  // The three painkillers are excluded: they share ONE aggregate
                  // MOH count shown above, so per-med rolling numbers would
                  // overstate and contradict it.
                  const isPainkiller = PAINKILLER_MED_IDS.includes(
                    m.id as (typeof PAINKILLER_MED_IDS)[number],
                  );
                  const rule = isPainkiller ? null : state.rules[m.id];
                  const resolved = rule
                    ? resolveRule(rule, MED_MAP[m.id]?.defaultRule ?? PAINKILLER_DEFAULT_RULE)
                    : null;
                  const windowDays = resolved?.windowDays ?? null;
                  const limit = resolved?.limit ?? null;
                  const windowUsed = windowDays !== null
                    ? usageDaysInWindow(state.meds, m.id, windowDays, now, state.timezone)
                    : null;
                  const daysLabel = `${m.days} ${m.days === 1 ? 'day' : 'days'}`;
                  const dosesLabel = `${m.doses} ${m.doses === 1 ? 'dose' : 'doses'}`;
                  // Same severity rule as Home/Calendar: over only past the
                  // limit, near only with at least one used day.
                  const rollingUsage = windowDays !== null && limit !== null && windowUsed !== null
                    ? limitState(windowUsed, limit)
                    : 'ok';
                  return (
                    <div key={m.name}>
                      <div className="flex justify-between text-sm">
                        <span className="font-medium">{m.name}</span>
                        <span className="tabular-nums text-slate-400">
                          {daysLabel} · {dosesLabel}
                          {windowDays !== null && limit !== null && windowUsed !== null && (
                            <span
                              className={`ml-1 font-semibold ${
                                rollingUsage === 'over'
                                  ? 'text-red-400'
                                  : rollingUsage === 'near'
                                    ? 'text-amber-300'
                                    : ''
                              }`}
                            >
                              ({windowUsed}/{limit} in {windowDays}d)
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full"
                          style={{
                            background: m.color,
                            width: `${Math.min(100, (m.days / Math.max(1, data.medUsageMax)) * 100)}%`,
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

        {/* triggers & symptoms — scoped to the selected month */}
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { title: 'Top triggers', items: data.triggers },
            { title: 'Top symptoms', items: data.symptoms },
          ].map(({ title, items }) => (
            <section
              key={title}
              className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm"
            >
              <h3 className="mb-3 text-sm font-bold">{title}</h3>
              {items.length ? (
                <div className="space-y-2">
                  {items.map(([name, n]) => (
                    <div key={name} className="flex items-center gap-2 text-sm">
                      <span className="w-32 truncate">{name}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-slate-600"
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
      </section>

      {/* ── 12-month trends (fixed view, unaffected by the export range) ── */}
      <section aria-labelledby="report-trends-title" className="space-y-3">
        <div>
          <h2
            id="report-trends-title"
            className="text-sm font-bold uppercase tracking-wide text-slate-400"
          >
            12-month trends
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Always the last 12 months — independent of the month above and of the
            download range.
          </p>
        </div>

        {/* attack days per month — the MIDAS-style questionnaire metric */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
          <h3 className="mb-1 text-sm font-bold">Attack days per month</h3>
          <p className="mb-3 text-xs text-slate-400">
            The “how many migraine days per month” number from medical questionnaires
          </p>
          <ResponsiveContainer width="100%" height={210}>
            <ComposedChart data={monthly}>
              <XAxis dataKey="month" tick={AXIS_TICK} />
              <YAxis yAxisId="left" allowDecimals={false} width={28} tick={AXIS_TICK} />
              <YAxis yAxisId="right" orientation="right" domain={[0, 10]} width={28} tick={AXIS_TICK} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#e2e8f0' }} />
              <Legend wrapperStyle={LEGEND_STYLE} />
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
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
          <h3 className="mb-1 text-sm font-bold">Medication days per month</h3>
          <p className="mb-3 text-xs text-slate-400">
            Distinct days each med was used — spot overuse patterns at a glance
          </p>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={monthly}>
              <XAxis dataKey="month" tick={AXIS_TICK} />
              <YAxis allowDecimals={false} width={28} tick={AXIS_TICK} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#e2e8f0' }} />
              <Legend wrapperStyle={LEGEND_STYLE} />
              {allMedIds(state.meds).map((id) => (
                <Bar key={id} dataKey={id} name={medName(id)} stackId="meds" fill={medColor(id)} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </section>
      </section>
    </div>
  );
}
