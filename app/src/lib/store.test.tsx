// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { Attack, DayState, MedEvent, Refill, StockBaseline, TrackerState, Workout } from '@/types';
import { currentStock } from '../../shared/inventory.ts';
import { localDayKey, systemTimeZone } from '../../shared/datetime.ts';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';
import { parseBackup } from '../../shared/backup.ts';
import type { ParsedBackup } from '../../shared/backup.ts';

// The store calls every backend method (some unconditionally chain `.catch`),
// so each one must be a mock that returns a promise. The factory is hoisted and
// self-contained; implementations are (re)applied per test after resetModules.
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
    weather: { enabled: false, location: null, pressureDropThresholdHpa: 5 },
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

function makeMed(id: string, overrides: Partial<MedEvent> = {}): MedEvent {
  return {
    id,
    medId: 'nurtec',
    ts: '2026-10-20T09:00:00.000Z',
    dose: '75 mg',
    quantity: 1,
    attackId: null,
    notes: '',
    source: 'manual',
    ...overrides,
  };
}

/**
 * A JavaScript (or `any`) caller can still smuggle a forbidden `id` into a
 * patch even though the store's public signature omits it; these tests prove
 * the runtime guard ignores it.
 */
function patchWithId<T extends { id: string }>(
  patch: Partial<T> & { id: string },
): Partial<Omit<T, 'id'>> {
  return patch as unknown as Partial<Omit<T, 'id'>>;
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
 * Simulate a reload: fresh module instances and fresh backend mocks, while
 * localStorage survives.
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

const ZERO_BACKUP_COUNTS = {
  attacks: 0, meds: 0, refills: 0, workouts: 0, dayStates: 0, stockBaselines: 0,
};

/** A current-format server envelope for the JSON restore tests. */
function backupEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    exportedAt: '2026-10-25T12:00:00.000Z',
    attacks: [],
    meds: [],
    refills: [],
    workouts: [],
    dayStates: [],
    stockBaselines: [],
    settings: {},
    ...overrides,
  };
}

