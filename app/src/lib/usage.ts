import type { MedEvent, MedRule, TrackerState } from '@/types';
import { diffDayKeys, localDayKey } from '../../shared/datetime.ts';

/** A usable day limit/window pair (both fields valid). */
export interface UsageRule {
  limit: number;
  windowDays: number;
}

/**
 * The three acute analgesics that share one MOH (medication-overuse headache)
 * day budget. `PAINKILLER_DEFAULT_RULE` mirrors their catalog `defaultRule`
 * entries (a unit test keeps the two in sync).
 */
export const PAINKILLER_MED_IDS = ['tylenol', 'ibuprofen', 'naproxen'] as const;
export const PAINKILLER_DEFAULT_RULE: UsageRule = { limit: 15, windowDays: 30 };
export const NURTEC_DEFAULT_RULE: UsageRule = { limit: 15, windowDays: 30 };

/** A day limit is a nonnegative integer (0 is meaningful: any use is over). */
export function isValidLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** A rolling window is a positive integer number of days. */
export function isValidWindowDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Resolve one persisted rule against its fallback, field by field.
 *
 * Imported/legacy rules can be partial or malformed (`{ limit: 15 }`, a string
 * window, NaN, a negative limit). A field that is not valid falls back to the
 * catalog default rather than producing NaN, `undefinedd`, or a zero-length
 * window that would silently report "0 days used".
 */
export function resolveRule(
  rule: MedRule | null | undefined,
  fallback: UsageRule,
): UsageRule {
  return {
    limit: isValidLimit(rule?.limit) ? rule.limit : fallback.limit,
    windowDays: isValidWindowDays(rule?.windowDays)
      ? rule.windowDays
      : fallback.windowDays,
  };
}

/**
 * Conservative shared Painkillers rule: the LOWEST valid limit and the WIDEST
 * valid window across Tylenol, Ibuprofen and Naproxen.
 *
 * The three meds can carry independent persisted rules (older data, a partial
 * import, or an edit made before this shared control existed). Until they are
 * saved as one rule, taking the least permissive combination avoids ever
 * under-reporting overuse. Malformed/missing fields fall back per-med to the
 * catalog default before aggregating.
 */
export function resolveSharedPainkillerRule(
  rules: TrackerState['rules'] | null | undefined,
): UsageRule {
  let limit = Number.POSITIVE_INFINITY;
  let windowDays = 0;
  for (const medId of PAINKILLER_MED_IDS) {
    const resolved = resolveRule(rules?.[medId], PAINKILLER_DEFAULT_RULE);
    limit = Math.min(limit, resolved.limit);
    windowDays = Math.max(windowDays, resolved.windowDays);
  }
  return {
    limit: Number.isFinite(limit) ? limit : PAINKILLER_DEFAULT_RULE.limit,
    windowDays: windowDays > 0 ? windowDays : PAINKILLER_DEFAULT_RULE.windowDays,
  };
}

/** True when the three persisted painkiller rules are not already identical. */
export function painkillerRulesDiffer(
  rules: TrackerState['rules'] | null | undefined,
): boolean {
  return PAINKILLER_MED_IDS.some((medId) => {
    const resolved = resolveRule(rules?.[medId], PAINKILLER_DEFAULT_RULE);
    return !PAINKILLER_MED_IDS.every((otherId) => {
      const other = resolveRule(rules?.[otherId], PAINKILLER_DEFAULT_RULE);
      return other.limit === resolved.limit && other.windowDays === resolved.windowDays;
    });
  });
}

/**
 * Usage severity for one rolling count.
 *
 * - `over` only when the count EXCEEDS the limit: reaching the limit is not
 *   overuse, so a limit of 3 at 3 used still reads "near".
 * - `near` requires at least one used day. An unused low limit (0–3) must never
 *   warn: `0 / 2` is a clean slate, not a warning.
 */
export type LimitState = 'ok' | 'near' | 'over';

export function limitState(used: number, limit: number): LimitState {
  if (used > limit) return 'over';
  if (used > 0 && used >= limit - 3) return 'near';
  return 'ok';
}

/**
 * Copy for mismatched persisted painkiller rules. The partner viewer has no
 * Settings route, so it must never tell its reader to save something they
 * cannot reach there.
 */
