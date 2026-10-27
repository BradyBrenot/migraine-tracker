// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TrackerState } from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';
import { DEFAULT_WEATHER_SETTINGS } from '../../shared/weather.ts';

/**
 * Demo Settings must describe the demo honestly (no server, no local storage)
 * and must not offer weather/geocode/health controls that would imply a
 * backend or attempt a request.
 */

const store = vi.hoisted(() => ({
  demo: true,
  state: {} as TrackerState,
  sync: { status: 'local', pending: 0, dirty: false, failed: false, diverged: false },
  serverMode: false,
  setLowStockThreshold: vi.fn(),
  resetLowStockAlert: vi.fn(),
  addStockBaseline: vi.fn(),
  deleteStockBaseline: vi.fn(),
  importData: vi.fn(),
  loadDemoData: vi.fn(),
  resetAll: vi.fn(() => Promise.resolve()),
  resolveUseServer: vi.fn(() => Promise.resolve()),
  setRule: vi.fn(),
  setRules: vi.fn(),
  setDoseDefault: vi.fn(),
  setTimezone: vi.fn(),
  updateReminders: vi.fn(() => []),
  updateWeather: vi.fn(() => []),
  mergeBackup: vi.fn(),
  replaceBackup: vi.fn(() => Promise.resolve()),
}));

const getHealth = vi.hoisted(() => vi.fn());
const geocodeWeather = vi.hoisted(() => vi.fn());

vi.mock('@/lib/store', () => ({ useStore: () => store }));
vi.mock('@/lib/api', () => ({ api: { getHealth, geocodeWeather } }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import Settings from './Settings';

function makeState(): TrackerState {
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
    reminders: { ...DEFAULT_REMINDER_SETTINGS },
    weather: { ...DEFAULT_WEATHER_SETTINGS },
    lowStockAlertedAt: null,
    seeded: true,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.state = makeState();
  getHealth.mockReset();
  geocodeWeather.mockReset();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Settings in demo mode', () => {
  it('explains the in-memory demo instead of claiming browser/server storage', () => {
    render(<Settings />);

    expect(screen.getByText(/Demo mode/)).toBeTruthy();
    expect(screen.getByText(/Nothing is saved to this browser, no server is contacted/))
      .toBeTruthy();
    expect(screen.getByText('Demo — no server')).toBeTruthy();
    // Never claim a real sync status.
    expect(screen.queryByText(/browser-only mode/)).toBeNull();
    expect(screen.queryByText(/Connected to the backend server/)).toBeNull();
  });

  it('removes weather server controls and makes no health/geocode requests', () => {
    render(<Settings />);

    expect(screen.getByText(/unavailable in this static demo/)).toBeTruthy();
    expect(screen.queryByLabelText('Enable weather warnings')).toBeNull();
    expect(screen.queryByLabelText('Search for a city')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save weather settings' })).toBeNull();

    expect(getHealth).not.toHaveBeenCalled();
    expect(geocodeWeather).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
