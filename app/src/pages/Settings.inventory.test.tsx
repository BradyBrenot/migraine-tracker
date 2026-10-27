// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { StockBaseline, TrackerState } from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const store = vi.hoisted(() => ({
  state: {} as TrackerState,
  sync: { status: 'synced', pending: 0, diverged: false },
  serverMode: true,
  setLowStockThreshold: vi.fn(),
  resetLowStockAlert: vi.fn(),
  addStockBaseline: vi.fn(),
  deleteStockBaseline: vi.fn(),
  importData: vi.fn(),
  loadDemoData: vi.fn(),
  resetAll: vi.fn(),
  resolveUseServer: vi.fn(),
  setRule: vi.fn(),
  setDoseDefault: vi.fn(),
  setTimezone: vi.fn(),
}));

vi.mock('@/lib/store', () => ({ useStore: () => store }));

// Settings fetches health on mount; keep it pending so these inventory tests
// stay synchronous and never touch a real network.
vi.mock('@/lib/api', () => ({
  api: { getHealth: vi.fn(() => new Promise(() => {})) },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import Settings from './Settings';
import { toast } from 'sonner';

function makeState(partial: Partial<TrackerState> = {}): TrackerState {
  return {
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
}

function makeBaseline(now: number, quantity: number, id = 'baseline-1'): StockBaseline {
  const at = new Date(now - 10 * DAY_MS).toISOString();
  return {
    id,
    medId: 'nurtec',
    effectiveAt: at,
    quantity,
    notes: 'initial',
    source: 'manual',
    createdAt: at,
  };
}

function renderSettings(): void {
  render(<Settings />);
}

function thresholdInput(): HTMLInputElement {
  return screen.getByLabelText('Low-stock alert level') as HTMLInputElement;
}

function quantityInput(): HTMLInputElement {
  return screen.getByLabelText('Starting tablet count') as HTMLInputElement;
}

beforeEach(() => {
  store.state = makeState();
  store.sync = { status: 'synced', pending: 0, diverged: false };
  store.serverMode = true;
  store.setLowStockThreshold.mockReset();
  store.resetLowStockAlert.mockReset();
  store.addStockBaseline.mockReset();
  store.deleteStockBaseline.mockReset();
  store.importData.mockReset();
  store.loadDemoData.mockReset();
  store.resetAll.mockReset();
  store.resolveUseServer.mockReset();
  store.setRule.mockReset();
  store.setDoseDefault.mockReset();
  store.setTimezone.mockReset();
  (toast.success as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Settings Nurtec inventory', () => {
  it('shows "Stock not set" (never 0) when no baseline applies', () => {
    renderSettings();

    expect(screen.getByText('Stock not set — add a starting count below')).toBeTruthy();
    expect(screen.queryByText(/0 tablets left/)).toBeNull();
  });

  it('shows the optimistic count and flags low stock in amber', () => {
    store.state = makeState({ stockBaselines: [makeBaseline(Date.now(), 2)] });
    renderSettings();

    expect(screen.getByText(/2 tablets left/)).toBeTruthy();
    expect(screen.getByText(/Low \(alert level 2\)/)).toBeTruthy();
  });

  it('shows a negative count as a reconciliation warning', () => {
    const now = Date.now();
    store.state = makeState({
      stockBaselines: [makeBaseline(now, 1)],
      meds: [
        {
          id: 'dose-1',
          medId: 'nurtec',
          quantity: 4,
          ts: new Date(now - 2 * DAY_MS).toISOString(),
          attackId: null,
          notes: '',
          source: 'manual',
        },
      ],
    });
    renderSettings();

    expect(screen.getByText(/Recorded stock is negative/)).toBeTruthy();
    expect(screen.queryByText(/0 tablets left/)).toBeNull();
  });

  it('updates the alert level and ignores invalid keystrokes', () => {
    renderSettings();

    fireEvent.change(thresholdInput(), { target: { value: '-3' } });
    expect(store.setLowStockThreshold).not.toHaveBeenCalled();

    fireEvent.change(thresholdInput(), { target: { value: '5' } });
    expect(store.setLowStockThreshold).toHaveBeenCalledWith(5);
  });

  it('adds a starting count with an ISO effective time and notes', () => {
    renderSettings();

    const addButton = screen.getByRole('button', { name: /^Add$/ }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);

    fireEvent.change(quantityInput(), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Starting count notes'), {
      target: { value: 'initial count' },
    });
    expect(addButton.disabled).toBe(false);
    fireEvent.click(addButton);

    expect(store.addStockBaseline).toHaveBeenCalledTimes(1);
    const payload = store.addStockBaseline.mock.calls[0][0] as {
      medId: string;
      effectiveAt: string;
      quantity: number;
      notes: string;
    };
    expect(payload).toMatchObject({ medId: 'nurtec', quantity: 12, notes: 'initial count' });
    expect(payload.effectiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isFinite(Date.parse(payload.effectiveAt))).toBe(true);
  });

  it('lists baselines newest first and deletes one', () => {
    const now = Date.now();
    store.state = makeState({
      stockBaselines: [
        makeBaseline(now, 8, 'baseline-old'),
        makeBaseline(now, 3, 'baseline-new'),
      ],
    });
    // Make the second effective instant newer.
    store.state.stockBaselines[1].effectiveAt =
      new Date(now - DAY_MS).toISOString();
    store.state.stockBaselines[1].createdAt = store.state.stockBaselines[1].effectiveAt;
    renderSettings();

    const quantityRows = screen.getAllByText(/^Quantity \d+$/);
    expect(quantityRows.map((row) => row.textContent)).toEqual(['Quantity 3', 'Quantity 8']);

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete count' })[0]);
    expect(store.deleteStockBaseline).toHaveBeenCalledWith('baseline-new');
    expect(toast.success).toHaveBeenCalledWith('Count deleted');
  });

  it('shows a latched low-stock alert and resets it', () => {
    store.state = makeState({ lowStockAlertedAt: '2026-10-01T12:00:00.000Z' });
    renderSettings();

    expect(screen.getByText(/Low-stock alert on since/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset alert' }));
    expect(store.resetLowStockAlert).toHaveBeenCalledTimes(1);
  });
});
