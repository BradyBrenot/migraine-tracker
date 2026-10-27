import { describe, expect, it } from 'vitest';
import { addDays, zonedDateTimeToMs } from '../../shared/datetime.ts';
import { MIN_BAR_WIDTH_DAYS, weekBarGeometry } from './calendar-bars.ts';

const NY = 'America/New_York';

/** Monday-first week containing 2026-10-13 (a Tuesday). */
const WEEK_START = '2026-10-12';

function at(day: string, time: string): number {
  return zonedDateTimeToMs(day, time, NY);
}

function geometry(startMs: number, endMs: number, weekStartKey = WEEK_START) {
  return weekBarGeometry({
    startMs,
    endMs,
    weekStartKey,
    weekEndKey: addDays(weekStartKey, 7),
    timeZone: NY,
  });
}

const EPS = 1e-9;

describe('weekBarGeometry: same-day minimum width', () => {
  it('keeps a 3h evening attack entirely inside its own local day', () => {
    // The reported Oct 13 7:59pm-10:59pm bar must not bleed into Oct 14.
    const { from, to } = geometry(at('2026-10-13', '19:59'), at('2026-10-13', '22:59'));

    expect(from).toBeGreaterThanOrEqual(1 - EPS); // Tuesday column
    expect(to).toBeLessThanOrEqual(2 + EPS); // ends by Wednesday 00:00
    expect(to - from).toBeGreaterThanOrEqual(MIN_BAR_WIDTH_DAYS - EPS);
    expect(to - from).toBeLessThanOrEqual(1 + EPS);
  });

  it('pads a short late-evening attack backwards without touching midnight', () => {
    const { from, to } = geometry(at('2026-10-13', '19:59'), at('2026-10-13', '22:59'));

    expect(to).toBeCloseTo(1 + 22.9833333333 / 24, 6);
    expect(to).toBeLessThan(2);
    expect(to - from).toBeCloseTo(MIN_BAR_WIDTH_DAYS, 6);
  });

  it('does not change a late attack that already exceeds the minimum width', () => {
    const { from, to } = geometry(at('2026-10-13', '16:59'), at('2026-10-13', '22:59'));

    expect(from).toBeCloseTo(1 + 16.9833333333 / 24, 6);
    expect(to).toBeCloseTo(1 + 22.9833333333 / 24, 6);
  });

  it('extends an early-day short attack forward only when needed', () => {
    const { from, to } = geometry(at('2026-10-13', '01:00'), at('2026-10-13', '02:00'));

    expect(from).toBeCloseTo(1 + 1 / 24, 6);
    expect(to).toBeCloseTo(1 + 1 / 24 + MIN_BAR_WIDTH_DAYS, 6);
    expect(to).toBeLessThan(2);
  });

  it('pads a very short attack without crossing midnight', () => {
    // 23:59-00:00 would be ~0.0007 columns: pad backwards inside Oct 13.
    const { from, to } = geometry(at('2026-10-13', '23:59'), at('2026-10-14', '00:00'));

    expect(from).toBeGreaterThanOrEqual(1 - EPS);
    expect(to).toBeLessThanOrEqual(2 + EPS);
    // Exactly at the boundary is allowed (it does not enter Oct 14).
    expect(to).toBeCloseTo(2, 6);
    expect(to - from).toBeCloseTo(MIN_BAR_WIDTH_DAYS, 6);
  });

  it('treats an attack ending at local midnight as inside the previous day', () => {
    const { from, to } = geometry(at('2026-10-13', '19:00'), at('2026-10-14', '00:00'));

    expect(from).toBeCloseTo(1 + 19 / 24, 6);
    expect(to).toBeCloseTo(2, 6);
  });

  it('pads inside a 25-hour fall-back day using real local midnights', () => {
    // Nov 1 2026 has 25 hours; it is the 7th column of the Oct 26 week.
    // 10:00 local is 11 elapsed hours after midnight (DST repeats 01:00-02:00).
    const { from, to } = geometry(
      at('2026-11-01', '10:00'),
      at('2026-11-01', '10:30'),
      '2026-10-26',
    );

    expect(from).toBeCloseTo(6 + 11 / 25, 6);
    expect(to).toBeCloseTo(from + MIN_BAR_WIDTH_DAYS, 6);
    expect(to).toBeLessThanOrEqual(7 + EPS);
  });
});