export function painkillerMismatchNote(readOnly: boolean, rule: UsageRule): string {
  const shared = `Tylenol, Ibuprofen and Naproxen have different saved limits — using the lowest limit (${rule.limit}) and widest window (${rule.windowDays}d)`;
  return readOnly
    ? `${shared}. This read-only view cannot change it — the writer app saves one shared rule in Settings.`
    : `${shared} until you save one shared rule in Settings.`;
}

/**
 * Distinct calendar days on which a med was used within the last `windowDays`
 * (a rolling window counted back from `now`).
 *
 * The rolling cutoff is deliberately unchanged: `now - windowDays * 86400000`
 * with inclusive `>=`, so overuse limits stay fixed-duration. Days are
 * bucketed with the shared local-day key in the configured IANA zone (falling
 * back to the system zone when omitted), never the UTC slice, so a dose taken
 * just before local midnight counts for the day the user experienced.
 */
export function usageDaysInWindow(
  meds: MedEvent[],
  medId: string,
  windowDays: number,
  now: number,
  timeZone?: string,
): number {
  return medUnionDaysInWindow(meds, [medId], windowDays, now, timeZone);
}

/**
 * Distinct configured-zone days on which ANY of `medIds` was used inside the
 * rolling window — the aggregate "painkiller days" metric.
 *
 * Two doses of different painkillers on one day are ONE medication-overuse
 * day, no matter how many tablets were taken. Individual `MedEvent` records and
 * their per-med counts are untouched; only this view unions them.
 */
export function medUnionDaysInWindow(
  meds: MedEvent[],
  medIds: readonly string[],
  windowDays: number,
  now: number,
  timeZone?: string,
): number {
  if (!Number.isFinite(windowDays) || windowDays <= 0) return 0;
  const ids = new Set(medIds);
  if (ids.size === 0) return 0;
  const cutoff = now - windowDays * 86400000;
  const days = new Set<string>();
  for (const m of meds) {
    if (!ids.has(m.medId)) continue;
    const t = Date.parse(m.ts);
    // Legacy/imported rows may carry an unparseable ts; ignore them.
    if (!Number.isFinite(t) || t < cutoff) continue;
    days.add(localDayKey(t, timeZone));
  }
  return days.size;
}

/** Per-med day/dose counts for the shared painkiller card. */
export interface PainkillerBreakdownEntry {
  medId: string;
  days: number;
  doses: number;
}

/**
 * Per-med breakdown behind the aggregate painkiller number, newest data only.
 * Used for the compact "which meds" line and the accessible card name.
 */
export function painkillerBreakdown(
  meds: MedEvent[],
  windowDays: number,
  now: number,
  timeZone?: string,
): PainkillerBreakdownEntry[] {
  if (!Number.isFinite(windowDays) || windowDays <= 0) return [];
  const cutoff = now - windowDays * 86400000;
  const byMed = new Map<string, { days: Set<string>; doses: number }>();
  for (const m of meds) {
    if (!PAINKILLER_MED_IDS.includes(m.medId as (typeof PAINKILLER_MED_IDS)[number])) continue;
    const t = Date.parse(m.ts);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const entry = byMed.get(m.medId) ?? { days: new Set<string>(), doses: 0 };
    entry.days.add(localDayKey(t, timeZone));
    entry.doses += 1;
    byMed.set(m.medId, entry);
  }
  return PAINKILLER_MED_IDS
    .filter((medId) => byMed.has(medId))
    .map((medId) => ({
      medId,
      days: byMed.get(medId)!.days.size,
      doses: byMed.get(medId)!.doses,
    }));
}

/**
 * Whole configured-local-calendar-day difference between `now` and the most
 * recent dose of a med (null if never, or if no dose has a parseable stamp). This is calendar-day arithmetic, not
 * floor(elapsed / 24h): a dose 46 hours ago across a DST change can be two
 * calendar days ago, and a dose just before local midnight can already be
 * "yesterday" after a few minutes.
 */
export function daysSinceLast(
  meds: MedEvent[],
  medId: string,
  now: number,
  timeZone?: string,
): number | null {
  // Legacy/imported rows may carry an unparseable ts (server validation only
  // requires a string). Ignore those rather than letting an invalid Date throw
  // inside Intl; a med with no usable dose is treated as never logged.
  const times = meds
    .filter((m) => m.medId === medId)
    .map((m) => new Date(m.ts).getTime())
    .filter(Number.isFinite);
  if (!times.length) return null;
  const latest = Math.max(...times);
  return diffDayKeys(localDayKey(now, timeZone), localDayKey(latest, timeZone));
}