function parsedBackup(json: unknown): ParsedBackup {
  const result = parseBackup(json);
  if (!result.ok) throw new Error(`expected a valid backup: ${result.error}`);
  return result.backup;
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

  it('re-hydrates after a genuine unmount/remount but still only once under StrictMode', async () => {
    // The `/view` route tree swaps providers, so returning to the writer routes
    // must hydrate against the server again. StrictMode's simulated remount
    // must not cause a second hydration within one provider lifetime.
    const { StoreProvider } = storeModule;
    const mount = () => render(
      <StrictMode>
        <StoreProvider>
          <Probe capture={captureStore} />
        </StoreProvider>
      </StrictMode>,
    );

    const first = mount();
    await waitFor(() => expect(currentStore().serverMode).toBe(true));
    expect(api.exportAll).toHaveBeenCalledTimes(1);

    first.unmount();
    captured = null;

    mount();
    await waitFor(() => expect(currentStore().serverMode).toBe(true));
    expect(api.exportAll).toHaveBeenCalledTimes(2);
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
      expect(api.putSetting).toHaveBeenCalledTimes(8);
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
    expect(api.putSetting).toHaveBeenCalledTimes(8);
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
      expect(api.putSetting).toHaveBeenCalledTimes(8);
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
      expect(api.putSetting).toHaveBeenCalledTimes(8);
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

  it('re-publishes only the local timezone after a confirmed reset and stays clean', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    // Hydration may already have published the zone; only the reset's own
    // settings writes are asserted here.
    api.resetAll.mockClear();
    api.putSetting.mockClear();

    await act(async () => {
      currentStore().resetAll();
    });

    await waitFor(() => {
      expect(api.resetAll).toHaveBeenCalledTimes(1);
      expect(currentStore().sync.status).toBe('synced');
    });

    // /api/reset cleared every setting, so the server now needs the browser
    // zone back — and ONLY that: a reset keeps the server defaults for
    // rules/doses/planned/threshold/reminders.
    expect(api.putSetting).toHaveBeenCalledTimes(1);
    expect(api.putSetting).toHaveBeenCalledWith(
      'timezone', systemTimeZone(),
    );
    expect(currentStore().state.timezone).toBe(systemTimeZone());
    // The publish happens inside the reset task, after the reset itself.
    expect(api.resetAll.mock.invocationCallOrder[0])
      .toBeLessThan(api.putSetting.mock.invocationCallOrder[0]);
    expect(currentStore().sync.pending).toBe(0);
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('does not lose a timezone chosen after the reset (run-time, not enqueue-time)', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.resetAll.mockClear();
    api.putSetting.mockClear();

    // Hold the server reset open, change the zone while it is unconfirmed,
    // then let the reset task finish: its timezone publish must read the
    // CURRENT state, and the queued setTimezone write must keep the choice.
    const deferred = createDeferred<void>();
    api.resetAll.mockReturnValue(deferred.promise);

    await act(async () => {
      currentStore().resetAll();
      currentStore().setTimezone('Asia/Kolkata');
    });
    expect(currentStore().state.timezone).toBe('Asia/Kolkata');

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const timezoneWrites = api.putSetting.mock.calls
      .filter((call) => call[0] === 'timezone');
    // Exactly two: the reset task's own publish (which must use the zone read
    // at run time, not the one captured when the reset was enqueued) and the
    // later setTimezone write queued behind it.
    expect(timezoneWrites).toHaveLength(2);
    for (const write of timezoneWrites) expect(write).toEqual(['timezone', 'Asia/Kolkata']);
    expect(currentStore().state.timezone).toBe('Asia/Kolkata');
    expect(readPersistedState().timezone).toBe('Asia/Kolkata');
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('resetAll resolves only after the reset and its timezone re-publication are confirmed', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.resetAll.mockClear();
    api.putSetting.mockClear();

    // Hold ONLY the timezone re-publication open; the reset itself resolves.
    const tzWrite = createDeferred<void>();
    api.putSetting.mockImplementation((key: string) => (
      key === 'timezone' ? tzWrite.promise : Promise.resolve()
    ));

    let resetResolved = false;
    let resetPromise!: Promise<void>;
    await act(async () => {
      resetPromise = currentStore().resetAll();
      resetPromise.then(() => {
        resetResolved = true;
      }, () => undefined);
    });

    // The local erase is synchronous/optimistic, before any server call.
    expect(currentStore().state.attacks).toHaveLength(0);

    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith(
      'timezone', systemTimeZone(),
    ));
    expect(api.resetAll).toHaveBeenCalledTimes(1);
    // The publish belongs to the reset task and runs after the reset itself.
    expect(api.resetAll.mock.invocationCallOrder[0])
      .toBeLessThan(api.putSetting.mock.invocationCallOrder[0]);

    // Reset confirmed and the publish INVOKED, but its write is still open:
    // the returned promise must be pending and the task still counted.
    expect(resetResolved).toBe(false);
    expect(currentStore().sync.pending).toBe(1);

    await act(async () => {
      tzWrite.resolve();
      await resetPromise;
      // Resolves only after the task's bookkeeping ran: the persisted latches
      // are already clean at the instant the promise fulfils.
      expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
    });
    expect(resetResolved).toBe(true);
    expect(currentStore().state.attacks).toHaveLength(0);
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));
    expect(currentStore().sync.dirty).toBe(false);
    expect(currentStore().sync.failed).toBe(false);
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('resetAll rejects when the server reset fails, keeping the local erase dirty + failed', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    const { toast } = await import('sonner');

    await act(async () => {
      currentStore().startAttack();
    });
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.resetAll.mockRejectedValue(new Error('boom'));
    api.putSetting.mockClear();

    let resetPromise!: Promise<void>;
    await act(async () => {
      resetPromise = currentStore().resetAll();
    });
    // The local erase applied optimistically even though the task will reject.
    expect(currentStore().state.attacks).toHaveLength(0);
    await act(async () => {
      await expect(resetPromise).rejects.toThrow('boom');
    });

    expect(api.resetAll).toHaveBeenCalledTimes(1);
    // The reset failed, so the timezone re-publication never ran.
    expect(api.putSetting).not.toHaveBeenCalled();
    // The task's bookkeeping ran before the rejection surfaced.
    expect(currentStore().sync.pending).toBe(0);
    expect(currentStore().sync.dirty).toBe(true);
    expect(currentStore().sync.failed).toBe(true);
    expect(readSyncMeta()).toEqual({ dirty: true, failed: true });
    expect(currentStore().state.attacks).toHaveLength(0);
    // Settings reports this failure itself; the queue must not also show the
    // generic toast (which would double-report the same failure)...
    expect(toast.error).not.toHaveBeenCalled();
    // ...while the diagnostic log and the latches above are unaffected.
    expect(consoleError).toHaveBeenCalledWith('[sync] reset failed:', expect.any(Error));
    consoleError.mockRestore();
  });

  it('resetAll rejects when only the timezone re-publication fails', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.putSetting.mockImplementation((key: string) => (
      key === 'timezone' ? Promise.reject(new Error('tz boom')) : Promise.resolve()
    ));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let resetPromise!: Promise<void>;
    await act(async () => {
      resetPromise = currentStore().resetAll();
      await expect(resetPromise).rejects.toThrow('tz boom');
    });

    expect(api.resetAll).toHaveBeenCalledTimes(1);
    expect(api.putSetting).toHaveBeenCalledWith('timezone', systemTimeZone());
    expect(currentStore().state.attacks).toHaveLength(0);
    expect(currentStore().sync.pending).toBe(0);
    expect(currentStore().sync.dirty).toBe(true);
    expect(currentStore().sync.failed).toBe(true);
    expect(readSyncMeta()).toEqual({ dirty: true, failed: true });
    consoleError.mockRestore();
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
    // Offline reset behaviour is unchanged: no server calls at all, including
    // the connected path's timezone re-publication.
    expect(api.putSetting).not.toHaveBeenCalled();
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

  it('replaces an existing non-Off record with Off when an attack starts now', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([]),
      dayStates: [makeDayState(today, { status: 'well', notes: 'good day' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().startAttack(new Date(), true);
    });

    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(1));
    expect(api.putDayState).toHaveBeenCalledWith(today, { status: 'off', notes: 'good day' });
    expect(currentStore().state.attacks).toHaveLength(1);
    expect(currentStore().state.dayStates).toEqual([
      expect.objectContaining({ day: today, status: 'off', notes: 'good day' }),
    ]);
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
  });

  it('creates no day-state row for a record-less current attack start', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().startAttack(new Date(), true);
    });

    expect(currentStore().state.attacks).toHaveLength(1);
    expect(currentStore().state.dayStates).toHaveLength(0);
    expect(api.putDayState).not.toHaveBeenCalled();
    // No extra write means the sync bookkeeping is exactly one addAttack.
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(api.addAttack).toHaveBeenCalledTimes(1);
  });

  it('never rewrites the day for a plain startAttack (compatibility default)', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([]),
      dayStates: [makeDayState(today, { status: 'well' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().startAttack(new Date());
    });

    expect(currentStore().state.dayStates[0]).toMatchObject({ status: 'well' });
    expect(api.putDayState).not.toHaveBeenCalled();
  });

  it('does not rewrite the day for a backfilled or future start', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    const yesterday = localDayKey(Date.now() - 24 * 60 * 60 * 1000, 'UTC');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([]),
      dayStates: [
        makeDayState(yesterday, { status: 'well', notes: 'yesterday' }),
        makeDayState(today, { status: 'well', notes: 'today' }),
      ],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().startAttack(new Date(Date.now() - 24 * 60 * 60 * 1000), true);
    });
    await act(async () => {
      currentStore().startAttack(new Date(Date.now() + 60 * 60 * 1000), true);
    });

    expect(currentStore().state.dayStates).toEqual([
      expect.objectContaining({ day: yesterday, status: 'well', notes: 'yesterday' }),
      expect.objectContaining({ day: today, status: 'well', notes: 'today' }),
    ]);
    expect(api.putDayState).not.toHaveBeenCalled();
  });

  it('writes no day state when a historical attack is reopened', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    const startedBeforeToday: Attack = {
      ...makeAttack('historical-reopened'),
      start: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([startedBeforeToday]),
      dayStates: [makeDayState(today, { status: 'well', notes: 'unrelated today' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().updateAttack(startedBeforeToday.id, { end: null });
    });

    // Reopening is a history edit, not a current transition: today's unrelated
    // check-in must never be overwritten by it.
    expect(currentStore().state.attacks[0].end).toBeNull();
    expect(currentStore().state.dayStates).toEqual([
      expect.objectContaining({ day: today, status: 'well', notes: 'unrelated today' }),
    ]);
    expect(api.putDayState).not.toHaveBeenCalled();
    expect(api.patchAttack).toHaveBeenCalledWith(startedBeforeToday.id, { end: null });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
  });

  it('replaces today with Off when a restored active attack is ended now', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    const active: Attack = {
      ...makeAttack('active'),
      start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      end: null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([active]),
      dayStates: [makeDayState(today, { status: 'well', notes: 'kept' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().endAttack(active.id, new Date(), true);
    });

    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(1));
    expect(api.putDayState).toHaveBeenCalledWith(today, { status: 'off', notes: 'kept' });
    expect(currentStore().state.dayStates[0]).toMatchObject({ status: 'off', notes: 'kept' });
    expect(currentStore().state.attacks[0].end).not.toBeNull();
    expect(api.patchAttack).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
  });

  it('writes no day state for a default or backfilled end', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    const first: Attack = {
      ...makeAttack('ended-default'),
      start: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      end: null,
    };
    const second: Attack = {
      ...makeAttack('ended-backfill'),
      start: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      end: null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([first, second]),
      dayStates: [makeDayState(today, { status: 'well', notes: 'today' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().endAttack(first.id);
    });
    await act(async () => {
      // A backfilled end on an earlier day must not rewrite today.
      currentStore().endAttack(second.id, new Date(Date.now() - 24 * 60 * 60 * 1000), true);
    });

    expect(currentStore().state.dayStates).toEqual([
      expect.objectContaining({ day: today, status: 'well', notes: 'today' }),
    ]);
    expect(api.putDayState).not.toHaveBeenCalled();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
  });

  it('restores the replaced day when the just-started attack is deleted (History path)', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    const unrelated: Attack = {
      ...makeAttack('unrelated'),
      start: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([unrelated]),
      dayStates: [makeDayState(today, { status: 'well', notes: 'good day' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    let startedId = '';
    await act(async () => {
      startedId = currentStore().startAttack(new Date(), true).id;
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(1));
    expect(currentStore().state.dayStates[0]).toMatchObject({ status: 'off', notes: 'good day' });

    // History deletes through the same store API — no Home closure involved.
    await act(async () => {
      currentStore().deleteAttack(startedId);
    });

    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(2));
    expect(api.putDayState).toHaveBeenLastCalledWith(
      today, { status: 'well', notes: 'good day' },
    );
    expect(currentStore().state.dayStates[0]).toMatchObject({ status: 'well', notes: 'good day' });
    expect(currentStore().state.attacks.map((a) => a.id)).toEqual([unrelated.id]);
    expect(api.deleteAttack).toHaveBeenCalledWith(startedId);

    // Provenance is consumed: deleting an unrelated attack never restores again.
    await act(async () => {
      currentStore().deleteAttack(unrelated.id);
    });
    expect(api.putDayState).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
  });

  it('does not restore when the day was changed after the start rewrite', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([]),
      dayStates: [makeDayState(today, { status: 'well', notes: 'good day' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    let startedId = '';
    await act(async () => {
      startedId = currentStore().startAttack(new Date(), true).id;
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(1));

    // The user makes an explicit choice during/after the attack: Undo must
    // never overwrite it.
    await act(async () => {
      currentStore().setDayState(today, 'well', 'manual choice');
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(2));

    await act(async () => {
      currentStore().deleteAttack(startedId);
    });

    expect(api.putDayState).toHaveBeenCalledTimes(2);
    expect(currentStore().state.dayStates[0]).toMatchObject({
      status: 'well',
      notes: 'manual choice',
    });
  });

  it('does not restore while another attack is active', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([]),
      dayStates: [makeDayState(today, { status: 'well', notes: 'good day' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    let startedId = '';
    await act(async () => {
      startedId = currentStore().startAttack(new Date(), true).id;
      currentStore().startAttack(new Date(), false);
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(1));

    await act(async () => {
      currentStore().deleteAttack(startedId);
    });

    // Another open attack still explains the Off day.
    expect(api.putDayState).toHaveBeenCalledTimes(1);
    expect(currentStore().state.dayStates[0]).toMatchObject({ status: 'off', notes: 'good day' });
  });

  it('does not restore while a remaining ended attack still overlaps today', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([]),
      dayStates: [makeDayState(today, { status: 'well', notes: 'good day' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    let startedId = '';
    await act(async () => {
      startedId = currentStore().startAttack(new Date(), true).id;
      const earlier = currentStore().startAttack(
        new Date(Date.now() - 2 * 60 * 60 * 1000), false,
      );
      currentStore().endAttack(earlier.id, new Date(), false);
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(1));

    await act(async () => {
      currentStore().deleteAttack(startedId);
    });

    expect(api.putDayState).toHaveBeenCalledTimes(1);
    expect(currentStore().state.dayStates[0]).toMatchObject({ status: 'off', notes: 'good day' });
  });

  it('does nothing for an unknown attack id on end', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().endAttack('missing-attack', new Date(), true);
    });

    expect(currentStore().state.attacks).toHaveLength(0);
    expect(currentStore().state.dayStates).toHaveLength(0);
    expect(api.patchAttack).not.toHaveBeenCalled();
    expect(api.putDayState).not.toHaveBeenCalled();
  });

  it('does not rewrite a manual post-attack Well on a repeated end', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    const active: Attack = {
      ...makeAttack('repeat-end'),
      start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      end: null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([active]),
      dayStates: [makeDayState(today, { status: 'well', notes: 'kept' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().endAttack(active.id, new Date(), true);
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(1));
    expect(currentStore().state.dayStates[0]).toMatchObject({ status: 'off', notes: 'kept' });

    // The user chooses Well after the attack.
    await act(async () => {
      currentStore().setDayState(today, 'well', 'manual');
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(2));

    // A repeated end of the already-closed attack is not a transition.
    await act(async () => {
      currentStore().endAttack(active.id, new Date(), true);
    });

    expect(api.putDayState).toHaveBeenCalledTimes(2);
    expect(currentStore().state.dayStates[0]).toMatchObject({ status: 'well', notes: 'manual' });
  });

  it('restores the prior day when an ended restored active attack is deleted', async () => {
    const today = localDayKey(Date.now(), 'UTC');
    const active: Attack = {
      ...makeAttack('ended-then-deleted'),
      start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      end: null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([active]),
      dayStates: [makeDayState(today, { status: 'well', notes: 'kept' })],
    }));

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().endAttack(active.id, new Date(), true);
    });
    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(1));
    expect(currentStore().state.dayStates[0]).toMatchObject({ status: 'off', notes: 'kept' });

    // The end created the same provenance a start would: a History delete can
    // restore the status the user had before the attack.
    await act(async () => {
      currentStore().deleteAttack(active.id);
    });

    await waitFor(() => expect(api.putDayState).toHaveBeenCalledTimes(2));
    expect(api.putDayState).toHaveBeenLastCalledWith(today, { status: 'well', notes: 'kept' });
    expect(currentStore().state.dayStates[0]).toMatchObject({ status: 'well', notes: 'kept' });
    expect(currentStore().state.attacks).toHaveLength(0);
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
    // Only the edited field goes on the wire: no id, no unchanged values.
    expect(api.patchWorkout).toHaveBeenCalledWith(id, { effort: 'hard' });
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
    // Narrow PATCH: the unchanged med/date/id are not resent.
    expect(api.patchRefill).toHaveBeenCalledWith(refillId, { quantity: 6 });
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

describe('JSON backup merge and replace', () => {
  it('merges only missing records, keeps existing local records, and leaves settings alone', async () => {
    const localAttack = { ...makeAttack('a1'), notes: 'local original' };
    const localDay = makeDayState('2026-10-21', { status: 'well', notes: 'local day' });
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [localAttack],
      dayStates: [localDay],
      settings: {
        timezone: 'Asia/Tokyo',
        lowStockThreshold: 5,
        rules: { nurtec: { limit: 9, windowDays: 30 } },
      },
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(currentStore().state.attacks.map((a) => a.id)).toEqual(['a1']);
    api.importAll.mockClear();

    const backup = parsedBackup(backupEnvelope({
      attacks: [
        { ...makeAttack('a1'), notes: 'backup version' },
        { ...makeAttack('a2'), start: '2026-10-22T08:00:00.000Z' },
      ],
      dayStates: [
        makeDayState('2026-10-21', { status: 'attack' }),
        makeDayState('2026-10-22', { status: 'off' }),
      ],
      settings: {
        timezone: 'America/New_York',
        lowStockThreshold: 1,
        rules: { nurtec: { limit: 1, windowDays: 7 } },
      },
    }));

    let added: ReturnType<StoreApi['mergeBackup']>['added'] | undefined;
    await act(async () => {
      added = currentStore().mergeBackup(backup).added;
    });
    expect(added).toEqual({
      attacks: 1, meds: 0, refills: 0, workouts: 0, dayStates: 1, stockBaselines: 0,
    });

    const state = currentStore().state;
    expect(state.attacks.map((a) => a.id)).toEqual(['a1', 'a2']);
    // Existing records win: the backup's different content never overwrites.
    expect(state.attacks[0].notes).toBe('local original');
    expect(state.dayStates).toHaveLength(2);
    expect(state.dayStates[0]).toEqual(localDay);
    expect(state.dayStates[1]).toMatchObject({ day: '2026-10-22', status: 'off' });
    // Settings are untouched by an additive merge.
    expect(state.timezone).toBe('Asia/Tokyo');
    expect(state.lowStockThreshold).toBe(5);
    expect(state.rules.nurtec).toEqual({ limit: 9, windowDays: 30 });

    await waitFor(() => expect(api.importAll).toHaveBeenCalledTimes(1));
    expect(api.importAll).toHaveBeenCalledWith({
      attacks: [expect.objectContaining({ id: 'a2' })],
      meds: [],
      refills: [],
      workouts: [],
      dayStates: [expect.objectContaining({ day: '2026-10-22' })],
      stockBaselines: [],
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
  });

  it('treats an entirely duplicate merge as a no-op that never hits the server', async () => {
    const localAttack = makeAttack('a1');
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [localAttack] });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.importAll.mockClear();

    const backup = parsedBackup(backupEnvelope({
      attacks: [{ ...localAttack, notes: 'different content' }],
    }));

    let result: ReturnType<StoreApi['mergeBackup']> | undefined;
    await act(async () => {
      result = currentStore().mergeBackup(backup);
    });
    expect(result!.added).toEqual(ZERO_BACKUP_COUNTS);
    await expect(result!.synced).resolves.toBeUndefined();

    expect(api.importAll).not.toHaveBeenCalled();
    expect(currentStore().state.attacks).toEqual([localAttack]);
    const sync = currentStore().sync;
    expect(sync.dirty).toBe(false);
    expect(sync.failed).toBe(false);
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('applies an offline merge locally and latches dirty + failed', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));

    mountStore();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore().serverMode).toBe(false);

    const backup = parsedBackup(backupEnvelope({
      attacks: [makeAttack('offline-a')],
    }));

    let synced!: Promise<void>;
    await act(async () => {
      const merged = currentStore().mergeBackup(backup);
      synced = merged.synced;
      synced.catch(() => undefined); // observed below; avoid unhandled-rejection noise
    });
    await expect(synced).rejects.toThrow(/offline/);

    expect(currentStore().state.attacks.map((a) => a.id)).toEqual(['offline-a']);
    const sync = currentStore().sync;
    expect(sync.status).toBe('local');
    expect(sync.dirty).toBe(true);
    expect(sync.failed).toBe(true);
    expect(readSyncMeta()).toEqual({ dirty: true, failed: true });
    expect(readPersistedState().attacks.map((a) => a.id)).toEqual(['offline-a']);
  });

  it('adopts the canonical server snapshot after a confirmed connected replace', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('before')],
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.importAll.mockClear();
    api.resetAll.mockClear();

    const restoredAttack = { ...makeAttack('restored'), notes: 'from backup' };
    const canonical = {
      ...emptyExport(),
      schemaVersion: 4,
      exportedAt: '2026-10-25T12:00:00.000Z',
      attacks: [restoredAttack],
      settings: {
        timezone: 'Asia/Tokyo',
        rules: { nurtec: { limit: 11, windowDays: 30 } },
        doses: { nurtec: '75 mg' },
        planned: { botox: '2026-11-01' },
        lowStockThreshold: 4,
        lowStockAlert: { latchedAt: null },
        reminders: { ...DEFAULT_REMINDER_SETTINGS },
      },
    };
    api.restoreAll.mockResolvedValue(canonical);

    const backup = parsedBackup(backupEnvelope({
      attacks: [restoredAttack],
      settings: { timezone: 'UTC', rules: { nurtec: { limit: 11, windowDays: 30 } } },
    }));

    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    // The wire payload carries every array plus the FULL effective settings:
    // the server only stores keys present in the payload, so a backup with
    // absent keys must still persist the defaults the browser adopts.
    expect(api.restoreAll).toHaveBeenCalledTimes(1);
    expect(api.restoreAll).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 4,
      attacks: [expect.objectContaining({ id: 'restored' })],
      meds: [],
      refills: [],
      workouts: [],
      dayStates: [],
      stockBaselines: [],
      settings: expect.objectContaining({
        timezone: 'UTC',
        rules: expect.objectContaining({ nurtec: { limit: 11, windowDays: 30 } }),
        lowStockThreshold: storeModule.DEFAULT_LOW_STOCK_THRESHOLD,
        lowStockAlert: { latchedAt: null },
        reminders: DEFAULT_REMINDER_SETTINGS,
        weather: { enabled: false, location: null, pressureDropThresholdHpa: 5 },
      }),
    }));

    const state = currentStore().state;
    expect(state.attacks.map((a) => a.id)).toEqual(['restored']);
    // Settings come from the BACKUP (defaults for keys it does not carry),
    // never from the returned envelope: replacement is not hydration, so the
    // stale pre-restore threshold/reminders must not survive either.
    expect(state.timezone).toBe('UTC');
    expect(state.lowStockThreshold).toBe(storeModule.DEFAULT_LOW_STOCK_THRESHOLD);
    expect(state.rules.nurtec).toEqual({ limit: 11, windowDays: 30 });
    expect(state.doses.nurtec).toBe('75 mg');
    expect(state.planned).toEqual({});
    expect(state.reminders).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(state.seeded).toBe(false);
    // A single atomic operation: no additive import, no reset-then-import.
    expect(api.importAll).not.toHaveBeenCalled();
    expect(api.resetAll).not.toHaveBeenCalled();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('rebases writes made while a connected replace is in flight (three-way)', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(persistedState([makeAttack('A1'), makeAttack('A2')])),
    );
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('A1'), makeAttack('A2')],
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(currentStore().state.timezone).toBe('UTC');

    const deferred = createDeferred<ReturnType<typeof emptyExport>>();
    api.restoreAll.mockReturnValue(deferred.promise);
    const restoredRefill = {
      id: 'r-backup',
      medId: 'nurtec',
      date: '2026-10-18',
      quantity: 8,
      notes: '',
      source: 'manual' as const,
    };
    const backup = parsedBackup(backupEnvelope({
      attacks: [makeAttack('from-backup')],
      refills: [restoredRefill],
      settings: {
        timezone: 'Asia/Tokyo',
        lowStockThreshold: 4,
        rules: { nurtec: { limit: 11, windowDays: 30 } },
      },
    }));

    let replace!: Promise<void>;
    await act(async () => {
      replace = currentStore().replaceBackup(backup);
    });
    expect(api.restoreAll).toHaveBeenCalledTimes(1);

    // Writes that land while the restore is pending: their server tasks are
    // queued BEHIND the restore.
    let newMed!: MedEvent;
    await act(async () => {
      newMed = currentStore().logMed('nurtec', new Date('2026-10-21T09:00:00.000Z'));
      currentStore().updateAttack('A1', { notes: 'edited while restoring' });
      currentStore().deleteAttack('A2');
      currentStore().setTimezone('Europe/Berlin');
      currentStore().setLowStockThreshold(7);
    });

    await act(async () => {
      // The canonical envelope echoes different records and different settings.
      deferred.resolve({
        ...emptyExport(),
        attacks: [makeAttack('from-backup')],
        refills: [restoredRefill],
        settings: { timezone: 'America/New_York', lowStockThreshold: 1 },
      });
      await replace;
    });
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));

    const state = currentStore().state;
    // Later ADDITION survives and the queued addMed reproduced the same row.
    expect(state.meds).toEqual([newMed]);
    expect(api.addMed).toHaveBeenCalledWith(newMed);
    // Later EDIT survives and the queued PATCH carries it.
    expect(state.attacks.find((a) => a.id === 'A1')?.notes).toBe('edited while restoring');
    expect(api.patchAttack).toHaveBeenCalledWith(
      'A1', expect.objectContaining({ notes: 'edited while restoring' }),
    );
    // Later DELETION survives and the queued DELETE ran.
    expect(state.attacks.some((a) => a.id === 'A2')).toBe(false);
    expect(api.deleteAttack).toHaveBeenCalledWith('A2');
    // Later SETTINGS win over the backup's.
    expect(state.timezone).toBe('Europe/Berlin');
    expect(state.lowStockThreshold).toBe(7);
    // Untouched replacement content still comes from the canonical envelope.
    expect(state.attacks.some((a) => a.id === 'from-backup')).toBe(true);
    expect(state.refills).toEqual([restoredRefill]);
    expect(state.rules.nurtec).toEqual({ limit: 11, windowDays: 30 });
  });

  it('connected replace adopts defaults for settings absent from the backup', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([]),
      timezone: 'America/New_York',
      lowStockThreshold: 5,
      reminders: { ...DEFAULT_REMINDER_SETTINGS, enabled: false },
    }));
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('before')],
      settings: {
        timezone: 'America/New_York',
        lowStockThreshold: 5,
        reminders: { ...DEFAULT_REMINDER_SETTINGS, enabled: false },
      },
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(currentStore().state.lowStockThreshold).toBe(5);
    expect(currentStore().state.reminders.enabled).toBe(false);

    api.restoreAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('restored')],
    });
    const backup = parsedBackup(backupEnvelope({ attacks: [makeAttack('restored')] }));
    expect(backup.settings).toEqual({});

    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    const state = currentStore().state;
    expect(state.lowStockThreshold).toBe(storeModule.DEFAULT_LOW_STOCK_THRESHOLD);
    expect(state.reminders).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(state.timezone).toBe(systemTimeZone());
    // Records still come from the canonical envelope.
    expect(state.attacks.map((a) => a.id)).toEqual(['restored']);
  });

  it('browser-only replace with absent settings yields the same defaults', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...persistedState([makeAttack('local')]),
      timezone: 'America/New_York',
      lowStockThreshold: 5,
      reminders: { ...DEFAULT_REMINDER_SETTINGS, enabled: false },
    }));
    api.exportAll.mockRejectedValue(new Error('offline'));

    mountStore();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore().serverMode).toBe(false);

    const backup = parsedBackup({ attacks: [] });
    expect(backup.format).toBe('browser');
    expect(backup.settings).toEqual({});

    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    const state = currentStore().state;
    expect(state.lowStockThreshold).toBe(storeModule.DEFAULT_LOW_STOCK_THRESHOLD);
    expect(state.reminders).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(state.timezone).toBe(systemTimeZone());
  });

  it('assigns a local id to an id-less merged attack and imports that same id', async () => {
    api.exportAll.mockResolvedValue(emptyExport());
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const backup = parsedBackup(backupEnvelope({
      attacks: [{ ...makeAttack(''), notes: 'no id' }],
    }));
    await act(async () => {
      currentStore().mergeBackup(backup);
    });

    const local = currentStore().state.attacks[0];
    expect(local.id).toBeTruthy();
    await waitFor(() => expect(api.importAll).toHaveBeenCalledTimes(1));
    expect(api.importAll).toHaveBeenCalledWith(expect.objectContaining({
      attacks: [expect.objectContaining({ id: local.id, notes: 'no id' })],
    }));
  });

  it('assigns unique local ids to every id-keyed record on a browser-only replace', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));
    mountStore();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore().serverMode).toBe(false);

    const attackWithoutId = (start: string) => ({
      start, end: null, painLog: [], peakPain: -1, symptoms: [], triggers: [],
      aura: null, notes: '', source: 'manual',
    });
    const backup = parsedBackup({
      attacks: [
        attackWithoutId('2026-10-20T08:00:00.000Z'),
        attackWithoutId('2026-10-21T08:00:00.000Z'),
      ],
      meds: [{
        medId: 'nurtec', ts: '2026-10-21T09:00:00.000Z', dose: '75 mg',
        quantity: 1, attackId: null, notes: '', source: 'manual',
      }],
      refills: [{
        medId: 'nurtec', date: '2026-10-18', quantity: 8, notes: '', source: 'manual',
      }],
      workouts: [{
        performedAt: '2026-10-19T17:00:00.000Z', kind: 'cardio', effort: 'low',
        durationMinutes: 20, notes: '', source: 'manual',
      }],
      stockBaselines: [{
        medId: 'nurtec', effectiveAt: '2026-10-01T00:00:00.000Z', quantity: 8,
        notes: '', source: 'manual', createdAt: '2026-10-01T00:00:01.000Z',
      }],
    });

    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    const state = currentStore().state;
    const ids = [
      ...state.attacks, ...state.meds, ...state.refills,
      ...state.workouts, ...state.stockBaselines,
    ].map((record) => record.id);
    expect(ids).toHaveLength(6);
    for (const id of ids) expect(id).toBeTruthy();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sends generated ids to the restore endpoint for id-less records', async () => {
    api.exportAll.mockResolvedValue(emptyExport());
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const backup = parsedBackup(backupEnvelope({
      attacks: [{ ...makeAttack(''), notes: 'no id' }],
    }));
    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    expect(api.restoreAll).toHaveBeenCalledTimes(1);
    const payload = api.restoreAll.mock.calls[0][0] as { attacks: { id: string }[] };
    expect(payload.attacks).toHaveLength(1);
    expect(payload.attacks[0].id).toBeTruthy();
    expect(payload.attacks[0].id).not.toBe('');
  });

  it('keeps pre-restore data when a connected replace fails and allows a retry', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('before')],
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const backup = parsedBackup(backupEnvelope({
      attacks: [makeAttack('restored')],
    }));
    api.restoreAll.mockRejectedValueOnce(new Error('restore failed'));

    await act(async () => {
      await expect(currentStore().replaceBackup(backup)).rejects.toThrow('restore failed');
    });

    expect(currentStore().state.attacks.map((a) => a.id)).toEqual(['before']);
    await waitFor(() => {
      expect(currentStore().sync.pending).toBe(0);
      expect(currentStore().sync.failed).toBe(true);
    });
    expect(currentStore().sync.dirty).toBe(true);

    // The mock recovers: a second attempt is possible and adopts the snapshot.
    api.restoreAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('restored')],
    });
    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    expect(currentStore().state.attacks.map((a) => a.id)).toEqual(['restored']);
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
    consoleError.mockRestore();
  });

  it('forces a replace through divergence, clears it on success, and drops stale pending latch bookkeeping', async () => {
    const localAttack = makeAttack('local-attack');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState([localAttack])));
    localStorage.setItem(SYNC_META_KEY, JSON.stringify({ dirty: true, failed: true }));
    localStorage.setItem(
      LATCH_PENDING_KEY,
      JSON.stringify({ latchedAt: '2026-10-01T00:00:00.000Z' }),
    );
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('server-attack')],
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('conflict'));
    expect(currentStore().sync.diverged).toBe(true);
    expect(readPendingLatch()).not.toBeNull();

    const deferred = createDeferred<ReturnType<typeof emptyExport>>();
    api.restoreAll.mockReturnValue(deferred.promise);
    const backup = parsedBackup(backupEnvelope({
      attacks: [makeAttack('restored')],
    }));

    let replace!: Promise<void>;
    await act(async () => {
      replace = currentStore().replaceBackup(backup);
    });

    // While the server restore is pending, the unsynced local data survives.
    expect(currentStore().state.attacks.map((a) => a.id)).toEqual(['local-attack']);
    expect(api.restoreAll).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({ ...emptyExport(), attacks: [makeAttack('restored')] });
      await replace;
    });

    expect(currentStore().state.attacks.map((a) => a.id)).toEqual(['restored']);
    expect(currentStore().sync.diverged).toBe(false);
    expect(readPendingLatch()).toBeNull();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('applies a browser-only replacement locally with its settings and stays dirty + failed', async () => {
    const localAttack = makeAttack('local-attack');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState([localAttack])));
    api.exportAll.mockRejectedValue(new Error('offline'));

    mountStore();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore().serverMode).toBe(false);

    const backup = parsedBackup({
      attacks: [{ ...makeAttack('browser-a'), notes: 'browser export' }],
      meds: [],
      refills: [],
      workouts: [],
      dayStates: [],
      stockBaselines: [],
      rules: { nurtec: { limit: 6, windowDays: 30 } },
      doses: { nurtec: '75 mg' },
      planned: { botox: '2026-11-01' },
      timezone: 'Asia/Tokyo',
      lowStockThreshold: 4,
      lowStockAlertedAt: '2026-10-20T00:00:00.000Z',
      reminders: { ...DEFAULT_REMINDER_SETTINGS, enabled: false },
      seeded: true,
    });
    expect(backup.format).toBe('browser');
    expect(backup.seeded).toBe(true);

    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    const state = currentStore().state;
    expect(state.attacks.map((a) => a.id)).toEqual(['browser-a']);
    expect(state.attacks[0].notes).toBe('browser export');
    expect(state.rules.nurtec).toEqual({ limit: 6, windowDays: 30 });
    expect(state.doses.nurtec).toBe('75 mg');
    expect(state.planned.botox).toBe('2026-11-01');
    expect(state.timezone).toBe('Asia/Tokyo');
    expect(state.lowStockThreshold).toBe(4);
    expect(state.lowStockAlertedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(state.reminders.enabled).toBe(false);
    expect(state.seeded).toBe(true);

    // Browser-only restore is local and unconfirmed: no server call, and the
    // sticky latches stop a later hydration from silently overwriting it.
    expect(api.restoreAll).not.toHaveBeenCalled();
    expect(api.importAll).not.toHaveBeenCalled();
    const sync = currentStore().sync;
    expect(sync.status).toBe('local');
    expect(sync.dirty).toBe(true);
    expect(sync.failed).toBe(true);
    expect(readSyncMeta()).toEqual({ dirty: true, failed: true });
    expect(readPersistedState().attacks.map((a) => a.id)).toEqual(['browser-a']);
  });

  it('applies an empty browser-only replacement and keeps it latched', async () => {
    const localAttack = makeAttack('local-attack');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState([localAttack])));
    api.exportAll.mockRejectedValue(new Error('offline'));

    mountStore();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore().serverMode).toBe(false);

    const backup = parsedBackup({
      attacks: [],
      meds: [],
      refills: [],
      workouts: [],
      dayStates: [],
      stockBaselines: [],
    });
    expect(backup.format).toBe('browser');

    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    const state = currentStore().state;
    expect(state.attacks).toEqual([]);
    expect(state.meds).toEqual([]);
    expect(state.lowStockThreshold).toBe(2);
    expect(state.seeded).toBe(false);
    expect(state.reminders).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(typeof state.timezone).toBe('string');

    // Even an empty deliberate replacement stays dirty + failed.
    const sync = currentStore().sync;
    expect(sync.dirty).toBe(true);
    expect(sync.failed).toBe(true);
    expect(readSyncMeta()).toEqual({ dirty: true, failed: true });
    expect(readPersistedState().attacks).toEqual([]);
  });

  it('rejects a replacement containing duplicate ids without changing state or calling the server', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('before')],
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    const backup = parsedBackup(backupEnvelope({
      attacks: [makeAttack('dup'), { ...makeAttack('dup'), notes: 'second' }],
    }));
    expect(backup.duplicateCounts.attacks).toBe(1);

    await act(async () => {
      await expect(currentStore().replaceBackup(backup))
        .rejects.toThrow('duplicate ids in backup; replacement must be exact');
    });

    expect(currentStore().state.attacks.map((a) => a.id)).toEqual(['before']);
    expect(api.restoreAll).not.toHaveBeenCalled();
    expect(api.importAll).not.toHaveBeenCalled();
  });

  it('normalizes sparse legacy records before merging them locally and sending the payload', async () => {
    api.exportAll.mockResolvedValue(emptyExport());
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.importAll.mockClear();

    // Legal/legacy records may omit optional fields, but the app itself sorts
    // and renders them (and their comparators assume the field exists), so a
    // fully-defaulted copy is required before the diff, the local apply, and
    // the payload — mirroring server/mappers.js.
    const sparseAttack = { id: 'sparse-a', start: '2026-10-20T08:00:00.000Z' };
    const sparseMed = { id: 'sparse-m', medId: 'nurtec' };
    const sparseBaseline = {
      id: 'sparse-b', medId: 'nurtec', effectiveAt: '2026-10-01T00:00:00.000Z', quantity: 8,
    };
    const backup = parsedBackup(backupEnvelope({
      attacks: [sparseAttack],
      meds: [sparseMed],
      stockBaselines: [sparseBaseline],
    }));

    await act(async () => {
      currentStore().mergeBackup(backup);
    });
    await waitFor(() => expect(api.importAll).toHaveBeenCalledTimes(1));

    const state = currentStore().state;
    expect(state.attacks).toEqual([{
      id: 'sparse-a',
      start: '2026-10-20T08:00:00.000Z',
      end: null,
      painLog: [],
      peakPain: -1,
      symptoms: [],
      triggers: [],
      aura: null,
      notes: '',
      source: 'manual',
    }]);
    expect(state.meds).toEqual([{
      id: 'sparse-m',
      medId: 'nurtec',
      ts: expect.any(String),
      dose: '',
      quantity: null,
      attackId: null,
      notes: '',
      source: 'import',
    }]);
    expect(state.stockBaselines).toEqual([{
      id: 'sparse-b',
      medId: 'nurtec',
      effectiveAt: '2026-10-01T00:00:00.000Z',
      quantity: 8,
      notes: '',
      source: 'import',
      createdAt: expect.any(String),
    }]);
    const med = state.meds[0];
    const baseline = state.stockBaselines[0];
    expect(Number.isFinite(Date.parse(med.ts))).toBe(true);
    expect(Number.isFinite(Date.parse(baseline.createdAt))).toBe(true);
    // ONE timestamp per normalization pass: every defaulted instant agrees.
    expect(baseline.createdAt).toBe(med.ts);

    // The import payload is the same usable, defaulted record set.
    expect(api.importAll).toHaveBeenCalledWith({
      attacks: [state.attacks[0]],
      meds: [med],
      refills: [],
      workouts: [],
      dayStates: [],
      stockBaselines: [baseline],
    });

    // Normalization copies: the parsed backup objects stay untouched.
    expect(backup.attacks[0]).toEqual(sparseAttack);
    expect(backup.meds[0]).toEqual(sparseMed);
    expect(backup.stockBaselines[0]).toEqual(sparseBaseline);
  });

  it('normalizes sparse records on a browser-only replace', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));
    mountStore();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(currentStore().serverMode).toBe(false);

    const backup = parsedBackup({
      attacks: [{ start: '2026-10-20T08:00:00.000Z' }],
      meds: [{ medId: 'nurtec' }],
      refills: [{ medId: 'nurtec', date: '2026-10-18' }],
      workouts: [{ performedAt: '2026-10-19T17:00:00.000Z', kind: 'cardio', effort: 'low' }],
      stockBaselines: [{ medId: 'nurtec', effectiveAt: '2026-10-01T00:00:00.000Z', quantity: 8 }],
      dayStates: [{ day: '2026-10-20', status: 'well' }],
    });
    expect(backup.format).toBe('browser');

    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    const state = currentStore().state;
    expect(state.attacks).toEqual([{
      id: expect.any(String),
      start: '2026-10-20T08:00:00.000Z',
      end: null,
      painLog: [],
      peakPain: -1,
      symptoms: [],
      triggers: [],
      aura: null,
      notes: '',
      source: 'manual',
    }]);
    expect(state.meds).toEqual([{
      id: expect.any(String),
      medId: 'nurtec',
      ts: expect.any(String),
      dose: '',
      quantity: null,
      attackId: null,
      notes: '',
      source: 'import',
    }]);
    expect(state.refills).toEqual([{
      id: expect.any(String),
      medId: 'nurtec',
      date: '2026-10-18',
      quantity: null,
      notes: '',
      source: 'import',
    }]);
    expect(state.workouts).toEqual([{
      id: expect.any(String),
      performedAt: '2026-10-19T17:00:00.000Z',
      kind: 'cardio',
      effort: 'low',
      durationMinutes: null,
      notes: '',
      source: 'import',
    }]);
    expect(state.stockBaselines).toEqual([{
      id: expect.any(String),
      medId: 'nurtec',
      effectiveAt: '2026-10-01T00:00:00.000Z',
      quantity: 8,
      notes: '',
      source: 'import',
      createdAt: expect.any(String),
    }]);
    expect(state.dayStates).toEqual([{
      day: '2026-10-20',
      status: 'well',
      notes: '',
      updatedAt: expect.any(String),
    }]);
    // Id-less records got usable local ids; the shared timestamp covers every
    // defaulted instant in this pass.
    expect(state.attacks[0].id).toBeTruthy();
    expect(state.stockBaselines[0].createdAt).toBe(state.meds[0].ts);
    expect(state.dayStates[0].updatedAt).toBe(state.meds[0].ts);
  });

  it('sends full defaulted settings and records for a connected replace of a settings-less backup', async () => {
    api.exportAll.mockResolvedValue(emptyExport());
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    // The defaults an empty-server hydration already shows: the replacement
    // must adopt exactly these (and report them to the server).
    const defaultRulesSnapshot = currentStore().state.rules;
    const defaultDosesSnapshot = currentStore().state.doses;
    expect(Object.keys(defaultRulesSnapshot).length).toBeGreaterThan(0);

    const backup = parsedBackup({
      schemaVersion: 4,
      attacks: [{ id: 'sparse-a', start: '2026-10-20T08:00:00.000Z' }],
      meds: [{ id: 'sparse-m', medId: 'nurtec' }],
    });
    expect(backup.settings).toEqual({});

    // The server applies its own mapper defaults and echoes the records.
    api.restoreAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [{
        id: 'sparse-a',
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
      meds: [{
        id: 'sparse-m',
        medId: 'nurtec',
        ts: '2026-10-21T00:00:00.000Z',
        dose: '',
        quantity: null,
        attackId: null,
        notes: '',
        source: 'import',
      }],
    });

    await act(async () => {
      await currentStore().replaceBackup(backup);
    });

    // The payload is usable AND carries the full effective settings: the
    // server stores only the keys it receives, so a settings-less backup must
    // not leave it without any.
    const payload = api.restoreAll.mock.calls[0][0] as {
      attacks: unknown[];
      meds: unknown[];
      settings: Record<string, unknown>;
    };
    expect(payload.attacks).toEqual([{
      id: 'sparse-a',
      start: '2026-10-20T08:00:00.000Z',
      end: null,
      painLog: [],
      peakPain: -1,
      symptoms: [],
      triggers: [],
      aura: null,
      notes: '',
      source: 'manual',
    }]);
    const payloadMed = payload.meds[0] as {
      ts: string; dose: string; quantity: unknown; attackId: unknown;
      notes: string; source: string;
    };
    expect(payloadMed).toMatchObject({
      dose: '', quantity: null, attackId: null, notes: '', source: 'import',
    });
    expect(Number.isFinite(Date.parse(payloadMed.ts))).toBe(true);

    expect(payload.settings.timezone).toBe(systemTimeZone());
    expect(payload.settings.lowStockThreshold).toBe(storeModule.DEFAULT_LOW_STOCK_THRESHOLD);
    expect(payload.settings.reminders).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(payload.settings.lowStockAlert).toEqual({ latchedAt: null });
    expect(payload.settings.rules).toEqual(defaultRulesSnapshot);
    expect(payload.settings.doses).toEqual(defaultDosesSnapshot);
    expect(payload.settings.planned).toEqual({});

    // The adopted local state agrees with what was sent to the server.
    const state = currentStore().state;
    expect(state.timezone).toBe(systemTimeZone());
    expect(state.lowStockThreshold).toBe(storeModule.DEFAULT_LOW_STOCK_THRESHOLD);
    expect(state.reminders).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(state.lowStockAlertedAt).toBeNull();
    expect(state.rules).toEqual(defaultRulesSnapshot);
    expect(state.doses).toEqual(defaultDosesSnapshot);
    expect(state.planned).toEqual({});
    // Records still come from the canonical envelope.
    expect(state.attacks.map((a) => a.id)).toEqual(['sparse-a']);
    expect(state.meds).toEqual([{
      id: 'sparse-m',
      medId: 'nurtec',
      ts: '2026-10-21T00:00:00.000Z',
      dose: '',
      quantity: null,
      attackId: null,
      notes: '',
      source: 'import',
    }]);
  });
});

