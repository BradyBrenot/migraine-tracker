// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type {
  Attack, DayState, MedEvent, Refill, StockBaseline, TrackerState, Workout,
} from '@/types';
import { fmtDateFull, fmtTime } from '@/lib/format';
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

function activateTab(name: RegExp): void {
  const tab = screen.getByRole('tab', { name });
  // Radix tabs activate on mousedown, not click.
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
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

function makeAttack(partial: Partial<Attack> & { id: string; start: string }): Attack {
  return {
    end: null,
    painLog: [],
    peakPain: 5,
    symptoms: [],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
    ...partial,
  };
}

function makeMed(partial: Partial<MedEvent> & { id: string; ts: string }): MedEvent {
  return {
    medId: 'nurtec',
    dose: '',
    quantity: null,
    attackId: null,
    notes: '',
    source: 'manual',
    ...partial,
  };
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

describe('History attack-linked medication grouping', () => {
  it('attributes meds per attack newest-first and ignores unlinked or non-string links', async () => {
    seedState({
      attacks: [
        makeAttack({ id: 'a', start: '2026-05-10T08:00:00.000Z', end: '2026-05-10T10:00:00.000Z' }),
        makeAttack({ id: 'b', start: '2026-05-12T08:00:00.000Z', end: '2026-05-12T10:00:00.000Z' }),
      ],
      meds: [
        // Newest overall, linked to the newer attack.
        makeMed({ id: 'b-med', medId: 'ibuprofen', ts: '2026-05-11T12:00:00.000Z', attackId: 'b' }),
        // Older attack: newest dose first inside its row.
        makeMed({ id: 'a-new', medId: 'tylenol', ts: '2026-05-10T12:00:00.000Z', attackId: 'a' }),
        makeMed({ id: 'a-old', medId: 'nurtec', ts: '2026-05-10T08:00:00.000Z', attackId: 'a' }),
        // Unlinked and legacy non-string links match no attack id.
        makeMed({ id: 'unlinked', medId: 'naproxen', ts: '2026-05-13T12:00:00.000Z', attackId: null }),
        {
          ...makeMed({ id: 'garbage-link', medId: 'naproxen', ts: '2026-05-14T12:00:00.000Z' }),
          attackId: 42 as unknown as string,
        },
      ],
    });

    mountHistory();
    await waitForSync();

    expect(screen.getByRole('heading', { level: 1, name: 'History' })).toBeTruthy();
    // Both attack rows render (the writer tree exposes edit controls).
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Edit\b/i })).toHaveLength(2));

    // Representative full names: the context is included, not just "Edit".
    const attackStart = '2026-05-10T08:00:00.000Z';
    const attackName = `${fmtDateFull(attackStart)} at ${fmtTime(attackStart)}`;
    expect(screen.getByRole('button', { name: `Edit attack ${attackName}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Delete attack ${attackName}` })).toBeTruthy();

    // Rows are newest-first; each row's chips keep the newest-first meds order.
    const chipNames = screen
      .getAllByText(/^(Tylenol|Nurtec|Ibuprofen)$/)
      .map((element) => element.textContent);
    expect(chipNames).toEqual(['Ibuprofen', 'Tylenol', 'Nurtec']);
    // The unlinked and legacy non-string links never attach to a row.
    expect(screen.queryByText('Naproxen')).toBeNull();

    activateTab(/Meds/);
    const medTs = '2026-05-10T12:00:00.000Z';
    const medLabel = `Tylenol ${fmtDateFull(medTs)} at ${fmtTime(medTs)}`;
    expect(await screen.findByRole('button', { name: `Edit ${medLabel}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Delete ${medLabel}` })).toBeTruthy();
  });
});

describe('History attack rows with inconsistent durations', () => {
  it('warns only on an end-before-start attack, hides its negative duration, and keeps it editable', async () => {
    seedState({
      attacks: [
        makeAttack({
          id: 'normal',
          start: '2026-05-10T08:00:00.000Z',
          end: '2026-05-10T10:00:00.000Z',
        }),
        makeAttack({
          id: 'inverted',
          start: '2026-05-12T10:00:00.000Z',
          end: '2026-05-12T09:00:00.000Z',
        }),
      ],
    });

    mountHistory();
    await waitForSync();

    // Exactly one visible warning, on the inverted attack.
    await waitFor(() => expect(screen.getAllByText('End is before start')).toHaveLength(1));

    // The bad row shows an em dash instead of a negative duration...
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText(/^-\d/)).toBeNull();
    // ...while the normal row keeps its real elapsed time.
    expect(screen.getByText('2h')).toBeTruthy();

    // Both entries remain editable and deletable — no validation gate.
    expect(screen.getAllByRole('button', { name: /^Edit\b/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^Delete\b/i })).toHaveLength(2);
  });

  it('never warns "End is before start" on an ongoing attack with a future start', async () => {
    seedState({
      attacks: [makeAttack({
        id: 'future-ongoing',
        start: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        end: null,
      })],
    });

    mountHistory();
    await waitForSync();

    await waitFor(() => expect(screen.getByText('ONGOING')).toBeTruthy());
    expect(screen.queryByText('End is before start')).toBeNull();
    // Future start means no elapsed-so-far, not a negative duration.
    expect(screen.getByText('—')).toBeTruthy();
  });
});
