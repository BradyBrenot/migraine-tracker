import { describe, it, expect } from 'vitest';
import type { Attack, MedEvent } from '@/types';
import { buildMonthlyTrend, buildReportLines, type ReportInput } from './report.ts';
import { zonedDateTimeToMs } from '../../shared/datetime.ts';

const UTC = 'UTC';
const NY = 'America/New_York';

let attackSeq = 0;

function makeAttack(partial: Partial<Attack> & { start: string }): Attack {
  attackSeq++;
  return {
    id: `a-${attackSeq}`,
    end: null,
    painLog: [],
    peakPain: 5,
    symptoms: [],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
    ...partial,
  };
}

let medSeq = 0;

function makeMed(ts: string, medId = 'nurtec'): MedEvent {
  medSeq++;
  return {
    id: `m-${medSeq}`,
    medId,
    ts,
    attackId: null,
    notes: '',
    source: 'manual',
  };
}

function iso(day: string, time = '12:00:00.000'): string {
  return `${day}T${time}Z`;
}

function build(partial: Partial<ReportInput>): string[] {
  return buildReportLines({
    attacks: [],
    meds: [],
    timeZone: UTC,
    span: '12',
    nowMs: Date.UTC(2026, 5, 15, 12),
    ...partial,
  });
}

/** Lines of one `## Month` section, excluding the heading itself. */
function section(lines: string[], heading: string): string[] {
  const start = lines.indexOf(`## ${heading}`);
  expect(start, `missing section "## ${heading}" in:\n${lines.join('\n')}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

function monthHeadings(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
}

describe('buildReportLines: no-data months', () => {
  it('marks a month with no records as "No data" instead of a known zero', () => {
    const lines = build({
      attacks: [makeAttack({
        start: iso('2026-05-10'),
        end: iso('2026-05-10', '13:00:00.000'),
        peakPain: 5,
      })],
      nowMs: Date.UTC(2026, 5, 15),
    });

    const june = section(lines, 'June 2026');
    expect(june).toContain('No data recorded this month.');
    expect(june.join('\n')).not.toContain('attack days');

    const may = section(lines, 'May 2026');
    expect(may[0]).toContain('**1 attack days of 31** · 1 attacks');
    expect(may.join('\n')).not.toContain('No data recorded this month.');
  });

  it('treats a meds-only month as known data with a real 0 attack days', () => {
    const lines = build({
      meds: [makeMed(iso('2026-06-05', '08:00:00.000'))],
      nowMs: Date.UTC(2026, 5, 15),
    });

    const june = section(lines, 'June 2026');
    expect(june[0]).toBe('**0 attack days of 30** · 0 attacks');
    expect(june.join('\n')).toContain('Medications:');
    expect(june.join('\n')).toContain('Nurtec: 1 days, 1 doses');
    expect(june.join('\n')).not.toContain('No data recorded this month.');
  });
});

describe('buildReportLines: month day bucketing', () => {
  it('counts 10 October attack days, matching Calendar (fixed-24h loop regression)', () => {
    // Synthetic equivalents of a real October pattern in America/New_York:
    // a 3-night attack plus several evening attacks, including one whose UTC
    // end is the next date and the 3-hour bar that must stay on Oct 13.
    const ny = (day: string, time: string) => new Date(zonedDateTimeToMs(day, time, NY)).toISOString();
    const attacks = [
      makeAttack({ start: ny('2026-10-05', '19:10'), end: ny('2026-10-08', '16:20') }),
      makeAttack({ start: ny('2026-10-09', '17:40'), end: ny('2026-10-09', '19:40') }),
      makeAttack({ start: ny('2026-10-10', '17:00'), end: ny('2026-10-10', '21:00') }),
      makeAttack({ start: ny('2026-10-13', '19:59'), end: ny('2026-10-13', '22:59') }),
      makeAttack({ start: ny('2026-10-21', '17:50'), end: ny('2026-10-21', '22:05') }),
      makeAttack({ start: ny('2026-10-24', '09:01'), end: ny('2026-10-24', '21:34') }),
      makeAttack({ start: ny('2026-10-26', '09:00'), end: ny('2026-10-26', '19:00') }),
    ];
    const nowMs = zonedDateTimeToMs('2026-10-27', '12:00', NY);

    const lines = build({ attacks, nowMs, timeZone: NY, span: 'all' });

    const october = section(lines, 'October 2026');
    expect(october[0]).toContain('**10 attack days of 31**');
    expect(october[0]).toContain('7 attacks');
    expect(october[0]).toContain('avg peak pain 5.0/10');
    expect(lines).toContain('- 7 attacks across 10 attack days');
    expect(lines).toContain('- Average 10.0 attack days/month (across 1 month with data)');
    // Distinct days: 5-10 (the 3-night attack plus two evenings), 13, 21, 24, 26.
    expect(october.join('\n')).toContain('Oct 5, 2026');
    expect(october.join('\n')).toContain('Oct 13, 2026');
  });

  it('counts every day of an attack that spans three nights (fixed-24h sampling bug)', () => {
    // 23:03 local through 20:49 three calendar days later: 4 attack days.
    const lines = build({
      attacks: [makeAttack({
        start: iso('2026-05-10', '23:03:00.000'),
        end: iso('2026-05-13', '20:49:00.000'),
      })],
      nowMs: Date.UTC(2026, 5, 15),
    });

    expect(section(lines, 'May 2026')[0]).toContain('**4 attack days of 31** · 1 attacks');
  });

  it('attributes a cross-month attack to both months and makes the second month known', () => {
    const lines = build({
      attacks: [makeAttack({
        start: iso('2026-01-30', '22:00:00.000'),
        end: iso('2026-02-02', '03:00:00.000'),
      })],
      nowMs: Date.UTC(2026, 1, 10),
    });

    expect(section(lines, 'January 2026')[0]).toContain('**2 attack days of 31** · 1 attacks');
    const february = section(lines, 'February 2026');
    expect(february[0]).toBe('**2 attack days of 28** · 0 attacks');
    expect(february.join('\n')).not.toContain('No data recorded this month.');

    expect(lines).toContain('- 1 attacks across 4 attack days');
  });

  it('buckets days in the configured zone, not UTC', () => {
    // 2026-06-01 23:30Z -> 2026-06-02 00:30Z is two UTC days but one New York
    // evening (Jun 1 19:30 -> 20:30).
    const attack = makeAttack({
      start: iso('2026-06-01', '23:30:00.000'),
      end: iso('2026-06-02', '00:30:00.000'),
    });
    const nowMs = Date.UTC(2026, 5, 15);

    expect(section(build({ attacks: [attack], nowMs, timeZone: UTC }), 'June 2026')[0])
      .toContain('**2 attack days of 30** · 1 attacks');
    expect(section(build({ attacks: [attack], nowMs, timeZone: NY }), 'June 2026')[0])
      .toContain('**1 attack days of 30** · 1 attacks');
  });

  it('buckets medication days in the configured zone', () => {
    const meds = [
      makeMed(iso('2026-06-02', '03:30:00.000')), // Jun 1 23:30 EDT
      makeMed(iso('2026-06-02', '05:00:00.000')), // Jun 2 01:00 EDT
    ];
    const nowMs = Date.UTC(2026, 5, 15);

    expect(section(build({ meds, nowMs, timeZone: UTC }), 'June 2026').join('\n'))
      .toContain('Nurtec: 1 days, 2 doses');
    expect(section(build({ meds, nowMs, timeZone: NY }), 'June 2026').join('\n'))
      .toContain('Nurtec: 2 days, 2 doses');
  });
});

describe('buildReportLines: counts and averages', () => {
  it('counts peakPain 0 and -1 attacks as attacks / attack days', () => {
    const lines = build({
      attacks: [
        makeAttack({ start: iso('2026-05-04', '08:00:00.000'), end: iso('2026-05-04', '09:00:00.000'), peakPain: 0 }),
        makeAttack({ start: iso('2026-05-06', '08:00:00.000'), end: iso('2026-05-06', '09:00:00.000'), peakPain: -1 }),
      ],
      nowMs: Date.UTC(2026, 5, 15),
    });

    const may = section(lines, 'May 2026');
    expect(may[0]).toContain('**2 attack days of 31**');
    expect(may[0]).toContain('2 attacks');
    // Only the reported 0 participates in the pain average.
    expect(may[0]).toContain('avg peak pain 0.0/10');
    expect(may.join('\n')).toContain('peak 0/10');
    expect(may.join('\n')).toContain('peak ?');
  });

  it('excludes -1 from the pain average while keeping 0 in the denominator', () => {
    const lines = build({
      attacks: [
        makeAttack({ start: iso('2026-05-04', '08:00:00.000'), end: iso('2026-05-04', '09:00:00.000'), peakPain: 0 }),
        makeAttack({ start: iso('2026-05-06', '08:00:00.000'), end: iso('2026-05-06', '09:00:00.000'), peakPain: 4 }),
        makeAttack({ start: iso('2026-05-08', '08:00:00.000'), end: iso('2026-05-08', '09:00:00.000'), peakPain: -1 }),
      ],
      nowMs: Date.UTC(2026, 5, 15),
    });

    expect(section(lines, 'May 2026')[0]).toContain('avg peak pain 2.0/10');
  });

  it('averages only valid durations, letting a zero-duration attack participate', () => {
    const lines = build({
      attacks: [
        // zero duration
        makeAttack({ start: iso('2026-05-04', '08:00:00.000'), end: iso('2026-05-04', '08:00:00.000') }),
        // 2 hours
        makeAttack({ start: iso('2026-05-06', '08:00:00.000'), end: iso('2026-05-06', '10:00:00.000') }),
        // negative duration: counted as an attack/day, never averaged
        makeAttack({ start: iso('2026-05-08', '10:00:00.000'), end: iso('2026-05-08', '09:00:00.000') }),
        // ongoing: excluded from the duration average
        makeAttack({ start: iso('2026-05-09', '08:00:00.000'), end: null }),
      ],
      nowMs: Date.UTC(2026, 5, 15),
    });

    const may = section(lines, 'May 2026');
    expect(may[0]).toContain('4 attacks');
    expect(may[0]).toContain('avg duration 1h');
    expect(may[0]).not.toContain('-');
    expect(may.join('\n')).toContain('ongoing');
  });

  it('keeps totals actual while averaging only over months with data', () => {
    const lines = build({
      attacks: [
        makeAttack({ start: iso('2026-03-04', '08:00:00.000'), end: iso('2026-03-04', '09:00:00.000') }),
        makeAttack({ start: iso('2026-05-04', '08:00:00.000'), end: iso('2026-05-04', '09:00:00.000') }),
      ],
      nowMs: Date.UTC(2026, 5, 15),
    });

    // March..June: 4 months in the list, 2 with data.
    expect(monthHeadings(lines)).toEqual([
      'March 2026', 'April 2026', 'May 2026', 'June 2026', 'Overall',
    ]);
    expect(lines).toContain('- 2 attacks across 2 attack days');
    expect(lines).toContain('- Average 1.0 attack days/month (across 2 months with data)');
  });

  it('omits the overall average when no month in the span has data', () => {
    const lines = build({ nowMs: Date.UTC(2026, 5, 15) });
    expect(monthHeadings(lines)).toEqual(['June 2026', 'Overall']);
    expect(lines).toContain('- 0 attacks across 0 attack days');
    expect(lines.join('\n')).not.toContain('Average');
  });
});

describe('buildMonthlyTrend', () => {
  it('gaps unknown months, keeps a med-only zero, and marks attack-spanning months as data', () => {
    const attacks = [
      // Crosses the May/June boundary in UTC.
      makeAttack({
        start: iso('2026-05-31', '22:00:00.000'),
        end: iso('2026-06-01', '02:00:00.000'),
      }),
    ];
    const rows = buildMonthlyTrend({
      attacks, meds: [], timeZone: UTC, nowMs: Date.UTC(2026, 5, 15),
    });
    expect(rows).toHaveLength(12);
    const may = rows[rows.length - 2];
    const june = rows[rows.length - 1];
    expect(may).toMatchObject({ attackDays: 1, attacks: 1 });
    // June has an attack overlapping into it, so it is known (1 day, 1 overlap).
    expect(june).toMatchObject({ attackDays: 1, attacks: 1 });
    // July 2025 has nothing at all: unknown, not a confirmed zero.
    expect(rows[0].attackDays).toBeNull();

    const medsOnly = buildMonthlyTrend({
      attacks: [],
      meds: [makeMed(iso('2026-06-05', '08:00:00.000'))],
      timeZone: UTC,
      nowMs: Date.UTC(2026, 5, 15),
    });
    expect(medsOnly[medsOnly.length - 1]).toMatchObject({ attackDays: 0, attacks: 0 });
  });

  it('counts 0 and -1 pain attacks and averages only reported pain', () => {
    const rows = buildMonthlyTrend({
      attacks: [
        makeAttack({ start: iso('2026-05-04', '08:00:00.000'), end: iso('2026-05-04', '09:00:00.000'), peakPain: 0 }),
        makeAttack({ start: iso('2026-05-06', '08:00:00.000'), end: iso('2026-05-06', '09:00:00.000'), peakPain: -1 }),
      ],
      meds: [],
      timeZone: UTC,
      nowMs: Date.UTC(2026, 5, 15),
    });
    expect(rows[rows.length - 2]).toMatchObject({ attackDays: 2, attacks: 2, avgPain: 0 });
  });
});

describe('buildReportLines: robustness and span', () => {
  it('never throws on unparseable dates and keeps the months list sane', () => {
    const lines = build({
      attacks: [
        makeAttack({ start: 'not-a-date', end: null }),
        makeAttack({ start: iso('2026-06-05', '10:00:00.000'), end: 'garbage' }),
      ],
      meds: [makeMed('also-garbage')],
      nowMs: Date.UTC(2026, 5, 15),
    });

    expect(monthHeadings(lines)).toEqual(['June 2026', 'Overall']);
    const june = section(lines, 'June 2026');
    expect(june[0]).toContain('**1 attack days of 30** · 1 attacks');
    expect(june.join('\n')).toContain('—');
  });

  it('ignores a parseable-but-absurd instant instead of letting it poison the month list', () => {
    const lines = build({
      attacks: [
        // Year 275760 parses, but is outside the 'YYYY-MM-DD' day-key domain.
        makeAttack({ start: '+275760-09-13T00:00:00.000Z', end: null }),
        makeAttack({ start: iso('2026-06-05', '10:00:00.000'), end: iso('2026-06-05', '11:00:00.000') }),
      ],
      nowMs: Date.UTC(2026, 5, 15),
    });

    expect(monthHeadings(lines)).toEqual(['June 2026', 'Overall']);
    expect(section(lines, 'June 2026')[0]).toContain('**1 attack days of 30**');
  });

  it('slices the month list to the requested span, keeping the most recent months', () => {
    const attacks = ['2026-01-04', '2026-03-04', '2026-05-04', '2026-06-04'].map((day) => makeAttack({
      start: iso(day, '08:00:00.000'),
      end: iso(day, '09:00:00.000'),
    }));

    expect(monthHeadings(build({ attacks, span: 'all' }))).toEqual([
      'January 2026', 'February 2026', 'March 2026', 'April 2026', 'May 2026', 'June 2026', 'Overall',
    ]);
    expect(monthHeadings(build({ attacks, span: '3' }))).toEqual([
      'April 2026', 'May 2026', 'June 2026', 'Overall',
    ]);
  });
});
