import type { Attack, MedEvent } from '@/types';
import { MED_CATALOG, allMedIds, medName } from '@/lib/meds';
import { daysSinceLast } from '@/lib/usage';
import { fmtDuration } from '@/lib/format';
import {
  addMonths, dayKeyStartMs, diffDayKeys, localDayKey, monthStartKey, type DayKey,
} from '../../shared/datetime.ts';
import {
  attackDayKeysInMonth, attackOverlapsRange, parseAttackTimes, validDurationMs,
} from '../../shared/attackstats.ts';

/**
 * Markdown report body construction, kept pure and out of the React page so it
 * can be unit-tested without rendering a chart (Reports.tsx only owns the
 * Blob/download plumbing).
 *
 * All month windows, day buckets, and labels use the configured IANA
 * `timeZone` and the shared half-open attack helpers — never browser-local
 * Dates, fixed 24h steps, or UTC `slice(0, 10)` day keys.
 */
export interface ReportInput {
  attacks: Attack[];
  meds: MedEvent[];
  /** Configured IANA zone (state.timezone). */
  timeZone: string;
  span: '3' | '6' | '12' | 'all';
  /** Reference instant; also the end of an ongoing attack. */
  nowMs: number;
}

/** Safety cap on the month list; real data never spans centuries. */
const MAX_MONTHS = 2400;

function formatMonth(key: DayKey, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long', year: 'numeric', timeZone,
  }).format(new Date(dayKeyStartMs(key, timeZone)));
}

function formatInstant(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short', timeZone,
  }).format(new Date(ms));
}

function formatDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone,
  }).format(new Date(ms));
}

/** True for a day key in the normal 4-digit-year domain ('YYYY-MM-DD'). */
const ISO_DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Largest magnitude instant `Date`/`Intl` can format (ECMAScript time value). */
const MAX_DATE_MS = 8.64e15;

/**
 * Month key containing `ms`, or null for instants outside the day-key domain
 * (e.g. a pathological year-275760 timestamp). Garbage must not enter the
 * month list.
 */
function monthKeyOf(ms: number, timeZone: string): DayKey | null {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  const key = monthStartKey(localDayKey(ms, timeZone));
  return ISO_DAY_KEY.test(key) ? key : null;
}

/** Every month key ('YYYY-MM-01') from `firstKey` through `lastKey`. */
function monthsBetween(firstKey: DayKey, lastKey: DayKey): DayKey[] {
  // Walk backwards from the current month so the cap (if it ever applies to
  // absurd legacy timestamps) drops ancient months, never recent ones.
  let key = lastKey;
  const months: DayKey[] = [];
  while (key >= firstKey && months.length < MAX_MONTHS) {
    months.push(key);
    key = addMonths(key, -1);
  }
  return months.reverse();
}

/**
 * Build the month-by-month trend chart rows (the most recent `months`
 * configured-zone calendar months, oldest first).
 *
 * `attackDays` is `null` for a month with no records at all: a blank chart gap,
 * never a confirmed zero. A month with any medication is known data, so its
 * zero attack days is a real zero. Attack counts match the Calendar month
 * header: every attack overlapping the month counts in it.
 */
export interface MonthlyTrendRow {
  month: string;
  attackDays: number | null;
  attacks: number;
  avgPain: number | null;
  /** Distinct configured-zone days per medication id. */
  [medId: string]: number | string | null;
}

