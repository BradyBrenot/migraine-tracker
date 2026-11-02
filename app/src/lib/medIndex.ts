import type { MedEvent } from '@/types';

/** One medId's parseable instants, ascending, plus its latest instant. */
export interface MedIndexEntry {
  instantsAsc: number[];
  latestMs: number | null;
}

export interface MedIndex {
  byId: Map<string, MedIndexEntry>;
}

/**
 * Parse every medication event ONCE into a per-medId ascending instant index.
 *
 * - The input array is not assumed to be sorted (`logMed` appends), so each
 *   medId's instants are sorted here.
 * - Unparseable timestamps are skipped; duplicate instants are preserved so
 *   dose counts stay exact.
 * - Future instants are kept (the rolling-window helpers deliberately have no
 *   upper bound); `currentStock` applies its own `<= now` rule.
 * - Neither `now` nor `timeZone` is baked in: day bucketing happens at query
 *   time, so one index serves multiple timezones.
 *
 * The store treats med arrays/objects as immutable (updates replace objects and
 * arrays), which is what makes memoizing this index by `meds` identity safe.
 */
export function buildMedIndex(meds: readonly MedEvent[]): MedIndex {
  const byId = new Map<string, number[]>();

  for (const med of meds) {
    const ms = Date.parse(med.ts);
    if (!Number.isFinite(ms)) continue;
    const instants = byId.get(med.medId);
    if (instants) instants.push(ms);
    else byId.set(med.medId, [ms]);
  }

  const out = new Map<string, MedIndexEntry>();
  for (const [medId, instants] of byId) {
    instants.sort((a, b) => a - b);
    out.set(medId, {
      instantsAsc: instants,
      latestMs: instants[instants.length - 1] ?? null,
    });
  }
  return { byId: out };
}

/** First index whose value is >= `value` in an ascending array. */
export function lowerBound(instantsAsc: readonly number[], value: number): number {
  let lo = 0;
  let hi = instantsAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (instantsAsc[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
