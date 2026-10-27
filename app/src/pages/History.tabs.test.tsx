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

    const pickups = screen.getByText('Pickups');
    expect(pickups).toBeTruthy();
    expect(screen.queryByText('Rx')).toBeNull();

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

    activateTab(/Pickups/);
    expect(await screen.findByText('Add pickup')).toBeTruthy();

    activateTab(/Meds/);
    expect(await screen.findByText('Add past medication')).toBeTruthy();
  });

  it('filters the active tab without changing the counts', async () => {
    const today = new Date().toISOString();
    seedState({
      attacks: [
        {
          id: 'a-note', start: today, end: today, painLog: [], peakPain: 4,
          symptoms: [], triggers: [], aura: null, notes: 'after lunch', source: 'manual',
        },
        {
          id: 'a-other', start: today, end: today, painLog: [], peakPain: 7,
          symptoms: ['Nausea'], triggers: [], aura: null, notes: '', source: 'manual',
        },
      ],
    });
    mountHistory();
    await waitForSync();

    // Counts describe the full record set.
    expect(screen.getByText('(2)')).toBeTruthy();

    const filter = screen.getByLabelText('Filter attacks') as HTMLInputElement;
    fireEvent.change(filter, { target: { value: 'nausea' } });

    expect(screen.queryByText('after lunch')).toBeNull();
    expect(screen.getByText('(2)')).toBeTruthy();

    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(screen.getByText('No attacks match “zzz”.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect((screen.getByLabelText('Filter attacks') as HTMLInputElement).value).toBe('');
    expect(screen.getAllByText('after lunch')).toHaveLength(1);
  });
});

describe('History tab filter scope', () => {
  it('clears the filter when switching tabs so it cannot invisibly filter the next tab', async () => {
    seedState({
      meds: [{
        id: 'med-1',
        medId: 'tylenol',
        ts: new Date().toISOString(),
        dose: '500 mg',
        quantity: null,
        attackId: null,
        notes: '',
        source: 'manual',
      }],
      attacks: [{
        id: 'attack-1',
        start: new Date().toISOString(),
        end: new Date().toISOString(),
        painLog: [],
        peakPain: 4,
        symptoms: [],
        triggers: [],
        aura: null,
        notes: 'after lunch',
        source: 'manual',
      }],
    });
    mountHistory();
    await waitForSync();

    const attackFilter = screen.getByLabelText('Filter attacks') as HTMLInputElement;
    fireEvent.change(attackFilter, { target: { value: 'zzz' } });
    expect(screen.getByText('No attacks match “zzz”.')).toBeTruthy();

    activateTab(/Meds/);

    // The next tab starts unfiltered, so its records are visible.
    const medFilter = screen.getByLabelText('Filter medications') as HTMLInputElement;
    expect(medFilter.value).toBe('');
    expect(await screen.findByText('Tylenol')).toBeTruthy();
    expect(screen.queryByText(/No medications match/)).toBeNull();

    // And returning to attacks is unfiltered too.
    activateTab(/Attacks/);
    expect((screen.getByLabelText('Filter attacks') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('after lunch')).toBeTruthy();
  });
});
