import { describe, it, expect, vi } from 'vitest';
import {
  attackCountsAsAttackDay,
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
  it('drops a final tail day that ended before 08:00 across DST fall-back', () => {
    // America/New_York falls back on 2026-11-01: the middle day is 25 hours.
    // The attack ends 03:00 on 11-03, before that day's 08:00 window.
    const start = at('2026-10-31', '22:00', NY);
    const end = at('2026-11-03', '03:00', NY);
    expect(attackDayKeys(start, end, NY)).toEqual([
      '2026-10-31', '2026-11-01', '2026-11-02',
    ]);
  });

  it('counts only the start day for a short attack crossing local midnight', () => {
    // 23:30 -> 00:30 is inside 06-01's 08:00-to-08:00 window; 06-02's window
    // starts at 08:00, after the attack ended.
    const start = at('2026-06-01', '23:30', NY);
    const end = at('2026-06-02', '00:30', NY);
    expect(attackDayKeys(start, end, NY)).toEqual(['2026-06-01']);
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

  it('attributes a zero-duration attack at local midnight to the previous day', () => {
    const t = dayKeyStartMs('2026-06-01', NY);
    expect(attackDayKeys(t, t, NY)).toEqual(['2026-05-31']);
  });

  it('counts exactly the start day for a negative-duration attack at/after 08:00', () => {
    const start = at('2026-06-03', '09:00', NY);
    const end = at('2026-06-01', '09:00', NY);
    expect(attackDayKeys(start, end, NY)).toEqual(['2026-06-03']);
  });

  it('attributes a degenerate attack before 08:00 to the previous day', () => {
    const start = at('2026-06-03', '07:59', NY);
    expect(attackDayKeys(start, start, NY)).toEqual(['2026-06-02']);
  });

  it('returns [] for an unparseable start and never throws', () => {
    expect(attackDayKeys(null, null, NY)).toEqual([]);
    expect(attackDayKeys(Number.NaN, Number.NaN, NY)).toEqual([]);
    expect(attackDayKeys(null, 1234567890, NY)).toEqual([]);
  });

  it('counts exactly the start day when the end is unparseable and at/after 08:00', () => {
    const start = at('2026-06-05', '08:00', NY);
    expect(attackDayKeys(start, null, NY)).toEqual(['2026-06-05']);
  });

  it('attributes an unparseable-end attack whose start is before 08:00 to the previous day', () => {
    const start = at('2026-06-05', '06:00', NY);
    expect(attackDayKeys(start, null, NY)).toEqual(['2026-06-04']);
  });

  it('clips a cross-month attack to each month without double-counting', () => {
    const start = at('2026-01-30', '22:00', UTC);
    // 02-02 03:00 UTC never reaches 02-02's 08:00 window, so that tail day is
    // not counted.
    const end = at('2026-02-02', '03:00', UTC);
    expect(attackDayKeys(start, end, UTC)).toEqual([
      '2026-01-30', '2026-01-31', '2026-02-01',
    ]);
    expect(attackDayKeysInMonth(start, end, '2026-01', UTC)).toEqual(['2026-01-30', '2026-01-31']);
    expect(attackDayKeysInMonth(start, end, '2026-02', UTC)).toEqual(['2026-02-01']);
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

  it('applies the 08:00 window in the configured zone, not UTC', () => {
    // 2026-06-02 10:00Z -> 11:00Z is 06:00-07:00 in New York (before 08:00,
    // so it belongs to 06-01) but 10:00-11:00 in UTC (06-02).
    const start = Date.UTC(2026, 5, 2, 10);
    const end = Date.UTC(2026, 5, 2, 11);
    expect(attackDayKeys(start, end, NY)).toEqual(['2026-06-01']);
    expect(attackDayKeys(start, end, UTC)).toEqual(['2026-06-02']);
  });

  it('counts both days when a morning attack crosses 08:00', () => {
    expect(attackDayKeys(
      at('2026-06-01', '07:59', NY), at('2026-06-01', '08:01', NY), NY,
    )).toEqual(['2026-05-31', '2026-06-01']);
    expect(attackDayKeys(
      at('2026-06-01', '07:00', NY), at('2026-06-01', '09:00', NY), NY,
    )).toEqual(['2026-05-31', '2026-06-01']);
  });

  it('attributes same-day early-morning attacks to the previous day', () => {
    expect(attackDayKeys(
      at('2026-06-01', '01:00', NY), at('2026-06-01', '02:00', NY), NY,
    )).toEqual(['2026-05-31']);
    expect(attackDayKeys(
      at('2026-06-01', '01:00', NY), at('2026-06-01', '06:00', NY), NY,
    )).toEqual(['2026-05-31']);
    expect(attackDayKeys(
      at('2026-06-01', '06:00', NY), at('2026-06-01', '07:59', NY), NY,
    )).toEqual(['2026-05-31']);
  });

  it('counts only the start day for a 22:00 -> next-day 06:00 attack', () => {
    const start = at('2026-06-01', '22:00', NY);
    const end = at('2026-06-02', '06:00', NY);
    expect(attackDayKeys(start, end, NY)).toEqual(['2026-06-01']);
  });

  it('is half-open at 08:00: an exact 08:00 end counts the previous day, an exact 08:00 instant starts the new day', () => {
    expect(attackDayKeys(
      at('2026-06-01', '06:00', NY), at('2026-06-01', '08:00', NY), NY,
    )).toEqual(['2026-05-31']);
    const eight = at('2026-06-01', '08:00', NY);
    expect(attackDayKeys(eight, eight, NY)).toEqual(['2026-06-01']);
  });

  it('uses the caller endMs for an ongoing-style attack (end = now)', () => {
    const start = at('2026-06-01', '07:00', NY);
    expect(attackDayKeys(start, at('2026-06-01', '07:59', NY), NY)).toEqual(['2026-05-31']);
    // Once the ongoing attack crosses 08:00 it contributes BOTH days; the
    // previous day never loses its attribution.
    expect(attackDayKeys(start, at('2026-06-01', '08:01', NY), NY))
      .toEqual(['2026-05-31', '2026-06-01']);
  });

  it('resolves the next 08:00 window end safely when DST starts at 00:00', () => {
    // America/Santiago springs forward at 00:00 on 2026-09-06 (00:00 -> 01:00).
    // The 08:00-to-08:00 window still contains a late 2026-09-05 attack.
    const TZ = 'America/Santiago';
    expect(attackDayKeys(
      at('2026-09-05', '23:10', TZ), at('2026-09-05', '23:50', TZ), TZ,
    )).toEqual(['2026-09-05']);
  });

  it('attributes an early-morning attack across a month boundary to the previous month', () => {
    // Feb 1 01:00-02:00 counts Jan 31.
    const start = at('2026-02-01', '01:00', UTC);
    const end = at('2026-02-01', '02:00', UTC);
    expect(attackDayKeys(start, end, UTC)).toEqual(['2026-01-31']);
    expect(attackDayKeysInMonth(start, end, '2026-01', UTC)).toEqual(['2026-01-31']);
    expect(attackDayKeysInMonth(start, end, '2026-02', UTC)).toEqual([]);
  });

  it('degrades to the start day for parseable instants outside the 4-digit-year domain', () => {
    // The maximum JS Date is year 275760: parseable, but not a 'YYYY-MM-DD' day
    // key. Enumerating it must not throw inside report generation.
    const start = Date.parse('+275760-09-13T00:00:00.000Z');
    expect(() => attackDayKeys(start, start + 6 * 86400000, UTC)).not.toThrow();
    expect(attackDayKeys(start, start + 6 * 86400000, UTC)).toEqual(['275760-09-13']);
    // A degenerate pathological instant keeps the same start-day fallback.
    expect(attackDayKeys(start, start, UTC)).toEqual(['275760-09-13']);
  });

  it('handles the last representable day key without throwing', () => {
    // '9999-12-31' + 1 day is '10000-01-01', outside the key domain: the day is
    // kept rather than throwing inside zonedDateTimeToMs.
    const start = Date.UTC(9999, 11, 31, 10);
    const end = Date.UTC(9999, 11, 31, 11);
    expect(() => attackDayKeys(start, end, UTC)).not.toThrow();
    expect(attackDayKeys(start, end, UTC)).toEqual(['9999-12-31']);
    // Accepted fail-open at the very edge of the key domain: there is no
    // representable next window end, so the day is kept without interval checks.
    expect(attackCountsAsAttackDay(
      Date.UTC(9999, 11, 31, 1), Date.UTC(9999, 11, 31, 6), '9999-12-31', UTC,
    )).toBe(true);
  });
});

describe('attackCountsAsAttackDay', () => {
  it('rejects far-away attacks without resolving Intl windows', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      expect(attackCountsAsAttackDay(
        Date.UTC(2020, 0, 1, 12), Date.UTC(2020, 0, 1, 13), '2026-06-01', UTC,
      )).toBe(false);
      // Degenerate/negative far-away attacks follow the same early exit.
      expect(attackCountsAsAttackDay(
        Date.UTC(2020, 0, 1, 12), Date.UTC(2020, 0, 1, 11), '2026-06-01', UTC,
      )).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the year-9999 fail-open even for a far-away attack', () => {
    expect(attackCountsAsAttackDay(
      Date.UTC(2026, 5, 1, 1), Date.UTC(2026, 5, 1, 2), '9999-12-31', UTC,
    )).toBe(true);
  });

  it('counts an attack in tomorrow 00:00-08:00 for today', () => {
    // Today's window ends at 08:00 tomorrow, so tomorrow's early morning is
    // today's migraine day. This is why a midnight-to-midnight prefilter is
    // wrong.
    expect(attackCountsAsAttackDay(
      Date.UTC(2026, 5, 2, 1), Date.UTC(2026, 5, 2, 2), '2026-06-01', UTC,
    )).toBe(true);
  });

  it('counts an ongoing attack with an ancient start today', () => {
    expect(attackCountsAsAttackDay(
      Date.UTC(2020, 0, 1, 1), Date.UTC(2026, 5, 1, 12), '2026-06-01', UTC,
    )).toBe(true);
  });

  it('handles extreme real-world offsets on both sides of UTC', () => {
    const east = 'Pacific/Kiritimati'; // UTC+14
    expect(attackCountsAsAttackDay(
      at('2026-06-02', '09:00', east), at('2026-06-02', '10:00', east), '2026-06-02', east,
    )).toBe(true);
    expect(attackCountsAsAttackDay(
      at('2026-06-02', '07:00', east), at('2026-06-02', '07:59', east), '2026-06-02', east,
    )).toBe(false);
    expect(attackCountsAsAttackDay(
      at('2026-06-02', '07:00', east), at('2026-06-02', '07:59', east), '2026-06-01', east,
    )).toBe(true);

    const west = 'Pacific/Pago_Pago'; // UTC-11
    expect(attackCountsAsAttackDay(
      at('2026-06-02', '09:00', west), at('2026-06-02', '10:00', west), '2026-06-02', west,
    )).toBe(true);
    expect(attackCountsAsAttackDay(
      at('2026-06-02', '07:00', west), at('2026-06-02', '07:59', west), '2026-06-01', west,
    )).toBe(true);
  });

  it('is false for null/NaN starts and never throws on garbage day keys', () => {
    expect(attackCountsAsAttackDay(null, null, '2026-06-01', NY)).toBe(false);
    expect(attackCountsAsAttackDay(Number.NaN, Number.NaN, '2026-06-01', NY)).toBe(false);
    expect(() => attackCountsAsAttackDay(
      at('2026-06-01', '09:00', NY), null, 'not-a-day', NY,
    )).not.toThrow();
    expect(attackCountsAsAttackDay(
      at('2026-06-01', '09:00', NY), null, 'not-a-day', NY,
    )).toBe(false);
    expect(attackCountsAsAttackDay(
      at('2026-06-01', '09:00', NY), null, '275760-09-13', NY,
    )).toBe(false);
    // ISO-shaped but impossible dates must not reach the throwing helpers.
    expect(() => attackCountsAsAttackDay(
      at('2026-06-01', '09:00', NY), null, '2026-02-30', NY,
    )).not.toThrow();
    expect(attackCountsAsAttackDay(
      at('2026-06-01', '09:00', NY), null, '2026-02-30', NY,
    )).toBe(false);
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
