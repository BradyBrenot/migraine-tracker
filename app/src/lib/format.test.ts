import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDateFull, fmtTime, toLocalInput } from './format.ts';

const ISO = '2026-10-27T18:05:00.000Z';

/**
 * format.ts now caches `Intl.DateTimeFormat` instances instead of calling
 * `Date#toLocale*String` per cell/row. These assertions pin the output back to
 * the replaced calls (including the non-throwing invalid-date text).
 */
describe('browser-locale formatters', () => {
  it('matches the Date#toLocale* output for a valid instant', () => {
    const d = new Date(ISO);
    expect(fmtTime(ISO)).toBe(
      d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    );
    expect(fmtDate(ISO)).toBe(
      d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    );
    expect(fmtDateFull(ISO)).toBe(
      d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    );
  });

  it('keeps the non-throwing "Invalid Date" text for an unparseable stamp', () => {
    const invalid = new Date('not-a-date');
    // Baseline: the replaced API never throws for garbage input.
    expect(invalid.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
      .toBe('Invalid Date');

    expect(fmtTime('not-a-date')).toBe('Invalid Date');
    expect(fmtDate('not-a-date')).toBe('Invalid Date');
    expect(fmtDateFull('not-a-date')).toBe('Invalid Date');
  });
});

describe('datetime-local conversion', () => {
  it('formats a valid Date for datetime-local inputs', () => {
    const d = new Date(2026, 2, 4, 9, 5);
    expect(toLocalInput(d)).toBe('2026-03-04T09:05');
  });

  it('returns an empty string for an invalid Date instead of NaN segments', () => {
    // Dialogs must open blank rather than "NaN-NaN-NaNTNaN:NaN".
    expect(toLocalInput(new Date('not-a-date'))).toBe('');
    expect(toLocalInput(new Date(Number.NaN))).toBe('');
  });
});
