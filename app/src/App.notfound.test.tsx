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

describe('in-shell not-found routes', () => {
  it('keeps writer chrome and only links back to the writer app for unknown writer paths', async () => {
    renderAt('/nope');

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy());
    expect(screen.getAllByRole('link', { name: 'Settings' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Read only')).toBeNull();

    const back = screen.getByRole('link', { name: 'Back to log' });
    expect(back.getAttribute('href')).toBe('/');
    expect(screen.queryByRole('link', { name: /Back to partner view/ })).toBeNull();
  });

  it('treats /viewx as a writer route, not the partner tree', async () => {
    renderAt('/viewx');

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy());
    // Writer navigation (including Settings) is present; the read-only badge is not.
    expect(screen.getAllByRole('link', { name: 'Settings' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Read only')).toBeNull();
  });

  it('shows the partner not-found for /view/settings and never exposes writer Settings', async () => {
    renderAt('/view/settings');

    await waitFor(() => expect(screen.getByText('Read only')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();

    expect(screen.queryAllByRole('link', { name: 'Settings' })).toHaveLength(0);
    expect(document.querySelector('a[href="/settings"]')).toBeNull();

    const back = screen.getByRole('link', { name: 'Back to partner view' });
    expect(back.getAttribute('href')).toBe('/view');
    expect(screen.queryByRole('link', { name: 'Back to log' })).toBeNull();
  });
});
