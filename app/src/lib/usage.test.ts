import { describe, expect, it } from 'vitest';
import type { MedEvent, TrackerState } from '@/types';
import { localDayKey } from '../../shared/datetime.ts';
import {
  PAINKILLER_DEFAULT_RULE, PAINKILLER_MED_IDS, daysSinceLast, isValidLimit,
  isValidWindowDays, limitState, medUnionDaysInWindow, painkillerBreakdown,
  painkillerRulesDiffer, resolveRule, resolveSharedPainkillerRule, usageDaysInWindow,
} from './usage';

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

describe('resolveRule', () => {
  it('keeps fully valid persisted values', () => {
    expect(resolveRule({ limit: 4, windowDays: 7 }, PAINKILLER_DEFAULT_RULE))
      .toEqual({ limit: 4, windowDays: 7 });
  });

  it('keeps a zero limit (any use is already over) but never a zero window', () => {
    expect(resolveRule({ limit: 0, windowDays: 30 }, PAINKILLER_DEFAULT_RULE).limit).toBe(0);
    expect(resolveRule({ limit: 4, windowDays: 0 }, PAINKILLER_DEFAULT_RULE).windowDays).toBe(30);
  });

  it('falls back per field for partial and malformed legacy rules', () => {
    const partial = { limit: 9 } as unknown as TrackerState['rules'][string];
    expect(resolveRule(partial, PAINKILLER_DEFAULT_RULE)).toEqual({ limit: 9, windowDays: 30 });

    const malformed = { limit: 'lots', windowDays: Number.NaN } as unknown as TrackerState['rules'][string];
    expect(resolveRule(malformed, PAINKILLER_DEFAULT_RULE)).toEqual(PAINKILLER_DEFAULT_RULE);

    const negative = { limit: -2, windowDays: -1 } as unknown as TrackerState['rules'][string];
    expect(resolveRule(negative, PAINKILLER_DEFAULT_RULE)).toEqual(PAINKILLER_DEFAULT_RULE);
  });

  it('treats missing/undefined rules as the fallback', () => {
    expect(resolveRule(undefined, { limit: 3, windowDays: 7 })).toEqual({ limit: 3, windowDays: 7 });
    expect(resolveRule(null, { limit: 3, windowDays: 7 })).toEqual({ limit: 3, windowDays: 7 });
  });

  it('validates limits and windows independently', () => {
    expect(isValidLimit(0)).toBe(true);
    expect(isValidLimit(1.5)).toBe(false);
    expect(isValidLimit(-1)).toBe(false);
    expect(isValidLimit('3')).toBe(false);
    expect(isValidWindowDays(1)).toBe(true);
    expect(isValidWindowDays(0)).toBe(false);
    expect(isValidWindowDays(2.5)).toBe(false);
  });
});

describe('resolveSharedPainkillerRule', () => {
  const rule = (limit: number, windowDays: number) => ({ limit, windowDays });

  it('defaults to 15 days / 30 days when nothing is configured', () => {
    expect(resolveSharedPainkillerRule({})).toEqual(PAINKILLER_DEFAULT_RULE);
    expect(resolveSharedPainkillerRule(undefined)).toEqual(PAINKILLER_DEFAULT_RULE);
  });

  it('uses the lowest valid limit and the widest valid window across the three', () => {
    const rules: TrackerState['rules'] = {
      tylenol: rule(12, 20),
      ibuprofen: rule(8, 30),
      naproxen: rule(15, 45),
    };
    expect(resolveSharedPainkillerRule(rules)).toEqual({ limit: 8, windowDays: 45 });
  });

  it('falls back per-med to defaults for malformed or missing fields before aggregating', () => {
    const rules: TrackerState['rules'] = {
      tylenol: { limit: 10 } as unknown as TrackerState['rules'][string],
      ibuprofen: { windowDays: 60 } as unknown as TrackerState['rules'][string],
      // naproxen missing entirely -> 15/30
    };
    // tylenol -> 10/30, ibuprofen -> 15/60, naproxen -> 15/30
    expect(resolveSharedPainkillerRule(rules)).toEqual({ limit: 10, windowDays: 60 });

    const garbage: TrackerState['rules'] = {
      tylenol: { limit: Number.NaN, windowDays: Number.NaN } as unknown as TrackerState['rules'][string],
      ibuprofen: rule(9, 7),
      naproxen: rule(9, 7),
    };
    expect(resolveSharedPainkillerRule(garbage)).toEqual({ limit: 9, windowDays: 30 });
  });

  it('flags mismatched rules and accepts three identical ones', () => {
    expect(painkillerRulesDiffer({})).toBe(false);
    expect(painkillerRulesDiffer({
      tylenol: rule(10, 30),
      ibuprofen: rule(10, 30),
      naproxen: rule(10, 30),
    })).toBe(false);
    expect(painkillerRulesDiffer({
      tylenol: rule(10, 30),
      ibuprofen: rule(10, 30),
      naproxen: rule(14, 30),
    })).toBe(true);
    // A partial rule that resolves to the same defaults is not a mismatch.
    expect(painkillerRulesDiffer({
      tylenol: { limit: 15 } as unknown as TrackerState['rules'][string],
    })).toBe(false);
  });

  it('exposes exactly Tylenol, Ibuprofen and Naproxen as painkillers', () => {
    expect([...PAINKILLER_MED_IDS]).toEqual(['tylenol', 'ibuprofen', 'naproxen']);
  });
});

