// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { ParsedBackup } from '../../shared/backup.ts';
import type {
  Attack, DayState, MedEvent, Refill, StockBaseline, TrackerState, Workout,
} from '@/types';
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const STORAGE_KEY = 'migraine-tracker-v1';
const SYNC_META_KEY = 'migraine-tracker-sync-v1';
const LATCH_PENDING_KEY = 'migraine-tracker-lowstock-pending-v1';
const WRITER_KEYS = [STORAGE_KEY, SYNC_META_KEY, LATCH_PENDING_KEY];

let api: MockedBackend;
let storeModule: StoreModule;
let captured: StoreApi | null = null;

function Probe() {
  captured = storeModule.useStore();
  return null;
}

function mountViewer(): void {
  const { ReadOnlyStoreProvider } = storeModule;
  render(
    <ReadOnlyStoreProvider>
      <Probe />
    </ReadOnlyStoreProvider>,
  );
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeAttack(id: string, overrides: Partial<Attack> = {}): Attack {
  return {
    id,
    start: '2026-10-20T08:00:00.000Z',
    end: null,
    painLog: [],
    peakPain: -1,
    symptoms: [],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
    ...overrides,
  };
}

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

function writerState(): TrackerState {
  return {
    attacks: [makeAttack('writer-local-attack')],
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
  };
}

function applyApiDefaults(backend: MockedBackend): void {
  backend.exportAll.mockResolvedValue(emptyExport());
  backend.importAll.mockResolvedValue(undefined);
  backend.restoreAll.mockResolvedValue(emptyExport());
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

function expectNoWriterApiCalls(): void {
  expect(api.importAll).not.toHaveBeenCalled();
  expect(api.restoreAll).not.toHaveBeenCalled();
  expect(api.resetAll).not.toHaveBeenCalled();
  expect(api.addAttack).not.toHaveBeenCalled();
  expect(api.patchAttack).not.toHaveBeenCalled();
  expect(api.deleteAttack).not.toHaveBeenCalled();
  expect(api.addMed).not.toHaveBeenCalled();
  expect(api.patchMed).not.toHaveBeenCalled();
  expect(api.deleteMed).not.toHaveBeenCalled();
  expect(api.addRefill).not.toHaveBeenCalled();
  expect(api.patchRefill).not.toHaveBeenCalled();
  expect(api.deleteRefill).not.toHaveBeenCalled();
  expect(api.addStockBaseline).not.toHaveBeenCalled();
  expect(api.patchStockBaseline).not.toHaveBeenCalled();
  expect(api.deleteStockBaseline).not.toHaveBeenCalled();
  expect(api.addWorkout).not.toHaveBeenCalled();
  expect(api.patchWorkout).not.toHaveBeenCalled();
  expect(api.deleteWorkout).not.toHaveBeenCalled();
  expect(api.putDayState).not.toHaveBeenCalled();
  expect(api.putSetting).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('ReadOnlyStoreProvider', () => {
  it('maps the canonical server snapshot and exposes viewer-only sync flags', async () => {
    const attack = makeAttack('server-attack');
    const med: MedEvent = {
      id: 'server-med', medId: 'nurtec', ts: '2026-10-20T09:00:00.000Z',
      dose: '75 mg', quantity: 1, attackId: attack.id, notes: '', source: 'manual',
    };
    const workout: Workout = {
      id: 'server-workout', performedAt: '2026-10-20T17:00:00.000Z',
      kind: 'strength', effort: 'medium', durationMinutes: 30, notes: '', source: 'manual',
    };
    const dayState: DayState = {
      day: '2026-10-20', status: 'attack', notes: '', updatedAt: '2026-10-20T18:00:00.000Z',
    };
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [attack],
      meds: [med],
      workouts: [workout],
      dayStates: [dayState],
      settings: {
        timezone: 'Asia/Tokyo',
        rules: { nurtec: { limit: 12, windowDays: 30 } },
      },
    });

    mountViewer();
    await waitFor(() => expect(captured?.sync.status).toBe('synced'));

    const store = captured!;
    expect(store.readOnly).toBe(true);
    expect(store.serverMode).toBe(true);
    expect(store.state.attacks).toEqual([attack]);
    expect(store.state.meds).toEqual([med]);
    expect(store.state.workouts).toEqual([workout]);
    expect(store.state.dayStates).toEqual([dayState]);
    expect(store.state.timezone).toBe('Asia/Tokyo');
    expect(store.state.rules.nurtec).toEqual({ limit: 12, windowDays: 30 });
    expect(store.sync).toEqual({
      status: 'synced', pending: 0, dirty: false, failed: false, diverged: false,
    });
    expect(api.exportAll).toHaveBeenCalledTimes(1);
    expectNoWriterApiCalls();
  });

  it('never reads or writes the writer localStorage keys, even when they are pre-seeded', async () => {
    const seededState = JSON.stringify(writerState());
    localStorage.setItem(STORAGE_KEY, seededState);
    localStorage.setItem(SYNC_META_KEY, JSON.stringify({ dirty: true, failed: true }));
    localStorage.setItem(LATCH_PENDING_KEY, JSON.stringify({ latchedAt: '2026-10-01T00:00:00.000Z' }));

    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');

    mountViewer();
    await waitFor(() => expect(captured?.sync.status).toBe('synced'));

    const getWriterKeys = () => getItem.mock.calls.filter(([key]) => WRITER_KEYS.includes(key));
    const setWriterKeys = () => setItem.mock.calls.filter(([key]) => WRITER_KEYS.includes(key));
    const removeWriterKeys = () => removeItem.mock.calls.filter(([key]) => WRITER_KEYS.includes(key));
    expect(getWriterKeys()).toHaveLength(0);
    expect(setWriterKeys()).toHaveLength(0);
    expect(removeWriterKeys()).toHaveLength(0);

    // The viewer did not adopt, clear, or overwrite any of the seeded values.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(seededState);
    expect(localStorage.getItem(SYNC_META_KEY)).toBe(JSON.stringify({ dirty: true, failed: true }));
    expect(localStorage.getItem(LATCH_PENDING_KEY)).toBe(JSON.stringify({ latchedAt: '2026-10-01T00:00:00.000Z' }));

    // A seeded non-empty local cache must not trigger a first-contact upload.
    expectNoWriterApiCalls();
    expect(captured!.state.attacks).toEqual([]);
  });

  it('refreshes periodically, on focus, and on visible visibilitychange', async () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('first')] });

    mountViewer();
    await waitFor(() => expect(captured?.sync.status).toBe('synced'));
    expect(captured!.state.attacks.map((a) => a.id)).toEqual(['first']);

    const refreshTimer = intervalSpy.mock.calls.find(([, ms]) => ms === 20000);
    expect(refreshTimer).toBeTruthy();

    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('periodic')] });
    await act(async () => {
      (refreshTimer![0] as () => void)();
      await Promise.resolve();
    });
    await waitFor(() => expect(captured!.state.attacks.map((a) => a.id)).toEqual(['periodic']));

    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('focused')] });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await waitFor(() => expect(captured!.state.attacks.map((a) => a.id)).toEqual(['focused']));

    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('visible')] });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await waitFor(() => expect(captured!.state.attacks.map((a) => a.id)).toEqual(['visible']));
  });

  it('does not overlap requests while one refresh is in flight', async () => {
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('initial')] });
    mountViewer();
    await waitFor(() => expect(captured?.sync.status).toBe('synced'));
    expect(api.exportAll).toHaveBeenCalledTimes(1);

    const pending = createDeferred<ReturnType<typeof emptyExport>>();
    api.exportAll.mockReturnValue(pending.promise);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(api.exportAll).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending.resolve({ ...emptyExport(), attacks: [makeAttack('second')] });
    });
    await waitFor(() => expect(captured!.state.attacks.map((a) => a.id)).toEqual(['second']));

    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('third')] });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await waitFor(() => expect(captured!.state.attacks.map((a) => a.id)).toEqual(['third']));
    expect(api.exportAll).toHaveBeenCalledTimes(3);
  });

  it('keeps the last successful snapshot (without writer latches) when a later refresh fails', async () => {
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('kept')] });
    mountViewer();
    await waitFor(() => expect(captured?.sync.status).toBe('synced'));

    api.exportAll.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(captured?.sync.status).toBe('error'));

    expect(captured!.serverMode).toBe(true);
    expect(captured!.state.attacks.map((a) => a.id)).toEqual(['kept']);
    expect(captured!.sync).toEqual({
      status: 'error', pending: 0, dirty: false, failed: false, diverged: false,
    });
    expectNoWriterApiCalls();
  });

  it('reports unavailable (not local) when the very first snapshot fails', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));
    mountViewer();
    await waitFor(() => expect(captured?.sync.status).toBe('error'));

    expect(captured!.serverMode).toBe(false);
    expect(captured!.readOnly).toBe(true);
    expect(captured!.state.attacks).toEqual([]);
    expect(captured!.sync).toEqual({
      status: 'error', pending: 0, dirty: false, failed: false, diverged: false,
    });
    expectNoWriterApiCalls();
  });

  it('throws from every mutation and never calls a writer API', async () => {
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('snapshot')] });
    mountViewer();
    await waitFor(() => expect(captured?.sync.status).toBe('synced'));

    const store = captured!;
    const attempts: Array<[string, () => unknown]> = [
      ['startAttack', () => store.startAttack()],
      ['endAttack', () => store.endAttack('a')],
      ['updateAttack', () => store.updateAttack('a', { notes: 'x' })],
      ['deleteAttack', () => store.deleteAttack('a')],
      ['logPain', () => store.logPain('a', 5)],
      ['logMed', () => store.logMed('nurtec')],
      ['updateMed', () => store.updateMed('m', { notes: 'x' })],
      ['deleteMed', () => store.deleteMed('m')],
      ['addRefill', () => store.addRefill('nurtec', '2026-10-20')],
      ['updateRefill', () => store.updateRefill('r', { notes: 'x' })],
      ['deleteRefill', () => store.deleteRefill('r')],
      ['addStockBaseline', () => store.addStockBaseline({ medId: 'nurtec', quantity: 1 })],
      ['updateStockBaseline', () => store.updateStockBaseline('b', { quantity: 2 })],
      ['deleteStockBaseline', () => store.deleteStockBaseline('b')],
      ['addWorkout', () => store.addWorkout({ kind: 'cardio', effort: 'low' })],
      ['updateWorkout', () => store.updateWorkout('w', { notes: 'x' })],
      ['deleteWorkout', () => store.deleteWorkout('w')],
      ['setDayState', () => store.setDayState('2026-10-20', 'well')],
      ['setTimezone', () => store.setTimezone('UTC')],
      ['setLowStockThreshold', () => store.setLowStockThreshold(2)],
      ['updateReminders', () => store.updateReminders({})],
      ['resetLowStockAlert', () => store.resetLowStockAlert()],
      ['importData', () => store.importData([], [])],
      ['setRule', () => store.setRule('nurtec', 15, 30)],
      ['setDoseDefault', () => store.setDoseDefault('nurtec', '75 mg')],
      ['setPlannedDose', () => store.setPlannedDose('nurtec', null)],
      ['loadDemoData', () => store.loadDemoData()],
      ['resetAll', () => store.resetAll()],
    ];

    for (const [name, attempt] of attempts) {
      let message = '';
      try {
        attempt();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, name).toMatch(/read-only/i);
    }
    await expect(store.resolveUseServer()).rejects.toThrow(/read-only/i);

    expect(store.state.attacks.map((a) => a.id)).toEqual(['snapshot']);
    expectNoWriterApiCalls();
    expect(api.exportAll).toHaveBeenCalledTimes(1);
  });

  it('denies JSON backup merge and replace on the viewer contract', async () => {
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('snapshot')] });
    mountViewer();
    await waitFor(() => expect(captured?.sync.status).toBe('synced'));

    const store = captured!;
    const backup = {
      duplicateCounts: {
        attacks: 0, meds: 0, refills: 0, workouts: 0, dayStates: 0, stockBaselines: 0,
      },
    } as unknown as ParsedBackup;

    expect(() => store.mergeBackup(backup)).toThrow(/read-only/i);
    await expect(store.replaceBackup(backup)).rejects.toThrow(/read-only/i);

    expect(store.state.attacks.map((a) => a.id)).toEqual(['snapshot']);
    expectNoWriterApiCalls();
  });
});
