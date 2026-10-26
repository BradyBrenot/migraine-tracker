import { describe, expect, it } from 'vitest';
import type { MedEvent } from '@/types';
import { localDayKey } from '../../shared/datetime.ts';
import { daysSinceLast, usageDaysInWindow } from './usage';

const DAY_MS = 86400000;

function dose(ts: string, medId = 'nurtec', id = ts): MedEvent {
  return {
    id,
    medId,
    dose: '75 mg',
    quantity: 1,
    ts,
    attackId: null,
    notes: '',
    source: 'manual',
  };
}

describe('usageDaysInWindow', () => {
  it('buckets doses by the configured zone day, not the UTC/system day', () => {
    // Both instants share the UTC day 2026-05-31, but in Pacific/Kiritimati
    // (UTC+14) they are May 31 14:30 and Jun 1 02:30 — two adjacent local days.
    const meds = [dose('2026-05-31T00:30:00.000Z'), dose('2026-05-31T12:30:00.000Z')];
    const now = Date.parse('2026-06-01T00:00:00.000Z');

    expect(localDayKey(Date.parse('2026-05-31T00:30:00.000Z'), 'Pacific/Kiritimati')).toBe('2026-05-31');
    expect(localDayKey(Date.parse('2026-05-31T12:30:00.000Z'), 'Pacific/Kiritimati')).toBe('2026-06-01');

    expect(usageDaysInWindow(meds, 'nurtec', 30, now, 'Pacific/Kiritimati')).toBe(2);
    // The same doses are one UTC day, proving the zone — not the UTC date — wins.
    expect(usageDaysInWindow(meds, 'nurtec', 30, now, 'UTC')).toBe(1);
  });

  it('filters by med id and returns 0 for an empty window', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const meds = [dose('2026-05-31T12:00:00.000Z', 'tylenol')];
    expect(usageDaysInWindow(meds, 'nurtec', 30, now, 'UTC')).toBe(0);
  });

  it('keeps the rolling cutoff: exact boundary counts, one ms earlier does not', () => {
    const now = Date.parse('2026-06-10T00:00:00.000Z');
    const windowDays = 2;
    // cutoff is local midnight, so the excluded instant is a DIFFERENT day:
    // including it would raise the distinct-day count, proving the cutoff
    // (not just bucketing) drives the result.
    const cutoff = new Date(now - windowDays * DAY_MS);
    const justBefore = new Date(cutoff.getTime() - 1);
    expect(localDayKey(cutoff.getTime(), 'UTC')).toBe('2026-06-08');
    expect(localDayKey(justBefore.getTime(), 'UTC')).toBe('2026-06-07');

    const atCutoff = dose(cutoff.toISOString(), 'nurtec', 'at-cutoff');
    const beforeCutoff = dose(justBefore.toISOString(), 'nurtec', 'before-cutoff');

    expect(usageDaysInWindow([atCutoff], 'nurtec', windowDays, now, 'UTC')).toBe(1);
    expect(usageDaysInWindow([beforeCutoff], 'nurtec', windowDays, now, 'UTC')).toBe(0);
    expect(usageDaysInWindow([atCutoff, beforeCutoff], 'nurtec', windowDays, now, 'UTC')).toBe(1);
  });
});

describe('daysSinceLast', () => {
  it('returns whole configured-local-calendar-day differences, not floor(elapsed/24h)', () => {
    // latest = Mar 7 15:00 EST, now = Mar 9 14:00 EDT (spring forward between).
    const latestIso = '2026-03-07T20:00:00.000Z';
    const now = Date.parse('2026-03-09T18:00:00.000Z');
    const elapsed = now - Date.parse(latestIso);

    expect(elapsed).toBe(46 * 3600000);
    expect(Math.floor(elapsed / DAY_MS)).toBe(1); // the old, wrong answer
    expect(daysSinceLast([dose(latestIso)], 'nurtec', now, 'America/New_York')).toBe(2);
  });

  it('counts a local-midnight crossing even when under 24h has elapsed', () => {
    const now = Date.parse('2026-05-31T10:01:00.000Z');
    const latestIso = '2026-05-31T09:59:00.000Z'; // May 31 23:59 Kiritimati
    expect(localDayKey(Date.parse(latestIso), 'Pacific/Kiritimati')).toBe('2026-05-31');
    expect(localDayKey(now, 'Pacific/Kiritimati')).toBe('2026-06-01');
    expect(now - Date.parse(latestIso)).toBe(2 * 60 * 1000); // < 24h
    expect(daysSinceLast([dose(latestIso)], 'nurtec', now, 'Pacific/Kiritimati')).toBe(1);

    // Same idea at exactly 24h: 2026-05-31T10:30Z is Jun 1 there, now is Jun 2.
    expect(daysSinceLast(
      [dose('2026-05-31T10:30:00.000Z')],
      'nurtec',
      Date.parse('2026-06-01T10:30:00.000Z'),
      'Pacific/Kiritimati',
    )).toBe(1);
  });

  it('returns null with no dose for the med and picks the latest instant', () => {
    const now = Date.parse('2026-03-09T12:00:00.000Z');
    expect(daysSinceLast([], 'nurtec', now, 'UTC')).toBeNull();
    expect(daysSinceLast([dose('2026-03-08T12:00:00.000Z', 'tylenol')], 'nurtec', now, 'UTC')).toBeNull();

    // Unsorted events: the latest instant (Mar 7), not the last array entry.
    const meds = [
      dose('2026-03-01T12:00:00.000Z'),
      dose('2026-03-07T20:00:00.000Z'),
      dose('2026-03-03T12:00:00.000Z'),
    ];
    expect(daysSinceLast(meds, 'nurtec', now, 'UTC')).toBe(2);
  });

  it('ignores unparseable timestamps instead of throwing', () => {
    const now = Date.parse('2026-03-09T12:00:00.000Z');
    const bad = dose('not-a-date', 'nurtec', 'bad');
    const good = dose('2026-03-08T12:00:00.000Z', 'nurtec', 'good');

    // Only invalid doses for this med: no usable latest instant.
    expect(daysSinceLast([bad], 'nurtec', now, 'UTC')).toBeNull();
    // A valid dose still wins; the invalid row does not poison Math.max.
    expect(daysSinceLast([bad, good], 'nurtec', now, 'UTC')).toBe(1);
  });

  it('does not clamp a negative difference when now precedes the latest dose', () => {
    expect(daysSinceLast(
      [dose('2026-03-07T20:00:00.000Z')],
      'nurtec',
      Date.parse('2026-03-06T12:00:00.000Z'),
      'UTC',
    )).toBe(-1);
  });
});
