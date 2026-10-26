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
import { dayKey, fmtDuration } from '@/lib/format';
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
  const { state } = useStore();
  const now = useNow();
  // exact-month view for on-screen stats
  const [cursor, setCursor] = useState(() => {
    const d = new Date(); d.setDate(1); return d;
  });
  const [reportSpan, setReportSpan] = useState<'3' | '6' | '12' | 'all'>('12');

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const monthLabel = cursor.toLocaleDateString([], { month: 'long', year: 'numeric' });

  const data = useMemo(() => {
    const mStart = new Date(year, month, 1).getTime();
    const mEnd = new Date(year, month + 1, 1).getTime();
    const inMonth = (ts: string) => {
      const t = new Date(ts).getTime();
      return t >= mStart && t < mEnd;
    };
    // attacks counted by overlap (multi-day attacks count into this month),
    // but listed/counted once by their start month
    const attacks = state.attacks.filter((a) => {
      const s = new Date(a.start).getTime();
      const e = a.end ? new Date(a.end).getTime() : now;
      return s < mEnd && e >= mStart;
    });
    const meds = state.meds.filter((m) => inMonth(m.ts));

    const finished = attacks.filter((a) => a.end);
    const totalMs = finished.reduce(
      (s, a) => s + (new Date(a.end!).getTime() - new Date(a.start).getTime()), 0);
    const avgMs = finished.length ? totalMs / finished.length : 0;
    const withPain = attacks.filter((a) => a.peakPain >= 0);
    const avgPain = withPain.length
      ? withPain.reduce((s, a) => s + a.peakPain, 0) / withPain.length
      : 0;

    // distinct days with any attack (clipped to this month)
    const daysLost = new Set<string>();
    for (const a of attacks) {
      const s = new Date(a.start).getTime();
      const e = a.end ? new Date(a.end).getTime() : now;
      for (let t = Math.max(s, mStart); t < Math.min(e, mEnd); t += 86400000) {
        daysLost.add(dayKey(new Date(t)));
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
          .map((e) => e.ts.slice(0, 10)),
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

    return { attacks, meds, avgMs, avgPain, daysLost: daysLost.size, painDist, medUsage, triggers, symptoms };
  }, [state, year, month, now]);

  // Monthly trend buckets — last 12 calendar months, independent of the
  // month picker. This is the view that matches "how many migraine days
  // per month" from medical questionnaires.
  const monthly = useMemo(() => {
    const nowDate = new Date(now);
    const rows = [];
    for (let i = 11; i >= 0; i--) {
      const first = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1);
      const mStart = first.getTime();
      const mEnd = new Date(first.getFullYear(), first.getMonth() + 1, 1).getTime();

      const days = new Set<string>();
      let attacks = 0;
      let painSum = 0;
      let painN = 0;
      for (const a of state.attacks) {
        const s = new Date(a.start).getTime();
        const e = a.end ? new Date(a.end).getTime() : now;
        if (s >= mEnd || e < mStart) continue;
        attacks++;
        if (a.peakPain >= 0) { painSum += a.peakPain; painN++; }
        for (let t = Math.max(s, mStart); t < Math.min(e, mEnd); t += 86400000) {
          days.add(dayKey(new Date(t)));
        }
      }

      const medDays: Record<string, number> = {};
      for (const id of allMedIds(state.meds)) {
        medDays[id] = new Set(
          state.meds
            .filter((e) => {
              const t = new Date(e.ts).getTime();
              return e.medId === id && t >= mStart && t < mEnd;
            })
            .map((e) => dayKey(new Date(e.ts))),
        ).size;
      }

      rows.push({
        month: first.toLocaleDateString([], { month: 'short' }),
        attackDays: days.size,
        attacks,
        avgPain: painN ? +(painSum / painN).toFixed(1) : null,
        ...medDays,
      });
    }
    return rows;
  }, [state.attacks, state.meds, now]);

  /** Build a month-by-month Markdown report. */
  function downloadReport() {
    const now = new Date();

    // figure out which months have any data at all
    const firstTs = Math.min(
      ...state.attacks.map((a) => new Date(a.start).getTime()),
      ...state.meds.map((m) => new Date(m.ts).getTime()),
      now.getTime(),
    );
    const first = new Date(firstTs);
    const allMonths: { y: number; m: number }[] = [];
    for (
      let d = new Date(first.getFullYear(), first.getMonth(), 1);
      d <= now;
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1)
    ) {
      allMonths.push({ y: d.getFullYear(), m: d.getMonth() });
    }
    const months =
      reportSpan === 'all' ? allMonths : allMonths.slice(-Number(reportSpan));

    const lines: string[] = [
      `# Migraine Report`,
      `Generated: ${now.toLocaleString()}`,
      `Coverage: ${months.length ? new Date(months[0].y, months[0].m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' }) : '—'} → ${now.toLocaleDateString([], { month: 'long', year: 'numeric' })}`,
      '',
    ];

    let totalAttackDays = 0;
    let totalAttacks = 0;

    for (const { y, m } of months) {
      const mStart = new Date(y, m, 1).getTime();
      const mEnd = new Date(y, m + 1, 1).getTime();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const monthLabel = new Date(y, m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });

      // attacks overlapping this month (listed by start month)
      const monthAttacks = state.attacks.filter((a) => {
        const s = new Date(a.start).getTime();
        return s >= mStart && s < mEnd;
      });
      const days = new Set<string>();
      for (const a of state.attacks) {
        const s = new Date(a.start).getTime();
        const e = a.end ? new Date(a.end).getTime() : now.getTime();
        if (s >= mEnd || e < mStart) continue;
        for (let t = Math.max(s, mStart); t < Math.min(e, mEnd); t += 86400000) {
          days.add(dayKey(new Date(t)));
        }
      }

      const monthMeds = state.meds.filter((e) => {
        const t = new Date(e.ts).getTime();
        return t >= mStart && t < mEnd;
      });

      const finished = monthAttacks.filter((a) => a.end);
      const totalMs = finished.reduce(
        (s, a) => s + (new Date(a.end!).getTime() - new Date(a.start).getTime()), 0);
      const withPain = monthAttacks.filter((a) => a.peakPain >= 0);
      const avgPain = withPain.length
        ? withPain.reduce((s, a) => s + a.peakPain, 0) / withPain.length
        : null;

      totalAttackDays += days.size;
      totalAttacks += monthAttacks.length;

      lines.push(`## ${monthLabel}`);
      lines.push(
        `**${days.size} attack days of ${daysInMonth}** · ${monthAttacks.length} attacks` +
          (avgPain !== null ? ` · avg peak pain ${avgPain.toFixed(1)}/10` : '') +
          (totalMs ? ` · avg duration ${fmtDuration(totalMs / Math.max(1, finished.length))}` : ''),
      );
      lines.push('');

      // medications this month
      if (monthMeds.length) {
        const byMed = new Map<string, { days: Set<string>; doses: number }>();
        for (const e of monthMeds) {
          const entry = byMed.get(e.medId) ?? { days: new Set<string>(), doses: 0 };
          entry.days.add(dayKey(new Date(e.ts)));
          entry.doses++;
          byMed.set(e.medId, entry);
        }
        lines.push(`Medications:`);
        for (const [medId, v] of byMed) {
          lines.push(`- ${medName(medId)}: ${v.days.size} days, ${v.doses} doses`);
        }
        lines.push('');
      }

      // triggers / symptoms this month
      const tally = (lists: string[][]) => {
        const c = new Map<string, number>();
        for (const l of lists) for (const x of l) c.set(x, (c.get(x) ?? 0) + 1);
        return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([k, n]) => `${k} (${n})`).join(', ');
      };
      const trig = tally(monthAttacks.map((a) => a.triggers));
      const sym = tally(monthAttacks.map((a) => a.symptoms));
      if (trig) lines.push(`Triggers: ${trig}`);
      if (sym) lines.push(`Symptoms: ${sym}`);
      if (trig || sym) lines.push('');

      // attack list
      for (const a of monthAttacks) {
        const dur = a.end
          ? fmtDuration(new Date(a.end).getTime() - new Date(a.start).getTime())
          : 'ongoing';
        const linked = state.meds.filter((e) => e.attackId === a.id);
        lines.push(
          `- ${new Date(a.start).toLocaleString()} — peak ${a.peakPain >= 0 ? a.peakPain + '/10' : '?'}, ${dur}` +
            (linked.length ? ` — meds: ${linked.map((e) => medName(e.medId)).join(', ')}` : '') +
            (a.symptoms.length ? ` — ${a.symptoms.join(', ')}` : '') +
            (a.notes ? ` — "${a.notes}"` : ''),
        );
      }
      lines.push('');
    }

    // overall summary at the end
    lines.push(`## Overall`);
    lines.push(`- ${totalAttacks} attacks across ${totalAttackDays} attack days`);
    if (months.length) {
      lines.push(`- Average ${(totalAttackDays / months.length).toFixed(1)} attack days/month`);
    }
    lines.push('');
    lines.push(`### Preventives`);
    for (const m of MED_CATALOG.filter((x) => x.kind === 'preventive')) {
      const doses = state.meds
        .filter((e) => e.medId === m.id)
        .sort((a, b) => a.ts.localeCompare(b.ts));
      const d = daysSinceLast(state.meds, m.id, Date.now(), state.timezone);
      lines.push(
        `- ${m.name}: last dose ${d === null ? 'never logged' : `${d} days ago`} (every ~${m.intervalDays}d)` +
          (doses.length
            ? `; recent: ${doses.slice(-4).map((e) => new Date(e.ts).toLocaleDateString()).join(', ')}`
            : ''),
      );
    }

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
            onClick={() => setCursor(new Date(year, month - 1, 1))}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="min-w-32 text-center text-base font-bold text-slate-100">
            {monthLabel}
          </span>
          <button
            onClick={() => setCursor(new Date(year, month + 1, 1))}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800"
            aria-label="Next month"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
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
      </div>

      {/* summary cards */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard icon={Activity} label="Attacks" value={String(data.attacks.length)} />
        <StatCard icon={CalendarX} label="Days affected" value={String(data.daysLost)} />
        <StatCard
          icon={Clock}
          label="Avg duration"
          value={data.avgMs ? fmtDuration(data.avgMs) : '—'}
        />
        <StatCard
          icon={TrendingUp}
          label="Avg peak pain"
          value={data.avgPain ? data.avgPain.toFixed(1) : '—'}
          sub={data.avgPain ? 'out of 10' : undefined}
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