describe('peak pain correction', () => {
  const PAIN_TS = '2026-10-20T09:00:00.000Z';

  async function mountWithAttack(attack: Attack): Promise<void> {
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [attack] });
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    await waitFor(() =>
      expect(currentStore().state.attacks.find((a) => a.id === attack.id)).toBeDefined());
  }

  function storedAttack(id: string): Attack {
    const found = currentStore().state.attacks.find((a) => a.id === id);
    if (!found) throw new Error(`attack ${id} missing from store state`);
    return found;
  }

  function lastAttackPatch(): Partial<Attack> {
    const calls = api.patchAttack.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][1] as Partial<Attack>;
  }

  async function settle(): Promise<void> {
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));
  }

  function seededAttack(id: string): Attack {
    return {
      ...makeAttack(id),
      peakPain: 6,
      painLog: [{ ts: PAIN_TS, level: 6 }],
    };
  }

  it('applies an explicit raised peak and keeps the existing single log entry', async () => {
    await mountWithAttack(seededAttack('a1'));
    expect(storedAttack('a1').peakPain).toBe(6);

    await act(async () => {
      currentStore().updateAttack('a1', { peakPain: 9 });
    });

    expect(storedAttack('a1').peakPain).toBe(9);
    expect(storedAttack('a1').painLog).toEqual([{ ts: PAIN_TS, level: 6 }]);
    await settle();

    // Only the corrected peak goes on the wire; the untouched log is not
    // resent and no synthetic entry is added.
    expect(lastAttackPatch()).toEqual({ peakPain: 9 });
  });

  it('applies an explicit downward correction', async () => {
    await mountWithAttack(seededAttack('a1'));

    await act(async () => {
      currentStore().updateAttack('a1', { peakPain: 2 });
    });

    expect(storedAttack('a1').peakPain).toBe(2);
    expect(storedAttack('a1').painLog).toHaveLength(1);
    await settle();
    expect(lastAttackPatch()).toEqual({ peakPain: 2 });
  });

  it('accepts an explicit 0 peak', async () => {
    await mountWithAttack(seededAttack('a1'));

    await act(async () => {
      currentStore().updateAttack('a1', { peakPain: 0 });
    });

    expect(storedAttack('a1').peakPain).toBe(0);
    await settle();
    expect(lastAttackPatch().peakPain).toBe(0);
  });

  it('does not resurrect an old peak on a metadata-only update after a correction', async () => {
    await mountWithAttack(seededAttack('a1'));
    await act(async () => {
      currentStore().updateAttack('a1', { peakPain: 2 });
    });
    await act(async () => {
      currentStore().updateAttack('a1', { notes: 'x' });
    });

    expect(storedAttack('a1').peakPain).toBe(2);
    expect(storedAttack('a1').notes).toBe('x');
    await settle();

    // The corrected peak is already stored, so the metadata edit sends only
    // the metadata — it must not resurrect or resend the peak.
    expect(lastAttackPatch()).toEqual({ notes: 'x' });
  });

  it('folds only new pain entries into the corrected peak', async () => {
    await mountWithAttack(seededAttack('a1'));
    await act(async () => {
      currentStore().updateAttack('a1', { peakPain: 2 });
    });
    await settle();

    await act(async () => {
      currentStore().logPain('a1', 3);
    });
    expect(storedAttack('a1').peakPain).toBe(3);
    expect(storedAttack('a1').painLog).toHaveLength(2);

    await act(async () => {
      currentStore().logPain('a1', 1);
    });
    expect(storedAttack('a1').peakPain).toBe(3);
    expect(storedAttack('a1').painLog).toHaveLength(3);

    await act(async () => {
      currentStore().logPain('a1', 9);
    });
    expect(storedAttack('a1').peakPain).toBe(9);
    expect(storedAttack('a1').painLog).toHaveLength(4);
    await settle();

    const payload = lastAttackPatch();
    expect(payload.peakPain).toBe(9);
    expect(payload.painLog).toHaveLength(4);
  });

  it('still derives a peak for legacy attacks whose stored peak is unknown', async () => {
    await mountWithAttack({
      ...makeAttack('legacy'),
      peakPain: -1,
      painLog: [
        { ts: PAIN_TS, level: 4 },
        { ts: '2026-10-20T10:00:00.000Z', level: 6 },
      ],
    });

    await act(async () => {
      currentStore().updateAttack('legacy', { notes: 'legacy' });
    });
    expect(storedAttack('legacy').peakPain).toBe(6);
    await settle();
    // The diff is built from the merged record: the derived peak is a real
    // change and must reach the server even though the caller only edited
    // metadata. The log itself is untouched and not resent.
    expect(lastAttackPatch()).toEqual({ peakPain: 6, notes: 'legacy' });
  });

  it('uses max semantics for new pain entries on a fresh attack', async () => {
    await mountWithAttack(makeAttack('fresh'));
    expect(storedAttack('fresh').peakPain).toBe(-1);

    await act(async () => {
      currentStore().logPain('fresh', 3);
    });
    expect(storedAttack('fresh').peakPain).toBe(3);

    await act(async () => {
      currentStore().logPain('fresh', 7);
    });
    expect(storedAttack('fresh').peakPain).toBe(7);

    await act(async () => {
      currentStore().logPain('fresh', 2);
    });
    expect(storedAttack('fresh').peakPain).toBe(7);
    await settle();
    expect(lastAttackPatch().peakPain).toBe(7);
  });

  it('keeps a 0-pain attack valid', async () => {
    await mountWithAttack(makeAttack('zero'));

    await act(async () => {
      currentStore().logPain('zero', 0);
    });

    expect(storedAttack('zero').peakPain).toBe(0);
    expect(storedAttack('zero').painLog).toEqual([
      { ts: expect.any(String), level: 0 },
    ]);
    await settle();
    expect(lastAttackPatch().peakPain).toBe(0);
    expect(lastAttackPatch().painLog).toEqual([{ ts: expect.any(String), level: 0 }]);
  });

  it.each([7, 0])(
    'keeps an initial %i-pain attack intact through the creation sequence',
    async (level) => {
      // AttackFormDialog's new/past path: startAttack -> logPain -> metadata
      // updateAttack. The metadata patch must not reset the captured peak.
      mountStore();
      await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

      let createdId = '';
      const start = new Date('2026-10-20T08:00:00.000Z');
      await act(async () => {
        createdId = currentStore().startAttack(start).id;
        currentStore().logPain(createdId, level, start);
        currentStore().updateAttack(createdId, { notes: 'past attack' });
      });
      await settle();

      expect(storedAttack(createdId).peakPain).toBe(level);
      expect(storedAttack(createdId).painLog).toHaveLength(1);
      // logPain already sent the peak, so the metadata patch is metadata-only.
      expect(lastAttackPatch()).toEqual({ notes: 'past attack' });
    },
  );
});

