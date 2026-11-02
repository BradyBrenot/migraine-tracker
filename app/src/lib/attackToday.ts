import type { Attack } from '@/types';
import { attackDayKeys, parseAttackInterval } from '../../shared/attackstats.ts';
import type { DayKey } from '../../shared/datetime.ts';

/** An attack whose raw `end` is a string (never an ongoing open attack). */
export type FinishedAttack = Omit<Attack, 'end'> & { end: string };

/** A finished attack's parsed interval, cached attack object, and order. */
export interface FinishedAttackInterval {
  attack: FinishedAttack;
  startMs: number | null;
  /** Null when the stored end string is unusable (degenerate at the start). */
  endMs: number | null;
  /** Original index in `state.attacks`, so callers can restore display order. */
  order: number;
}

/** An ongoing (`end === null`) attack's parsed start, attack, and order. */
export interface OngoingAttackInterval {
  attack: Attack;
  startMs: number | null;
  order: number;
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

  for (let order = 0; order < attacks.length; order++) {
    const attack = attacks[order];
    const { startMs, endMs, ongoing: isOngoing } = parseAttackInterval(attack);
    if (isOngoing) ongoing.push({ attack, startMs, order });
    else finished.push({ attack: attack as FinishedAttack, startMs, endMs, order });
  }

  return { finished, ongoing };
}

/**
 * Cached attributed day keys for a FINISHED attack. The cache is keyed by
 * object identity and timezone, and revalidates both raw strings, so an
 * in-place mutation cannot return stale keys. The returned array is shared:
 * callers must treat it as read-only.
 *
 * Ongoing attacks are structurally rejected: their day set changes as `now`
 * advances, and freezing it would silently undercount the current day.
 */
const finishedDayKeysCache = new WeakMap<
  object,
  Map<string, { start: string; end: string; keys: readonly DayKey[] }>
>();

/**
 * Pathological records can enumerate up to `MAX_ENUMERATED_DAYS`; do not retain
 * an absurd array in the long-lived cache. They still compute correctly, just
 * uncached.
 */
const MAX_CACHED_DAY_KEYS = 400;

export function attackDayKeysForFinished(
  attack: FinishedAttack,
  timeZone: string,
): readonly DayKey[] {
  if (attack.end === null) {
    throw new TypeError('attackDayKeysForFinished requires a finished attack');
  }

  let byZone = finishedDayKeysCache.get(attack);
  if (byZone === undefined) {
    byZone = new Map();
    finishedDayKeysCache.set(attack, byZone);
  }
  const cached = byZone.get(timeZone);
  if (
    cached !== undefined
    && cached.start === attack.start
    && cached.end === attack.end
  ) {
    return cached.keys;
  }

  const keys = attackDayKeys(
    Date.parse(attack.start), Date.parse(attack.end), timeZone,
  );
  if (keys.length <= MAX_CACHED_DAY_KEYS) {
    byZone.set(timeZone, { start: attack.start, end: attack.end, keys });
  }
  return keys;
}
