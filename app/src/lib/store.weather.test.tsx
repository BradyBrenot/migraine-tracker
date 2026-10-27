// @vitest-environment jsdom
/**
 * Store-level weather persistence/sync paths: legacy cache defaults, strict
 * update validation, first-contact upload, server hydration, and restore.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { TrackerState } from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';
import { parseBackup } from '../../shared/backup.ts';
import type { ParsedBackup } from '../../shared/backup.ts';

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
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

type StoreModule = typeof import('@/lib/store');

interface MockedBackend {
  exportAll: Mock;
  importAll: Mock;
  restoreAll: Mock;
  resetAll: Mock;
  putSetting: Mock;
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
const ENABLED_WEATHER = {
  enabled: true,
  location: BOSTON,
  pressureDropThresholdHpa: 6,
};

let api: MockedBackend;
let storeModule: StoreModule;
let captured: StoreApi | null = null;

function currentStore(): StoreApi {
  if (captured === null) throw new Error('StoreProvider has not rendered yet');
  return captured;
}

function Probe() {
  captured = storeModule.useStore();
  return null;
}

function mountStore(): void {
  const { StoreProvider } = storeModule;
  render(
    <StoreProvider>
      <Probe />
    </StoreProvider>,
  );
}

function emptyExport() {
  return {
    attacks: [],
    meds: [],
    refills: [],
    workouts: [],
    dayStates: [],
    stockBaselines: [],
    settings: {} as Record<string, unknown>,
  };
}

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
    weather: { enabled: false, location: null, pressureDropThresholdHpa: 5 },
    lowStockAlertedAt: null,
    seeded: false,
    ...overrides,
  };
}

function parsedWeatherBackup(weather: unknown): ParsedBackup {
  const parsed = parseBackup({
    schemaVersion: 4,
    attacks: [],
    settings: { weather },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.backup;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  storeModule = await import('@/lib/store');

  api.exportAll.mockResolvedValue(emptyExport());
  api.importAll.mockResolvedValue(undefined);
  api.restoreAll.mockResolvedValue(emptyExport());
  api.resetAll.mockResolvedValue(undefined);
  api.putSetting.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('store weather settings', () => {
  it('defaults a legacy cache without weather to disabled', async () => {
    // A pre-weather cache: no `weather` key at all.
    const legacy = stateWith();
    delete (legacy as Partial<TrackerState>).weather;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(currentStore().state.weather).toEqual({
      enabled: false,
      location: null,
      pressureDropThresholdHpa: 5,
    });
  });

  it('rejects invalid weather updates without applying or queueing them', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.putSetting.mockClear();

    const before = currentStore().state.weather;
    expect(currentStore().updateWeather({ pressureDropThresholdHpa: 0 }))
      .toContain('pressureDropThresholdHpa must be a number from 1 to 25');
    const withSecret = {
      ...ENABLED_WEATHER,
      ntfyToken: 'x',
    } as unknown as Partial<TrackerState['weather']>;
    expect(currentStore().updateWeather(withSecret)).not.toHaveLength(0);
    expect(currentStore().state.weather).toEqual(before);
    expect(api.putSetting).not.toHaveBeenCalled();
  });

  it('applies and persists a valid weather update', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    let errors: string[] = [];
    act(() => {
      errors = currentStore().updateWeather(ENABLED_WEATHER);
    });
    expect(errors).toEqual([]);
    expect(currentStore().state.weather).toEqual(ENABLED_WEATHER);
    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith('weather', ENABLED_WEATHER));
  });

  it('includes weather in the first-contact upload', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateWith({
      attacks: [{
        id: 'a1',
        start: '2026-10-20T08:00:00.000Z',
        end: null,
        painLog: [],
        peakPain: -1,
        symptoms: [],
        triggers: [],
        aura: null,
        notes: '',
        source: 'manual',
      }],
      weather: ENABLED_WEATHER,
    })));

    mountStore();
    await waitFor(() => expect(api.importAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith('weather', ENABLED_WEATHER));
  });

  it('adopts valid server weather on hydration', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      // A non-empty server plus an empty local cache selects hydrate-server.
      attacks: [{
        id: 'server-attack',
        start: '2026-10-20T08:00:00.000Z',
        end: null,
        painLog: [],
        peakPain: -1,
        symptoms: [],
        triggers: [],
        aura: null,
        notes: '',
        source: 'manual',
      }],
      settings: { weather: ENABLED_WEATHER },
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(currentStore().state.weather).toEqual(ENABLED_WEATHER);
  });

  it('restores weather settings and sends them in the restore payload', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      settings: { weather: ENABLED_WEATHER },
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const backup = parsedWeatherBackup({
      enabled: true,
      location: { ...BOSTON, name: 'Salem' },
      pressureDropThresholdHpa: 7,
    });
    api.restoreAll.mockResolvedValue({
      ...emptyExport(),
      schemaVersion: 4,
      exportedAt: '2026-10-25T12:00:00.000Z',
      settings: {
        weather: {
          enabled: true,
          location: { ...BOSTON, name: 'Salem' },
          pressureDropThresholdHpa: 7,
        },
      },
    });

    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    expect(api.restoreAll).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        weather: {
          enabled: true,
          location: { ...BOSTON, name: 'Salem' },
          pressureDropThresholdHpa: 7,
        },
      }),
    }));
    expect(currentStore().state.weather.location?.name).toBe('Salem');
    expect(currentStore().state.weather.pressureDropThresholdHpa).toBe(7);
  });
});
