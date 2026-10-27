// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';

/**
 * The demo provider must be a completely local, ephemeral store: synthetic
 * seed data on mount, ordinary mutations in memory, clean sync state, and no
 * localStorage/network access at all.
 */

const apiMock = vi.hoisted(() => {
  const names = [
    'getHealth', 'getWeather', 'geocodeWeather',
    'exportAll', 'importAll', 'restoreAll', 'resetAll',
    'addAttack', 'patchAttack', 'deleteAttack',
    'addMed', 'patchMed', 'deleteMed',
    'addRefill', 'patchRefill', 'deleteRefill',
    'addStockBaseline', 'patchStockBaseline', 'deleteStockBaseline',
    'addWorkout', 'patchWorkout', 'deleteWorkout',
    'listWorkouts', 'listDayStates', 'putDayState', 'putSetting',
  ] as const;
  return Object.fromEntries(names.map((name) => [name, vi.fn()])) as
    Record<(typeof names)[number], ReturnType<typeof vi.fn>>;
});

vi.mock('@/lib/api', () => ({ api: apiMock }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { StoreProvider, useStore } from '@/lib/store';
import { buildDemoData, buildDemoState } from '@/lib/demo';
import { nurtecInventory } from '@/lib/inventory';
import type { TrackerState } from '@/types';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../../shared/inventory.ts';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';
import { DEFAULT_WEATHER_SETTINGS } from '../../shared/weather.ts';

let captured: StoreApi | null = null;

function captureStore(next: StoreApi): void {
  captured = next;
}

function Probe({ capture }: { capture: (store: StoreApi) => void }) {
  const store = useStore();
  capture(store);
  return <div data-testid="attack-count">{store.state.attacks.length}</div>;
}

function renderDemo() {
  return render(
    <StoreProvider demo>
      <Probe capture={captureStore} />
    </StoreProvider>,
  );
}

function apiCalls(): number {
  return Object.values(apiMock).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

function emptyState(): TrackerState {
  return {
    attacks: [], meds: [], refills: [], workouts: [], dayStates: [],
    stockBaselines: [], rules: {}, doses: {}, planned: {},
    timezone: 'UTC',
    lowStockThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
    reminders: { ...DEFAULT_REMINDER_SETTINGS },
    weather: { ...DEFAULT_WEATHER_SETTINGS },
    lowStockAlertedAt: null,
    seeded: false,
  };
}

let storageGet: ReturnType<typeof vi.spyOn>;
let storageSet: ReturnType<typeof vi.spyOn>;
let storageRemove: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  captured = null;
  storageGet = vi.spyOn(Storage.prototype, 'getItem');
  storageSet = vi.spyOn(Storage.prototype, 'setItem');
  storageRemove = vi.spyOn(Storage.prototype, 'removeItem');
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('demo initial data', () => {
  it('composes the normal defaults with complete synthetic records', () => {
    const state = buildDemoState(emptyState());
    const extra = buildDemoData();

    expect(state.seeded).toBe(true);
    expect(state.attacks.length).toBe(extra.attacks.length);
    expect(state.attacks.length).toBeGreaterThan(0);
    expect(state.meds.length).toBeGreaterThan(0);
    expect(state.refills.length).toBeGreaterThan(0);
    expect(state.workouts.length).toBeGreaterThan(0);
    expect(state.dayStates.length).toBeGreaterThan(0);
    expect(state.stockBaselines.length).toBeGreaterThan(0);
    // Defaults the demo deliberately keeps: weather disabled and stock healthy.
    expect(state.weather).toEqual(DEFAULT_WEATHER_SETTINGS);
    expect(state.reminders).toEqual(DEFAULT_REMINDER_SETTINGS);
    const stock = nurtecInventory(state, Date.now());
    expect(stock.status).toBe('known');
    expect(stock.level).toBe('ok');
    expect(stock.quantity).toBeGreaterThan(state.lowStockThreshold);
  });

  it('mounts a clean local store without storage, hydration, or network access', async () => {
    renderDemo();

    await waitFor(() => expect(captured).not.toBeNull());
    const store = captured!;

    expect(store.demo).toBe(true);
    expect(store.serverMode).toBe(false);
    expect(store.state.seeded).toBe(true);
    expect(store.state.attacks.length).toBeGreaterThan(0);
    expect(store.sync).toMatchObject({
      pending: 0, dirty: false, failed: false, diverged: false,
    });

    await waitFor(() => expect(apiCalls()).toBe(0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
  });
});

describe('demo mutations', () => {
  it('applies ordinary writer actions in memory while staying clean and offline', async () => {
    renderDemo();
    await waitFor(() => expect(captured).not.toBeNull());
    const store = captured!;
    const attacksBefore = store.state.attacks.length;
    const medsBefore = store.state.meds.length;

    act(() => {
      store.startAttack(new Date('2026-10-20T09:00:00.000Z'));
      store.logMed('nurtec', new Date('2026-10-20T10:00:00.000Z'));
      store.setDayState('2026-10-20', 'well', 'demo check-in');
      store.setRule('nurtec', 12, 30);
      store.setLowStockThreshold(3);
    });

    await waitFor(() => {
      expect(captured!.state.attacks.length).toBe(attacksBefore + 1);
      expect(captured!.state.meds.length).toBe(medsBefore + 1);
    });
    const state = captured!.state;
    expect(state.dayStates.find((d) => d.day === '2026-10-20')?.status).toBe('well');
    expect(state.rules.nurtec).toEqual({ limit: 12, windowDays: 30 });
    expect(state.lowStockThreshold).toBe(3);

    // Every queued "server" task resolves as confirmed without touching the
    // backend or the sync latches.
    await waitFor(() => {
      expect(captured!.sync).toEqual({
        status: 'local', pending: 0, dirty: false, failed: false, diverged: false,
      });
    });
    expect(apiCalls()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
  });

  it('resolves server-only conflict resolution as a no-op', async () => {
    renderDemo();
    await waitFor(() => expect(captured).not.toBeNull());

    await act(async () => {
      await captured!.resolveUseServer();
    });

    expect(apiMock.exportAll).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('demo reset and remount', () => {
  it('erases in memory, then restores the sample seed on remount', async () => {
    const view = renderDemo();
    await waitFor(() => expect(captured).not.toBeNull());
    const seededAttacks = captured!.state.attacks.length;
    expect(seededAttacks).toBeGreaterThan(0);

    await act(async () => {
      await captured!.resetAll();
    });

    expect(captured!.state.attacks).toHaveLength(0);
    expect(captured!.state.meds).toHaveLength(0);
    expect(captured!.state.dayStates).toHaveLength(0);
    expect(captured!.sync).toEqual({
      status: 'local', pending: 0, dirty: false, failed: false, diverged: false,
    });
    expect(apiMock.resetAll).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();

    view.unmount();
    captured = null;
    renderDemo();

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.state.attacks.length).toBe(seededAttacks);
    expect(captured!.state.seeded).toBe(true);
    expect(screen.getByTestId('attack-count').textContent).toBe(String(seededAttacks));

    expect(apiCalls()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
  });
});
