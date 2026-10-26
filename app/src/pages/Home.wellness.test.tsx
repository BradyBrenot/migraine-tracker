// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { Attack, DayState, TrackerState, Workout } from '@/types';
import { localDayKey } from '../../shared/datetime.ts';
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
    deleteRefill: vi.fn(),
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
type SonnerModule = typeof import('sonner');

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
  deleteRefill: Mock;
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
let homeModule: HomeModule;
let sonner: SonnerModule;
let captured: StoreApi | null = null;

function captureStore(next: StoreApi): void {
  captured = next;
}

function Probe() {
  const storeApi = storeModule.useStore();
  captureStore(storeApi);
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

function readPersisted(): TrackerState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) throw new Error('state was not persisted to localStorage');
  return JSON.parse(raw) as TrackerState;
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

function makeAttack(now: number): Attack {
  return {
    id: 'seed-attack',
    start: new Date(now - 60 * 60 * 1000).toISOString(),
    end: null,
    painLog: [],
    peakPain: -1,
    symptoms: [],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
  };
}

function makeDayState(day: string): DayState {
  return {
    day,
    status: 'attack',
    notes: '',
    updatedAt: new Date().toISOString(),
  };
}

function emptyExport() {
  return {
    attacks: [] as Attack[],
    meds: [] as TrackerState['meds'],
    refills: [] as TrackerState['refills'],
    workouts: [] as Workout[],
    dayStates: [] as DayState[],
    settings: {} as Record<string, unknown>,
  };
}

function applyApiDefaults(backend: MockedBackend): void {
  backend.exportAll.mockResolvedValue(emptyExport());
  backend.importAll.mockResolvedValue(undefined);
  backend.resetAll.mockResolvedValue(undefined);
  backend.addAttack.mockResolvedValue(undefined);
  backend.patchAttack.mockResolvedValue(undefined);
  backend.deleteAttack.mockResolvedValue(undefined);
  backend.addMed.mockResolvedValue(undefined);
  backend.patchMed.mockResolvedValue(undefined);
  backend.deleteMed.mockResolvedValue(undefined);
  backend.addRefill.mockResolvedValue(undefined);
  backend.deleteRefill.mockResolvedValue(undefined);
  backend.addWorkout.mockResolvedValue(undefined);
  backend.patchWorkout.mockResolvedValue(undefined);
  backend.deleteWorkout.mockResolvedValue(undefined);
  backend.listWorkouts.mockResolvedValue([]);
  backend.listDayStates.mockResolvedValue([]);
  backend.putDayState.mockResolvedValue(undefined);
  backend.putSetting.mockResolvedValue(undefined);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  sonner = await import('sonner');
  homeModule = await import('@/pages/Home');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('Home wellness logging', () => {
  it('logs a strength workout with two taps and undoes it from the toast', async () => {
    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Strength' }));
    fireEvent.click(screen.getByRole('button', { name: 'Medium' }));

    await waitFor(() => expect(captured!.state.workouts).toHaveLength(1));
    const workout = captured!.state.workouts[0];
    expect(workout.kind).toBe('strength');
    expect(workout.effort).toBe('medium');
    expect(api.addWorkout).toHaveBeenCalledTimes(1);
    expect(api.addWorkout).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'strength', effort: 'medium' }),
    );

    await waitFor(() => expect(readPersisted().workouts).toHaveLength(1));

    const logCall = (sonner.toast.success as Mock).mock.calls.find(
      ([message]) => message === 'Strength logged',
    );
    expect(logCall).toBeTruthy();
    const action = logCall![1].action as { label: string; onClick: () => void };
    expect(action.label).toBe('Undo');

    act(() => {
      action.onClick();
    });

    await waitFor(() => expect(captured!.state.workouts).toHaveLength(0));
    expect(api.deleteWorkout).toHaveBeenCalledWith(workout.id);
  });

  it('logs a cardio workout with the tapped effort', async () => {
    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Cardio' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }));

    await waitFor(() => expect(captured!.state.workouts).toHaveLength(1));
    expect(captured!.state.workouts[0]).toMatchObject({ kind: 'cardio', effort: 'hard' });
    expect(api.addWorkout).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cardio', effort: 'hard' }),
    );
  });

  it('collapses the day check-in after a choice and persists the day state', async () => {
    mountHome();
    await waitForSync();

    expect(screen.getByRole('button', { name: 'Well' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attack' })).toBeTruthy();
    expect(screen.getByText('How was today?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Off' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Off' })).toBeNull());
    expect(screen.getByText('Today: Off')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();

    await waitFor(() => expect(readPersisted().dayStates).toHaveLength(1));
    const persisted = readPersisted();
    const todayKey = localDayKey(Date.now(), persisted.timezone);
    expect(persisted.dayStates[0]).toMatchObject({ day: todayKey, status: 'off' });
    expect(api.putDayState).toHaveBeenCalledWith(
      todayKey,
      expect.objectContaining({ status: 'off' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));

    await waitFor(() => {
      const next = readPersisted();
      expect(next.dayStates).toHaveLength(1);
      expect(next.dayStates[0].status).toBe('well');
    });
    expect(screen.getByText('Today: Well')).toBeTruthy();
  });

  it('adds an optional day note, keeps it through status changes, and clears it when blank', async () => {
    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(screen.getByText('Today: Off')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    fireEvent.change(screen.getByLabelText('Day note'), {
      target: { value: '  rough morning  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(readPersisted().dayStates[0]?.notes).toBe('rough morning'));
    const persisted = readPersisted();
    const todayKey = localDayKey(Date.now(), persisted.timezone);
    expect(api.putDayState).toHaveBeenLastCalledWith(
      todayKey,
      { status: 'off', notes: 'rough morning' },
    );

    // Changing status must preserve the note (store notes-preservation path).
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));
    await waitFor(() => {
      expect(readPersisted().dayStates[0]).toMatchObject({
        status: 'well',
        notes: 'rough morning',
      });
    });

    // Saving an empty note is an explicit clear.
    fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    fireEvent.change(screen.getByLabelText('Day note'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(readPersisted().dayStates[0]?.notes).toBe(''));
    expect(api.putDayState).toHaveBeenLastCalledWith(
      todayKey,
      { status: 'well', notes: '' },
    );
  });

  it('suppresses exercise logging on an explicit attack day and still allows an override', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({ timezone: 'UTC', dayStates: [makeDayState(todayKey)] });

    mountHome();
    await waitForSync();

    expect(screen.queryByRole('button', { name: 'Strength' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cardio' })).toBeNull();
    expect(screen.getByText('Attack — rest. No exercise needed.')).toBeTruthy();
    expect(screen.getByText('Today: Attack')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));

    await waitFor(() => {
      const persisted = readPersisted();
      expect(persisted.dayStates).toHaveLength(1);
      expect(persisted.dayStates[0]).toMatchObject({ day: todayKey, status: 'well' });
    });
    expect(screen.getByText('Well — normal routine today.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Strength' })).toBeTruthy();
  });

  it('infers attack rest from an attack overlapping today when no record exists', async () => {
    const now = Date.now();
    seedState({ timezone: 'UTC', attacks: [makeAttack(now)] });

    mountHome();
    await waitForSync();

    expect(screen.queryByRole('button', { name: 'Strength' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cardio' })).toBeNull();
    expect(screen.getByText('Attack — rest. No exercise needed.')).toBeTruthy();

    // An explicit choice is still possible on an inferred attack day.
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Strength' })).toBeTruthy());
  });
});
