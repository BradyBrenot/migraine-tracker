// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Attack } from '@/types';
import {
  attackCountsAsAttackDay, attackOverlapsRange, parseAttackTimes,
} from '../../shared/attackstats.ts';
import { addDays, zonedDateTimeToMs } from '../../shared/datetime.ts';
import { useTodayAttackFacts } from './use-today-attack-facts.ts';

const TZ = 'UTC';
const NOW = Date.UTC(2026, 5, 15, 12);
const TODAY = '2026-06-15';

function attack(partial: Partial<Attack> & Pick<Attack, 'id'>): Attack {
  return {
    start: '2026-06-15T09:00:00.000Z',
    end: '2026-06-15T11:00:00.000Z',
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

/** Independent reference implementation used by the differential assertions. */
function naiveFacts(
  attacks: readonly Attack[],
  now: number,
  todayKey: string,
  timeZone: string,
): { countsAsAttackDayToday: boolean; attackOverlapsToday: boolean } {
  const dayStart = zonedDateTimeToMs(todayKey, '00:00', timeZone);
  const dayEnd = zonedDateTimeToMs(addDays(todayKey, 1), '00:00', timeZone);
  let counts = false;
  let overlaps = false;
  for (const a of attacks) {
    const times = parseAttackTimes(a, now);
    if (!counts && attackCountsAsAttackDay(times.startMs, times.endMs, todayKey, timeZone)) {
      counts = true;
    }
    if (!overlaps && attackOverlapsRange(
      times.startMs, times.endMs, dayStart, dayEnd,
    )) {
      overlaps = true;
    }
  }
  return { countsAsAttackDayToday: counts, attackOverlapsToday: overlaps };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTodayAttackFacts differential parity', () => {
  it('matches the naive per-attack scan across dirty and boundary fixtures', () => {
    const fixtures: Attack[][] = [
      [],
      [attack({ id: 'daytime', start: '2026-06-15T09:00:00.000Z' })],
      // Early morning belongs to yesterday's attack day but still raw-overlaps today.
      [attack({ id: 'early', start: '2026-06-15T01:00:00.000Z', end: '2026-06-15T02:00:00.000Z' })],
      // Crosses 08:00: today counts.
      [attack({ id: 'crossing', start: '2026-06-15T07:00:00.000Z', end: '2026-06-15T09:00:00.000Z' })],
      // Yesterday evening -> this morning: only yesterday's attack day.
      [attack({ id: 'night', start: '2026-06-14T22:00:00.000Z', end: '2026-06-15T06:00:00.000Z' })],
      // Ongoing since yesterday morning: today's window overlaps now.
      [attack({ id: 'ongoing-yesterday', start: '2026-06-14T09:00:00.000Z', end: null })],
      // Ongoing but not yet at 08:00 today.
      [attack({ id: 'ongoing-pre-0800', start: '2026-06-15T07:00:00.000Z', end: null })],
      // Future-dated open attack: rescue for the CTA is Home's job, not this hook.
      [attack({ id: 'future-open', start: '2026-06-16T01:00:00.000Z', end: null })],
      // Dirty ends are finished/degenerate, never re-anchored to now.
      [attack({ id: 'garbage-end', start: '2026-06-15T01:00:00.000Z', end: 'garbage' })],
      [attack({ id: 'empty-end', start: '2026-06-15T01:00:00.000Z', end: '' })],
      [attack({ id: 'undefined-end', start: '2026-06-15T01:00:00.000Z', end: undefined as unknown as null })],
      [attack({ id: 'bad-start-open', start: 'not-a-date', end: null })],
      [
        attack({ id: 'multi', start: '2026-06-13T22:00:00.000Z', end: '2026-06-16T03:00:00.000Z' }),
        attack({ id: 'early-tail', start: '2026-06-16T01:00:00.000Z', end: '2026-06-16T02:00:00.000Z' }),
      ],
    ];

    for (const attacks of fixtures) {
      const { result } = renderHook(() => useTodayAttackFacts(attacks, TZ, TODAY, NOW));
      expect(result.current).toEqual(naiveFacts(attacks, NOW, TODAY, TZ));
    }
  });

  it('re-evaluates only the ongoing attack across ticks and flips at 08:00', () => {
    const attacks = [attack({ id: 'ongoing', start: '2026-06-15T07:00:00.000Z', end: null })];
    const { result, rerender } = renderHook(
      ({ now }) => useTodayAttackFacts(attacks, TZ, TODAY, now),
      { initialProps: { now: Date.UTC(2026, 5, 15, 7, 59) } },
    );

    expect(result.current.countsAsAttackDayToday).toBe(false);
    rerender({ now: Date.UTC(2026, 5, 15, 8, 1) });
    expect(result.current.countsAsAttackDayToday).toBe(true);
  });

  it('does not re-parse finished history on a tick', () => {
    const attacks = [
      ...Array.from({ length: 1000 }, (_, i) => attack({
        id: `finished-${i}`,
        start: new Date(Date.UTC(2025, 0, 1) + i * 21600000).toISOString(),
        end: new Date(Date.UTC(2025, 0, 1) + i * 21600000 + 3600000).toISOString(),
      })),
      attack({ id: 'ongoing', start: '2026-06-15T07:00:00.000Z', end: null }),
    ];
    const { rerender } = renderHook(
      ({ now }) => useTodayAttackFacts(attacks, TZ, TODAY, now),
      { initialProps: { now: Date.UTC(2026, 5, 15, 7, 59) } },
    );

    const parseSpy = vi.spyOn(Date, 'parse');
    rerender({ now: Date.UTC(2026, 5, 15, 8, 1) });
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('recomputes finished facts on a local-day rollover', () => {
    // An attack in tomorrow's early-morning window belongs to tomorrow, not today.
    const attacks = [attack({
      id: 'tomorrow-early',
      start: '2026-06-16T01:00:00.000Z',
      end: '2026-06-16T02:00:00.000Z',
    })];
    const { result, rerender } = renderHook(
      ({ todayKey, now }) => useTodayAttackFacts(attacks, TZ, todayKey, now),
      { initialProps: { todayKey: TODAY, now: NOW } },
    );

    expect(result.current.countsAsAttackDayToday).toBe(true); // tonight's window

    rerender({ todayKey: '2026-06-16', now: Date.UTC(2026, 5, 16, 12) });
    expect(result.current.countsAsAttackDayToday).toBe(false); // before 08:00 tomorrow
    expect(result.current.attackOverlapsToday).toBe(true); // raw calendar day
  });
});
