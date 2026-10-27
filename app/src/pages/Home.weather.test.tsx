// @vitest-environment jsdom
/**
 * Home placement contract for the compact WeatherCard: it must sit AFTER the
 * primary logging controls (attack banner / start, wellness, medications) and
 * BEFORE Today's meds, without reordering or removing anything.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { TrackerState } from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

vi.mock('@/lib/api', () => ({
  api: {
    exportAll: vi.fn(),
    importAll: vi.fn(),
    restoreAll: vi.fn(),
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
    getWeather: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

type StoreModule = typeof import('@/lib/store');

interface MockedBackend {
  exportAll: Mock;
  importAll: Mock;
  resetAll: Mock;
  putSetting: Mock;
  getWeather: Mock;
}

const STORAGE_KEY = 'migraine-tracker-v1';
const BOSTON = {
  id: 4930956,
  name: 'Boston',
  admin1: 'Massachusetts',
  country: 'United States',
  latitude: 42.35843,
  longitude: -71.05977,
};

let api: MockedBackend;
let storeModule: StoreModule;

function stateWith(overrides: Partial<TrackerState> = {}): TrackerState {
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
    weather: {
      enabled: true,
      location: BOSTON,
      pressureDropThresholdHpa: 5,
    },
    lowStockAlertedAt: null,
    seeded: false,
    ...overrides,
  };
}

function seedState(state: TrackerState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function mountHome(): void {
  const Home = requireHome();
  render(
    <storeModule.StoreProvider>
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    </storeModule.StoreProvider>,
  );
}

let homeModule: typeof import('@/pages/Home');

function requireHome() {
  return homeModule.default;
}

function isBefore(a: Element | null, b: Element | null): boolean {
  if (!a || !b) throw new Error('both elements must exist');
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  storeModule = await import('@/lib/store');
  homeModule = await import('@/pages/Home');

  api.exportAll.mockResolvedValue({
    attacks: [],
    meds: [],
    refills: [],
    workouts: [],
    dayStates: [],
    stockBaselines: [],
    settings: {},
  });
  api.importAll.mockResolvedValue(undefined);
  api.resetAll.mockResolvedValue(undefined);
  api.putSetting.mockResolvedValue(undefined);
  api.getWeather.mockResolvedValue({
    status: 'ready',
    location: BOSTON,
    current: { temperatureC: 14, humidityPercent: 60, pressureHpa: 1010 },
    warning: {
      baselineHpa: 1013,
      targetHpa: 1005,
      dropHpa: 8,
      targetTimeMs: Date.now() + 6 * 60 * 60 * 1000,
      thresholdHpa: 5,
    },
    fetchedAt: new Date().toISOString(),
    stale: false,
    thresholdHpa: 5,
    timeZone: 'UTC',
  });
});

afterEach(() => {
  cleanup();
});

describe('Home weather placement', () => {
  it('keeps start/wellness/medication controls and places the card before Today meds', async () => {
    seedState(stateWith({
      meds: [{
        id: 'm1',
        medId: 'nurtec',
        ts: new Date().toISOString(),
        dose: '75 mg',
        quantity: 1,
        attackId: null,
        notes: '',
        source: 'manual',
      }],
    }));

    mountHome();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Weather' })).toBeTruthy());

    const start = screen.getByRole('button', { name: /Start attack now|Log another attack/ });
    const well = screen.getByRole('button', { name: 'Well' });
    const medHeading = screen.getByRole('heading', { name: 'Took a med' });
    const weatherHeading = screen.getByRole('heading', { name: 'Weather' });
    const todayHeading = screen.getByRole('heading', { name: 'Today' });
    const nurtecButton = screen.getByRole('button', { name: /Nurtec/ });

    // Approved order: attack controls -> medications -> wellness/movement ->
    // weather -> today's meds.
    expect(isBefore(start, medHeading)).toBe(true);
    expect(isBefore(medHeading, nurtecButton)).toBe(true);
    expect(isBefore(nurtecButton, well)).toBe(true);
    expect(isBefore(well, weatherHeading)).toBe(true);
    expect(isBefore(weatherHeading, todayHeading)).toBe(true);
  });

  it('leaves the active-attack Log pain / Attack ended order untouched', async () => {
    seedState(stateWith({
      attacks: [{
        id: 'a1',
        start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        end: null,
        painLog: [],
        peakPain: -1,
        symptoms: [],
        triggers: [],
        aura: null,
        notes: '',
        source: 'manual',
      }],
    }));

    mountHome();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Weather' })).toBeTruthy());

    const pain = screen.getByRole('button', { name: 'Log pain' });
    const ended = screen.getByRole('button', { name: 'Attack ended' });
    const medHeading = screen.getByRole('heading', { name: 'Took a med' });
    const movement = screen.getByText('Movement');
    const weatherHeading = screen.getByRole('heading', { name: 'Weather' });

    expect(isBefore(pain, ended)).toBe(true);
    expect(isBefore(ended, medHeading)).toBe(true);
    expect(isBefore(medHeading, movement)).toBe(true);
    expect(isBefore(movement, weatherHeading)).toBe(true);
  });

  it('hides the card entirely when weather is disabled', async () => {
    seedState(stateWith({
      weather: { enabled: false, location: null, pressureDropThresholdHpa: 5 },
    }));
    mountHome();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Took a med' })).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Weather' })).toBeNull();
    expect(api.getWeather).not.toHaveBeenCalled();
  });
});
