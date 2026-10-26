// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { Attack, DayState, StockBaseline, TrackerState, Workout } from '@/types';
import { currentStock } from '../../shared/inventory.ts';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

// The store calls every backend method (some unconditionally chain `.catch`),
// so each one must be a mock that returns a promise. The factory is hoisted and
// self-contained; implementations are (re)applied per test after resetModules.
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const STORAGE_KEY = 'migraine-tracker-v1';
const SYNC_META_KEY = 'migraine-tracker-sync-v1';
const LATCH_PENDING_KEY = 'migraine-tracker-lowstock-pending-v1';

// Fresh module instances per test: store.tsx keeps a module-level hydration
// guard, so a cached instance would never hydrate twice.
let api: MockedBackend;
let storeModule: StoreModule;
let captured: StoreApi | null = null;

function currentStore(): StoreApi {
  if (captured === null) throw new Error('StoreProvider has not rendered yet');
  return captured;
}

function captureStore(next: StoreApi): void {
  captured = next;
}

function Probe({ capture }: { capture: (storeApi: StoreApi) => void }) {
  const storeApi = storeModule.useStore();
  capture(storeApi);
  return null;
}

function mountStore(): void {
  const { StoreProvider } = storeModule;
  render(
    <StoreProvider>
      <Probe capture={captureStore} />
    </StoreProvider>,
  );
}

/** Production mounts under React.StrictMode (src/main.tsx); mirror that. */
function mountStoreStrict(): void {
  const { StoreProvider } = storeModule;
  render(
    <StrictMode>
      <StoreProvider>
        <Probe capture={captureStore} />
      </StoreProvider>
    </StrictMode>,
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

function emptyExport() {
  return {
    attacks: [] as Attack[],
    meds: [] as TrackerState['meds'],
    refills: [] as TrackerState['refills'],
    workouts: [] as TrackerState['workouts'],
    dayStates: [] as TrackerState['dayStates'],
    stockBaselines: [] as TrackerState['stockBaselines'],
    settings: {} as Record<string, unknown>,
  };
}

function makeAttack(id: string): Attack {
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
  };
}

function persistedState(attacks: Attack[]): TrackerState {
  return {
    attacks,
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

function makeWorkout(id: string, overrides: Partial<Workout> = {}): Workout {
  return {
    id,
    performedAt: '2026-10-20T17:00:00.000Z',
    kind: 'strength',
    effort: 'medium',
    durationMinutes: 45,
    notes: '',
    source: 'manual',
    ...overrides,
  };
}

function makeDayState(day: string, overrides: Partial<DayState> = {}): DayState {
  return {
    day,
    status: 'well',
    notes: '',
    updatedAt: '2026-10-20T18:00:00.000Z',
    ...overrides,
  };
}

/** Fixed offsets around the real clock keep inventory instants deterministic. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A 'YYYY-MM-DD' day key a few days in the past (refills are date-only). */
function dayKeyDaysAgo(days: number): string {
  return daysAgo(days).slice(0, 10);
}

function makeStockBaseline(id: string, quantity: number, effectiveAt: string): StockBaseline {
  return {
    id,
    medId: 'nurtec',
    effectiveAt,
    quantity,
    notes: '',
    source: 'manual',
    createdAt: effectiveAt,
  };
}

/** Low-stock setting writes only (hydration may also write the timezone). */
function lowStockWrites(): unknown[][] {
  return api.putSetting.mock.calls.filter((call) => call[0] === 'lowStockAlert');
}

function readPendingLatch(): { latchedAt: string } | null {
  const raw = localStorage.getItem(LATCH_PENDING_KEY);
  return raw === null ? null : (JSON.parse(raw) as { latchedAt: string });
}

/**
 * Simulate a reload: fresh module instances (the store keeps a module-level
 * hydration guard) and fresh backend mocks, while localStorage survives.
 */
async function reloadStore(): Promise<void> {
  cleanup();
  vi.resetModules();
  // resetModules resets the module registry but NOT module-mock vi.fn call
  // history (the hoisted factories are reused), so session 1's toasts would
  // still be visible to session 2. Clear history before re-applying the
  // backend mock implementations below.
  vi.clearAllMocks();
  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  storeModule = await import('@/lib/store');
  captured = null;
}

/**
 * Session 1 of the reload scenarios: go offline with a low applicable
 * baseline, let the latch toast locally, and return the latched instant.
 */
async function mountOfflineLatched(): Promise<string> {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...persistedState([]),
    stockBaselines: [makeStockBaseline('b-offline', 2, daysAgo(10))],
  }));
  api.exportAll.mockRejectedValue(new Error('offline'));
  mountStore();
  await waitFor(() => expect(currentStore().state.lowStockAlertedAt).not.toBeNull());
  const latch = currentStore().state.lowStockAlertedAt as string;
  // The latch is queued in DURABLE bookkeeping, not just memory.
  expect(readPendingLatch()).toEqual({ latchedAt: latch });
  return latch;
}

function readPersistedState(): TrackerState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) throw new Error('state was not persisted to localStorage');
  return JSON.parse(raw) as TrackerState;
}

function readSyncMeta(): { dirty: boolean; failed: boolean } {
  const raw = localStorage.getItem(SYNC_META_KEY);
  if (raw === null) throw new Error('sync meta was not persisted to localStorage');
  return JSON.parse(raw) as { dirty: boolean; failed: boolean };
}

