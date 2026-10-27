import type {
  DayState, Refill, StockBaseline, TrackerState, Workout,
} from '@/types';
import { uid } from '@/lib/format';
import { buildSeedData } from '@/lib/seed';
import { localDayKey, systemTimeZone } from '../../shared/datetime.ts';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../../shared/inventory.ts';

/**
 * True only for the static GitHub Pages demo build (`vite build --mode demo`).
 *
 * The demo is a frontend-only, in-memory sample so the ordinary build and the
 * Docker/production behaviour stay byte-for-byte compatible. Runtime demo
 * behavior is injected through the `StoreProvider` `demo` prop (see store.tsx);
 * this constant only selects it in the deployed entry point, so tests can
 * exercise both modes explicitly.
 */
export const IS_DEMO = import.meta.env.MODE === 'demo';

/**
 * Extra synthetic records layered over the store's normal defaults for the
 * demo. `buildSeedData()` already supplies the attacks/meds that make Calendar
 * and Reports meaningful; the modest additions here (workouts, day check-ins,
 * one refill, a starting count, a planned preventive dose) exercise the other
 * pages without inventing a second data model.
 *
 * Every value is clearly fictional sample data. Timestamps are relative to the
 * current instant so the demo always looks recent; a reload re-derives the
 * whole set from the same deterministic seed.
 */
export function buildDemoData(): Pick<
  TrackerState,
  | 'attacks' | 'meds' | 'refills' | 'workouts' | 'dayStates' | 'stockBaselines'
  | 'planned' | 'timezone' | 'lowStockThreshold'
> {
  const now = Date.now();
  const timezone = systemTimeZone();
  const day = (daysAgo: number): string => localDayKey(now - daysAgo * 86_400_000, timezone);
  const iso = (daysAgo: number, hours = 12): string => {
    const date = new Date(now - daysAgo * 86_400_000);
    date.setHours(hours, 0, 0, 0);
    return date.toISOString();
  };

  const seed = buildSeedData();
  // Seed doses carry no tablet count. The demo gives them a known quantity so
  // the inventory section shows a real, healthy count instead of "unknown".
  const meds = seed.meds.map((med) => ({ ...med, quantity: med.quantity ?? 1 }));

  const refills: Refill[] = [{
    id: uid(),
    medId: 'nurtec',
    date: day(12),
    quantity: 8,
    notes: 'Pharmacy pickup (sample)',
    source: 'manual',
  }];

  const stockBaselines: StockBaseline[] = [{
    id: uid(),
    medId: 'nurtec',
    effectiveAt: iso(30, 9),
    quantity: 14,
    notes: 'Demo starting count (sample)',
    source: 'manual',
    createdAt: iso(30, 9),
  }];

  const workouts: Workout[] = [
    {
      id: uid(),
      performedAt: iso(1, 18),
      kind: 'strength',
      effort: 'medium',
      durationMinutes: 40,
      notes: 'Sample upper-body session',
      source: 'manual',
    },
    {
      id: uid(),
      performedAt: iso(3, 7),
      kind: 'mobility',
      effort: 'low',
      durationMinutes: 20,
      notes: 'Sample gentle stretching',
      source: 'manual',
    },
    {
      id: uid(),
      performedAt: iso(6, 17),
      kind: 'cardio',
      effort: 'hard',
      durationMinutes: 32,
      notes: 'Sample easy-pace run',
      source: 'manual',
    },
  ];

  const dayStates: DayState[] = [
    { day: day(1), status: 'well', notes: 'Sample check-in', updatedAt: iso(1, 21) },
    { day: day(2), status: 'off', notes: 'Recovery day (sample)', updatedAt: iso(2, 20) },
    { day: day(3), status: 'well', notes: '', updatedAt: iso(3, 9) },
    { day: day(5), status: 'well', notes: 'Sample calm day', updatedAt: iso(5, 8) },
    { day: day(8), status: 'off', notes: 'Rough morning (sample)', updatedAt: iso(8, 19) },
  ];

  const planned = { botox: day(-30) };

  return {
    attacks: seed.attacks,
    meds,
    refills,
    workouts,
    dayStates,
    stockBaselines,
    planned,
    // Keep the ordinary defaults readable next to the synthetic records: the
    // demo uses the browser's zone and the standard low-stock threshold (the
    // seeded count is well above it, so no alert fires).
    timezone,
    lowStockThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
  };
}

/** Complete initial TrackerState for the demo (defaults + synthetic records). */
export function buildDemoState(defaults: TrackerState): TrackerState {
  return { ...defaults, ...buildDemoData(), seeded: true };
}
