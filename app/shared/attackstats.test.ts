import { describe, it, expect } from 'vitest';
import {
  attackDayKeys,
  attackDayKeysInMonth,
  attackOverlapsRange,
  parseAttackTimes,
  validDurationMs,
} from './attackstats.ts';
import { dayKeyStartMs, zonedDateTimeToMs } from './datetime.ts';

const NY = 'America/New_York';
const UTC = 'UTC';

/** Instant of a wall-clock time in a zone ('YYYY-MM-DD', 'HH:MM'). */
function at(day: string, time: string, timeZone: string): number {
  return zonedDateTimeToMs(day, time, timeZone);
}

describe('parseAttackTimes', () => {
  it('treats a null end as ongoing by substituting nowMs', () => {
    const start = '2026-06-01T12:00:00.000Z';
    const now = Date.UTC(2026, 5, 1, 18);
    expect(parseAttackTimes({ start, end: null }, now)).toEqual({
      startMs: Date.parse(start),
      endMs: now,
      ongoing: true,
    });
  });

  it('parses both instants', () => {
    const start = '2026-06-01T12:00:00.000Z';
    const end = '2026-06-01T15:00:00.000Z';
    expect(parseAttackTimes({ start, end }, 0)).toEqual({
      startMs: Date.parse(start),
      endMs: Date.parse(end),
      ongoing: false,
    });
  });

  it('returns both null for an unparseable start', () => {
    expect(parseAttackTimes({ start: 'not-a-date', end: '2026-06-01T15:00:00.000Z' }, 0))
      .toEqual({ startMs: null, endMs: null, ongoing: false });
  });

  it('keeps the start and nulls an unparseable end string', () => {
    const start = '2026-06-01T12:00:00.000Z';
    expect(parseAttackTimes({ start, end: 'garbage' }, 0))
      .toEqual({ startMs: Date.parse(start), endMs: null, ongoing: false });
  });
});

describe('attackDayKeys', () => {
  it('enumerates every calendar day of a multi-day attack across DST fall-back', () => {
    // America/New_York falls back on 2026-11-01: the middle day is 25 hours.
    const start = at('2026-10-31', '22:00', NY);
    const end = at('2026-11-03', '03:00', NY);
    expect(attackDayKeys(start, end, NY)).toEqual([
      '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03',
    ]);
  });

  it('counts both days for a short attack crossing local midnight', () => {
    const start = at('2026-06-01', '23:30', NY);
    const end = at('2026-06-02', '00:30', NY);
    expect(attackDayKeys(start, end, NY)).toEqual(['2026-06-01', '2026-06-02']);
  });

  it('does not count the new day when the attack ends exactly at local midnight', () => {
    const start = at('2026-06-01', '20:00', NY);
    const end = at('2026-06-02', '00:00', NY);
    expect(attackDayKeys(start, end, NY)).toEqual(['2026-06-01']);
  });

  it('counts exactly the start day for a zero-duration attack at midday', () => {
    const t = at('2026-06-01', '12:00', NY);
    expect(attackDayKeys(t, t, NY)).toEqual(['2026-06-01']);
  });

  it('counts exactly the start day for a zero-duration attack at local midnight', () => {
    const t = dayKeyStartMs('2026-06-01', NY);
    expect(attackDayKeys(t, t, NY)).toEqual(['2026-06-01']);
  });

  it('counts exactly the start day for a negative-duration attack', () => {
    const start = at('2026-06-03', '09:00', NY);
    const end = at('2026-06-01', '09:00', NY);
    expect(attackDayKeys(start, end, NY)).toEqual(['2026-06-03']);
  });

  it('returns [] for an unparseable start and never throws', () => {
    expect(attackDayKeys(null, null, NY)).toEqual([]);
    expect(attackDayKeys(Number.NaN, Number.NaN, NY)).toEqual([]);
    expect(attackDayKeys(null, 1234567890, NY)).toEqual([]);
  });

  it('counts exactly the start day when the end is unparseable', () => {
    const start = at('2026-06-05', '08:00', NY);
    expect(attackDayKeys(start, null, NY)).toEqual(['2026-06-05']);
  });

  it('clips a cross-month attack to each month without double-counting', () => {
    const start = at('2026-01-30', '22:00', UTC);
    const end = at('2026-02-02', '03:00', UTC);
    expect(attackDayKeys(start, end, UTC)).toEqual([
      '2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02',
    ]);
    expect(attackDayKeysInMonth(start, end, '2026-01', UTC)).toEqual(['2026-01-30', '2026-01-31']);
    expect(attackDayKeysInMonth(start, end, '2026-02', UTC)).toEqual(['2026-02-01', '2026-02-02']);
    // The union of the clipped months equals the full enumeration.
    const clipped = [
      ...attackDayKeysInMonth(start, end, '2026-01', UTC),
      ...attackDayKeysInMonth(start, end, '2026-02', UTC),
    ];
    expect(clipped).toEqual(attackDayKeys(start, end, UTC));
  });

  it('dedupes to one day when two attacks cover the same day', () => {
    const a1s = at('2026-06-01', '08:00', NY);
    const a1e = at('2026-06-01', '10:00', NY);
    const a2s = at('2026-06-01', '18:00', NY);
    const a2e = at('2026-06-01', '20:00', NY);
    const days = new Set([
      ...attackDayKeys(a1s, a1e, NY),
      ...attackDayKeys(a2s, a2e, NY),
    ]);
    expect(days.size).toBe(1);
  });

  it('maps the same instant to different days in different zones', () => {
    // 2026-06-02 02:00Z is Jun 1 22:00 in New York and Jun 2 02:00 in UTC.
    const t = Date.UTC(2026, 5, 2, 2);
    expect(attackDayKeys(t, t + 60 * 60 * 1000, NY)).toEqual(['2026-06-01']);
    expect(attackDayKeys(t, t + 60 * 60 * 1000, UTC)).toEqual(['2026-06-02']);
  });

  it('degrades to the start day for parseable instants outside the 4-digit-year domain', () => {
    // The maximum JS Date is year 275760: parseable, but not a 'YYYY-MM-DD' day
    // key. Enumerating it must not throw inside report generation.
    const start = Date.parse('+275760-09-13T00:00:00.000Z');
    expect(() => attackDayKeys(start, start + 6 * 86400000, UTC)).not.toThrow();
    expect(attackDayKeys(start, start + 6 * 86400000, UTC)).toEqual(['275760-09-13']);
  });
});