function applyApiDefaults(backend: MockedBackend): void {
  backend.exportAll.mockResolvedValue(emptyExport());
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

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;

  const apiModule = await import('@/lib/api');
  api = apiModule.api as unknown as MockedBackend;
  applyApiDefaults(api);

  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('StoreProvider sync state and persistence', () => {
  it('persists a mutation to localStorage and reloads it on a fresh mount', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().startAttack();
    });
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));

    const persisted = readPersistedState();
    expect(persisted.attacks).toHaveLength(1);
    const persistedId = persisted.attacks[0].id;
    expect(currentStore().state.attacks.map((attack) => attack.id)).toEqual([persistedId]);

    // Remount with a brand-new store module instance on the same localStorage.
    cleanup();
    captured = null;
    vi.resetModules();
    api = (await import('@/lib/api')).api as unknown as MockedBackend;
    applyApiDefaults(api);
    storeModule = await import('@/lib/store');

    mountStore();

    // loadState runs in useState's initializer, so the cached attack is present
    // synchronously — before the fresh hydration request resolves.
    expect(currentStore().state.attacks.map((attack) => attack.id)).toEqual([persistedId]);

    // Let the new instance's hydration settle so no work leaks into later tests.
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
  });

  it('reports dirty + pending until the deferred server write is confirmed', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const write = createDeferred<unknown>();
    api.addAttack.mockReturnValueOnce(write.promise);

    await act(async () => {
      currentStore().startAttack();
    });

    const before = currentStore().sync;
    expect(before.status).toBe('syncing');
    expect(before.pending).toBe(1);
    expect(before.dirty).toBe(true);
    expect(before.failed).toBe(false);
    expect(before.diverged).toBe(false);

    await act(async () => {
      write.resolve(undefined);
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const after = currentStore().sync;
    expect(after.pending).toBe(0);
    expect(after.dirty).toBe(false);
    expect(after.failed).toBe(false);
  });

  it('keeps dirty + failed/error after a later write succeeds', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    api.addAttack.mockRejectedValueOnce(new Error('server unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      currentStore().startAttack();
      currentStore().logMed('nurtec');
    });

    await waitFor(() => {
      expect(currentStore().sync.pending).toBe(0);
      expect(currentStore().sync.failed).toBe(true);
    });

    const sync = currentStore().sync;
    expect(sync.dirty).toBe(true);
    expect(sync.failed).toBe(true);
    expect(sync.status).toBe('error');
    expect(api.addMed).toHaveBeenCalledTimes(1);
    // The store logs the expected failure; it is not a test failure.
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('does not clean dirty after a successful upload while a later write is unconfirmed', async () => {
    const seededAttack = makeAttack('seed-attack');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState([seededAttack])));

    const upload = createDeferred<unknown>();
    const refillWrite = createDeferred<unknown>();
    api.importAll.mockReturnValueOnce(upload.promise);
    api.addRefill.mockReturnValueOnce(refillWrite.promise);

    mountStore();

    // First contact with an empty server uploads the local snapshot.
    await waitFor(() => expect(currentStore().sync.pending).toBe(1));
    await waitFor(() => expect(api.importAll).toHaveBeenCalledTimes(1));
    expect(api.importAll).toHaveBeenCalledWith(
      expect.objectContaining({ attacks: [seededAttack] }),
    );
    expect(currentStore().sync.dirty).toBe(true);

    // Queue a second write behind the still-in-flight upload.
    await act(async () => {
      currentStore().addRefill('nurtec', '2026-10-25');
    });
    expect(currentStore().sync.pending).toBe(2);

    await act(async () => {
      upload.resolve(undefined);
    });

    await waitFor(() => {
      expect(api.addRefill).toHaveBeenCalledTimes(1);
      expect(api.putSetting).toHaveBeenCalledTimes(7);
      expect(api.putSetting).toHaveBeenCalledWith('reminders', DEFAULT_REMINDER_SETTINGS);
      expect(currentStore().sync.pending).toBe(1);
    });

    // Upload success with a later unconfirmed write must not clean the latch.
    expect(currentStore().sync.dirty).toBe(true);
    expect(currentStore().sync.failed).toBe(false);
    expect(currentStore().sync.status).toBe('syncing');

    await act(async () => {
      refillWrite.resolve(undefined);
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(currentStore().sync.dirty).toBe(false);
    expect(currentStore().sync.failed).toBe(false);
  });

  it('uploads a settings-only dirty cache on first contact', async () => {
    // decideHydration(true, false, true) is already covered by the pure test in
    // shared/sync.test.ts; this exercises the real provider path it drives.
    localStorage.setItem(SYNC_META_KEY, JSON.stringify({ dirty: true, failed: false }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    expect(api.importAll).toHaveBeenCalledTimes(1);
    expect(api.importAll).toHaveBeenCalledWith({
      attacks: [], meds: [], refills: [], workouts: [], dayStates: [],
      stockBaselines: [],
    });
    expect(api.putSetting).toHaveBeenCalledTimes(7);
    expect(api.putSetting).toHaveBeenCalledWith('reminders', DEFAULT_REMINDER_SETTINGS);
    expect(api.putSetting).toHaveBeenCalledWith('lowStockThreshold', 2);
    expect(api.putSetting).toHaveBeenCalledWith('lowStockAlert', { latchedAt: null });

    const sync = currentStore().sync;
    expect(sync.dirty).toBe(false);
    expect(sync.failed).toBe(false);
    expect(sync.pending).toBe(0);
    expect(currentStore().serverMode).toBe(true);
  });

  it('latches dirty + failed locally when the server is unreachable', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));

    mountStore();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore().serverMode).toBe(false);

    await act(async () => {
      currentStore().startAttack();
    });

    const sync = currentStore().sync;
    expect(sync.status).toBe('local');
    expect(sync.dirty).toBe(true);
    expect(sync.failed).toBe(true);
    expect(sync.pending).toBe(0);
    expect(api.addAttack).not.toHaveBeenCalled();

    const meta = localStorage.getItem(SYNC_META_KEY);
    expect(meta).not.toBeNull();
    expect(JSON.parse(meta as string)).toEqual({ dirty: true, failed: true });
  });

  it('resolves an earlier offline failure after a full first-contact exchange even with a later write queued', async () => {
    const seededAttack = makeAttack('seed-attack');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState([seededAttack])));
    // Latch left behind by an earlier offline session.
    localStorage.setItem(SYNC_META_KEY, JSON.stringify({ dirty: true, failed: true }));

    const upload = createDeferred<unknown>();
    const refillWrite = createDeferred<unknown>();
    api.importAll.mockReturnValueOnce(upload.promise);
    api.addRefill.mockReturnValueOnce(refillWrite.promise);

    mountStore();

    await waitFor(() => expect(currentStore().sync.pending).toBe(1));
    await waitFor(() => expect(api.importAll).toHaveBeenCalledTimes(1));

    // Queue a later write behind the still-in-flight upload.
    await act(async () => {
      currentStore().addRefill('nurtec', '2026-10-25');
    });
    expect(currentStore().sync.pending).toBe(2);

    await act(async () => {
      upload.resolve(undefined);
    });

    await waitFor(() => {
      expect(api.putSetting).toHaveBeenCalledTimes(7);
      expect(api.putSetting).toHaveBeenCalledWith('reminders', DEFAULT_REMINDER_SETTINGS);
      expect(api.addRefill).toHaveBeenCalledTimes(1);
      expect(currentStore().sync.pending).toBe(1);
      expect(currentStore().sync.failed).toBe(false);
    });

    // The confirmed full exchange resolves the earlier failure latch even
    // while the later write is still unconfirmed; dirty stays set.
    expect(currentStore().sync.dirty).toBe(true);
    expect(currentStore().sync.failed).toBe(false);
    expect(currentStore().sync.status).toBe('syncing');

    await act(async () => {
      refillWrite.resolve(undefined);
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const sync = currentStore().sync;
    expect(sync.pending).toBe(0);
    expect(sync.dirty).toBe(false);
    expect(sync.failed).toBe(false);
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('re-latches dirty + failed when a later write rejects after the first-contact exchange succeeded', async () => {
    const seededAttack = makeAttack('seed-attack');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState([seededAttack])));
    localStorage.setItem(SYNC_META_KEY, JSON.stringify({ dirty: true, failed: true }));

    const upload = createDeferred<unknown>();
    const refillWrite = createDeferred<unknown>();
    api.importAll.mockReturnValueOnce(upload.promise);
    api.addRefill.mockReturnValueOnce(refillWrite.promise);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    mountStore();

    await waitFor(() => expect(currentStore().sync.pending).toBe(1));
    await waitFor(() => expect(api.importAll).toHaveBeenCalledTimes(1));

    await act(async () => {
      currentStore().addRefill('nurtec', '2026-10-25');
    });
    expect(currentStore().sync.pending).toBe(2);

    await act(async () => {
      upload.resolve(undefined);
    });

    await waitFor(() => {
      expect(api.putSetting).toHaveBeenCalledTimes(7);
      expect(api.putSetting).toHaveBeenCalledWith('reminders', DEFAULT_REMINDER_SETTINGS);
      expect(api.addRefill).toHaveBeenCalledTimes(1);
      expect(currentStore().sync.pending).toBe(1);
      expect(currentStore().sync.failed).toBe(false);
    });
    expect(currentStore().sync.dirty).toBe(true);

    await act(async () => {
      refillWrite.reject(new Error('server unavailable'));
    });

    await waitFor(() => {
      expect(currentStore().sync.pending).toBe(0);
      expect(currentStore().sync.failed).toBe(true);
    });

    const sync = currentStore().sync;
    expect(sync.dirty).toBe(true);
    expect(sync.failed).toBe(true);
    expect(sync.status).toBe('error');
    expect(readSyncMeta()).toEqual({ dirty: true, failed: true });
    // The store logs the expected failure; it is not a test failure.
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('pauses backend writes and keeps local state while diverged', async () => {
    const localAttack = makeAttack('local-attack');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState([localAttack])));
    localStorage.setItem(SYNC_META_KEY, JSON.stringify({ dirty: true, failed: true }));
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('server-attack')],
    });

    mountStore();

    await waitFor(() => expect(currentStore().sync.status).toBe('conflict'));
    expect(currentStore().sync.diverged).toBe(true);
    expect(currentStore().serverMode).toBe(true);

    await act(async () => {
      currentStore().startAttack();
    });

    // The mutation applies locally despite the write pause.
    const ids = currentStore().state.attacks.map((attack) => attack.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('local-attack');
    expect(ids).not.toContain('server-attack');

    expect(api.addAttack).not.toHaveBeenCalled();

    const sync = currentStore().sync;
    expect(sync.pending).toBe(0);
    expect(sync.dirty).toBe(true);
    expect(sync.failed).toBe(true);
    expect(sync.diverged).toBe(true);
    expect(sync.status).toBe('conflict');
  });

  it('keeps local data and the divergence latches when resolveUseServer cannot reach the server', async () => {
    const localAttack = makeAttack('local-attack');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState([localAttack])));
    localStorage.setItem(SYNC_META_KEY, JSON.stringify({ dirty: true, failed: true }));
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('server-attack')],
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('conflict'));

    // The retry fails too: nothing may be adopted or cleaned.
    api.exportAll.mockRejectedValueOnce(new Error('still offline'));
    const { toast } = await import('sonner');

    await act(async () => {
      await currentStore().resolveUseServer();
    });

    expect(currentStore().state.attacks.map((attack) => attack.id)).toEqual(['local-attack']);

    const sync = currentStore().sync;
    expect(sync.diverged).toBe(true);
    expect(sync.status).toBe('conflict');
    expect(sync.dirty).toBe(true);
    expect(sync.failed).toBe(true);
    expect(readSyncMeta()).toEqual({ dirty: true, failed: true });
    expect(toast.error).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('confirms an online reset and clears the sync latches', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().startAttack();
    });
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));
    expect(currentStore().state.attacks).toHaveLength(1);

    await act(async () => {
      currentStore().resetAll();
    });

    await waitFor(() => {
      expect(api.resetAll).toHaveBeenCalledTimes(1);
      expect(currentStore().sync.status).toBe('synced');
    });

    expect(currentStore().state.attacks).toHaveLength(0);
    expect(currentStore().sync.pending).toBe(0);
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('keeps an offline reset dirty + failed so a later hydration cannot resurrect server records', async () => {
    const localAttack = makeAttack('local-attack');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState([localAttack])));
    api.exportAll.mockRejectedValue(new Error('offline'));

    mountStore();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore().serverMode).toBe(false);

    await act(async () => {
      currentStore().resetAll();
    });

    expect(api.resetAll).not.toHaveBeenCalled();
    expect(currentStore().state.attacks).toHaveLength(0);
    const offlineSync = currentStore().sync;
    expect(offlineSync.status).toBe('local');
    expect(offlineSync.dirty).toBe(true);
    expect(offlineSync.failed).toBe(true);
    expect(readSyncMeta()).toEqual({ dirty: true, failed: true });
    // The emptied state was persisted, not just held in memory.
    expect(readPersistedState().attacks).toHaveLength(0);

    // Fresh module instance: the server now answers with data, but the
    // unconfirmed local reset must not be overwritten by it.
    cleanup();
    captured = null;
    vi.resetModules();
    api = (await import('@/lib/api')).api as unknown as MockedBackend;
    applyApiDefaults(api);
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('server-attack')],
    });
    storeModule = await import('@/lib/store');

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('conflict'));

    expect(currentStore().sync.diverged).toBe(true);
    expect(currentStore().serverMode).toBe(true);
    expect(currentStore().state.attacks).toHaveLength(0);
    expect(readSyncMeta()).toEqual({ dirty: true, failed: true });
  });
});

