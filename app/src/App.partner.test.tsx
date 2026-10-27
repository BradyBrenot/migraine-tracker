// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type {
  Attack, DayState, MedEvent, Refill, StockBaseline, Workout,
} from '@/types';

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
  Toaster: () => null,
}));

type AppModule = typeof import('@/App');

interface MockedBackend {
  exportAll: Mock;
  importAll: Mock;
  putSetting: Mock;
}

const STORAGE_KEY = 'migraine-tracker-v1';

let api: MockedBackend;
let appModule: AppModule;

function emptyExport() {
  return {
    attacks: [] as Attack[],
    meds: [] as MedEvent[],
    refills: [] as Refill[],
    workouts: [] as Workout[],
    dayStates: [] as DayState[],
    stockBaselines: [] as StockBaseline[],
    settings: {} as Record<string, unknown>,
  };
}

function renderAt(path: string): void {
  const App = appModule.default;
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  api.exportAll.mockResolvedValue(emptyExport());
  api.importAll.mockResolvedValue(undefined);
  api.putSetting.mockResolvedValue(undefined);
  appModule = await import('@/App');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('App route provider composition', () => {
  it('mounts only the read-only store under /view and never writes the writer cache', async () => {
    renderAt('/view');

    await waitFor(() => expect(screen.getByText('No active attack')).toBeTruthy());
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('Partner view')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Now' })).toHaveLength(2);
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(api.importAll).not.toHaveBeenCalled();
    expect(api.putSetting).not.toHaveBeenCalled();
  });

  it('mounts only the read-only store under /view/calendar', async () => {
    renderAt('/view/calendar');

    await waitFor(() => expect(screen.getByText('Live')).toBeTruthy());
    // Calendar is a lazy chunk; wait for it inside the already-mounted shell.
    await waitFor(
      () => expect(screen.getByText('Medication limits')).toBeTruthy(),
      { timeout: 5000 },
    );
    // The viewer has no schedule control and no writer navigation.
    expect(screen.queryByRole('button', { name: /Schedule next/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('resolves a lazily loaded partner page inside the mounted viewer shell', async () => {
    renderAt('/view/history');

    // The shell (nav + freshness) renders while the page chunk loads.
    await waitFor(() => expect(screen.getByText('Live')).toBeTruthy());
    expect(screen.getByText('Partner view')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();

    // History is a lazy chunk: its tab list appears without unmounting the shell.
    await waitFor(
      () => expect(screen.getByRole('tab', { name: /Attacks/ })).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(screen.getAllByRole('link', { name: 'History' })).toHaveLength(2);
    expect(screen.getByText('Partner view')).toBeTruthy();
  });

  it('resolves a lazily loaded writer page with the writer chrome mounted', async () => {
    renderAt('/calendar');

    // Navigation renders immediately; only the page body is a lazy chunk.
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: 'Settings' }).length).toBeGreaterThan(0));
    await waitFor(
      () => expect(screen.getByText('Medication limits')).toBeTruthy(),
      { timeout: 5000 },
    );

    expect(screen.getByText(/Migraine Tracker/)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Calendar' })).toHaveLength(2);
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull());
  });

  it('still mounts the normal writer store with Settings outside /view', async () => {
    renderAt('/');

    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Settings' }).length).toBeGreaterThan(0));
    expect(screen.queryByText('Read only')).toBeNull();
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull());
  });
});
