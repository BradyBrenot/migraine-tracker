import { describe, it, expect } from 'vitest';
import {
  addDays,
  dayKeyStartMs,
  diffDayKeys,
  isValidTimeZone,
  localDayKey,
  sameSundayWeek,
  sundayWeekBounds,
  sundayWeekStart,
  systemTimeZone,
  weekdayOf,
} from './datetime.ts';

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

describe('localDayKey', () => {
  it('maps one instant to different local days per zone, diverging from the UTC day', () => {
    const t = Date.UTC(2026, 0, 2, 4, 30);
    // Local day in New York (Jan 1 23:30 EST):
    expect(localDayKey(t, 'America/New_York')).toBe('2026-01-01');
    // ...while the UTC calendar date of the very same instant is Jan 2:
    expect(new Date(t).toISOString().slice(0, 10)).toBe('2026-01-02');
    // Same instant in Tokyo is already Jan 2 (13:30 JST):
    expect(localDayKey(t, 'Asia/Tokyo')).toBe('2026-01-02');
  });

  it('flips days exactly at local midnight (one-ms boundary)', () => {
    // June 2 03:59:59.999Z == June 1 23:59:59.999 EDT:
    expect(localDayKey(Date.UTC(2026, 5, 2, 3, 59, 59, 999), 'America/New_York')).toBe('2026-06-01');
    // June 2 04:00:00.000Z == June 2 00:00:00.000 EDT:
    expect(localDayKey(Date.UTC(2026, 5, 2, 4, 0, 0), 'America/New_York')).toBe('2026-06-02');
  });

  it('is self-consistent with local getters in the system zone', () => {
    const instants = [
      new Date(2026, 0, 15, 13, 45).getTime(),
      new Date(2026, 6, 1, 0, 5).getTime(),
      new Date(2025, 11, 31, 23, 59).getTime(),
    ];
    for (const t of instants) {
      const d = new Date(t);
      const manual = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      expect(localDayKey(t)).toBe(manual);
      expect(localDayKey(t, systemTimeZone())).toBe(manual);
      expect(manual).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('dayKeyStartMs', () => {
  it('handles US DST boundaries in America/New_York', () => {
    // Spring-forward day: local midnight is still EST (UTC-5).
    expect(dayKeyStartMs('2026-03-08', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 5, 0, 0));
    // Fall-back day: local midnight is still EDT (UTC-4).
    expect(dayKeyStartMs('2026-11-01', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 4, 0, 0));
    // Regular summer day: EDT (UTC-4).
    expect(dayKeyStartMs('2026-06-01', 'America/New_York')).toBe(Date.UTC(2026, 5, 1, 4, 0, 0));
  });

  it('handles a fixed-offset zone (Asia/Tokyo, UTC+9, no DST)', () => {
    expect(dayKeyStartMs('2026-06-01', 'Asia/Tokyo')).toBe(Date.UTC(2026, 4, 31, 15, 0, 0));
  });

  it('matches the local Date constructor in the system zone', () => {
    expect(dayKeyStartMs('2026-04-10')).toBe(new Date(2026, 3, 10).getTime());
  });

  it('throws RangeError on malformed keys', () => {
    expect(() => dayKeyStartMs('2026-6-1')).toThrow(RangeError);
    expect(() => dayKeyStartMs('not-a-day')).toThrow(RangeError);
  });
});

describe('weekdayOf', () => {
  it('returns 0=Sunday..6=Saturday', () => {
    expect(weekdayOf('2026-01-01')).toBe(4); // Thursday
    expect(weekdayOf('2025-12-28')).toBe(0); // Sunday
    expect(weekdayOf('2026-01-03')).toBe(6); // Saturday
    expect(weekdayOf('2024-02-29')).toBe(4); // Thursday (leap day)
  });
});

describe('sundayWeekStart', () => {
  it('maps onto the Sunday on-or-before, including year and leap boundaries', () => {
    expect(sundayWeekStart('2026-01-01')).toBe('2025-12-28'); // Thursday
    expect(sundayWeekStart('2026-01-03')).toBe('2025-12-28'); // Saturday
    expect(sundayWeekStart('2025-12-28')).toBe('2025-12-28'); // Sunday itself
    expect(sundayWeekStart('2026-01-04')).toBe('2026-01-04'); // next Sunday
    expect(sundayWeekStart('2024-02-29')).toBe('2024-02-25'); // leap-day Thursday
  });
});

describe('sameSundayWeek', () => {
  it('groups days of one Sunday-start week and separates adjacent weeks', () => {
    expect(sameSundayWeek('2025-12-28', '2026-01-03')).toBe(true);
    expect(sameSundayWeek('2026-01-03', '2026-01-04')).toBe(false);
  });
});

describe('sundayWeekBounds', () => {
  it('shortens to 167h across the spring-forward transition', () => {
    // Week of Sun 2026-03-08: starts at EST midnight (05:00Z), ends at EDT
    // midnight (04:00Z) after the 23-hour day.
    const bounds = sundayWeekBounds('2026-03-10', 'America/New_York');
    expect(bounds.startMs).toBe(Date.UTC(2026, 2, 8, 5));
    expect(bounds.endMs).toBe(Date.UTC(2026, 2, 15, 4));
    expect(bounds.endMs - bounds.startMs).toBe(167 * 3600000);
  });

  it('lengthens to 169h in the week containing the fall-back transition', () => {
    // The 25-hour day is 2026-11-01 (02:00 EDT -> 01:00 EST), so the week
    // STARTING on that Sunday runs Nov 1 00:00 EDT (04:00Z) to Nov 8
    // 00:00 EST (05:00Z). (The prior week — sundayWeekBounds('2026-10-27')
    // — ends exactly when Nov 1 begins and is a regular 168h week.)
    const bounds = sundayWeekBounds('2026-11-03', 'America/New_York');
    expect(bounds.startMs).toBe(Date.UTC(2026, 10, 1, 4));
    expect(bounds.endMs).toBe(Date.UTC(2026, 10, 8, 5));
    expect(bounds.endMs - bounds.startMs).toBe(169 * 3600000);
  });

  it('is exactly 604800000 ms in a week without DST changes', () => {
    const bounds = sundayWeekBounds('2026-06-10', 'America/New_York');
    expect(bounds.endMs - bounds.startMs).toBe(604800000);
  });
});

describe('addDays', () => {
  it('does calendar-day arithmetic across month, leap, and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // leap day
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-06-15', 0)).toBe('2026-06-15');
  });
});

describe('diffDayKeys', () => {
  it('counts whole calendar days across month, leap, and year boundaries', () => {
    expect(diffDayKeys('2026-01-15', '2026-01-01')).toBe(14);
    expect(diffDayKeys('2026-03-09', '2026-03-08')).toBe(1);
    expect(diffDayKeys('2024-03-01', '2024-02-28')).toBe(2); // leap day
    expect(diffDayKeys('2026-01-01', '2025-12-31')).toBe(1);
    expect(diffDayKeys('2026-06-15', '2026-06-15')).toBe(0);
  });

  it('is DST-independent (US spring-forward weekend is still one day)', () => {
    // America/New_York springs forward on 2026-03-08: the local day is 23h,
    // but the UTC-noon calendar-day difference stays exactly 1.
    expect(diffDayKeys('2026-03-09', '2026-03-08')).toBe(1);
    expect(diffDayKeys('2026-11-02', '2026-11-01')).toBe(1); // fall-back
  });

  it('returns a negative difference when later precedes earlier', () => {
    expect(diffDayKeys('2026-01-01', '2026-01-15')).toBe(-14);
  });

  it('throws RangeError on malformed keys', () => {
    expect(() => diffDayKeys('2026-6-1', '2026-01-01')).toThrow(RangeError);
    expect(() => diffDayKeys('2026-01-01', 'not-a-day')).toThrow(RangeError);
  });
});

describe('time zone validation', () => {
  it('accepts valid IANA ids and rejects unknown ones', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });

  it('systemTimeZone() returns a non-empty string', () => {
    expect(typeof systemTimeZone()).toBe('string');
    expect(systemTimeZone().length).toBeGreaterThan(0);
  });
});
