// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  mergeBackup: vi.fn(),
  replaceBackup: vi.fn(),
}));

vi.mock('@/lib/store', () => ({ useStore: () => store }));

// Settings fetches health on mount; keep it pending so these tests never touch
// a real network.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { getHealth: vi.fn(() => new Promise(() => {})) } };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import Settings from './Settings';
import { toast } from 'sonner';

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

function jsonInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"][accept*="json"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('JSON file input not found');
  return input;
}

function renderSettings(): void {
  render(<Settings />);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function confirmErase(): Promise<void> {
  // The section trigger and the dialog action share a name; open the dialog
  // first, then click the action inside it.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Erase everything' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const dialog = await screen.findByRole('alertdialog');
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Erase everything' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function resetDescription(): HTMLElement {
  const description = document.querySelector('[data-slot="alert-dialog-description"]');
  if (!(description instanceof HTMLElement)) throw new Error('Reset description not found');
  return description;
}

beforeEach(() => {
  store.state = makeState();
  store.sync = { status: 'synced', pending: 0, diverged: false };
  store.serverMode = true;
  store.loadDemoData.mockReset();
  store.resetAll.mockReset();
  store.setRule.mockReset();
  store.setDoseDefault.mockReset();
  (toast.success as unknown as Mock).mockReset();
  (toast.error as unknown as Mock).mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Settings hides demo seeding', () => {
  it('never renders a demo-data action in server mode over existing data', () => {
    store.state = makeState({
      seeded: true,
      attacks: [
        {
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
        },
      ],
    });
    renderSettings();

    expect(screen.queryByRole('button', { name: /demo/i })).toBeNull();
    expect(screen.queryByText(/demo data/i)).toBeNull();
    expect(store.loadDemoData).not.toHaveBeenCalled();
  });
});

describe('Settings erase-everything copy', () => {
  it('names the full record scope and both the server and this browser in server mode', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Erase everything' }));

    expect(screen.getByText('Erase all data?')).toBeTruthy();
    const text = resetDescription().textContent ?? '';
    expect(text).toMatch(
      /every attack, medication, refill, workout and day-state record, stock baseline, and non-secret setting/,
    );
    expect(text).toMatch(/stored on the server and in this browser/);
  });

  it('names the same scope without claiming server erasure in browser-only mode', () => {
    store.serverMode = false;
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Erase everything' }));

    const text = resetDescription().textContent ?? '';
    expect(text).toMatch(
      /every attack, medication, refill, workout and day-state record, stock baseline, and non-secret setting/,
    );
    expect(text).toMatch(/stored in this browser/);
    expect(text).not.toMatch(/server/i);
  });
});

