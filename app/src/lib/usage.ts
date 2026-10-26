import type { MedEvent } from '@/types';
import { diffDayKeys, localDayKey } from '../../shared/datetime.ts';

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
  const cutoff = now - windowDays * 86400000;
  const days = new Set<string>();
  for (const m of meds) {
    if (m.medId !== medId) continue;
    const t = new Date(m.ts).getTime();
    if (t >= cutoff) days.add(localDayKey(t, timeZone));
  }
  return days.size;
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
