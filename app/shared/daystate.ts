/**
 * Day-state precedence helpers.
 *
 * Product rule: an attack day MAY default to 'attack' from existing attack
 * records, but an explicit user choice must never be overwritten by them.
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
 * - otherwise 'attack' when an attack overlaps the day;
 * - otherwise null (no status to show).
 */
export function effectiveDayState(
  record: { status: DayStateStatus } | null | undefined,
  hasAttackThatDay: boolean,
): DayStateStatus | null {
  if (record) return record.status;
  return hasAttackThatDay ? 'attack' : null;
}
