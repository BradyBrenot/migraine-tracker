/**
 * Day-state precedence helpers.
 *
 * Product rule: an attack day is an OFF day. The explicit day check-in still
 * wins (a Well/Off chosen after an attack must persist), but when no record
 * exists a day overlapped by an attack infers 'off', never 'attack'. Active
 * attacks are shown as Attack by the screens that know about them; the stored
 * day state remains Off.
 *
 * 'attack' stays readable as an explicit legacy status: old records and
 * imported data may carry it, and an explicit record always wins.
 *
 * This module MUST stay erasable-syntax only (no enums, namespaces, parameter
 * properties, or other code-emitting TypeScript constructs) and
 * double-environment safe: it is bundled by Vite for the browser and also
 * consumed directly by Node 24 via native type-stripping. Relative imports
 * need explicit `.ts` extensions, and only APIs present in BOTH environments
 * (Date, Math, Intl, Map) may be used — no DOM APIs.
 */

import type { DayStateStatus } from '../src/types/index.ts';

/**
 * Effective status for one local day:
 * - an explicit record always wins (never overwritten by attacks);
 * - otherwise 'off' when an attack overlaps the day (attack days are days off);
 * - otherwise null (no status to show).
 */
export function effectiveDayState(
  record: { status: DayStateStatus } | null | undefined,
  hasAttackThatDay: boolean,
): DayStateStatus | null {
  if (record) return record.status;
  return hasAttackThatDay ? 'off' : null;
}
