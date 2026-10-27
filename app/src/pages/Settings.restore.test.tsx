// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TrackerState } from '@/types';
import type { BackupRecordKey } from '../../shared/backup.ts';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

interface MergeResult {
  added: Record<BackupRecordKey, number>;
  synced: Promise<void>;
}

interface StoreStub {
  state: TrackerState;
  sync: { status: string; pending: number; diverged: boolean };
  serverMode: boolean;
  setLowStockThreshold: Mock;
  resetLowStockAlert: Mock;
  addStockBaseline: Mock;
  deleteStockBaseline: Mock;
  importData: Mock;
  loadDemoData: Mock;
  resetAll: Mock;
  resolveUseServer: Mock;
  setRule: Mock;
  setDoseDefault: Mock;
  setTimezone: Mock;
  updateReminders: Mock;
  mergeBackup: Mock;
  replaceBackup: Mock;
}

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
  mergeBackup: vi.fn(),
  replaceBackup: vi.fn(),
})) as unknown as StoreStub;

vi.mock('@/lib/store', () => ({ useStore: () => store }));

// Settings fetches health on mount; keep it pending so these tests never touch
// a real network. The real ApiError class is kept so the component's
// status-based classification can be exercised with real instances.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { getHealth: vi.fn(() => new Promise(() => {})) } };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import Settings from './Settings';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';

const ZERO_COUNTS: Record<BackupRecordKey, number> = {
  attacks: 0, meds: 0, refills: 0, workouts: 0, dayStates: 0, stockBaselines: 0,
};

// ── fixtures (mirrors shared/backup.test.ts record rules) ─────────────
const attack = (id: string, start = '2026-10-20T08:00:00.000Z') => ({
  id,
  start,
  end: null,
  painLog: [],
  peakPain: -1,
  symptoms: [],
  triggers: [],
  aura: null,
  notes: '',
  source: 'manual',
});

const med = (id: string) => ({
  id,
  medId: 'nurtec',
  ts: '2026-10-20T09:00:00.000Z',
  dose: '75 mg',
  quantity: 1,
  attackId: null,
  notes: '',
  source: 'manual',
});

const refill = (id: string) => ({
  id,
  medId: 'nurtec',
  date: '2026-10-18',
  quantity: 8,
  notes: '',
  source: 'manual',
});

const workout = (id: string) => ({
  id,
  performedAt: '2026-10-19T17:00:00.000Z',
  kind: 'cardio',
  effort: 'low',
  durationMinutes: 20,
  notes: '',
  source: 'manual',
});

const dayState = (day: string, status = 'well') => ({
  day,
  status,
  notes: '',
  updatedAt: '2026-10-20T18:00:00.000Z',
});

const baseline = (id: string) => ({
  id,
  medId: 'nurtec',
  effectiveAt: '2026-10-01T00:00:00.000Z',
  quantity: 8,
  notes: '',
  source: 'manual',
  createdAt: '2026-10-01T00:00:01.000Z',
});

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    exportedAt: '2026-10-25T12:00:00.000Z',
    attacks: [attack('a1'), attack('a2', '2026-10-21T08:00:00.000Z')],
    meds: [med('m1')],
    refills: [refill('r1')],
    workouts: [workout('w1')],
    dayStates: [dayState('2026-10-20')],
    stockBaselines: [baseline('b1')],
    settings: { timezone: 'UTC' },
    ...overrides,
  };
}

function browserExport(overrides: Record<string, unknown> = {}) {
  return {
    attacks: [attack('browser-a')],
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
    lowStockAlertedAt: null,
    reminders: { ...DEFAULT_REMINDER_SETTINGS },
    weather: { enabled: false, location: null, pressureDropThresholdHpa: 5 },
    seeded: true,
    ...overrides,
  };
}

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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
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

function mergeResult(
  added: Partial<Record<BackupRecordKey, number>> = {},
  synced: Promise<void> = Promise.resolve(),
): MergeResult {
  return { added: { ...ZERO_COUNTS, ...added }, synced };
}

function jsonInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"][accept*="json"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('JSON file input not found');
  return input;
}