describe('painkiller day union', () => {
  const DAY = 86400000;
  const now = Date.parse('2026-06-10T12:00:00.000Z');

  it('counts multiple doses of one med on one day as one day', () => {
    const meds = [
      dose('2026-06-09T08:00:00.000Z', 'tylenol', 't1'),
      dose('2026-06-09T20:00:00.000Z', 'tylenol', 't2'),
    ];
    expect(medUnionDaysInWindow(meds, PAINKILLER_MED_IDS, 30, now, 'UTC')).toBe(1);
  });

  it('counts different painkillers on the same day as one MoH day', () => {
    const meds = [
      dose('2026-06-09T08:00:00.000Z', 'tylenol', 't1'),
      dose('2026-06-09T12:00:00.000Z', 'ibuprofen', 'i1'),
      dose('2026-06-09T22:00:00.000Z', 'naproxen', 'n1'),
    ];
    expect(medUnionDaysInWindow(meds, PAINKILLER_MED_IDS, 30, now, 'UTC')).toBe(1);
    // The per-med view is unchanged: one day each.
    expect(usageDaysInWindow(meds, 'tylenol', 30, now, 'UTC')).toBe(1);
    expect(usageDaysInWindow(meds, 'ibuprofen', 30, now, 'UTC')).toBe(1);
    expect(usageDaysInWindow(meds, 'naproxen', 30, now, 'UTC')).toBe(1);
  });

  it('adds distinct days across meds', () => {
    const meds = [
      dose('2026-06-08T08:00:00.000Z', 'tylenol', 't1'),
      dose('2026-06-09T08:00:00.000Z', 'ibuprofen', 'i1'),
      dose('2026-06-09T18:00:00.000Z', 'naproxen', 'n1'),
    ];
    expect(medUnionDaysInWindow(meds, PAINKILLER_MED_IDS, 30, now, 'UTC')).toBe(2);
  });

  it('excludes Nurtec and other non-painkillers from the union', () => {
    const meds = [
      dose('2026-06-09T08:00:00.000Z', 'nurtec', 'n1'),
      dose('2026-06-09T09:00:00.000Z', 'emgality', 'e1'),
    ];
    expect(medUnionDaysInWindow(meds, PAINKILLER_MED_IDS, 30, now, 'UTC')).toBe(0);
  });

  it('applies the same rolling cutoff (inclusive) as the per-med count', () => {
    const atCutoff = dose(new Date(now - 2 * DAY).toISOString(), 'tylenol', 'cutoff');
    const beforeCutoff = dose(new Date(now - 2 * DAY - 1).toISOString(), 'ibuprofen', 'before');
    expect(medUnionDaysInWindow([atCutoff], PAINKILLER_MED_IDS, 2, now, 'UTC')).toBe(1);
    expect(medUnionDaysInWindow([beforeCutoff], PAINKILLER_MED_IDS, 2, now, 'UTC')).toBe(0);
  });

  it('buckets the union by the configured zone, not UTC', () => {
    const meds = [
      dose('2026-05-31T00:30:00.000Z', 'tylenol', 't1'),
      dose('2026-05-31T12:30:00.000Z', 'ibuprofen', 'i1'),
    ];
    expect(medUnionDaysInWindow(meds, PAINKILLER_MED_IDS, 30, Date.parse('2026-06-01T00:00:00.000Z'), 'Pacific/Kiritimati')).toBe(2);
    expect(medUnionDaysInWindow(meds, PAINKILLER_MED_IDS, 30, Date.parse('2026-06-01T00:00:00.000Z'), 'UTC')).toBe(1);
  });

  it('ignores unparseable timestamps and unusable windows', () => {
    const meds = [dose('not-a-date', 'tylenol', 'bad')];
    expect(medUnionDaysInWindow(meds, PAINKILLER_MED_IDS, 30, now, 'UTC')).toBe(0);
    expect(medUnionDaysInWindow([], PAINKILLER_MED_IDS, 0, now, 'UTC')).toBe(0);
    expect(medUnionDaysInWindow([], PAINKILLER_MED_IDS, 30, now, 'UTC')).toBe(0);
  });
});

describe('painkillerBreakdown', () => {
  const now = Date.parse('2026-06-10T12:00:00.000Z');

  it('reports days and doses per used painkiller', () => {
    const meds = [
      dose('2026-06-09T08:00:00.000Z', 'tylenol', 't1'),
      dose('2026-06-09T20:00:00.000Z', 'tylenol', 't2'),
      dose('2026-06-08T09:00:00.000Z', 'naproxen', 'n1'),
    ];
    expect(painkillerBreakdown(meds, 30, now, 'UTC')).toEqual([
      { medId: 'tylenol', days: 1, doses: 2 },
      { medId: 'naproxen', days: 1, doses: 1 },
    ]);
  });

  it('omits unused meds and ignores invalid timestamps', () => {
    expect(painkillerBreakdown([dose('nope', 'ibuprofen', 'bad')], 30, now, 'UTC')).toEqual([]);
  });
});

describe('limitState', () => {
  it('never warns on an unused low limit (0-3)', () => {
    expect(limitState(0, 0)).toBe('ok');
    expect(limitState(0, 1)).toBe('ok');
    expect(limitState(0, 2)).toBe('ok');
    expect(limitState(0, 3)).toBe('ok');
    expect(limitState(0, 15)).toBe('ok');
  });

  it('treats reaching the limit as near, never over', () => {
    expect(limitState(2, 3)).toBe('near');
    expect(limitState(3, 3)).toBe('near');
    expect(limitState(4, 3)).toBe('over');
  });

  it('warns near only inside the last three allowed days', () => {
    expect(limitState(11, 15)).toBe('ok');
    expect(limitState(12, 15)).toBe('near');
    expect(limitState(15, 15)).toBe('near');
    expect(limitState(16, 15)).toBe('over');
  });

  it('is over immediately for a zero limit with any use', () => {
    expect(limitState(1, 0)).toBe('over');
  });
});
