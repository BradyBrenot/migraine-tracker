// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { Attack, DayState, MedEvent, Refill, StockBaseline, TrackerState, Workout } from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

/** Fixed reference instant: October 2026, so the default month is stable. */
const NOW = Date.UTC(2026, 9, 27, 12);

vi.mock('@/lib/clock', () => ({
  useNow: () => NOW,
  bumpClock: vi.fn(),
}));

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
type ReportsModule = typeof import('@/pages/Reports');

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
let reportsModule: ReportsModule;
let captured: StoreApi | null = null;

function Probe() {
  captured = storeModule.useStore();
  return null;
}

function mountReports(): void {
  const Reports = reportsModule.default;
  render(
    <storeModule.StoreProvider>
      <Reports />
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
    meds: [] as MedEvent[],
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
    attackId: null,
    notes: '',
    source: 'manual',
    ...partial,
  };
}

/** The stat card whose label is `label` (card = label's parent element). */
function statCard(label: string): HTMLElement {
  return screen.getByText(label).parentElement as HTMLElement;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;
  // Recharts' ResponsiveContainer needs ResizeObserver, absent in jsdom.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  reportsModule = await import('@/pages/Reports');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('Reports selected-month cards', () => {
  it('shows unknown rather than a known zero for a month with no records', async () => {
    // Only September has data; the default October view is unknown.
    seedState({
      attacks: [makeAttack({
        id: 'september',
        start: '2026-09-10T08:00:00.000Z',
        end: '2026-09-10T10:00:00.000Z',
      })],
    });

    mountReports();
    await waitForSync();

    await waitFor(() => expect(screen.getAllByText('no data this month')).toHaveLength(2));
    expect(statCard('Attacks').textContent).toContain('—');
    expect(statCard('Days affected').textContent).toContain('—');
    // Not a confirmed clear month.
    expect(statCard('Attacks').textContent).not.toMatch(/Attacks0/);
  });

  it('treats a medication-only month as known data with real zero attack days', async () => {
    seedState({
      meds: [makeMed({ id: 'med-1', ts: '2026-10-05T08:00:00.000Z' })],
    });

    mountReports();
    await waitForSync();

    await waitFor(() => expect(screen.queryAllByText('no data this month')).toHaveLength(0));
    expect(statCard('Attacks').textContent).toContain('Attacks0');
    expect(statCard('Days affected').textContent).toContain('Days affected0');
  });

  it('counts 0/-1 attacks and averages only reported pain (0,4,-1 => 2.0)', async () => {
    seedState({
      attacks: [
        makeAttack({
          id: 'zero-pain',
          start: '2026-10-05T08:00:00.000Z',
          end: '2026-10-05T09:00:00.000Z',
          peakPain: 0,
        }),
        makeAttack({
          id: 'four-pain',
          start: '2026-10-07T08:00:00.000Z',
          end: '2026-10-07T09:00:00.000Z',
          peakPain: 4,
        }),
        makeAttack({
          id: 'unreported-pain',
          start: '2026-10-09T08:00:00.000Z',
          end: '2026-10-09T09:00:00.000Z',
          peakPain: -1,
        }),
      ],
    });

    mountReports();
    await waitForSync();

    await waitFor(() => expect(screen.getByText('out of 10')).toBeTruthy());
    // The -1 attack still counts as an attack and a day...
    expect(statCard('Attacks').textContent).toContain('Attacks3');
    expect(statCard('Days affected').textContent).toContain('Days affected3');
    // ...but is excluded from the denominator: (0 + 4) / 2 = 2.0, not 1.3.
    expect(statCard('Avg peak pain').textContent).toContain('2.0');
  });
});