describe('workouts and day states', () => {
  it('adds workouts locally, sends them to the server, and returns to synced', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    let lateId = '';
    let earlyId = '';
    await act(async () => {
      lateId = currentStore().addWorkout({
        performedAt: '2026-10-22T17:00:00.000Z',
        kind: 'strength',
        effort: 'medium',
        durationMinutes: 45,
        notes: 'gym',
      }).id;
      earlyId = currentStore().addWorkout({
        performedAt: '2026-10-18T07:30:00.000Z',
        kind: 'cardio',
        effort: 'low',
      }).id;
    });
    const late = currentStore().state.workouts.find((w) => w.id === lateId);
    const early = currentStore().state.workouts.find((w) => w.id === earlyId);
    if (!late || !early) throw new Error('addWorkout did not apply locally');

    expect(late.source).toBe('manual');
    expect(late.notes).toBe('gym');
    expect(late.durationMinutes).toBe(45);
    expect(late.performedAt).toBe('2026-10-22T17:00:00.000Z');
    expect(early.notes).toBe('');
    expect(early.durationMinutes).toBeNull();

    // Kept sorted by performedAt regardless of insertion order.
    expect(currentStore().state.workouts.map((w) => w.id)).toEqual([early.id, late.id]);

    await waitFor(() => expect(api.addWorkout).toHaveBeenCalledTimes(2));
    expect(api.addWorkout).toHaveBeenCalledWith(expect.objectContaining({
      id: early.id,
      performedAt: '2026-10-18T07:30:00.000Z',
      kind: 'cardio',
      effort: 'low',
      source: 'manual',
    }));

    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(currentStore().sync.pending).toBe(0);
    expect(readPersistedState().workouts.map((w) => w.id)).toEqual([early.id, late.id]);
  });

  it('upserts one day state per day and replaces the previous status', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().setDayState('2026-10-21', 'off', 'rough morning');
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(1));
    expect(api.putDayState).toHaveBeenLastCalledWith('2026-10-21', {
      status: 'off',
      notes: 'rough morning',
    });

    let records = currentStore().state.dayStates;
    expect(records).toHaveLength(1);
    const created = records[0];
    expect(created).toMatchObject({ day: '2026-10-21', status: 'off', notes: 'rough morning' });
    expect(Number.isNaN(Date.parse(created.updatedAt))).toBe(false);

    // Same day again: replaces status, keeps notes, produces a new record.
    await act(async () => {
      currentStore().setDayState('2026-10-21', 'attack');
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(2));
    expect(api.putDayState).toHaveBeenLastCalledWith('2026-10-21', {
      status: 'attack',
      notes: 'rough morning',
    });

    records = currentStore().state.dayStates;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ day: '2026-10-21', status: 'attack', notes: 'rough morning' });
    expect(Date.parse(records[0].updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));

    // A different day is a separate record with empty notes.
    await act(async () => {
      currentStore().setDayState('2026-10-22', 'well');
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(3));
    expect(api.putDayState).toHaveBeenLastCalledWith('2026-10-22', { status: 'well', notes: '' });
    expect(currentStore().state.dayStates).toHaveLength(2);

    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(readPersistedState().dayStates).toHaveLength(2);
  });

  it('latches dirty + failed when setDayState runs offline', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));

    mountStore();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore().serverMode).toBe(false);

    await act(async () => {
      currentStore().setDayState('2026-10-21', 'well');
    });

    expect(currentStore().state.dayStates).toHaveLength(1);
    expect(api.putDayState).not.toHaveBeenCalled();

    const sync = currentStore().sync;
    expect(sync.status).toBe('local');
    expect(sync.pending).toBe(0);
    expect(sync.dirty).toBe(true);
    expect(sync.failed).toBe(true);
    expect(readSyncMeta()).toEqual({ dirty: true, failed: true });
  });

  it('merges a workout update and removes workouts locally + on the server', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    let createdId = '';
    await act(async () => {
      createdId = currentStore().addWorkout({
        performedAt: '2026-10-19T07:00:00.000Z',
        kind: 'cardio',
        effort: 'low',
        durationMinutes: 20,
        notes: 'run',
      }).id;
    });
    const id = createdId;
    await waitFor(() => expect(api.addWorkout).toHaveBeenCalledTimes(1));

    await act(async () => {
      currentStore().updateWorkout(id, { effort: 'hard' });
    });
    await waitFor(() => expect(api.patchWorkout).toHaveBeenCalledTimes(1));
    expect(api.patchWorkout).toHaveBeenCalledWith(id, expect.objectContaining({
      id,
      kind: 'cardio',
      effort: 'hard',
      durationMinutes: 20,
      notes: 'run',
      performedAt: '2026-10-19T07:00:00.000Z',
    }));
    expect(currentStore().state.workouts.find((w) => w.id === id)).toMatchObject({
      kind: 'cardio',
      effort: 'hard',
      durationMinutes: 20,
      notes: 'run',
    });

    await act(async () => {
      currentStore().deleteWorkout(id);
    });
    await waitFor(() => expect(api.deleteWorkout).toHaveBeenCalledWith(id));
    expect(currentStore().state.workouts).toHaveLength(0);
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
  });

  it('hydrates workouts and day states when the server has only those records', async () => {
    const serverWorkout = makeWorkout('server-workout', { notes: 'server workout' });
    const serverDayState = makeDayState('2026-10-21', { status: 'attack', notes: 'server day' });
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      workouts: [serverWorkout],
      dayStates: [serverDayState],
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    // Workouts/day states alone make the server non-empty: hydrate, never upload.
    expect(api.importAll).not.toHaveBeenCalled();
    expect(currentStore().state.workouts).toEqual([serverWorkout]);
    expect(currentStore().state.dayStates).toEqual([serverDayState]);
  });

  it('uploads local workouts and day states on first contact with an empty server', async () => {
    const workout = makeWorkout('local-workout');
    const dayState = makeDayState('2026-10-21', { status: 'off' });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([]),
      workouts: [workout],
      dayStates: [dayState],
    }));

    mountStore();

    await waitFor(() => expect(api.importAll).toHaveBeenCalledTimes(1));
    expect(api.importAll).toHaveBeenCalledWith(expect.objectContaining({
      attacks: [],
      meds: [],
      refills: [],
      workouts: [workout],
      dayStates: [dayState],
    }));

    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(currentStore().state.workouts).toEqual([workout]);
    expect(currentStore().state.dayStates).toEqual([dayState]);
  });

  it('writes the timezone setting and updates local state, ignoring invalid zones', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.putSetting.mockClear();

    await act(async () => {
      currentStore().setTimezone('Asia/Tokyo');
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    expect(api.putSetting).toHaveBeenCalledWith('timezone', 'Asia/Tokyo');
    expect(api.putSetting).toHaveBeenCalledTimes(1);
    expect(currentStore().state.timezone).toBe('Asia/Tokyo');

    await act(async () => {
      currentStore().setTimezone('Not/AZone');
    });
    expect(currentStore().state.timezone).toBe('Asia/Tokyo');
    expect(api.putSetting).toHaveBeenCalledTimes(1);
  });
});