describe('record id integrity', () => {
  it('never lets a patch id replace an attack id locally or on the wire', async () => {
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('a1')] });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().updateAttack(
        'a1', patchWithId<Attack>({ id: 'hijacked', notes: 'kept' }),
      );
    });
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));

    const attacks = currentStore().state.attacks;
    expect(attacks).toHaveLength(1);
    expect(attacks[0].id).toBe('a1');
    expect(attacks[0].notes).toBe('kept');

    expect(api.patchAttack).toHaveBeenCalledTimes(1);
    const [routeId, payload] = api.patchAttack.mock.calls[0];
    expect(routeId).toBe('a1');
    // The wire PATCH is a narrow diff: it never carries an id at all, so the
    // smuggled `id` cannot reassign the record; only the change is sent.
    expect(payload).not.toHaveProperty('id');
    expect(payload).toEqual({ notes: 'kept' });
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('never lets a patch id replace a med id locally or on the wire', async () => {
    api.exportAll.mockResolvedValue({ ...emptyExport(), meds: [makeMed('m1')] });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.patchMed.mockClear();

    await act(async () => {
      currentStore().updateMed(
        'm1', patchWithId<MedEvent>({ id: 'hijacked', notes: 'edited' }),
      );
    });
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));

    const meds = currentStore().state.meds;
    expect(meds).toHaveLength(1);
    expect(meds[0].id).toBe('m1');
    expect(meds[0].notes).toBe('edited');

    expect(api.patchMed).toHaveBeenCalledTimes(1);
    const [routeId, payload] = api.patchMed.mock.calls[0];
    expect(routeId).toBe('m1');
    // The partial patch is sent without any id: the route id is authoritative.
    expect(payload).not.toHaveProperty('id');
    expect(payload.notes).toBe('edited');
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
  });

  it('ignores updateMed for an unknown id: no local record and no queued patch', async () => {
    api.exportAll.mockResolvedValue({ ...emptyExport(), meds: [makeMed('m1')] });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.patchMed.mockClear();

    await act(async () => {
      currentStore().updateMed('does-not-exist', { notes: 'never applied' });
    });

    expect(currentStore().state.meds.map((m) => m.id)).toEqual(['m1']);
    expect(currentStore().state.meds[0].notes).toBe('');
    expect(api.patchMed).not.toHaveBeenCalled();
    expect(currentStore().sync.pending).toBe(0);
    expect(currentStore().sync.dirty).toBe(false);
  });
});