export function buildMonthlyTrend(input: {
  attacks: Attack[];
  meds: MedEvent[];
  timeZone: string;
  nowMs: number;
  /** Defaults to 12. */
  months?: number;
}): MonthlyTrendRow[] {
  const {
    attacks, meds, timeZone, nowMs, months = 12,
  } = input;
  const currentMonth = monthStartKey(localDayKey(nowMs, timeZone));
  const parsed = attacks.map((attack) => ({
    attack,
    times: parseAttackTimes(attack, nowMs),
  }));
  const parsedMeds = meds
    .map((med) => ({ med, ts: Date.parse(med.ts) }))
    .filter(({ ts }) => Number.isFinite(ts));
  const medIds = allMedIds(meds);

  const rows: MonthlyTrendRow[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const monthKey = addMonths(currentMonth, -i);
    const monthPrefix = monthKey.slice(0, 7);
    const mStart = dayKeyStartMs(monthKey, timeZone);
    const mEnd = dayKeyStartMs(addMonths(monthKey, 1), timeZone);

    const days = new Set<DayKey>();
    let attackCount = 0;
    let painSum = 0;
    let painN = 0;
    for (const { attack, times } of parsed) {
      if (!attackOverlapsRange(times.startMs, times.endMs, mStart, mEnd)) continue;
      attackCount++;
      if (attack.peakPain >= 0) { painSum += attack.peakPain; painN++; }
      for (const key of attackDayKeysInMonth(times.startMs, times.endMs, monthPrefix, timeZone)) {
        days.add(key);
      }
    }

    const monthMeds = parsedMeds.filter(({ ts }) => ts >= mStart && ts < mEnd);
    const medDays: Record<string, number> = {};
    for (const id of medIds) {
      medDays[id] = new Set(
        monthMeds
          .filter(({ med }) => med.medId === id)
          .map(({ ts }) => localDayKey(ts, timeZone)),
      ).size;
    }

    // No attack overlap and no medication = unknown month, not a clear one.
    const hasData = attackCount > 0 || monthMeds.length > 0;
    rows.push({
      month: new Intl.DateTimeFormat(undefined, { month: 'short', timeZone })
        .format(new Date(mStart)),
      attackDays: hasData ? days.size : null,
      attacks: attackCount,
      avgPain: painN ? +(painSum / painN).toFixed(1) : null,
      ...medDays,
    });
  }
  return rows;
}

/**
 * Build the month-by-month Markdown report as lines. Pure: no DOM, no clock,
 * no store access.
 */