describe('Nurtec inventory and low-stock latch', () => {
  it('decrements optimistic stock with a dose quantity and sends it to the backend', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const effectiveAt = daysAgo(10);
    let baselineId = '';
    await act(async () => {
      baselineId = currentStore().addStockBaseline({
        medId: 'nurtec', effectiveAt, quantity: 10,
      }).id;
    });
    await waitFor(() => expect(api.addStockBaseline).toHaveBeenCalledTimes(1));
    expect(api.addStockBaseline).toHaveBeenCalledWith(expect.objectContaining({
      id: baselineId, medId: 'nurtec', effectiveAt, quantity: 10,
    }));

    await act(async () => {
      currentStore().logMed('nurtec', new Date(), null, '75 mg', '', 1);
    });
    await waitFor(() => expect(api.addMed).toHaveBeenCalledTimes(1));
    expect(api.addMed).toHaveBeenCalledWith(expect.objectContaining({
      medId: 'nurtec', quantity: 1,
    }));

    const state = currentStore().state;
    const stock = currentStock(
      { baselines: state.stockBaselines, doses: state.meds, refills: state.refills },
      { now: Date.now(), timeZone: state.timezone },
    );
    expect(stock.status).toBe('known');
    expect(stock.quantity).toBe(10 - 1);

    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
  });

  it('increments stock with a refill, merges refill edits, and deletes baselines on the server', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const effectiveAt = daysAgo(10);
    let baselineId = '';
    await act(async () => {
      baselineId = currentStore().addStockBaseline({
        medId: 'nurtec', effectiveAt, quantity: 4,
      }).id;
    });
    await waitFor(() => expect(api.addStockBaseline).toHaveBeenCalledTimes(1));

    const pickupDay = dayKeyDaysAgo(3);
    let refillId = '';
    await act(async () => {
      refillId = currentStore().addRefill('nurtec', pickupDay, '', 8).id;
    });
    await waitFor(() => expect(api.addRefill).toHaveBeenCalledTimes(1));
    expect(api.addRefill).toHaveBeenCalledWith(expect.objectContaining({
      id: refillId, medId: 'nurtec', date: pickupDay, quantity: 8,
    }));

    const afterRefill = currentStock(
      {
        baselines: currentStore().state.stockBaselines,
        doses: currentStore().state.meds,
        refills: currentStore().state.refills,
      },
      { now: Date.now(), timeZone: currentStore().state.timezone },
    );
    expect(afterRefill.quantity).toBe(4 + 8);

    await act(async () => {
      currentStore().updateRefill(refillId, { quantity: 6 });
    });
    await waitFor(() => expect(api.patchRefill).toHaveBeenCalledTimes(1));
    expect(api.patchRefill).toHaveBeenCalledWith(refillId, expect.objectContaining({
      id: refillId, medId: 'nurtec', date: pickupDay, quantity: 6,
    }));
    expect(currentStore().state.refills.find((r) => r.id === refillId)).toMatchObject({
      quantity: 6,
    });

    await act(async () => {
      currentStore().deleteStockBaseline(baselineId);
    });
    await waitFor(() => expect(api.deleteStockBaseline).toHaveBeenCalledWith(baselineId));
    expect(currentStore().state.stockBaselines).toHaveLength(0);
    // Without any applicable baseline the stock is unknown, never zero.
    expect(currentStock(
      {
        baselines: currentStore().state.stockBaselines,
        doses: currentStore().state.meds,
        refills: currentStore().state.refills,
      },
      { now: Date.now(), timeZone: currentStore().state.timezone },
    ).status).toBe('unknown');

    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
  });

  it('adopts the server low-stock latch and a valid threshold during hydration', async () => {
    const latchedAt = '2026-10-20T12:00:00.000Z';
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('server-attack')],
      settings: { lowStockAlert: { latchedAt }, lowStockThreshold: 3 },
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    expect(currentStore().state.lowStockAlertedAt).toBe(latchedAt);
    expect(currentStore().state.lowStockThreshold).toBe(3);

    const { toast } = await import('sonner');
    // A persisted latch is not a new crossing — never re-toasted on hydration.
    expect(toast.warning).not.toHaveBeenCalled();
    expect(lowStockWrites()).toHaveLength(0);
  });

  it('keeps the local default threshold and latch when the server values are invalid', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('server-attack')],
      settings: { lowStockThreshold: -1, lowStockAlert: { latchedAt: 42 } },
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    expect(currentStore().state.lowStockThreshold).toBe(2);
    expect(currentStore().state.lowStockAlertedAt).toBeNull();
  });

  it('does nothing while stock is unknown (no baseline): no toast, no write, no latch', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    const { toast } = await import('sonner');

    await act(async () => {
      currentStore().logMed('nurtec', new Date(), null, '75 mg', '', 1);
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    expect(currentStore().state.meds).toHaveLength(1);
    expect(currentStore().state.lowStockAlertedAt).toBeNull();
    expect(lowStockWrites()).toHaveLength(0);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('latches low stock once, toasts once, and persists the latch exactly once', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    const { toast } = await import('sonner');

    await act(async () => {
      currentStore().addStockBaseline({ medId: 'nurtec', effectiveAt: daysAgo(10), quantity: 2 });
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(1));
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const latchedAt = currentStore().state.lowStockAlertedAt;
    expect(typeof latchedAt).toBe('string');
    expect(lowStockWrites()).toEqual([['lowStockAlert', { latchedAt }]]);
    expect(toast.warning).toHaveBeenCalledTimes(1);

    // Continuous low across further state changes must never re-alert or
    // re-write the setting while the effect keeps re-running.
    await act(async () => {
      currentStore().logMed('nurtec', new Date(), null, '75 mg', '', 1);
      currentStore().setTimezone('Asia/Tokyo');
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    expect(currentStore().state.lowStockAlertedAt).toBe(latchedAt);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(lowStockWrites()).toHaveLength(1);
  });

  it('re-arms after replenishment above the threshold and alerts again on a later drop', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    const { toast } = await import('sonner');

    await act(async () => {
      currentStore().addStockBaseline({ medId: 'nurtec', effectiveAt: daysAgo(10), quantity: 2 });
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(1));
    expect(toast.warning).toHaveBeenCalledTimes(1);

    // 2 + 8 > 2: replenished, so the latch clears (and the server is told).
    await act(async () => {
      currentStore().addRefill('nurtec', dayKeyDaysAgo(3), '', 8);
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(2));
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(lowStockWrites()[1]).toEqual(['lowStockAlert', { latchedAt: null }]);
    expect(currentStore().state.lowStockAlertedAt).toBeNull();
    expect(toast.warning).toHaveBeenCalledTimes(1);

    // 2 + 8 - 9 = 1: a fresh crossing alerts again.
    await act(async () => {
      currentStore().logMed('nurtec', new Date(), null, '75 mg', '', 9);
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(3));
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    expect(typeof currentStore().state.lowStockAlertedAt).toBe('string');
    expect(lowStockWrites()[2]).toEqual([
      'lowStockAlert', { latchedAt: currentStore().state.lowStockAlertedAt },
    ]);
    expect(toast.warning).toHaveBeenCalledTimes(2);
  });

  it('resetLowStockAlert clears the latch without re-alerting the same low episode', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    const { toast } = await import('sonner');

    await act(async () => {
      currentStore().addStockBaseline({ medId: 'nurtec', effectiveAt: daysAgo(10), quantity: 2 });
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(1));
    expect(toast.warning).toHaveBeenCalledTimes(1);

    await act(async () => {
      currentStore().resetLowStockAlert();
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(2));
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    expect(lowStockWrites()[1]).toEqual(['lowStockAlert', { latchedAt: null }]);
    expect(currentStore().state.lowStockAlertedAt).toBeNull();
    // The stock is still low; the silenced episode must not toast again.
    expect(toast.warning).toHaveBeenCalledTimes(1);

    // Replenishment re-arms; the next crossing alerts once more.
    await act(async () => {
      currentStore().addRefill('nurtec', dayKeyDaysAgo(3), '', 8);
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(lowStockWrites()).toHaveLength(2);

    await act(async () => {
      currentStore().logMed('nurtec', new Date(), null, '75 mg', '', 9);
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(3));
    expect(toast.warning).toHaveBeenCalledTimes(2);
  });

  it('resetAll re-arms the episode: a new low baseline after a full erase alerts again', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    const { toast } = await import('sonner');

    await act(async () => {
      currentStore().addStockBaseline({ medId: 'nurtec', effectiveAt: daysAgo(10), quantity: 2 });
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(1));
    const firstLatch = currentStore().state.lowStockAlertedAt;
    expect(typeof firstLatch).toBe('string');
    expect(toast.warning).toHaveBeenCalledTimes(1);

    await act(async () => {
      currentStore().resetAll();
    });
    await waitFor(() => expect(api.resetAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    // The latch is gone with the data, and unknown stock must not publish any
    // latch write of its own.
    expect(currentStore().state.lowStockAlertedAt).toBeNull();
    expect(lowStockWrites()).toHaveLength(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);

    // A brand-new applicable low baseline in the same provider session is a
    // NEW episode: it must latch, persist, and toast exactly once.
    await act(async () => {
      currentStore().addStockBaseline({ medId: 'nurtec', effectiveAt: daysAgo(5), quantity: 2 });
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(2));
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const secondLatch = currentStore().state.lowStockAlertedAt;
    expect(typeof secondLatch).toBe('string');
    expect(secondLatch).not.toBe(firstLatch);
    expect(lowStockWrites()[1]).toEqual(['lowStockAlert', { latchedAt: secondLatch }]);
    expect(toast.warning).toHaveBeenCalledTimes(2);
  });

  it('resetAll drops an offline pending latch so a pre-reset alert is never published', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([]),
      stockBaselines: [makeStockBaseline('b-offline', 2, daysAgo(10))],
    }));
    api.exportAll.mockRejectedValue(new Error('offline'));

    mountStore();
    const { toast } = await import('sonner');

    // Offline latch: toasted locally, publish deferred until the server answers.
    await waitFor(() => expect(currentStore().state.lowStockAlertedAt).not.toBeNull());
    const preResetLatch = currentStore().state.lowStockAlertedAt;
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(api.putSetting).not.toHaveBeenCalled();

    await act(async () => {
      currentStore().resetAll();
    });
    expect(api.resetAll).not.toHaveBeenCalled(); // offline reset stays unconfirmed
    expect(currentStore().state.lowStockAlertedAt).toBeNull();

    // Still offline, a new applicable low baseline is a NEW episode: it
    // latches and toasts again, still without a server write.
    await act(async () => {
      currentStore().addStockBaseline({ medId: 'nurtec', effectiveAt: daysAgo(5), quantity: 2 });
    });
    await waitFor(() => expect(currentStore().state.lowStockAlertedAt).not.toBeNull());
    const postResetLatch = currentStore().state.lowStockAlertedAt;
    expect(postResetLatch).not.toBe(preResetLatch);
    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(api.putSetting).not.toHaveBeenCalled();

    // The server comes back: only the post-reset latch may be published —
    // never the stale pre-reset one.
    api.exportAll.mockResolvedValue(emptyExport());
    await act(async () => {
      await currentStore().resolveUseServer();
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(1));
    expect(lowStockWrites()[0]).toEqual(['lowStockAlert', { latchedAt: postResetLatch }]);
    expect(toast.warning).toHaveBeenCalledTimes(2);
  });

  it('latches and alerts locally while offline without polluting the sync latches', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([]),
      stockBaselines: [makeStockBaseline('b-offline', 2, daysAgo(10))],
    }));
    api.exportAll.mockRejectedValue(new Error('offline'));

    mountStore();
    const { toast } = await import('sonner');

    await waitFor(() => expect(currentStore().state.lowStockAlertedAt).not.toBeNull());
    expect(toast.warning).toHaveBeenCalledTimes(1);
    // An automatic background latch must never enqueue a server write offline.
    expect(api.putSetting).not.toHaveBeenCalled();

    const sync = currentStore().sync;
    expect(sync.status).toBe('local');
    expect(sync.dirty).toBe(false);
    expect(sync.failed).toBe(false);
    expect(sync.pending).toBe(0);
    expect(localStorage.getItem(SYNC_META_KEY)).toBeNull();

    // The latch is still cached for the next session.
    await waitFor(() => expect(readPersistedState().lowStockAlertedAt).not.toBeNull());
  });

  it('keeps an offline latch across a reload: adopts it, publishes it once, never re-toasts', async () => {
    const offlineLatch = await mountOfflineLatched();

    // Session 2 ("reload"): the server is reachable with data but no latch.
    await reloadStore();
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('server-attack')] });
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const { toast: toast2 } = await import('sonner');
    // The latch is re-adopted from durable bookkeeping — not lost by the
    // hydration snapshot, not re-announced with a second toast.
    expect(currentStore().state.lowStockAlertedAt).toBe(offlineLatch);
    expect(toast2.warning).not.toHaveBeenCalled();
    // Published exactly once; the snapshot replaced local records (no upload).
    await waitFor(() =>
      expect(lowStockWrites()).toEqual([['lowStockAlert', { latchedAt: offlineLatch }]]));
    expect(api.importAll).not.toHaveBeenCalled();
    // Confirmed publication clears the durable bookkeeping.
    await waitFor(() => expect(readPendingLatch()).toBeNull());
  });

  it('does not republish a pending latch when the server already supplies its own latch', async () => {
    await mountOfflineLatched();

    await reloadStore();
    const serverLatch = '2026-10-01T00:00:00.000Z';
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('server-attack')],
      settings: { lowStockAlert: { latchedAt: serverLatch } },
    });
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const { toast: toast2 } = await import('sonner');
    // The server copy is canonical: no duplicate publication, no re-toast.
    expect(lowStockWrites()).toHaveLength(0);
    expect(currentStore().state.lowStockAlertedAt).toBe(serverLatch);
    expect(toast2.warning).not.toHaveBeenCalled();
    // The obsolete pending bookkeeping is dropped either way.
    expect(readPendingLatch()).toBeNull();
  });

  it('keeps pending bookkeeping after a failed publication and republishes exactly once on a later pass', async () => {
    const offlineLatch = await mountOfflineLatched();

    await reloadStore();
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('server-attack')] });
    let latchAttempts = 0;
    api.putSetting.mockImplementation(async (key: string) => {
      if (key === 'lowStockAlert') {
        latchAttempts += 1;
        if (latchAttempts === 1) throw new Error('flaky server');
      }
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mountStore();

    // The first publication attempt failed. Because bookkeeping is cleared
    // only on CONFIRMED publication, it is still durable; no state change
    // retries on its own, so there is no render/write loop.
    await waitFor(() => expect(lowStockWrites()).toHaveLength(1));
    expect(readPendingLatch()).toEqual({ latchedAt: offlineLatch });
    expect(currentStore().state.lowStockAlertedAt).toBe(offlineLatch);
    // Give React a chance to (incorrectly) loop before asserting stability.
    await act(async () => {
      await Promise.resolve();
    });
    expect(lowStockWrites()).toHaveLength(1);

    // Any later effect pass (here: a timezone change) retries the publication.
    await act(async () => {
      currentStore().setTimezone('Asia/Tokyo');
    });
    await waitFor(() => expect(lowStockWrites()).toHaveLength(2));
    expect(lowStockWrites()[0]).toEqual(['lowStockAlert', { latchedAt: offlineLatch }]);
    expect(lowStockWrites()[1]).toEqual(['lowStockAlert', { latchedAt: offlineLatch }]);
    await waitFor(() => expect(readPendingLatch()).toBeNull());

    consoleError.mockRestore();
  });

  it('StrictMode reload publishes a pending latch once without re-toasting or dirtying sync', async () => {
    const offlineLatch = await mountOfflineLatched();

    await reloadStore();
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('server-attack')] });
    mountStoreStrict();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    await waitFor(() =>
      expect(lowStockWrites()).toEqual([['lowStockAlert', { latchedAt: offlineLatch }]]));

    const { toast: toast2 } = await import('sonner');
    // Re-adopted from durable bookkeeping, never re-announced.
    expect(currentStore().state.lowStockAlertedAt).toBe(offlineLatch);
    expect(toast2.warning).not.toHaveBeenCalled();
    // Exactly one publication despite StrictMode's double effects; the
    // automatic background path must not leave sync latched dirty/failed.
    expect(lowStockWrites()).toHaveLength(1);
    await waitFor(() => expect(readPendingLatch()).toBeNull());
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    const sync = currentStore().sync;
    expect(sync.dirty).toBe(false);
    expect(sync.failed).toBe(false);
    expect(sync.pending).toBe(0);
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('clears durable pending bookkeeping when replenished above threshold and never publishes the stale latch', async () => {
    await mountOfflineLatched();
    expect(readPendingLatch()).not.toBeNull();
    const { toast } = await import('sonner');
    expect(toast.warning).toHaveBeenCalledTimes(1);

    // Still offline: a refill lifts stock above the alert level, ending the
    // episode. The queued latch is discarded (no server write while offline).
    await act(async () => {
      currentStore().addRefill('nurtec', dayKeyDaysAgo(1), '', 8);
    });
    await waitFor(() => expect(currentStore().state.lowStockAlertedAt).toBeNull());
    expect(readPendingLatch()).toBeNull();
    expect(lowStockWrites()).toHaveLength(0);
    expect(toast.warning).toHaveBeenCalledTimes(1);

    // Server becomes reachable: the discarded latch is never published.
    api.exportAll.mockResolvedValue(emptyExport());
    await act(async () => {
      await currentStore().resolveUseServer();
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(currentStore().state.lowStockAlertedAt).toBeNull();
    expect(readPendingLatch()).toBeNull();
    expect(lowStockWrites()).toHaveLength(0);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('resetLowStockAlert also cancels a pending offline latch publication', async () => {
    await mountOfflineLatched();
    const { toast } = await import('sonner');

    await act(async () => {
      currentStore().resetLowStockAlert();
    });
    expect(currentStore().state.lowStockAlertedAt).toBeNull();
    expect(readPendingLatch()).toBeNull();

    // Once the server is reachable again, the cancelled latch is never published.
    api.exportAll.mockResolvedValue(emptyExport());
    await act(async () => {
      await currentStore().resolveUseServer();
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(lowStockWrites()).toHaveLength(0);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('resetAll also drops durable pending bookkeeping: a pre-reset latch is never published after a reload', async () => {
    const toast = await import('sonner');
    await mountOfflineLatched();
    const preResetLatch = currentStore().state.lowStockAlertedAt as string;
    expect(toast.toast.warning).toHaveBeenCalledTimes(1);

    await act(async () => {
      currentStore().resetAll();
    });
    // The durable bookkeeping is gone together with the in-memory one.
    expect(currentStore().state.lowStockAlertedAt).toBeNull();
    expect(readPendingLatch()).toBeNull();

    // Reload: the server is still empty and the offline reset stays
    // unconfirmed, so the (empty) local snapshot uploads — carrying
    // latchedAt null, never the stale pre-reset latch.
    await reloadStore();
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const { toast: toast2 } = await import('sonner');
    expect(currentStore().state.lowStockAlertedAt).toBeNull();
    expect(lowStockWrites()).toEqual([['lowStockAlert', { latchedAt: null }]]);
    expect(lowStockWrites()[0]).not.toEqual(['lowStockAlert', { latchedAt: preResetLatch }]);
    expect(toast2.warning).not.toHaveBeenCalled();
  });
});
