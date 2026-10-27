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

function makeRefill(overrides: Partial<Refill> = {}): Refill {
  return {
    id: 'refill-1',
    medId: 'nurtec',
    date: '2026-03-01',
    quantity: 8,
    notes: 'pharmacy',
    source: 'manual',
    ...overrides,
  };
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

function openRefillsTab(): void {
  const tab = screen.getByRole('tab', { name: /Rx pickups/ });
  // Radix tabs activate on mousedown, not click.
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

function tabletsInput(): HTMLInputElement {
  return screen.getByLabelText('Tablets') as HTMLInputElement;
}

function dateInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="date"]');
  if (!input) throw new Error('pickup date input not found');
  return input;
}

function notesInput(): HTMLInputElement {
  return screen.getByPlaceholderText('e.g. CVS') as HTMLInputElement;
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

describe('History Rx pickups tablets', () => {
  it('defaults a new Nurtec pickup to 8 tablets and switches defaults with the med', async () => {
    mountHistory();
    await waitForSync();
    openRefillsTab();

    fireEvent.click(screen.getByRole('button', { name: /Add Rx pickup/ }));
    expect(tabletsInput().value).toBe('8');

    fireEvent.click(screen.getByRole('button', { name: 'Tylenol' }));
    expect(tabletsInput().value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Nurtec' }));
    expect(tabletsInput().value).toBe('8');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(api.addRefill).toHaveBeenCalledTimes(1));
    expect(api.addRefill).toHaveBeenCalledWith(
      expect.objectContaining({ medId: 'nurtec', quantity: 8 }),
    );
  });

  it('defaults a new pickup to the configured local day, not the UTC day, near local midnight', async () => {
    // 'Pacific/Kiritimati' is UTC+14 year-round, so the local day leads the
    // UTC day around midnight there.
    seedState({ timezone: 'Pacific/Kiritimati' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 2026-05-31T10:30:00Z == 2026-06-01T00:30 local — just past local
      // midnight, while the UTC day (the old toISOString default) is still
      // '2026-05-31'.
      vi.setSystemTime(new Date('2026-05-31T10:30:00.000Z').getTime());
      mountHistory();
      await waitForSync();
      openRefillsTab();

      fireEvent.click(screen.getByRole('button', { name: /Add Rx pickup/ }));

      // The pickup must land on the configured LOCAL day so stock/refill
      // math counts it on the right day.
      expect(dateInput().value).toBe('2026-06-01');
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits a pickup with prefilled values and calls updateRefill', async () => {
    seedState({ refills: [makeRefill()] });
    mountHistory();
    await waitForSync();
    openRefillsTab();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(tabletsInput().value).toBe('8');
    expect(dateInput().value).toBe('2026-03-01');
    expect(notesInput().value).toBe('pharmacy');

    fireEvent.change(tabletsInput(), { target: { value: '4' } });
    fireEvent.change(notesInput(), { target: { value: 'CVS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.patchRefill).toHaveBeenCalledTimes(1));
    // Narrow PATCH: the unchanged date (and the id) are not resent.
    expect(api.patchRefill).toHaveBeenCalledWith('refill-1', {
      notes: 'CVS',
      quantity: 4,
    });
  });

  it('shows the structured quantity only when it is known', async () => {
    seedState({
      refills: [
        makeRefill(),
        makeRefill({ id: 'refill-legacy', date: '2026-02-01', quantity: null, notes: '8 tablets' }),
      ],
    });
    mountHistory();
    await waitForSync();
    openRefillsTab();

    expect(screen.getByText('8 tabs')).toBeTruthy();
    // The legacy note mentions 8 tablets, but it must never become a quantity.
    expect(screen.getAllByText(/^\d+ tabs$/)).toHaveLength(1);
  });

  it('leaves a legacy pickup quantity blank in edit mode', async () => {
    seedState({ refills: [makeRefill({ quantity: null })] });
    mountHistory();
    await waitForSync();
    openRefillsTab();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(tabletsInput().value).toBe('');
  });
});

describe('History refill cadence gaps', () => {
  it('counts one calendar day across the spring-forward weekend', async () => {
    // America/New_York springs forward on 2026-03-08: the local day is 23h,
    // but pickup cadence is calendar-day math and must still read +1d.
    seedState({
      timezone: 'America/New_York',
      refills: [
        makeRefill({ id: 'refill-old', date: '2026-03-08' }),
        makeRefill({ id: 'refill-new', date: '2026-03-09' }),
      ],
    });
    mountHistory();
    await waitForSync();
    openRefillsTab();

    expect(screen.getByText('+1d since last')).toBeTruthy();
  });

  it('shows a multi-day gap in whole calendar days', async () => {
    seedState({
      refills: [
        makeRefill({ id: 'refill-jan-1', date: '2026-01-01' }),
        makeRefill({ id: 'refill-jan-15', date: '2026-01-15' }),
      ],
    });
    mountHistory();
    await waitForSync();
    openRefillsTab();

    expect(screen.getByText('+14d since last')).toBeTruthy();
  });

  it('skips a malformed legacy date without crashing or skewing the next gap', async () => {
    // '2026-01-0X' sorts between the two valid dates but is not a real day
    // key. It must not throw, must not render a bogus gap, and must not become
    // the baseline for the Jan 15 pickup.
    seedState({
      refills: [
        makeRefill({ id: 'refill-jan-1', date: '2026-01-01' }),
        makeRefill({ id: 'refill-bad', date: '2026-01-0X' }),
        makeRefill({ id: 'refill-jan-15', date: '2026-01-15' }),
      ],
    });
    mountHistory();
    await waitForSync();
    openRefillsTab();

    expect(screen.getByText('+14d since last')).toBeTruthy();
    // Only the valid newer pickup gets a gap; the malformed row adds none.
    expect(screen.getAllByText(/\+\d+d since last/)).toHaveLength(1);
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
  });
});