export function buildReportLines(input: ReportInput): string[] {
  const { attacks, meds, timeZone, span, nowMs } = input;
  const nowMonth = monthStartKey(localDayKey(nowMs, timeZone));

  const parsedAttacks = attacks.map((attack) => ({
    attack,
    times: parseAttackTimes(attack, nowMs),
  }));

  // Earliest usable record month anchors the month list. Unparseable strings
  // and instants outside the day-key domain are ignored (Math.min over NaN
  // would poison the whole list, as would a year-275760 timestamp).
  let firstMonthKey = nowMonth;
  for (const { times } of parsedAttacks) {
    if (times.startMs === null) continue;
    const key = monthKeyOf(times.startMs, timeZone);
    if (key !== null && key < firstMonthKey) firstMonthKey = key;
  }
  for (const med of meds) {
    const t = Date.parse(med.ts);
    if (!Number.isFinite(t)) continue;
    const key = monthKeyOf(t, timeZone);
    if (key !== null && key < firstMonthKey) firstMonthKey = key;
  }

  const allMonths = monthsBetween(firstMonthKey, nowMonth);
  const months = span === 'all' ? allMonths : allMonths.slice(-Number(span));

  const lines: string[] = [
    `# Migraine Report`,
    `Generated: ${formatInstant(nowMs, timeZone)}`,
    `Coverage: ${formatMonth(months[0], timeZone)} → ${formatMonth(nowMonth, timeZone)}`,
    '',
  ];

  let totalAttackDays = 0;
  let totalAttacks = 0;
  let monthsWithData = 0;

  for (const monthKey of months) {
    const monthPrefix = monthKey.slice(0, 7);
    const monthStartMs = dayKeyStartMs(monthKey, timeZone);
    const nextMonthKey = addMonths(monthKey, 1);
    const monthEndMs = dayKeyStartMs(nextMonthKey, timeZone);
    const daysInMonth = diffDayKeys(nextMonthKey, monthKey);
    const monthLabel = formatMonth(monthKey, timeZone);

    // Attacks are listed/counted once, by START month (one row per attack).
    // Days are attributed by overlap instead, so a multi-day attack still
    // contributes its days to every month it touches without being listed
    // twice.
    const monthEntries = parsedAttacks.filter(({ times }) => times.startMs !== null
      && times.startMs >= monthStartMs
      && times.startMs < monthEndMs);
    const monthAttacks = monthEntries.map(({ attack }) => attack);

    const days = new Set<DayKey>();
    for (const { times } of parsedAttacks) {
      if (!attackOverlapsRange(times.startMs, times.endMs, monthStartMs, monthEndMs)) continue;
      for (const key of attackDayKeysInMonth(times.startMs, times.endMs, monthPrefix, timeZone)) {
        days.add(key);
      }
    }

    const monthMeds = meds.filter((m) => {
      const t = Date.parse(m.ts);
      return Number.isFinite(t) && t >= monthStartMs && t < monthEndMs;
    });

    // A month is "known" when anything was recorded in it: an attack that
    // starts or spans into it, or any medication. Only then is 0 attack days
    // a real zero; otherwise the month is unknown, not clear.
    const hasData = days.size > 0 || monthAttacks.length > 0 || monthMeds.length > 0;

    lines.push(`## ${monthLabel}`);
    if (!hasData) {
      lines.push('No data recorded this month.');
      lines.push('');
      continue;
    }
    monthsWithData++;
    totalAttackDays += days.size;
    totalAttacks += monthAttacks.length;

    let painSum = 0;
    let painN = 0;
    const durations: number[] = [];
    for (const { attack, times } of monthEntries) {
      const duration = validDurationMs(times);
      if (duration !== null) durations.push(duration);
      if (attack.peakPain >= 0) {
        painSum += attack.peakPain;
        painN++;
      }
    }

    const summary = [`**${days.size} attack days of ${daysInMonth}**`, `${monthAttacks.length} attacks`];
    if (painN > 0) summary.push(`avg peak pain ${(painSum / painN).toFixed(1)}/10`);
    if (durations.length > 0) {
      summary.push(`avg duration ${fmtDuration(durations.reduce((s, d) => s + d, 0) / durations.length)}`);
    }
    lines.push(summary.join(' · '));
    lines.push('');

    // medications this month
    if (monthMeds.length) {
      const byMed = new Map<string, { days: Set<DayKey>; doses: number }>();
      for (const e of monthMeds) {
        const entry = byMed.get(e.medId) ?? { days: new Set<DayKey>(), doses: 0 };
        entry.days.add(localDayKey(Date.parse(e.ts), timeZone));
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

    // attack list — ongoing stays "ongoing"; a finished attack with an
    // unusable/negative duration prints an em dash instead of nonsense.
    for (const { attack: a, times } of monthEntries) {
      const duration = validDurationMs(times);
      const durLabel = a.end === null ? 'ongoing' : duration !== null ? fmtDuration(duration) : '—';
      const linked = meds.filter((e) => e.attackId === a.id);
      const when = times.startMs !== null ? formatInstant(times.startMs, timeZone) : a.start;
      lines.push(
        `- ${when} — peak ${a.peakPain >= 0 ? a.peakPain + '/10' : '?'}, ${durLabel}`
          + (linked.length ? ` — meds: ${linked.map((e) => medName(e.medId)).join(', ')}` : '')
          + (a.symptoms.length ? ` — ${a.symptoms.join(', ')}` : '')
          + (a.notes ? ` — "${a.notes}"` : ''),
      );
    }
    lines.push('');
  }

  // overall summary at the end — totals are actual totals, while the average
  // divides only by months that actually have data.
  lines.push(`## Overall`);
  lines.push(`- ${totalAttacks} attacks across ${totalAttackDays} attack days`);
  if (monthsWithData > 0) {
    lines.push(
      `- Average ${(totalAttackDays / monthsWithData).toFixed(1)} attack days/month `
        + `(across ${monthsWithData} month${monthsWithData === 1 ? '' : 's'} with data)`,
    );
  }
  lines.push('');
  lines.push(`### Preventives`);
  for (const m of MED_CATALOG.filter((x) => x.kind === 'preventive')) {
    const doses = meds
      .filter((e) => e.medId === m.id)
      .map((e) => Date.parse(e.ts))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    const d = daysSinceLast(meds, m.id, nowMs, timeZone);
    lines.push(
      `- ${m.name}: last dose ${d === null ? 'never logged' : `${d} days ago`} (every ~${m.intervalDays}d)`
        + (doses.length ? `; recent: ${doses.slice(-4).map((t) => formatDay(t, timeZone)).join(', ')}` : ''),
    );
  }
  return lines;
}
