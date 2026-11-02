import { useMemo } from 'react';
import type { Attack } from '@/types';
import {
  addDays, zonedDateTimeToMs, type DayKey,
} from '../../shared/datetime.ts';
import {
  attackCountsAsAttackDay, attackOverlapsRange,
} from '../../shared/attackstats.ts';
import { buildAttackIndex } from './attackToday.ts';

export interface TodayAttackFacts {
  /**
   * Does today count as an attack/migraine day? Evaluates finished attacks
   * once per local day and ongoing attacks with `endMs = now` on every tick.
   * Deliberately has no `activeAttack` shortcut: an attack started pre-08:00
   * today must not infer today until its interval reaches today's window.
   */
  countsAsAttackDayToday: boolean;
  /**
   * Raw local-midnight-to-midnight overlap for today. Used by the Home CTA,
   * which separately ORs `activeAttack` so a future-dated open attack still
   * offers "Log another attack".
   */
  attackOverlapsToday: boolean;
}

/**
 * Today's attack-day facts without rescanning history on every 15s clock tick.
 *
 * - The attack index is parsed once per `attacks` identity.
 * - Finished results are memoized per local day/zone; their intervals never
 *   depend on `now`.
 * - Only `end === null` attacks are evaluated per tick, with `endMs = now`,
 *   which preserves the live "crossing 08:00 gains today" behavior.
 *
 * Callers must pass the same `now` and `todayKey` they render with (Home and
 * PartnerHome share `useNow()`), so the day key and the ongoing end never
 * disagree around midnight.
 */
export function useTodayAttackFacts(
  attacks: readonly Attack[],
  timeZone: string,
  todayKey: DayKey,
  now: number,
): TodayAttackFacts {
  const index = useMemo(() => buildAttackIndex(attacks), [attacks]);

  const todayBounds = useMemo(() => ({
    startMs: zonedDateTimeToMs(todayKey, '00:00', timeZone),
    endMs: zonedDateTimeToMs(addDays(todayKey, 1), '00:00', timeZone),
  }), [todayKey, timeZone]);

  const finished = useMemo(() => {
    let counts = false;
    let overlaps = false;
    for (const { startMs, endMs } of index.finished) {
      if (!counts && attackCountsAsAttackDay(startMs, endMs, todayKey, timeZone)) {
        counts = true;
      }
      if (!overlaps && attackOverlapsRange(
        startMs, endMs, todayBounds.startMs, todayBounds.endMs,
      )) {
        overlaps = true;
      }
      if (counts && overlaps) break;
    }
    return { counts, overlaps };
  }, [index, todayKey, timeZone, todayBounds]);

  // Only ongoing attacks depend on the clock. Usually zero or one.
  let ongoingCounts = false;
  let ongoingOverlaps = false;
  for (const { startMs } of index.ongoing) {
    if (!ongoingCounts && attackCountsAsAttackDay(startMs, now, todayKey, timeZone)) {
      ongoingCounts = true;
    }
    if (!ongoingOverlaps && attackOverlapsRange(
      startMs, now, todayBounds.startMs, todayBounds.endMs,
    )) {
      ongoingOverlaps = true;
    }
    if (ongoingCounts && ongoingOverlaps) break;
  }

  return {
    countsAsAttackDayToday: finished.counts || ongoingCounts,
    attackOverlapsToday: finished.overlaps || ongoingOverlaps,
  };
}
