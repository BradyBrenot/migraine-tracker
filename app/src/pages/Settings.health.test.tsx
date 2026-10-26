// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TrackerState } from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

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
  updateReminders: vi.fn(() => []),
}));

const getHealth = vi.hoisted(() => vi.fn());

vi.mock('@/lib/store', () => ({ useStore: () => store }));

vi.mock('@/lib/api', () => ({ api: { getHealth } }));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import Settings from './Settings';

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
    lowStockAlertedAt: null,
    seeded: false,
    ...partial,
  };
}

beforeEach(() => {
  store.state = makeState();
  store.sync = { status: 'synced', pending: 0, diverged: false };
  store.serverMode = true;
  getHealth.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Settings attack-alert environment status', () => {
  it('shows Configured when the health endpoint reports attack alerts enabled', async () => {
    getHealth.mockResolvedValue({
      ok: true,
      notifications: { reminders: false, attackAlerts: true },
    });

    render(<Settings />);

    expect(await screen.findByText('Configured')).toBeTruthy();
    expect(screen.getByText(/Configuration comes from the server environment/))
      .toBeTruthy();
    expect(screen.getByText(/no delivery guarantee/)).toBeTruthy();
  });

  it('shows Not configured when the health endpoint reports attack alerts disabled', async () => {
    getHealth.mockResolvedValue({
      ok: true,
      notifications: { reminders: true, attackAlerts: false },
    });

    render(<Settings />);

    expect(await screen.findByText('Not configured')).toBeTruthy();
  });

  it('shows Unavailable when the health request rejects', async () => {
    getHealth.mockRejectedValue(new Error('network down'));

    render(<Settings />);

    expect(await screen.findByText('Unavailable')).toBeTruthy();
  });

  it('shows Unavailable for a legacy or malformed health response', async () => {
    getHealth.mockResolvedValue({ ok: true });

    render(<Settings />);

    expect(await screen.findByText('Unavailable')).toBeTruthy();
  });

  it('renders no attack-alert toggle or input', async () => {
    getHealth.mockResolvedValue({
      ok: true,
      notifications: { reminders: true, attackAlerts: true },
    });

    render(<Settings />);
    await screen.findByText('Configured');

    expect(screen.queryByRole('switch', { name: /attack/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /attack/i })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /attack/i })).toBeNull();
  });
});
