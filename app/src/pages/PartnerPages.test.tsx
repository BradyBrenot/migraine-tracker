// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { StoreApi } from '@/lib/store';
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
}));

type StoreModule = typeof import('@/lib/store');
type CalendarModule = typeof import('@/pages/CalendarPage');
type ReportsModule = typeof import('@/pages/Reports');
type HistoryModule = typeof import('@/pages/History');

interface MockedBackend {
  exportAll: Mock;
}

const FIXED = Date.parse('2026-10-15T12:00:00.000Z');
const TZ = 'UTC';
const TODAY = '2026-10-15';

let api: MockedBackend;
let storeModule: StoreModule;
let calendarModule: CalendarModule;
let reportsModule: ReportsModule;
let historyModule: HistoryModule;
let captured: StoreApi | null = null;

function Probe() {
  captured = storeModule.useStore();
  return null;
}

function mountPage(page: ReactNode): void {
  render(
    <storeModule.ReadOnlyStoreProvider>
      {page}
      <Probe />
    </storeModule.ReadOnlyStoreProvider>,
  );
}

async function waitForSync(): Promise<void> {
  await waitFor(() => {
    expect(captured).not.toBeNull();
    expect(captured!.sync.status).toBe('synced');
  });
}

function snapshot() {
  return {
    attacks: [{
      id: 'attack-1',
      start: '2026-10-15T10:00:00.000Z',
      end: '2026-10-15T11:00:00.000Z',
      painLog: [],
      peakPain: 6,
      symptoms: ['Nausea'],
      triggers: ['Stress'],
      aura: null,
      notes: '',
      source: 'manual',
    }] as Attack[],
    meds: [{
      id: 'med-1', medId: 'nurtec', ts: '2026-10-15T10:30:00.000Z', dose: '75 mg',
      quantity: 1, attackId: 'attack-1', notes: '', source: 'manual',
    }] as MedEvent[],
    refills: [{
      id: 'refill-1', medId: 'nurtec', date: '2026-10-01', quantity: 8,
      notes: 'CVS', source: 'manual',
    }] as Refill[],
    workouts: [{
      id: 'workout-1', performedAt: '2026-10-15T08:00:00.000Z', kind: 'strength',
      effort: 'medium', durationMinutes: 30, notes: '', source: 'manual',
    }] as Workout[],
    dayStates: [{
      day: TODAY, status: 'off', notes: '', updatedAt: '2026-10-15T12:00:00.000Z',
    }] as DayState[],
    stockBaselines: [{
      id: 'baseline-1', medId: 'nurtec', effectiveAt: '2026-10-01T00:00:00.000Z',
      quantity: 8, notes: '', source: 'manual', createdAt: '2026-10-01T00:00:00.000Z',
    }] as StockBaseline[],
    settings: {
      timezone: TZ,
      rules: { nurtec: { limit: 15, windowDays: 30 } },
      doses: { nurtec: '75 mg' },
      lowStockThreshold: 2,
    } as Record<string, unknown>,
  };
}

function activateTab(name: RegExp): void {
  const tab = screen.getByRole('tab', { name });
  // Radix tabs activate on mousedown, not click.
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED);
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  api.exportAll.mockResolvedValue(snapshot());
  calendarModule = await import('@/pages/CalendarPage');
  reportsModule = await import('@/pages/Reports');
  historyModule = await import('@/pages/History');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('CalendarPage in the read-only viewer', () => {
  it('keeps month/day navigation but omits schedule controls, dialogs, and attack edit buttons', async () => {
    const CalendarPage = calendarModule.default;
    mountPage(<CalendarPage />);
    await waitForSync();

    // No preventive schedule affordance and no mutation dialogs are mounted.
    expect(screen.queryByRole('button', { name: /Schedule next/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    // Month navigation still works.
    const current = new Date(FIXED);
    current.setDate(1);
    expect(screen.getByText(monthLabel(current))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    const previous = new Date(current.getFullYear(), current.getMonth() - 1, 1);
    await waitFor(() => expect(screen.getByText(monthLabel(previous))).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(screen.getByText(monthLabel(current))).toBeTruthy());

    // Open a day with an attack: the summary is not a focusable edit button.
    const dayCell = document.querySelector<HTMLButtonElement>(`[data-day="${TODAY}"]`);
    expect(dayCell).not.toBeNull();
    fireEvent.click(dayCell!);
    await waitFor(() => expect(screen.getByText('Day state')).toBeTruthy());
    expect(screen.getByText('Off')).toBeTruthy();

    const sheet = document.querySelector('[data-slot="sheet-content"]');
    expect(sheet).not.toBeNull();
    const attackSummary = within(sheet as HTMLElement).getByText(/→/);
    expect(attackSummary.closest('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /→/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('Reports in the read-only viewer', () => {
  it('keeps month navigation and charts but omits the span selector and Report download', async () => {
    const Reports = reportsModule.default;
    mountPage(<Reports />);
    await waitForSync();

    expect(screen.getByText('Attack days per month')).toBeTruthy();
    expect(screen.getByText('Medication days per month')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();

    // The span selector only feeds the omitted download, so the whole group is hidden.
    for (const name of ['3mo', '6mo', '12mo', 'All']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }

    expect(screen.queryByRole('dialog')).toBeNull();

    const current = new Date(FIXED);
    current.setDate(1);
    expect(screen.getAllByText(monthLabel(current)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    const previous = new Date(current.getFullYear(), current.getMonth() - 1, 1);
    await waitFor(() =>
      expect(screen.getAllByText(monthLabel(previous)).length).toBeGreaterThan(0));
  });
});

describe('History in the read-only viewer', () => {
  it('keeps the four tabs and lists but omits add/edit/delete controls and dialogs', async () => {
    const History = historyModule.default;
    mountPage(<History />);
    await waitForSync();

    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Add past attack' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/Nausea/)).toBeTruthy();

    activateTab(/Workouts/);
    await waitFor(() => expect(screen.getByText('Strength · medium')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Add past workout' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

    activateTab(/Rx pickups/);
    await waitFor(() => expect(screen.getByText('CVS')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Add Rx pickup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

    activateTab(/Meds/);
    await waitFor(() => expect(screen.getByText('75 mg')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Add past medication' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
