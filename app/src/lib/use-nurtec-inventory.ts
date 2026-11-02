import { useMemo } from 'react';
import {
  nurtecInventoryFrom, type NurtecInventory, type NurtecInventoryState,
} from './inventory.ts';

/**
 * Per-tick Nurtec stock without re-filtering the whole medication history.
 * The Nurtec-only parts are memoized by data identity; the stock arithmetic
 * then runs only over those events (and the shared instant caches make
 * repeated parses free). Output is identical to `nurtecInventory(state, now)`.
 */
export function useNurtecInventory(
  state: NurtecInventoryState,
  now: number,
): NurtecInventory {
  const parts = useMemo(() => ({
    stockBaselines: state.stockBaselines.filter((b) => b.medId === 'nurtec'),
    meds: state.meds.filter((m) => m.medId === 'nurtec'),
    refills: state.refills.filter((r) => r.medId === 'nurtec'),
    timezone: state.timezone,
    lowStockThreshold: state.lowStockThreshold,
  }), [
    state.stockBaselines, state.meds, state.refills,
    state.timezone, state.lowStockThreshold,
  ]);

  return useMemo(() => nurtecInventoryFrom(parts, now), [parts, now]);
}