describe('Settings erase-everything outcome reporting', () => {
  it('reports "All data erased" only after resetAll fulfills', async () => {
    const reset = deferred<void>();
    store.resetAll.mockReturnValue(reset.promise);
    renderSettings();

    await confirmErase();

    expect(store.resetAll).toHaveBeenCalledTimes(1);
    // The local erase is optimistic; the success toast must still be pending.
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => {
      reset.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('All data erased'));
    expect(toast.error).not.toHaveBeenCalled();
    // The dialog closes once the outcome is settled.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('locks the dialog open while the erase is pending and ignores a second click', async () => {
    const reset = deferred<void>();
    store.resetAll.mockReturnValue(reset.promise);
    renderSettings();

    await confirmErase();

    expect(store.resetAll).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('alertdialog');
    const action = within(dialog).getByRole('button', { name: 'Erasing…' });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);

    // A second click must not start another erase: the synchronous ref guard
    // holds even when the disabled attribute is bypassed.
    await act(async () => {
      fireEvent.click(action);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(store.resetAll).toHaveBeenCalledTimes(1);
    // Still open, and no outcome reported yet.
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    await act(async () => {
      reset.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('never reports success when the server erase rejects, and says the local erase happened', async () => {
    const reset = deferred<void>();
    store.resetAll.mockReturnValue(reset.promise);
    renderSettings();

    await confirmErase();
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => {
      reset.reject(new Error('network down'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();

    const [title, options] = (toast.error as unknown as Mock).mock.calls[0] as [
      string,
      { description?: string } | undefined,
    ];
    const copy = `${title} ${options?.description ?? ''}`;
    expect(title).not.toBe('All data erased');
    // Exactly the specific Settings toast — not the generic queue toast (the
    // store suppresses that one for resetAll).
    expect(title).toBe('Erased in this browser — server erase unconfirmed');
    expect(title).not.toBe('Server sync failed');
    expect(copy).toMatch(/browser/i); // the local erase did happen
    expect(copy).toMatch(/server/i); // ...but the server side did not confirm
    expect(copy).toMatch(/unconfirmed|failed/i);
    // Failure also settles the dialog closed, like the success path.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('reports a browser-only erase as local and silences the by-design rejection', async () => {
    store.serverMode = false;
    // resetAll() erases locally, then rejects because there is no server.
    store.resetAll.mockImplementation(() => Promise.reject(new Error('offline')));
    renderSettings();

    await confirmErase();

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Data erased in this browser',
        expect.objectContaining({ description: expect.stringMatching(/no server copy/i) }),
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('Settings JSON pre-check', () => {
  it('rejects a >25 MiB file before reading, parsing, or previewing it', async () => {
    renderSettings();

    const huge = new File(['{}'], 'huge-backup.json', { type: 'application/json' });
    Object.defineProperty(huge, 'size', { value: 25 * 1024 * 1024 + 1 });
    const textSpy = vi.fn(() => Promise.resolve('{}'));
    huge.text = textSpy;

    await act(async () => {
      fireEvent.change(jsonInput(), { target: { files: [huge] } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(textSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Backup file is too large',
      expect.objectContaining({ description: expect.stringContaining('25 MB') }),
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('huge-backup.json');
    expect(alert.textContent).toContain('25.01 MB');
    expect(alert.textContent).toMatch(/25 MB precheck limit/);
    expect(screen.queryByText('Restore preview')).toBeNull();
  });

  it('invalidates a slower earlier read when a too-large file is picked', async () => {
    renderSettings();

    const slow = new File(['{}'], 'slow.json', { type: 'application/json' });
    let resolveSlow!: (text: string) => void;
    slow.text = () => new Promise<string>((resolve) => { resolveSlow = resolve; });
    fireEvent.change(jsonInput(), { target: { files: [slow] } });

    const huge = new File(['{}'], 'huge-backup.json', { type: 'application/json' });
    Object.defineProperty(huge, 'size', { value: 25 * 1024 * 1024 + 1 });
    huge.text = vi.fn(() => Promise.resolve('{}'));
    await act(async () => {
      fireEvent.change(jsonInput(), { target: { files: [huge] } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      resolveSlow('{ not json');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The earlier pick never publishes: the size error stays and no preview
    // for slow.json appears.
    expect(screen.getByRole('alert').textContent).toContain('huge-backup.json');
    expect(screen.queryByText('slow.json')).toBeNull();
    expect(screen.queryByText('Restore preview')).toBeNull();
  });

  it('clears an earlier valid preview when a >25 MiB file is picked', async () => {
    renderSettings();

    // A minimal envelope that parseBackup accepts and previews.
    const small = new File(
      [JSON.stringify({ schemaVersion: 4 })],
      'small-backup.json',
      { type: 'application/json' },
    );
    await act(async () => {
      fireEvent.change(jsonInput(), { target: { files: [small] } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByText('Restore preview')).toBeTruthy();
    expect(screen.getByText('small-backup.json')).toBeTruthy();

    const huge = new File(['{}'], 'huge-backup.json', { type: 'application/json' });
    Object.defineProperty(huge, 'size', { value: 25 * 1024 * 1024 + 1 });
    const textSpy = vi.fn(() => Promise.resolve('{}'));
    huge.text = textSpy;
    await act(async () => {
      fireEvent.change(jsonInput(), { target: { files: [huge] } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The old preview must not survive (or be restorable) after this pick.
    expect(screen.queryByText('Restore preview')).toBeNull();
    expect(screen.queryByText('small-backup.json')).toBeNull();
    expect(textSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('huge-backup.json');
  });
});

describe('Settings med-limit inputs', () => {
  it('exposes med-scoped accessible names and keeps the rule semantics', () => {
    renderSettings();

    const maxDays = screen.getByLabelText('Nurtec max days') as HTMLInputElement;
    const windowDays = screen.getByLabelText('Nurtec window days') as HTMLInputElement;
    const defaultDose = screen.getByLabelText('Nurtec default dose') as HTMLInputElement;
    expect(maxDays.value).toBe('15');
    expect(windowDays.value).toBe('30');

    fireEvent.change(maxDays, { target: { value: '10' } });
    expect(store.setRule).toHaveBeenCalledWith('nurtec', 10, 30);

    fireEvent.change(windowDays, { target: { value: '21' } });
    expect(store.setRule).toHaveBeenLastCalledWith('nurtec', 15, 21);

    fireEvent.change(defaultDose, { target: { value: '75 mg' } });
    expect(store.setDoseDefault).toHaveBeenCalledWith('nurtec', '75 mg');
  });
});
