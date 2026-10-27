// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TrackerState } from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

const BOSTON = {
  id: 4930956,
  name: 'Boston',
  admin1: 'Massachusetts',
  country: 'United States',
  latitude: 42.35843,
  longitude: -71.05977,
};

const store = vi.hoisted(() => ({
  state: {} as TrackerState,
  sync: { status: 'synced', pending: 0, diverged: false },
  serverMode: true,
  updateWeather: vi.fn(() => [] as string[]),
  updateReminders: vi.fn(() => [] as string[]),
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

vi.mock('@/lib/api', () => ({
  api: {
    // Keep the mount-time health request pending: these tests stay local.
    getHealth: vi.fn(() => new Promise(() => {})),
    geocodeWeather: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import Settings from './Settings';
import { toast } from 'sonner';
import { api } from '@/lib/api';

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
    reminders: { ...DEFAULT_REMINDER_SETTINGS },
    weather: { enabled: false, location: null, pressureDropThresholdHpa: 5 },
    lowStockAlertedAt: null,
    seeded: false,
    ...partial,
  };
}

function renderSettings(): void {
  render(<Settings />);
}

beforeEach(() => {
  store.state = makeState();
  store.sync = { status: 'synced', pending: 0, diverged: false };
  store.serverMode = true;
  store.updateWeather.mockReset();
  store.updateWeather.mockReturnValue([]);
  store.updateReminders.mockReset();
  store.updateReminders.mockReturnValue([]);
  (toast.success as ReturnType<typeof vi.fn>).mockReset();
  (toast.error as ReturnType<typeof vi.fn>).mockReset();
  (api.geocodeWeather as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Settings weather section', () => {
  it('shows the saved city, cautious evidence caveat, attribution, and per-type switch', () => {
    store.state = makeState({
      weather: { enabled: true, location: BOSTON, pressureDropThresholdHpa: 6 },
    });
    renderSettings();

    expect(screen.getByText('Boston, Massachusetts, United States')).toBeTruthy();
    expect(screen.getByLabelText('Enable weather warnings')).toBeTruthy();
    expect(screen.getByLabelText('Pressure drop threshold (hPa)')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'open-meteo.com' }).getAttribute('href'))
      .toContain('open-meteo.com');
    expect(screen.getByText(/not a validated clinical cutoff/)).toBeTruthy();
    expect(screen.getByText(/not a medical prediction or a likelihood score/)).toBeTruthy();
    expect(screen.getByText(/searched city|search text/i)).toBeTruthy();
    // Existing reminders grid gains the weather per-type switch.
    expect(screen.getByLabelText('Weather pressure drops')).toBeTruthy();
  });

  it('saves an edited threshold through the store with validation', () => {
    store.state = makeState({
      weather: { enabled: true, location: BOSTON, pressureDropThresholdHpa: 5 },
    });
    renderSettings();

    const threshold = screen.getByLabelText('Pressure drop threshold (hPa)');
    fireEvent.change(threshold, { target: { value: '6.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save weather settings' }));

    expect(store.updateWeather).toHaveBeenCalledWith({
      enabled: true,
      location: BOSTON,
      pressureDropThresholdHpa: 6.5,
    });
    expect(toast.success).toHaveBeenCalledWith('Weather settings saved');
  });

  it('blocks saving an out-of-range threshold', () => {
    store.state = makeState({
      weather: { enabled: true, location: BOSTON, pressureDropThresholdHpa: 5 },
    });
    renderSettings();

    fireEvent.change(screen.getByLabelText('Pressure drop threshold (hPa)'), {
      target: { value: '0' },
    });
    expect(screen.getByRole('button', { name: 'Save weather settings' }))
      .toHaveProperty('disabled', true);
    expect(screen.getByText(/pressureDropThresholdHpa must be a number from 1 to 25/))
      .toBeTruthy();
    expect(store.updateWeather).not.toHaveBeenCalled();
  });

  it('searches by POST and saves the selected projected city', async () => {
    (api.geocodeWeather as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [BOSTON],
    });
    renderSettings();

    fireEvent.change(screen.getByLabelText('Search for a city'), {
      target: { value: 'Boston' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(api.geocodeWeather).toHaveBeenCalledWith('Boston'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Boston/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Boston/ }));

    expect(screen.getByText(/Unsaved city:/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save weather settings' }));
    expect(store.updateWeather).toHaveBeenCalledWith({
      enabled: false,
      location: BOSTON,
      pressureDropThresholdHpa: 5,
    });
  });

  it('clears a saved location in the draft', () => {
    store.state = makeState({
      weather: { enabled: true, location: BOSTON, pressureDropThresholdHpa: 5 },
    });
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save weather settings' }));
    expect(store.updateWeather).toHaveBeenCalledWith({
      enabled: true,
      location: null,
      pressureDropThresholdHpa: 5,
    });
  });

  it('shows a calm inline error when city search is unavailable', async () => {
    (api.geocodeWeather as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('upstream'));
    renderSettings();

    fireEvent.change(screen.getByLabelText('Search for a city'), {
      target: { value: 'Boston' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText('City search is unavailable right now.')).toBeTruthy());
  });
});