describe('narrow record PATCH payloads', () => {
  function makeRefillRecord(id: string, overrides: Partial<Refill> = {}): Refill {
    return {
      id,
      medId: 'nurtec',
      date: '2026-03-01',
      quantity: 8,
      notes: 'pharmacy',
      source: 'manual',
      ...overrides,
    };
  }

  it('sends only the changed attack fields, never the id or unchanged keys', async () => {
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [makeAttack('a1')] });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().updateAttack('a1', {
        // Unchanged values (identical arrays/null) are not edits.
        notes: 'narrow', symptoms: [], triggers: [], aura: null,
      });
    });
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));

    expect(api.patchAttack).toHaveBeenCalledTimes(1);
    const [routeId, payload] = api.patchAttack.mock.calls[0];
    expect(routeId).toBe('a1');
    expect(payload).toEqual({ notes: 'narrow' });
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
    expect(currentStore().state.attacks[0]).toMatchObject({ id: 'a1', notes: 'narrow' });
  });

  it('transmits explicit null clears for attack end/aura', async () => {
    const attack: Attack = {
      ...makeAttack('a1'),
      end: '2026-10-20T12:00:00.000Z',
      aura: true,
    };
    api.exportAll.mockResolvedValue({ ...emptyExport(), attacks: [attack] });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().updateAttack('a1', { end: null, aura: null });
    });
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));

    expect(api.patchAttack).toHaveBeenCalledWith('a1', { end: null, aura: null });
    const stored = currentStore().state.attacks[0];
    expect(stored.end).toBeNull();
    expect(stored.aura).toBeNull();
  });

  it('transmits explicit null clears for med quantity/attackId and refill quantity', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      meds: [makeMed('m1', { attackId: 'atk1', quantity: 3 })],
      refills: [makeRefillRecord('r1')],
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().updateMed('m1', { attackId: null, quantity: null });
      currentStore().updateRefill('r1', { quantity: null });
    });
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));

    expect(api.patchMed).toHaveBeenCalledWith('m1', { attackId: null, quantity: null });
    expect(api.patchRefill).toHaveBeenCalledWith('r1', { quantity: null });
    expect(currentStore().state.meds[0]).toMatchObject({ attackId: null, quantity: null });
    expect(currentStore().state.refills[0].quantity).toBeNull();
  });

  it('sends narrow stock-baseline and workout diffs', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      stockBaselines: [makeStockBaseline('b1', 10, daysAgo(5))],
      workouts: [makeWorkout('w1')],
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      currentStore().updateStockBaseline('b1', { quantity: 7 });
      currentStore().updateWorkout('w1', { durationMinutes: 30 });
    });
    await waitFor(() => expect(currentStore().sync.pending).toBe(0));

    expect(api.patchStockBaseline).toHaveBeenCalledWith('b1', { quantity: 7 });
    expect(api.patchWorkout).toHaveBeenCalledWith('w1', { durationMinutes: 30 });
    expect(currentStore().state.stockBaselines[0].quantity).toBe(7);
    expect(currentStore().state.workouts[0].durationMinutes).toBe(30);
  });

  it('skips the PATCH and the sync latches for no-op and undefined-only updates', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack('a1')],
      meds: [makeMed('m1')],
      refills: [makeRefillRecord('r1')],
      workouts: [makeWorkout('w1')],
      stockBaselines: [makeStockBaseline('b1', 10, daysAgo(5))],
    });

    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    await act(async () => {
      // Identical values and undefined keys (which JSON cannot transmit) are
      // not edits: no empty PATCH, no optimistic change, no dirty latch.
      currentStore().updateAttack('a1', { notes: '', peakPain: undefined });
      currentStore().updateAttack('a1', { notes: undefined });
      currentStore().updateMed('m1', { notes: undefined });
      currentStore().updateRefill('r1', { notes: 'pharmacy' });
      currentStore().updateStockBaseline('b1', { quantity: 10 });
      currentStore().updateWorkout('w1', { notes: undefined });
    });

    expect(api.patchAttack).not.toHaveBeenCalled();
    expect(api.patchMed).not.toHaveBeenCalled();
    expect(api.patchRefill).not.toHaveBeenCalled();
    expect(api.patchStockBaseline).not.toHaveBeenCalled();
    expect(api.patchWorkout).not.toHaveBeenCalled();
    expect(currentStore().sync.pending).toBe(0);
    expect(currentStore().sync.dirty).toBe(false);
    expect(readSyncMeta()).toEqual({ dirty: false, failed: false });
    // An undefined key is absent, never a local-only clear.
    expect(currentStore().state.meds[0].notes).toBe('');
    expect(currentStore().state.workouts[0].notes).toBe('');
  });
});

describe('setRules batch write', () => {
  it('applies all rules in one state update and one whole-map settings write', async () => {
    mountStore();
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));
    api.putSetting.mockClear();

    const shared = { limit: 9, windowDays: 21 };
    await act(async () => {
      currentStore().setRules({
        tylenol: { ...shared },
        ibuprofen: { ...shared },
        naproxen: { ...shared },
      });
    });
    await waitFor(() => expect(currentStore().sync.status).toBe('synced'));

    // ONE write for the whole resolved map, not three intermediate payloads.
    expect(api.putSetting).toHaveBeenCalledTimes(1);
    expect(api.putSetting).toHaveBeenCalledWith('rules', expect.objectContaining({
      tylenol: shared,
      ibuprofen: shared,
      naproxen: shared,
      // Untouched meds stay in the whole-map payload.
      nurtec: expect.anything(),
    }));
    expect(currentStore().state.rules.tylenol).toEqual(shared);
    expect(currentStore().state.rules.naproxen).toEqual(shared);
  });
});
