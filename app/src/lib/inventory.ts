import { classifyStock, currentStock } from '../../shared/inventory.ts';
import type { StockLevel } from '../../shared/inventory.ts';
import type { TrackerState } from '@/types';

export interface NurtecInventory {
  status: 'unknown' | 'known';
  /** Tablets on hand; null when no applicable baseline exists. May be negative. */
  quantity: number | null;
  level: StockLevel;
}

/**
 * Parse a tablet-count form field. Blank means "unknown" (null); anything
 * non-blank must be a nonnegative whole number. Legacy free text is never
 * interpreted, and invalid input is never silently coerced to null.
 */
export function parseTabletQuantity(raw: string): { valid: boolean; quantity: number | null } {
  const trimmed = raw.trim();
  if (trimmed === '') return { valid: true, quantity: null };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return { valid: false, quantity: null };
  return { valid: true, quantity: value };
}

export type NurtecInventoryState = Pick<
  TrackerState,
  'stockBaselines' | 'meds' | 'refills' | 'timezone' | 'lowStockThreshold'
>;

/**
 * Build the display inventory from parts ALREADY filtered to `nurtec`.
 * Callers that render on a clock tick can memoize the filtering by data
 * identity and only re-run the (Nurtec-sized) stock arithmetic per tick.
 */
export function nurtecInventoryFrom(
  state: NurtecInventoryState,
  now: number,
): NurtecInventory {
  const stock = currentStock(
    {
      baselines: state.stockBaselines,
      doses: state.meds,
      refills: state.refills,
    },
    { now, timeZone: state.timezone },
  );
  return {
    status: stock.status,
    quantity: stock.quantity,
    level: classifyStock(stock.quantity, state.lowStockThreshold),
  };
}

/**
 * Optimistic Nurtec stock for display. Mirrors the server's scoping in
 * `GET /api/inventory/nurtec` (inventory is Nurtec-only today) and reuses the
 * same shared calculation, so the UI never invents a second interpretation.
 * The server count stays authoritative; this is only a local preview.
 */
export function nurtecInventory(
  state: NurtecInventoryState,
  now: number,
): NurtecInventory {
  return nurtecInventoryFrom({
    stockBaselines: state.stockBaselines.filter((b) => b.medId === 'nurtec'),
    meds: state.meds.filter((m) => m.medId === 'nurtec'),
    refills: state.refills.filter((r) => r.medId === 'nurtec'),
    timezone: state.timezone,
    lowStockThreshold: state.lowStockThreshold,
  }, now);
}
