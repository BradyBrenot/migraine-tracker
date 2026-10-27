// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    expect(alert.textContent).toMatch(/over the 25 MB limit/);
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
