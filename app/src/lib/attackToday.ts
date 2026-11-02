import type { Attack } from '@/types';
import { parseAttackInterval } from '../../shared/attackstats.ts';

/** A finished attack's parsed interval. `endMs` is null for a dirty end. */
export interface FinishedAttackInterval {
  startMs: number | null;
  endMs: number | null;
}

/** An ongoing (`end === null`) attack's parsed start. */
export interface OngoingAttackInterval {
  startMs: number | null;
}

export interface AttackIndex {
  finished: FinishedAttackInterval[];
  ongoing: OngoingAttackInterval[];
}

/**
 * Parse every attack ONCE and split it by the RAW `attack.end === null` flag.
 *
 * Finished attacks never depend on the clock: their parsed instants are pure
 * functions of the stored strings, so callers can memoize this index by the
 * `attacks` array identity. Ongoing attacks are kept separately because only
 * they need a fresh `now` end on every tick.
 *
 * Partitioning deliberately uses the raw flag, not `endMs === null`: a
 * finished attack with an unparseable end is degenerate at its start and must
 * NOT be re-anchored to `now`.
 *
 * The store treats attack arrays and objects as immutable (every mutation
 * replaces the array and the changed object), which is what makes identity
 * memoization safe.
 */
export function buildAttackIndex(attacks: readonly Attack[]): AttackIndex {
  const finished: FinishedAttackInterval[] = [];
  const ongoing: OngoingAttackInterval[] = [];

  for (const attack of attacks) {
    const { startMs, endMs, ongoing: isOngoing } = parseAttackInterval(attack);
    if (isOngoing) ongoing.push({ startMs });
    else finished.push({ startMs, endMs });
  }

  return { finished, ongoing };
}
