// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type {
  Attack, DayState, Refill, StockBaseline, TrackerState, Workout,
} from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

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
type HistoryModule = typeof import('@/pages/History');

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

let api: MockedBackend;
let storeModule: StoreModule;
let historyModule: HistoryModule;
let captured: StoreApi | null = null;

function Probe() {
  captured = storeModule.useStore();
  return null;
}

function mountHistory(): void {
  const History = historyModule.default;
  render(
    <storeModule.StoreProvider>
      <History />
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
    weather: { enabled: false, location: null, pressureDropThresholdHpa: 5 },
    lowStockAlertedAt: null,
    seeded: false,
    ...partial,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function applyApiDefaults(backend: MockedBackend): void {
  backend.exportAll.mockResolvedValue({
    attacks: [] as Attack[],
    meds: [] as TrackerState['meds'],
    refills: [] as Refill[],
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

function activateTab(name: RegExp): void {
  const tab = screen.getByRole('tab', { name });
  // Radix tabs activate on mousedown, not click.
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  historyModule = await import('@/pages/History');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('History tab bar', () => {
  it('keeps four equal tabs with counts and responsive compact/full labels', async () => {
    mountHistory();
    await waitForSync();

    const tablist = screen.getByRole('tablist');
    expect(tablist.className).toContain('grid-cols-4');
    // h-14 holds the stacked label/count rows at phone widths (still a 44px+
    // tap target); the shorter h-9 returns at sm+ where they sit inline.
    expect(tablist.className).toContain('h-14');
    expect(tablist.className).toContain('sm:h-9');

    // All four tabs remain, each with its record count.
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(screen.getAllByText('(0)')).toHaveLength(4);

    // Narrow screens get concise labels; the full wording stays in the markup
    // for sm+ (jsdom applies no CSS, so both spans render in tests and the
    // responsive classes are asserted directly).
    const meds = screen.getByText('Meds');
    expect(meds.className).toContain('sm:hidden');
    const medications = screen.getByText('Medications');
    expect(medications.className).toContain('hidden');
    expect(medications.className).toContain('sm:inline');

    const rx = screen.getByText('Rx');
    expect(rx.className).toContain('sm:hidden');
    const rxPickups = screen.getByText('Rx pickups');
    expect(rxPickups.className).toContain('hidden');
    expect(rxPickups.className).toContain('sm:inline');

    // Attacks and Workouts are short enough to serve at every width.
    expect(screen.getByText('Attacks')).toBeTruthy();
    expect(screen.getByText('Workouts')).toBeTruthy();
  });

  it('still navigates between tabs with the compact labels in place', async () => {
    seedState({ refills: [], workouts: [] });
    mountHistory();
    await waitForSync();

    activateTab(/Workouts/);
    expect(await screen.findByText('Add past workout')).toBeTruthy();

    activateTab(/Rx pickups/);
    expect(await screen.findByText('Add Rx pickup')).toBeTruthy();

    activateTab(/Meds/);
    expect(await screen.findByText('Add past medication')).toBeTruthy();
  });
});
