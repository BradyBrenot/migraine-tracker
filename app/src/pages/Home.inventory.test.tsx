// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { Attack, DayState, StockBaseline, TrackerState, Workout } from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

// The store calls every backend method (some unconditionally chain `.catch`),
// so each one must be a mock that returns a promise.
vi.mock('@/lib/api', () => ({
  api: {
    exportAll: vi.fn(),
    importAll: vi.fn(),
    resetAll: vi.fn(),
    addAttack: vi.fn(),
    patchAttack: vi.fn(),
    deleteAttack: vi.fn(),
    addMed: vi.fn(),
    patchMed: vi.fn(),
    deleteMed: vi.fn(),
    addRefill: vi.fn(),
    patchRefill: vi.fn(),
    deleteRefill: vi.fn(),
    addStockBaseline: vi.fn(),
    patchStockBaseline: vi.fn(),
    deleteStockBaseline: vi.fn(),
    addWorkout: vi.fn(),
    patchWorkout: vi.fn(),
    deleteWorkout: vi.fn(),
    listWorkouts: vi.fn(),
    listDayStates: vi.fn(),
    putDayState: vi.fn(),
    putSetting: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

type StoreModule = typeof import('@/lib/store');
type HomeModule = typeof import('@/pages/Home');

interface MockedBackend {
  exportAll: Mock;
  importAll: Mock;
  resetAll: Mock;
  addAttack: Mock;
  patchAttack: Mock;
  deleteAttack: Mock;
  addMed: Mock;
  patchMed: Mock;
  deleteMed: Mock;
  addRefill: Mock;
  patchRefill: Mock;
  deleteRefill: Mock;
  addStockBaseline: Mock;
  patchStockBaseline: Mock;
  deleteStockBaseline: Mock;
  addWorkout: Mock;
  patchWorkout: Mock;
  deleteWorkout: Mock;
  listWorkouts: Mock;
  listDayStates: Mock;
  putDayState: Mock;
  putSetting: Mock;
}

const STORAGE_KEY = 'migraine-tracker-v1';
const DAY_MS = 24 * 60 * 60 * 1000;

let api: MockedBackend;
let storeModule: StoreModule;
let homeModule: HomeModule;
let captured: StoreApi | null = null;

function Probe() {
  captured = storeModule.useStore();
  return null;
}

function mountHome(): void {
  const Home = homeModule.default;
  render(
    <storeModule.StoreProvider>
      <Home />
      <Probe />
    </storeModule.StoreProvider>,
  );
}

async function waitForSync(): Promise<void> {
  await waitFor(() => {
    expect(captured).not.toBeNull();
    expect(captured!.sync.status).toBe('synced');
  });
}

function seedState(partial: Partial<TrackerState>): void {
  const state: TrackerState = {
    attacks: [],
    meds: [],
    refills: [],
    workouts: [],
    dayStates: [],
    stockBaselines: [],
    rules: {},
    doses: {},
    planned: {},
    timezone: 'UTC',
    lowStockThreshold: 2,
    reminders: DEFAULT_REMINDER_SETTINGS,
    lowStockAlertedAt: null,
    seeded: false,
    ...partial,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function makeBaseline(now: number, quantity: number, daysAgo = 10): StockBaseline {
  const at = new Date(now - daysAgo * DAY_MS).toISOString();
  return {
    id: 'seed-baseline',
    medId: 'nurtec',
    effectiveAt: at,
    quantity,
    notes: '',
    source: 'manual',
    createdAt: at,
  };
}

function applyApiDefaults(backend: MockedBackend): void {
  backend.exportAll.mockResolvedValue({
    attacks: [] as Attack[],
    meds: [] as TrackerState['meds'],
    refills: [] as TrackerState['refills'],
    workouts: [] as Workout[],
    dayStates: [] as DayState[],
    stockBaselines: [] as StockBaseline[],
    settings: {} as Record<string, unknown>,
  });
  backend.importAll.mockResolvedValue(undefined);
  backend.resetAll.mockResolvedValue(undefined);
  backend.addAttack.mockResolvedValue(undefined);
  backend.patchAttack.mockResolvedValue(undefined);
  backend.deleteAttack.mockResolvedValue(undefined);
  backend.addMed.mockResolvedValue(undefined);
  backend.patchMed.mockResolvedValue(undefined);
  backend.deleteMed.mockResolvedValue(undefined);
  backend.addRefill.mockResolvedValue(undefined);
  backend.patchRefill.mockResolvedValue(undefined);
  backend.deleteRefill.mockResolvedValue(undefined);
  backend.addStockBaseline.mockResolvedValue(undefined);
  backend.patchStockBaseline.mockResolvedValue(undefined);
  backend.deleteStockBaseline.mockResolvedValue(undefined);
  backend.addWorkout.mockResolvedValue(undefined);
  backend.patchWorkout.mockResolvedValue(undefined);
  backend.deleteWorkout.mockResolvedValue(undefined);
  backend.listWorkouts.mockResolvedValue([]);
  backend.listDayStates.mockResolvedValue([]);
  backend.putDayState.mockResolvedValue(undefined);
  backend.putSetting.mockResolvedValue(undefined);
}

function nurtecQuickButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Nurtec/ }) as HTMLButtonElement;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  homeModule = await import('@/pages/Home');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('Home Nurtec inventory display', () => {
  it('shows "stock not set" when no baseline applies (never zero)', async () => {
    mountHome();
    await waitForSync();

    expect(screen.getByText('stock not set')).toBeTruthy();
    expect(screen.queryByText('0 left')).toBeNull();
  });

  it('shows the remaining count after known doses since the baseline', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      lowStockThreshold: 2,
      stockBaselines: [makeBaseline(now, 10)],
      meds: [
        {
          id: 'seed-dose',
          medId: 'nurtec',
          dose: '75 mg',
          quantity: 3,
          ts: new Date(now - 2 * DAY_MS).toISOString(),
          attackId: null,
          notes: '',
          source: 'manual',
        },
      ],
    });

    mountHome();
    await waitForSync();

    expect(screen.getByText('7 left')).toBeTruthy();
  });

  it('styles a low count with the amber warning badge', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      lowStockThreshold: 2,
      stockBaselines: [makeBaseline(now, 5)],
      meds: [
        {
          id: 'seed-dose',
          medId: 'nurtec',
          quantity: 3,
          ts: new Date(now - 2 * DAY_MS).toISOString(),
          attackId: null,
          notes: '',
          source: 'manual',
        },
      ],
    });

    mountHome();
    await waitForSync();

    const badge = screen.getByText('2 left');
    expect(badge.className).toContain('text-amber-300');
  });

  it('shows a negative count as a rose reconciliation warning', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      lowStockThreshold: 2,
      stockBaselines: [makeBaseline(now, 1)],
      meds: [
        {
          id: 'seed-dose',
          medId: 'nurtec',
          quantity: 4,
          ts: new Date(now - 2 * DAY_MS).toISOString(),
          attackId: null,
          notes: '',
          source: 'manual',
        },
      ],
    });

    mountHome();
    await waitForSync();

    const badge = screen.getByText('−3 stock');
    expect(badge.className).toContain('text-rose-300');
    expect(badge.getAttribute('title')).toContain('negative');
  });

  it('logs a quick Nurtec dose with quantity 1 and leaves other meds unchanged', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      lowStockThreshold: 2,
      stockBaselines: [makeBaseline(now, 10)],
    });

    mountHome();
    await waitForSync();

    fireEvent.click(nurtecQuickButton());

    await waitFor(() => expect(api.addMed).toHaveBeenCalledTimes(1));
    expect(api.addMed).toHaveBeenCalledWith(
      expect.objectContaining({ medId: 'nurtec', quantity: 1 }),
    );
    // The optimistic store record carries the tablet count too (undo works on it).
    const logged = captured!.state.meds.find((m) => m.medId === 'nurtec');
    expect(logged?.quantity).toBe(1);
  });

  it('decrements the stock badge immediately after a quick dose, without waiting for the 15s clock tick', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      lowStockThreshold: 2,
      stockBaselines: [makeBaseline(now, 10)],
    });

    mountHome();
    await waitForSync();
    expect(screen.getByText('10 left')).toBeTruthy();

    // Let the dose instant land strictly AFTER the coarse "now" the badge was
    // rendered with: the stale-tick behavior ignored such a dose until the
    // next 15s tick and kept showing "10 left".
    await new Promise((resolve) => setTimeout(resolve, 25));

    fireEvent.click(nurtecQuickButton());

    // fireEvent flushes the optimistic update synchronously (act): the badge
    // text must already reflect the dose — no tick, no async wait.
    expect(screen.getByText('9 left')).toBeTruthy();
    expect(screen.queryByText('10 left')).toBeNull();
  });

  it('counts Nurtec use days in the configured zone, not the UTC day', async () => {
    // The clock module captures Date.now() at import time, so fake the Date
    // and re-import store/Home before mounting.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z').getTime());
      vi.resetModules();
      captured = null;
      localStorage.clear();
      seedState({
        timezone: 'Pacific/Kiritimati', // UTC+14 year-round
        lowStockThreshold: 2,
        meds: [
          {
            id: 'kiritimati-am',
            medId: 'nurtec',
            ts: '2026-05-31T00:30:00.000Z', // May 31 14:30 local
            attackId: null,
            notes: '',
            source: 'manual',
          },
          {
            id: 'kiritimati-pm',
            medId: 'nurtec',
            ts: '2026-05-31T12:30:00.000Z', // Jun 1 02:30 local
            attackId: null,
            notes: '',
            source: 'manual',
          },
        ],
      });
      api = (await import('@/lib/api')).api as unknown as MockedBackend;
      applyApiDefaults(api);
      homeModule = await import('@/pages/Home');
      storeModule = await import('@/lib/store');

      mountHome();
      await waitForSync();

      // Both instants share the UTC day 2026-05-31; in the configured zone
      // they fall on two adjacent local days, so the badge reads 2/15.
      expect(screen.getByText('2/15')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
