// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TrackerState } from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';
import { PAINKILLER_MED_IDS, resolveSharedPainkillerRule } from '@/lib/usage';

const store = vi.hoisted(() => ({
  state: {} as TrackerState,
  activeAttack: null,
  sync: { status: 'synced', pending: 0, diverged: false },
  serverMode: true,
  readOnly: false,
  setLowStockThreshold: vi.fn(),
  resetLowStockAlert: vi.fn(),
  addStockBaseline: vi.fn(),
  deleteStockBaseline: vi.fn(),
  importData: vi.fn(),
  loadDemoData: vi.fn(),
  resetAll: vi.fn(),
  resolveUseServer: vi.fn(),
  setRule: vi.fn(),
  setRules: vi.fn(),
  setDoseDefault: vi.fn(),
  setTimezone: vi.fn(),
  updateReminders: vi.fn(() => []),
  updateWeather: vi.fn(() => []),
  mergeBackup: vi.fn(),
  replaceBackup: vi.fn(),
}));

vi.mock('@/lib/store', () => ({ useStore: () => store }));

// Settings fetches health on mount; keep it pending so these tests stay sync.
vi.mock('@/lib/api', () => ({
  api: { getHealth: vi.fn(() => new Promise(() => {})) },
}));

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
    weather: { enabled: false, location: null, pressureDropThresholdHpa: 5 },
    lowStockAlertedAt: null,
    seeded: false,
    ...partial,
  };
}

function limitInput(): HTMLInputElement {
  return screen.getByLabelText('Painkillers max days') as HTMLInputElement;
}

function windowInput(): HTMLInputElement {
  return screen.getByLabelText('Painkillers window days') as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save shared rule' }) as HTMLButtonElement;
}

beforeEach(() => {
  store.state = makeState();
  store.setRule.mockReset();
  store.setRules.mockReset();
  store.setDoseDefault.mockReset();
  (toast.success as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Settings shared painkiller rule', () => {
  it('does not persist while typing, then saves all three in ONE batch action', () => {
    render(<Settings />);

    expect(limitInput().value).toBe('15');
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(limitInput(), { target: { value: '9' } });
    fireEvent.change(windowInput(), { target: { value: '21' } });

    // Typing is a local draft only: no rule write on each keystroke.
    expect(store.setRules).not.toHaveBeenCalled();
    expect(store.setRule).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    fireEvent.click(saveButton());

    expect(store.setRules).toHaveBeenCalledTimes(1);
    expect(store.setRules).toHaveBeenCalledWith({
      tylenol: { limit: 9, windowDays: 21 },
      ibuprofen: { limit: 9, windowDays: 21 },
      naproxen: { limit: 9, windowDays: 21 },
    });
    // One batch call, never per-med writes.
    expect(store.setRule).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Painkiller rule saved for all three');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('supports a zero limit and validates the window before saving', () => {
    render(<Settings />);

    fireEvent.change(limitInput(), { target: { value: '0' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(store.setRules).toHaveBeenLastCalledWith({
      tylenol: { limit: 0, windowDays: 30 },
      ibuprofen: { limit: 0, windowDays: 30 },
      naproxen: { limit: 0, windowDays: 30 },
    });

    store.setRules.mockReset();
    fireEvent.change(windowInput(), { target: { value: '3' } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/Window must be a whole number from 7 to 90 days/)).toBeTruthy();
    fireEvent.click(saveButton());
    expect(store.setRules).not.toHaveBeenCalled();

    // Empty/non-numeric drafts never save either.
    fireEvent.change(limitInput(), { target: { value: '' } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/Max days must be a whole number from 0 to 31/)).toBeTruthy();
  });

  it('discards a draft back to the saved values', () => {
    render(<Settings />);

    fireEvent.change(limitInput(), { target: { value: '4' } });
    expect(limitInput().value).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(limitInput().value).toBe('15');
    expect(windowInput().value).toBe('30');
    expect(store.setRules).not.toHaveBeenCalled();
  });

  it('shows the conservative resolution and explains it when the three differ', () => {
    const rules = {
      tylenol: { limit: 8, windowDays: 30 },
      ibuprofen: { limit: 15, windowDays: 45 },
      naproxen: { limit: 10, windowDays: 30 },
    };
    store.state = makeState({ rules });

    render(<Settings />);

    const expected = resolveSharedPainkillerRule(rules);
    expect(expected).toEqual({ limit: 8, windowDays: 45 });
    expect(limitInput().value).toBe('8');
    expect(windowInput().value).toBe('45');
    expect(screen.getByText(/lowest limit \(8\)/)).toBeTruthy();
    expect(screen.getByText(/widest window \(45 days\)/)).toBeTruthy();

    // Saving the conservative resolution unifies the three.
    fireEvent.change(windowInput(), { target: { value: '46' } });
    fireEvent.click(saveButton());
    expect(store.setRules).toHaveBeenCalledWith(
      Object.fromEntries(
        PAINKILLER_MED_IDS.map((medId) => [medId, { limit: 8, windowDays: 46 }]),
      ),
    );
  });

  it('keeps Nurtec separate with its own limit/window and default dose', () => {
    render(<Settings />);

    expect((screen.getByLabelText('Nurtec max days') as HTMLInputElement).value).toBe('15');
    expect((screen.getByLabelText('Nurtec window days') as HTMLInputElement).value).toBe('30');

    fireEvent.change(screen.getByLabelText('Nurtec max days'), { target: { value: '12' } });
    expect(store.setRule).toHaveBeenCalledWith('nurtec', 12, 30);
    expect(store.setRules).not.toHaveBeenCalled();
  });

  it('keeps default doses individual for every med', () => {
    store.state = makeState({ doses: { nurtec: '75 mg' } });

    render(<Settings />);

    fireEvent.change(screen.getByLabelText('Tylenol default dose'), {
      target: { value: '500 mg' },
    });
    expect(store.setDoseDefault).toHaveBeenCalledWith('tylenol', '500 mg');
    expect((screen.getByLabelText('Nurtec default dose') as HTMLInputElement).value).toBe('75 mg');
  });
});
