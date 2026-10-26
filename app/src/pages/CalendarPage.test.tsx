// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { Attack, DayState, TrackerState, Workout } from '@/types';
import { dayKeyStartMs, localDayKey } from '../../shared/datetime.ts';
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
type CalendarPageModule = typeof import('@/pages/CalendarPage');

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
const ZONES = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'];

let api: MockedBackend;
let storeModule: StoreModule;
let calendarPageModule: CalendarPageModule;
let captured: StoreApi | null = null;

function Probe() {
  captured = storeModule.useStore();
  return null;
}

function mountCalendar(): void {
  const CalendarPage = calendarPageModule.default;
  render(
    <storeModule.StoreProvider>
      <CalendarPage />
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

function applyApiDefaults(backend: MockedBackend): void {
  backend.exportAll.mockResolvedValue({
    attacks: [] as Attack[],
    meds: [] as TrackerState['meds'],
    refills: [] as TrackerState['refills'],
    workouts: [] as Workout[],
    dayStates: [] as DayState[],
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
  backend.deleteRefill.mockResolvedValue(undefined);
  backend.addWorkout.mockResolvedValue(undefined);
  backend.patchWorkout.mockResolvedValue(undefined);
  backend.deleteWorkout.mockResolvedValue(undefined);
  backend.listWorkouts.mockResolvedValue([]);
  backend.listDayStates.mockResolvedValue([]);
  backend.putDayState.mockResolvedValue(undefined);
  backend.putSetting.mockResolvedValue(undefined);
}

function formatDayTitle(key: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(new Date(dayKeyStartMs(key, timeZone)));
}

/**
 * Pick a configured zone + a mid-month day in its current month, plus an
 * instant inside that configured-zone day whose machine-local day differs.
 * Mid-month keeps both days in the visible six-week grid regardless of the
 * machine zone.
 */
function findConfiguredDayDifferentFromSystem(): {
  timeZone: string;
  dayKey: string;
  machineKey: string;
  instantMs: number;
} {
  const now = Date.now();
  for (const timeZone of ZONES) {
    const todayKey = localDayKey(now, timeZone);
    // Day 15 always exists and is always inside the visible month grid.
    const dayKey = `${todayKey.slice(0, 7)}-15`;
    const start = dayKeyStartMs(dayKey, timeZone);
    for (let minutes = 30; minutes < 24 * 60; minutes += 30) {
      const instantMs = start + minutes * 60 * 1000;
      if (localDayKey(instantMs, timeZone) !== dayKey) continue;
      const machineKey = localDayKey(instantMs);
      if (machineKey !== dayKey) {
        return { timeZone, dayKey, machineKey, instantMs };
      }
    }
  }
  throw new Error(
    'could not construct an instant whose configured-zone day differs from the machine day',
  );
}

function clickDay(key: string): void {
  const cell = document.querySelector<HTMLButtonElement>(`[data-day="${key}"]`);
  if (!cell) throw new Error(`calendar cell not found for ${key}`);
  fireEvent.click(cell);
}

function makeWorkout(performedAt: number): Workout {
  return {
    id: 'seed-workout',
    performedAt: new Date(performedAt).toISOString(),
    kind: 'cardio',
    effort: 'medium',
    durationMinutes: 30,
    notes: '',
    source: 'manual',
  };
}

function makeAttack(dayKey: string, timeZone: string): Attack {
  const start = dayKeyStartMs(dayKey, timeZone) + 60 * 60 * 1000;
  return {
    id: 'seed-attack',
    start: new Date(start).toISOString(),
    end: new Date(start + 2 * 60 * 60 * 1000).toISOString(),
    painLog: [],
    peakPain: 6,
    symptoms: ['nausea'],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  calendarPageModule = await import('@/pages/CalendarPage');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('CalendarPage configured-timezone day identity', () => {
  it('shows a workout under the configured-zone day, not the machine-local day', async () => {
    const { timeZone, dayKey, machineKey, instantMs } = findConfiguredDayDifferentFromSystem();
    seedState({ timezone: timeZone, workouts: [makeWorkout(instantMs)] });

    mountCalendar();
    await waitForSync();

    clickDay(dayKey);
    await waitFor(() => expect(screen.getByText('Cardio · medium')).toBeTruthy());
    expect(screen.getByRole('heading', { name: formatDayTitle(dayKey, timeZone) })).toBeTruthy();

    // The same instant belongs to a different machine-local day; that cell must
    // not show the workout.
    clickDay(machineKey);
    await waitFor(() => expect(screen.queryByText('Cardio · medium')).toBeNull());
    expect(
      screen.getByRole('heading', { name: formatDayTitle(machineKey, timeZone) }),
    ).toBeTruthy();
  });

  it('shows the configured-zone day state and its notes in that day sheet', async () => {
    const { timeZone, dayKey } = findConfiguredDayDifferentFromSystem();
    seedState({
      timezone: timeZone,
      dayStates: [{
        day: dayKey,
        status: 'off',
        notes: 'rough morning',
        updatedAt: new Date().toISOString(),
      }],
    });

    mountCalendar();
    await waitForSync();

    clickDay(dayKey);
    await waitFor(() => expect(screen.getByText('Day state')).toBeTruthy());
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText('rough morning')).toBeTruthy();
    expect(screen.getByRole('heading', { name: formatDayTitle(dayKey, timeZone) })).toBeTruthy();
  });

  it('keeps attack inference, workouts, and the sheet title on the same configured day', async () => {
    const { timeZone, dayKey, instantMs } = findConfiguredDayDifferentFromSystem();
    seedState({
      timezone: timeZone,
      attacks: [makeAttack(dayKey, timeZone)],
      workouts: [makeWorkout(instantMs)],
    });

    mountCalendar();
    await waitForSync();

    clickDay(dayKey);
    await waitFor(() => expect(screen.getByText('attack (from attacks)')).toBeTruthy());
    expect(screen.getByText('nausea')).toBeTruthy();
    expect(screen.getByText('Cardio · medium')).toBeTruthy();
    expect(screen.getByRole('heading', { name: formatDayTitle(dayKey, timeZone) })).toBeTruthy();
  });
});