describe('weekBarGeometry: real crossings and degenerate attacks', () => {
  it('does not shorten an attack that genuinely spans several days', () => {
    const { from, to } = geometry(at('2026-10-13', '20:00'), at('2026-10-15', '08:00'));

    expect(from).toBeGreaterThanOrEqual(1 - EPS);
    expect(to).toBeCloseTo(3 + 8 / 24, 6); // Thursday 08:00
    expect(to - from).toBeGreaterThan(1);
  });

  it('keeps a genuine 23:30-00:30 crossing across the boundary', () => {
    const { from, to } = geometry(at('2026-10-13', '23:30'), at('2026-10-14', '00:30'));

    expect(from).toBeLessThan(2);
    expect(to).toBeGreaterThan(2);
    expect(to - from).toBeCloseTo(1 / 24, 6);
  });

  it('renders a negative-duration attack at its start, never backwards', () => {
    const start = at('2026-10-13', '20:00');
    const { from, to } = geometry(start, at('2026-10-12', '20:00'));

    expect(to).toBeGreaterThanOrEqual(from);
    expect(from).toBeGreaterThanOrEqual(1 - EPS);
    expect(to).toBeLessThanOrEqual(2 + EPS);
    // Padding pulls the left edge back from the true start, not forward.
    expect(from).toBeLessThanOrEqual(1 + 20 / 24 + EPS);
  });

  it('collapses a zero-duration attack to a visible short bar at its start', () => {
    const start = at('2026-10-13', '20:00');
    const { from, to } = geometry(start, start);

    expect(from).toBeCloseTo(2 - MIN_BAR_WIDTH_DAYS, 6);
    expect(to).toBeCloseTo(2, 6);
  });
});

describe('weekBarGeometry: week clipping', () => {
  it('clips an attack that starts before the week and flags the continuation', () => {
    const { from, to, continuesLeft, continuesRight } = geometry(
      at('2026-10-11', '22:00'),
      at('2026-10-13', '02:00'),
    );

    expect(from).toBe(0);
    expect(to).toBeGreaterThan(0);
    expect(to).toBeCloseTo(1 + 2 / 24, 6);
    expect(continuesLeft).toBe(true);
    expect(continuesRight).toBe(false);
  });

  it('clips an attack that runs past the week and flags the continuation', () => {
    const { from, to, continuesLeft, continuesRight } = geometry(
      at('2026-10-18', '22:00'),
      at('2026-10-21', '02:00'),
    );

    expect(from).toBeGreaterThanOrEqual(6 - EPS);
    expect(to).toBe(7);
    expect(continuesLeft).toBe(false);
    expect(continuesRight).toBe(true);
  });

  it('always returns a non-negative width inside the seven columns', () => {
    const cases: Array<[number, number]> = [
      [at('2026-10-13', '00:00'), at('2026-10-13', '00:00')],
      [at('2026-10-13', '23:59'), at('2026-10-13', '23:59')],
      [at('2026-10-12', '00:00'), at('2026-10-18', '23:59')],
      [at('2026-10-10', '10:00'), at('2026-10-10', '11:00')],
    ];
    for (const [start, end] of cases) {
      const { from, to } = geometry(start, end);
      expect(from).toBeGreaterThanOrEqual(-EPS);
      expect(to).toBeLessThanOrEqual(7 + EPS);
      expect(to).toBeGreaterThanOrEqual(from);
    }
  });
});