describe('attackOverlapsRange', () => {
  const rangeStart = Date.UTC(2026, 5, 1);
  const rangeEnd = Date.UTC(2026, 6, 1);

  it('is false when the attack ends exactly at the range start (half-open)', () => {
    expect(attackOverlapsRange(Date.UTC(2026, 4, 30), rangeStart, rangeStart, rangeEnd)).toBe(false);
  });

  it('is false when the attack starts exactly at the range end (half-open)', () => {
    expect(attackOverlapsRange(rangeEnd, rangeEnd + 3600000, rangeStart, rangeEnd)).toBe(false);
  });

  it('is true for an attack spanning the whole range and one ending just inside it', () => {
    expect(attackOverlapsRange(rangeStart - 3600000, rangeEnd + 3600000, rangeStart, rangeEnd)).toBe(true);
    expect(attackOverlapsRange(rangeStart - 3600000, rangeStart + 1, rangeStart, rangeEnd)).toBe(true);
  });

  it('counts degenerate attacks by start-in-range membership', () => {
    const midRange = rangeStart + 5 * 86400000;
    expect(attackOverlapsRange(midRange, midRange, rangeStart, rangeEnd)).toBe(true);
    expect(attackOverlapsRange(midRange, midRange - 3600000, rangeStart, rangeEnd)).toBe(true);
    expect(attackOverlapsRange(midRange, null, rangeStart, rangeEnd)).toBe(true);
    expect(attackOverlapsRange(rangeEnd, rangeEnd, rangeStart, rangeEnd)).toBe(false);
    expect(attackOverlapsRange(rangeStart - 1, rangeStart - 1, rangeStart, rangeEnd)).toBe(false);
  });

  it('is false for an unparseable start', () => {
    expect(attackOverlapsRange(null, null, rangeStart, rangeEnd)).toBe(false);
    expect(attackOverlapsRange(Number.NaN, Number.NaN, rangeStart, rangeEnd)).toBe(false);
  });
});

describe('validDurationMs', () => {
  it('returns null for ongoing and unparseable attacks', () => {
    expect(validDurationMs({ startMs: 1000, endMs: 9000, ongoing: true })).toBeNull();
    expect(validDurationMs({ startMs: 1000, endMs: null, ongoing: false })).toBeNull();
    expect(validDurationMs({ startMs: null, endMs: 2000, ongoing: false })).toBeNull();
    expect(validDurationMs({ startMs: null, endMs: null, ongoing: false })).toBeNull();
  });

  it('returns null for negative durations', () => {
    expect(validDurationMs({ startMs: 2000, endMs: 1000, ongoing: false })).toBeNull();
  });

  it('returns 0 for a zero-duration attack', () => {
    expect(validDurationMs({ startMs: 1000, endMs: 1000, ongoing: false })).toBe(0);
  });

  it('returns the elapsed time for a normal attack', () => {
    expect(validDurationMs({ startMs: 1000, endMs: 1000 + 90 * 60000, ongoing: false }))
      .toBe(90 * 60000);
  });
});