/** Choose a file through the real hidden input, flushing file.text(). */
async function chooseJson(contents: string | object, name = 'backup.json'): Promise<void> {
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents);
  const file = new File([text], name, { type: 'application/json' });
  await act(async () => {
    fireEvent.change(jsonInput(), { target: { files: [file] } });
    // Let the handler's awaited file.text() settle inside act.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderSettings(): void {
  render(<Settings />);
}

beforeEach(() => {
  store.state = makeState();
  store.sync = { status: 'synced', pending: 0, diverged: false };
  store.serverMode = true;
  store.mergeBackup.mockReset();
  store.replaceBackup.mockReset();
  store.mergeBackup.mockReturnValue(mergeResult());
  store.replaceBackup.mockResolvedValue(undefined);
  (toast.success as unknown as Mock).mockReset();
  (toast.error as unknown as Mock).mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Settings JSON backup restore', () => {
  it('previews a server envelope with per-type counts and the filename', async () => {
    renderSettings();
    await chooseJson(envelope());

    expect(await screen.findByText('backup.json')).toBeTruthy();
    expect(screen.getByText(/Server backup · schema v4/)).toBeTruthy();
    expect(screen.getByText(/exported /)).toBeTruthy();
    expect(screen.getByLabelText('2 attacks')).toBeTruthy();
    expect(screen.getByLabelText('1 medication entry')).toBeTruthy();
    expect(screen.getByLabelText('1 refill')).toBeTruthy();
    expect(screen.getByLabelText('1 workout')).toBeTruthy();
    expect(screen.getByLabelText('1 day state')).toBeTruthy();
    expect(screen.getByLabelText('1 starting count')).toBeTruthy();
    // Semantics are always spelled out in the preview.
    expect(screen.getByText(/Merge adds only records missing here/)).toBeTruthy();
    expect(screen.getByText(/Replace removes ALL current records/)).toBeTruthy();
  });

  it('labels a flattened browser export and counts its records', async () => {
    renderSettings();
    await chooseJson(browserExport(), 'browser-export.json');

    expect(await screen.findByText('browser-export.json')).toBeTruthy();
    expect(screen.getByText('Browser export')).toBeTruthy();
    expect(screen.getByLabelText('1 attack')).toBeTruthy();
    expect(screen.getByLabelText('0 medication entries')).toBeTruthy();
    expect(screen.queryByText(/Server backup/)).toBeNull();
  });

  it('shows an inline error and opens no preview for invalid JSON', async () => {
    renderSettings();
    await chooseJson('{ not json', 'broken.json');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('broken.json');
    expect(alert.textContent).toMatch(/not valid JSON/);
    expect(screen.queryByText('Restore preview')).toBeNull();
    expect(store.mergeBackup).not.toHaveBeenCalled();
    expect(store.replaceBackup).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('rejects a future schema version without opening the preview', async () => {
    renderSettings();
    await chooseJson({ schemaVersion: 99, attacks: [] }, 'future.json');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('future.json');
    expect(alert.textContent).toMatch(/unsupported schemaVersion/);
    expect(screen.queryByText('Restore preview')).toBeNull();
    expect(store.mergeBackup).not.toHaveBeenCalled();
    expect(store.replaceBackup).not.toHaveBeenCalled();
  });

  it('merges through store.mergeBackup and summarizes the added records', async () => {
    store.mergeBackup.mockReturnValue(mergeResult({ attacks: 2, meds: 1 }));
    renderSettings();
    await chooseJson(envelope());
    await screen.findByText('backup.json');

    fireEvent.click(screen.getByRole('button', { name: 'Merge missing records' }));

    await waitFor(() => expect(store.mergeBackup).toHaveBeenCalledTimes(1));
    expect(store.mergeBackup.mock.calls[0][0]).toMatchObject({
      format: 'envelope',
      schemaVersion: 4,
      attacks: [expect.objectContaining({ id: 'a1' }), expect.objectContaining({ id: 'a2' })],
    });
    expect(toast.success).toHaveBeenCalledWith('Added 2 attacks, 1 medication entry');
    await waitFor(() => expect(screen.queryByText('Restore preview')).toBeNull());
    expect(store.replaceBackup).not.toHaveBeenCalled();
  });

  it('reports a no-op merge when every record already exists', async () => {
    renderSettings();
    await chooseJson(envelope());
    await screen.findByText('backup.json');

    fireEvent.click(screen.getByRole('button', { name: 'Merge missing records' }));

    await waitFor(() => expect(store.mergeBackup).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(
      'Nothing new to add — all records already exist',
    );
  });

  it('confirms replace, surfaces a rejected restore, and re-enables the actions', async () => {
    // A 400 is a definite pre-write rejection, so "nothing was changed" holds.
    store.replaceBackup.mockRejectedValueOnce(new ApiError('POST', '/api/restore', 400));
    renderSettings();
    await chooseJson(envelope());
    await screen.findByText('backup.json');

    fireEvent.click(screen.getByRole('button', { name: 'Replace everything…' }));
    expect(await screen.findByText('Replace all data with this backup?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Replace everything' }));

    await waitFor(() => expect(store.replaceBackup).toHaveBeenCalledTimes(1));
    expect(store.replaceBackup.mock.calls[0][0]).toMatchObject({ format: 'envelope' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Restore failed — nothing was changed',
      expect.objectContaining({ description: 'POST /api/restore → 400' }),
    ));

    // The confirm closes, the preview stays open for retry, and busy is clear.
    expect(screen.queryByText('Replace all data with this backup?')).toBeNull();
    expect(screen.getByText('Restore preview')).toBeTruthy();
    const mergeButton = screen.getByRole('button', { name: 'Merge missing records' });
    expect((mergeButton as HTMLButtonElement).disabled).toBe(false);
    expect(store.mergeBackup).not.toHaveBeenCalled();
  });

  it('warns about duplicates, disables replace, and still offers merge', async () => {
    renderSettings();
    await chooseJson(envelope({ attacks: [attack('dup'), attack('dup', '2026-10-22T08:00:00.000Z')] }));
    await screen.findByText('backup.json');

    expect(screen.getByText(/contains 1 duplicate record/)).toBeTruthy();
    const replaceButton = screen.getByRole('button', { name: 'Replace everything…' });
    expect((replaceButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Merge missing records' }));
    await waitFor(() => expect(store.mergeBackup).toHaveBeenCalledTimes(1));
  });

  it('surfaces a 413 restore rejection as a too-large-file error and keeps the preview', async () => {
    store.replaceBackup.mockRejectedValueOnce(new ApiError('POST', '/api/restore', 413));
    renderSettings();
    await chooseJson(envelope());
    await screen.findByText('backup.json');

    fireEvent.click(screen.getByRole('button', { name: 'Replace everything…' }));
    await screen.findByText('Replace all data with this backup?');
    fireEvent.click(screen.getByRole('button', { name: 'Replace everything' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Backup file is too large',
      expect.objectContaining({ description: expect.stringContaining('25 MB') }),
    ));
    // The raw status string never reaches the user, and neither the generic
    // restore error nor the uncertain wording is shown for a size problem.
    expect(toast.error).not.toHaveBeenCalledWith(
      'Restore failed — nothing was changed', expect.anything(),
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      'Restore could not be confirmed', expect.anything(),
    );
    expect(screen.getByText('Restore preview')).toBeTruthy();
    const mergeButton = screen.getByRole('button', { name: 'Merge missing records' });
    expect((mergeButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('reports an uncertain outcome for a non-4xx replace failure', async () => {
    // A plain Error is what a network failure/timeout looks like, and a 5xx
    // may have committed the replacement: neither may claim nothing changed.
    store.replaceBackup.mockRejectedValueOnce(new Error('network down'));
    renderSettings();
    await chooseJson(envelope());
    await screen.findByText('backup.json');

    fireEvent.click(screen.getByRole('button', { name: 'Replace everything…' }));
    await screen.findByText('Replace all data with this backup?');
    fireEvent.click(screen.getByRole('button', { name: 'Replace everything' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Restore could not be confirmed',
      expect.objectContaining({
        description: expect.stringContaining('may already have applied the replacement'),
      }),
    ));
    expect(toast.error).not.toHaveBeenCalledWith(
      'Restore failed — nothing was changed', expect.anything(),
    );
    expect(screen.getByText('Restore preview')).toBeTruthy();
  });

  it('also reports an uncertain outcome for a 500 replace response', async () => {
    store.replaceBackup.mockRejectedValueOnce(new ApiError('POST', '/api/restore', 500));
    renderSettings();
    await chooseJson(envelope());
    await screen.findByText('backup.json');

    fireEvent.click(screen.getByRole('button', { name: 'Replace everything…' }));
    await screen.findByText('Replace all data with this backup?');
    fireEvent.click(screen.getByRole('button', { name: 'Replace everything' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Restore could not be confirmed',
      expect.objectContaining({
        description: expect.stringContaining('may already have applied the replacement'),
      }),
    ));
    expect(toast.error).not.toHaveBeenCalledWith(
      'Restore failed — nothing was changed', expect.anything(),
    );
  });

  it('a 413 merge rejection is a definite server rejection, not a network guess', async () => {
    const synced = Promise.reject(new ApiError('POST', '/api/import', 413));
    synced.catch(() => undefined);
    store.mergeBackup.mockReturnValue(mergeResult({ attacks: 1 }, synced));
    renderSettings();
    await chooseJson(envelope());
    await screen.findByText('backup.json');

    fireEvent.click(screen.getByRole('button', { name: 'Merge missing records' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Backup file is too large',
      expect.objectContaining({ description: expect.stringContaining('25 MB') }),
    ));
    expect(toast.error).not.toHaveBeenCalledWith(
      'Records were added on this device only', expect.anything(),
    );
  });

  it('states a browser-only restore is local and cannot promise a future sync', async () => {
    store.serverMode = false;
    renderSettings();
    await chooseJson(envelope());
    await screen.findByText('backup.json');

    fireEvent.click(screen.getByRole('button', { name: 'Replace everything…' }));
    await screen.findByText('Replace all data with this backup?');
    fireEvent.click(screen.getByRole('button', { name: 'Replace everything' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Restore applied on this device only',
      expect.objectContaining({
        description: 'The server data was not changed. This device is marked unsynced.',
      }),
    ));
  });

  it('does not promise an automatic merge when the additive import fails', async () => {
    const synced = Promise.reject(new Error('offline: import(merge) kept locally'));
    // Observed below via the component's handler; silence the early rejection.
    synced.catch(() => undefined);
    store.mergeBackup.mockReturnValue(mergeResult({ attacks: 1 }, synced));
    renderSettings();
    await chooseJson(envelope());
    await screen.findByText('backup.json');

    fireEvent.click(screen.getByRole('button', { name: 'Merge missing records' }));

    // No status means the outcome is unknown: the server may or may not have
    // these additions, so the copy must not be described as unchanged.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Records were added on this device only',
      expect.objectContaining({
        description: 'The server copy may not include them; these additions are marked unsynced.',
      }),
    ));
  });

  it('ignores a file change while a restore is in flight', async () => {
    const deferred = createDeferred<void>();
    store.replaceBackup.mockReturnValue(deferred.promise);
    renderSettings();
    await chooseJson(envelope(), 'first.json');
    await screen.findByText('first.json');

    fireEvent.click(screen.getByRole('button', { name: 'Replace everything…' }));
    await screen.findByText('Replace all data with this backup?');
    fireEvent.click(screen.getByRole('button', { name: 'Replace everything' }));
    await waitFor(() => expect(store.replaceBackup).toHaveBeenCalledTimes(1));

    // Programmatic change while busy: the guard returns before parsing or
    // touching the preview.
    const second = new File([JSON.stringify(browserExport())], 'second.json', {
      type: 'application/json',
    });
    await act(async () => {
      fireEvent.change(jsonInput(), { target: { files: [second] } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText('first.json')).toBeTruthy();
    expect(screen.queryByText('second.json')).toBeNull();
    expect(store.mergeBackup).not.toHaveBeenCalled();

    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText('Restore preview')).toBeNull());
  });

  it('disables both actions while a replace is in flight', async () => {
    const deferred = createDeferred<void>();
    store.replaceBackup.mockReturnValue(deferred.promise);
    renderSettings();
    await chooseJson(envelope());
    await screen.findByText('backup.json');

    fireEvent.click(screen.getByRole('button', { name: 'Replace everything…' }));
    await screen.findByText('Replace all data with this backup?');
    fireEvent.click(screen.getByRole('button', { name: 'Replace everything' }));

    await waitFor(() => expect(store.replaceBackup).toHaveBeenCalledTimes(1));
    const action = screen.getByRole('button', { name: 'Replace everything' }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    // The preview underneath also has both actions disabled.
    const mergeButton = screen.getByRole('button', {
      name: 'Merge missing records', hidden: true,
    }) as HTMLButtonElement;
    expect(mergeButton.disabled).toBe(true);
    const previewReplace = screen.getByRole('button', {
      name: 'Replace everything…', hidden: true,
    }) as HTMLButtonElement;
    expect(previewReplace.disabled).toBe(true);

    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Backup restored'));
    expect(screen.queryByText('Restore preview')).toBeNull();
  });

  it('lets the newest file pick win over a slower earlier read', async () => {
    renderSettings();

    // An earlier pick whose read is still pending when a newer pick lands.
    const slow = new File(['{}'], 'slow.json', { type: 'application/json' });
    const slowRead = createDeferred<string>();
    slow.text = () => slowRead.promise;
    fireEvent.change(jsonInput(), { target: { files: [slow] } });

    // The newer pick resolves normally and previews immediately.
    await chooseJson(browserExport(), 'fast.json');
    expect(await screen.findByText('fast.json')).toBeTruthy();

    // The stale read now settles with a DIFFERENT valid backup. It must be
    // discarded instead of replacing the newer pick's preview.
    await act(async () => {
      slowRead.resolve(JSON.stringify(envelope()));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText('fast.json')).toBeTruthy();
    expect(screen.queryByText('slow.json')).toBeNull();
    expect(screen.queryByText(/Server backup/)).toBeNull();
  });
});
