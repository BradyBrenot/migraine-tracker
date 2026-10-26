// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { Attack, DayState, TrackerState, Workout, WorkoutKind } from '@/types';
import { localDayKey } from '../../shared/datetime.ts';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

// The store calls every backend method (some unconditionally chain `.catch`),
// so each one must be a mock that returns a promise.
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
    deleteRefill: vi.fn(),
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
type HomeModule = typeof import('@/pages/Home');
type SonnerModule = typeof import('sonner');

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
  deleteRefill: Mock;
  addWorkout: Mock;
  patchWorkout: Mock;
  deleteWorkout: Mock;
  listWorkouts: Mock;
  listDayStates: Mock;
  putDayState: Mock;
  putSetting: Mock;
}

const STORAGE_KEY = 'migraine-tracker-v1';

let api: MockedBackend;
let storeModule: StoreModule;
let homeModule: HomeModule;
let sonner: SonnerModule;
let captured: StoreApi | null = null;

function captureStore(next: StoreApi): void {
  captured = next;
}

function Probe() {
  const storeApi = storeModule.useStore();
  captureStore(storeApi);
  return null;
}

function mountHome(): void {
  const Home = homeModule.default;
  render(
    <storeModule.StoreProvider>
      <Home />
      <Probe />
    </storeModule.StoreProvider>,
  );
}

async function waitForSync(): Promise<void> {
  await waitFor(() => {
    expect(captured).not.toBeNull();
    expect(captured!.sync.status).toBe('synced');
  });
}

function readPersisted(): TrackerState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) throw new Error('state was not persisted to localStorage');
  return JSON.parse(raw) as TrackerState;
}

function seedState(partial: Partial<TrackerState>): void {
  const state: TrackerState = {
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function makeAttack(now: number): Attack {
  return {
    id: 'seed-attack',
    start: new Date(now - 60 * 60 * 1000).toISOString(),
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

/**
 * An attack that ended a second ago. It still overlaps today (so it implies an
 * Attack day) but is not active, so the banner and its rest guidance stay off.
 * Ending "now minus one second" rather than an hour ago keeps the overlap true
 * even when the suite happens to run just after local midnight.
 */
function makeEndedAttack(now: number): Attack {
  return {
    ...makeAttack(now),
    id: 'seed-ended-attack',
    start: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    end: new Date(now - 1000).toISOString(),
  };
}

function makeWorkout(kind: WorkoutKind, overrides: Partial<Workout> = {}): Workout {
  return {
    id: 'seed-workout',
    performedAt: new Date().toISOString(),
    kind,
    effort: 'medium',
    durationMinutes: null,
    notes: '',
    source: 'manual',
    ...overrides,
  };
}

function makeDayState(day: string): DayState {
  return {
    day,
    status: 'attack',
    notes: '',
    updatedAt: new Date().toISOString(),
  };
}

function emptyExport() {
  return {
    attacks: [] as Attack[],
    meds: [] as TrackerState['meds'],
    refills: [] as TrackerState['refills'],
    workouts: [] as Workout[],
    dayStates: [] as DayState[],
    settings: {} as Record<string, unknown>,
  };
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
  backend.deleteRefill.mockResolvedValue(undefined);
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

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  sonner = await import('sonner');
  homeModule = await import('@/pages/Home');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('Home wellness logging', () => {
  it('logs a strength workout with two taps and undoes it from the toast', async () => {
    mountHome();
    await waitForSync();

    // Weekly goals stay visible beside the quick-log buttons.
    expect(screen.getByText('This week:')).toBeTruthy();
    expect(screen.getByText('0/2')).toBeTruthy();
    expect(screen.getByText('0/3')).toBeTruthy();

    // No mobility logged, so the mobility tally is omitted entirely.
    const countsEl = screen.getByTitle("This week's goal progress (weeks start Sunday)");
    expect(countsEl.textContent).not.toContain('Mobility');

    fireEvent.click(screen.getByRole('button', { name: 'Strength' }));

    // Choosing a kind must not hide the tallies while effort is pending.
    expect(screen.getByText('Strength effort')).toBeTruthy();
    expect(screen.getByText('This week:')).toBeTruthy();
    expect(screen.getByText('0/2')).toBeTruthy();
    expect(screen.getByText('0/3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Medium' }));

    await waitFor(() => expect(captured!.state.workouts).toHaveLength(1));
    const workout = captured!.state.workouts[0];
    expect(workout.kind).toBe('strength');
    expect(workout.effort).toBe('medium');
    expect(api.addWorkout).toHaveBeenCalledTimes(1);
    expect(api.addWorkout).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'strength', effort: 'medium' }),
    );

    await waitFor(() => expect(readPersisted().workouts).toHaveLength(1));

    const logCall = (sonner.toast.success as Mock).mock.calls.find(
      ([message]) => message === 'Strength logged',
    );
    expect(logCall).toBeTruthy();
    const action = logCall![1].action as { label: string; onClick: () => void };
    expect(action.label).toBe('Undo');

    act(() => {
      action.onClick();
    });

    await waitFor(() => expect(captured!.state.workouts).toHaveLength(0));
    expect(api.deleteWorkout).toHaveBeenCalledWith(workout.id);
  });

  it('logs a cardio workout with the tapped effort', async () => {
    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Cardio' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }));

    await waitFor(() => expect(captured!.state.workouts).toHaveLength(1));
    expect(captured!.state.workouts[0]).toMatchObject({ kind: 'cardio', effort: 'hard' });
    expect(api.addWorkout).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cardio', effort: 'hard' }),
    );
  });

  it('shows the mobility tally once a mobility workout is logged this week', async () => {
    seedState({ timezone: 'UTC', workouts: [makeWorkout('mobility')] });

    mountHome();
    await waitForSync();

    const counts = screen.getByTitle("This week's goal progress (weeks start Sunday)");
    expect(counts.textContent).toContain('Mobility');
    // The strength/cardio goals remain on the line alongside it.
    expect(counts.textContent).toContain('Strength');
    expect(counts.textContent).toContain('Cardio');
  });

  it('collapses the day check-in after a choice and persists the day state', async () => {
    mountHome();
    await waitForSync();

    expect(screen.getByRole('button', { name: 'Well' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy();
    // The small chip never offers a disconnected day-only Attack.
    expect(screen.queryByRole('button', { name: 'Attack' })).toBeNull();
    expect(screen.getByText('How was today?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Off' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Off' })).toBeNull());
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();

    await waitFor(() => expect(readPersisted().dayStates).toHaveLength(1));
    const persisted = readPersisted();
    const todayKey = localDayKey(Date.now(), persisted.timezone);
    expect(persisted.dayStates[0]).toMatchObject({ day: todayKey, status: 'off' });
    expect(api.putDayState).toHaveBeenCalledWith(
      todayKey,
      expect.objectContaining({ status: 'off' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));

    await waitFor(() => {
      const next = readPersisted();
      expect(next.dayStates).toHaveLength(1);
      expect(next.dayStates[0].status).toBe('well');
    });
    expect(screen.getByText('Well')).toBeTruthy();
  });

  it('adds an optional day note, keeps it through status changes, and clears it when blank', async () => {
    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(screen.getByText('Off')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    fireEvent.change(screen.getByLabelText('Day note'), {
      target: { value: '  rough morning  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(readPersisted().dayStates[0]?.notes).toBe('rough morning'));
    const persisted = readPersisted();
    const todayKey = localDayKey(Date.now(), persisted.timezone);
    expect(api.putDayState).toHaveBeenLastCalledWith(
      todayKey,
      { status: 'off', notes: 'rough morning' },
    );

    // Changing status must preserve the note (store notes-preservation path).
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));
    await waitFor(() => {
      expect(readPersisted().dayStates[0]).toMatchObject({
        status: 'well',
        notes: 'rough morning',
      });
    });

    // Saving an empty note is an explicit clear.
    fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    fireEvent.change(screen.getByLabelText('Day note'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(readPersisted().dayStates[0]?.notes).toBe(''));
    expect(api.putDayState).toHaveBeenLastCalledWith(
      todayKey,
      { status: 'well', notes: '' },
    );
  });

  it('saves the day note with Enter and closes it with Escape without saving', async () => {
    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(screen.getByText('Off')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    const input = screen.getByLabelText('Day note');
    fireEvent.change(input, { target: { value: '  via enter  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(readPersisted().dayStates[0]?.notes).toBe('via enter'));
    expect(screen.queryByLabelText('Day note')).toBeNull();

    // Escape closes the editor and must not persist the unsaved draft.
    fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    const reopened = screen.getByLabelText('Day note');
    fireEvent.change(reopened, { target: { value: 'draft not saved' } });
    fireEvent.keyDown(reopened, { key: 'Escape' });

    expect(screen.queryByLabelText('Day note')).toBeNull();
    expect(readPersisted().dayStates[0]?.notes).toBe('via enter');
  });

  it('cancels re-choosing and keeps the recorded day state', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({ timezone: 'UTC', dayStates: [{ ...makeDayState(todayKey), status: 'off' }] });

    mountHome();
    await waitForSync();

    expect(screen.getByText('Off')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('button', { name: 'Well' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
    expect(screen.getByText('Off')).toBeTruthy();
    expect(readPersisted().dayStates[0]).toMatchObject({ day: todayKey, status: 'off' });
    expect(api.putDayState).not.toHaveBeenCalled();
  });

  it('suppresses exercise logging on an explicit attack day and still allows an override', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({ timezone: 'UTC', dayStates: [makeDayState(todayKey)] });

    mountHome();
    await waitForSync();

    expect(screen.queryByRole('button', { name: 'Strength' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cardio' })).toBeNull();
    expect(screen.getByText('Rest — no exercise needed.')).toBeTruthy();
    expect(screen.getByText('Attack')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    // Change offers Well/Off only — the legacy Attack record stays display-only.
    expect(screen.getByRole('button', { name: 'Well' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attack' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));

    await waitFor(() => {
      const persisted = readPersisted();
      expect(persisted.dayStates).toHaveLength(1);
      expect(persisted.dayStates[0]).toMatchObject({ day: todayKey, status: 'well' });
    });
    expect(screen.getByText('Normal routine today.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Strength' })).toBeTruthy();
  });

  it('infers attack rest from an ended attack overlapping today when no record exists', async () => {
    const now = Date.now();
    seedState({ timezone: 'UTC', attacks: [makeEndedAttack(now)] });

    mountHome();
    await waitForSync();

    // Collapsed inferred Attack state: display pill + guidance, but no choices.
    expect(screen.getByText('Attack')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attack' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
    expect(screen.getByText('Rest — no exercise needed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Strength/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cardio/ })).toBeNull();

    // Change offers Well/Off only, and an explicit recovery choice wins.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('button', { name: 'Well' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attack' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Well' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Strength/ })).toBeTruthy());
    expect(screen.getByText('Normal routine today.')).toBeTruthy();
  });

  it('keeps an active attack over an earlier Well record and restores the card after it ends', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({
      timezone: 'UTC',
      attacks: [makeAttack(now)],
      dayStates: [{ ...makeDayState(todayKey), status: 'well' }],
    });

    mountHome();
    await waitForSync();

    // The banner owns rest guidance while active — exactly one instance in the DOM.
    expect(screen.getAllByText('Rest — no exercise needed.')).toHaveLength(1);
    // The whole wellness card is gone, so an earlier Well can never re-enable exercise.
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Note' })).toBeNull();
    expect(screen.queryByText('This week:')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Strength/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cardio/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Attack ended' }));

    await waitFor(() => expect(screen.queryByText('Attack in progress')).toBeNull());
    // The explicit Well record wins over the ended attack's inferred Attack day.
    expect(screen.getByText('Well')).toBeTruthy();
    expect(screen.getByText('Normal routine today.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Strength/ })).toBeTruthy();
    expect(screen.queryByText('Rest — no exercise needed.')).toBeNull();
  });

  it('latches an Attack day record when a note is saved on an inferred attack day', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({ timezone: 'UTC', attacks: [makeEndedAttack(now)] });

    mountHome();
    await waitForSync();

    expect(screen.getByText('Rest — no exercise needed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    fireEvent.change(screen.getByLabelText('Day note'), {
      target: { value: '  postdrome, low energy  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(readPersisted().dayStates).toHaveLength(1));
    const persisted = readPersisted();
    expect(persisted.dayStates[0]).toMatchObject({
      day: todayKey,
      status: 'attack',
      notes: 'postdrome, low energy',
    });
    expect(api.putDayState).toHaveBeenCalledWith(
      todayKey,
      { status: 'attack', notes: 'postdrome, low energy' },
    );

    // Change to Well keeps the latched note (store notes-preservation path).
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));
    await waitFor(() => {
      expect(readPersisted().dayStates[0]).toMatchObject({
        status: 'well',
        notes: 'postdrome, low energy',
      });
    });
    expect(screen.getByText('Normal routine today.')).toBeTruthy();
  });

  it('closes the note editor without latching a record when an inferred attack day note is blank', async () => {
    const now = Date.now();
    seedState({ timezone: 'UTC', attacks: [makeEndedAttack(now)] });

    mountHome();
    await waitForSync();

    expect(screen.getByText('Rest — no exercise needed.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    fireEvent.change(screen.getByLabelText('Day note'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // A blank draft has nothing to persist: the editor closes and no
    // valueless Attack record is latched.
    expect(screen.queryByLabelText('Day note')).toBeNull();
    expect(screen.getByText('Attack')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
    expect(readPersisted().dayStates).toHaveLength(0);
    expect(api.putDayState).not.toHaveBeenCalled();
  });

  it('infers an attack day when an ended attack crossed midnight into today', async () => {
    // Same fake-Date + re-import pattern as the timezone test above: the clock
    // module captures Date.now() at import time.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z').getTime());
      vi.resetModules();
      captured = null;
      localStorage.clear();
      seedState({
        timezone: 'UTC', // today = 2026-06-15, day start 2026-06-15T00:00:00Z
        attacks: [
          {
            ...makeAttack(Date.now()),
            id: 'crossed-midnight',
            start: '2026-06-14T22:00:00.000Z',
            end: '2026-06-15T06:00:00.000Z',
          },
        ],
      });
      api = (await import('@/lib/api')).api as unknown as MockedBackend;
      applyApiDefaults(api);
      homeModule = await import('@/pages/Home');
      storeModule = await import('@/lib/store');

      mountHome();
      await waitForSync();

      // Started yesterday but ended today: collapsed inferred Attack day.
      expect(screen.getByText('Attack')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Attack' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
      expect(screen.getByText('Rest — no exercise needed.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Strength/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Cardio/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not infer an attack day when the attack ended exactly at today\'s start', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z').getTime());
      vi.resetModules();
      captured = null;
      localStorage.clear();
      seedState({
        timezone: 'UTC', // today = 2026-06-15, day start 2026-06-15T00:00:00Z
        attacks: [
          {
            ...makeAttack(Date.now()),
            id: 'ended-at-day-start',
            start: '2026-06-14T20:00:00.000Z',
            end: '2026-06-15T00:00:00.000Z',
          },
        ],
      });
      api = (await import('@/lib/api')).api as unknown as MockedBackend;
      applyApiDefaults(api);
      homeModule = await import('@/pages/Home');
      storeModule = await import('@/lib/store');

      mountHome();
      await waitForSync();

      // Ending precisely at the day start is not an overlap: fresh choices.
      expect(screen.queryByText('Attack')).toBeNull();
      expect(screen.getByRole('button', { name: 'Well' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy();
      expect(screen.getByText('How was today?')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels the primary CTA "Another attack started" and starts a second real attack', async () => {
    const now = Date.now();
    seedState({ timezone: 'UTC', attacks: [makeEndedAttack(now)] });

    mountHome();
    await waitForSync();

    expect(screen.queryByRole('button', { name: 'Attack started' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Another attack started' }));

    await waitFor(() => expect(captured!.state.attacks).toHaveLength(2));
    expect(screen.getByText('How bad is the pain right now?')).toBeTruthy();
  });

  it('keeps the "Attack started" CTA on a day with no attacks', async () => {
    mountHome();
    await waitForSync();

    expect(screen.getByRole('button', { name: 'Attack started' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Another attack started' })).toBeNull();
  });

  it('clicking 0 without an active attack starts a real 0-pain attack, not an Off day', async () => {
    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Log pain' }));

    // Intensity 0 is a real pain level, so the dialog always offers it.
    expect(screen.getByText('How bad is the pain right now?')).toBeTruthy();
    expect(screen.getByText('0 = no pain, but still an attack.')).toBeTruthy();
    for (let n = 0; n <= 10; n += 1) {
      expect(screen.getByRole('button', { name: String(n) })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole('button', { name: '0' }));

    await waitFor(() => expect(captured!.state.attacks).toHaveLength(1));
    const attack = captured!.state.attacks[0];
    expect(attack.end).toBeNull();
    expect(attack.peakPain).toBe(0);
    expect(attack.painLog.some((entry) => entry.level === 0)).toBe(true);
    expect(api.addAttack).toHaveBeenCalledTimes(1);

    // The new attack drives the banner and hides the wellness card.
    await waitFor(() => expect(screen.getByText('Attack in progress')).toBeTruthy());
    expect(screen.getByText('Rest — no exercise needed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Strength/ })).toBeNull();

    // It is an attack, never a day-state record (i.e. not an Off day).
    await waitFor(() => expect(readPersisted().attacks).toHaveLength(1));
    expect(readPersisted().dayStates).toHaveLength(0);
    expect(api.putDayState).not.toHaveBeenCalled();

    expect(sonner.toast.success).toHaveBeenCalledWith('Attack started at 0/10');
  });

  it('still offers pain level 0 while an attack is active', async () => {
    seedState({ timezone: 'UTC', attacks: [makeAttack(Date.now())] });

    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Log pain' }));

    expect(screen.getByText('How bad is the pain right now?')).toBeTruthy();
    expect(screen.getByText('0 = no pain, but still an attack.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '0' })).toBeTruthy();
    for (let n = 1; n <= 10; n += 1) {
      expect(screen.getByRole('button', { name: String(n) })).toBeTruthy();
    }
  });
});

describe('Home workout per-kind dedup', () => {
  const HOUR_MS = 60 * 60 * 1000;

  function countsText(): string {
    return screen.getByTitle("This week's goal progress (weeks start Sunday)").textContent ?? '';
  }

  // Today's chip becomes part of the accessible name ("Strength Medium"), so
  // kind buttons are matched by prefix; the no-record states stay exact.
  function strengthButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: /^Strength/ }) as HTMLButtonElement;
  }

  function cardioButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: /^Cardio/ }) as HTMLButtonElement;
  }

  it('upgrades a lower effort in place and Undo restores the previous effort', async () => {
    const now = Date.now();
    const performedAt = new Date(now).toISOString();
    seedState({
      timezone: 'UTC',
      workouts: [makeWorkout('strength', { id: 'seed-strength', effort: 'medium', performedAt })],
    });

    mountHome();
    await waitForSync();

    // Today state is visible on the kind button itself.
    expect(strengthButton().textContent).toContain('Medium');
    expect(strengthButton().getAttribute('title')).toContain('Strength logged today: Medium');
    const countsBefore = countsText();
    expect(countsBefore).toContain('Strength 1/2');

    fireEvent.click(strengthButton());
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }));

    await waitFor(() => expect(api.patchWorkout).toHaveBeenCalledTimes(1));
    expect(api.addWorkout).not.toHaveBeenCalled();
    expect(api.patchWorkout).toHaveBeenCalledWith(
      'seed-strength',
      expect.objectContaining({ effort: 'hard' }),
    );
    expect(captured!.state.workouts).toHaveLength(1);
    expect(captured!.state.workouts[0]).toMatchObject({
      id: 'seed-strength',
      effort: 'hard',
      performedAt,
    });
    // An upgrade never adds a weekly count.
    expect(countsText()).toBe(countsBefore);
    expect(strengthButton().textContent).toContain('Hard');

    const upgradeCall = (sonner.toast.success as Mock).mock.calls.find(
      ([message]) => message === 'Strength effort updated to Hard',
    );
    expect(upgradeCall).toBeTruthy();
    const action = upgradeCall![1].action as { label: string; onClick: () => void };
    expect(action.label).toBe('Undo');

    act(() => action.onClick());

    await waitFor(() => expect(api.patchWorkout).toHaveBeenCalledTimes(2));
    expect(api.patchWorkout).toHaveBeenLastCalledWith(
      'seed-strength',
      expect.objectContaining({ effort: 'medium' }),
    );
    // Undo restores the effort; it must never delete the session.
    expect(api.deleteWorkout).not.toHaveBeenCalled();
    expect(captured!.state.workouts).toHaveLength(1);
    expect(captured!.state.workouts[0].effort).toBe('medium');
    expect(countsText()).toBe(countsBefore);
  });

  it('rejects a lower effort without any write or state change', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      workouts: [makeWorkout('strength', {
        id: 'seed-strength',
        effort: 'hard',
        performedAt: new Date(now).toISOString(),
      })],
    });

    mountHome();
    await waitForSync();

    expect(strengthButton().textContent).toContain('Hard');

    fireEvent.click(strengthButton());
    fireEvent.click(screen.getByRole('button', { name: 'Medium' }));

    await waitFor(() => expect(sonner.toast.warning).toHaveBeenCalledTimes(1));
    expect(sonner.toast.warning).toHaveBeenCalledWith(
      'Strength · Hard kept',
      expect.objectContaining({ description: "Only a higher effort replaces today's session." }),
    );
    expect(api.addWorkout).not.toHaveBeenCalled();
    expect(api.patchWorkout).not.toHaveBeenCalled();
    expect(captured!.state.workouts).toHaveLength(1);
    expect(captured!.state.workouts[0].effort).toBe('hard');
    expect(strengthButton().textContent).toContain('Hard');
  });

  it('rejects an equal effort without any write or state change', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      workouts: [makeWorkout('strength', {
        id: 'seed-strength',
        effort: 'medium',
        performedAt: new Date(now).toISOString(),
      })],
    });

    mountHome();
    await waitForSync();

    expect(strengthButton().textContent).toContain('Medium');

    fireEvent.click(strengthButton());
    fireEvent.click(screen.getByRole('button', { name: 'Medium' }));

    await waitFor(() => expect(sonner.toast.warning).toHaveBeenCalledTimes(1));
    expect(sonner.toast.warning).toHaveBeenCalledWith(
      'Strength · Medium kept',
      expect.objectContaining({ description: "Only a higher effort replaces today's session." }),
    );
    expect(api.addWorkout).not.toHaveBeenCalled();
    expect(api.patchWorkout).not.toHaveBeenCalled();
    expect(captured!.state.workouts).toHaveLength(1);
    expect(captured!.state.workouts[0].effort).toBe('medium');
  });

  it('allows one Strength and one Cardio on the same day with separate counts', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      workouts: [makeWorkout('strength', {
        id: 'seed-strength',
        effort: 'medium',
        performedAt: new Date(now).toISOString(),
      })],
    });

    mountHome();
    await waitForSync();

    fireEvent.click(cardioButton());
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }));

    await waitFor(() => expect(captured!.state.workouts).toHaveLength(2));
    const kinds = captured!.state.workouts.map((w) => `${w.kind}:${w.effort}`).sort();
    expect(kinds).toEqual(['cardio:hard', 'strength:medium']);
    expect(new Set(captured!.state.workouts.map((w) => w.id)).size).toBe(2);
    expect(api.addWorkout).toHaveBeenCalledTimes(1);
    expect(countsText()).toContain('Strength 1/2');
    expect(countsText()).toContain('Cardio 1/3');
    expect(cardioButton().textContent).toContain('Hard');
  });

  it('picks the highest-effort duplicate as current and never deletes extras', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      workouts: [
        makeWorkout('strength', { id: 'dup-medium', effort: 'medium', performedAt: new Date(now - 3 * HOUR_MS).toISOString() }),
        makeWorkout('strength', { id: 'dup-low', effort: 'low', performedAt: new Date(now - 2 * HOUR_MS).toISOString() }),
        makeWorkout('strength', { id: 'dup-hard', effort: 'hard', performedAt: new Date(now - HOUR_MS).toISOString() }),
      ],
    });

    mountHome();
    await waitForSync();

    expect(strengthButton().textContent).toContain('Hard');

    fireEvent.click(strengthButton());
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }));

    await waitFor(() => expect(sonner.toast.warning).toHaveBeenCalledTimes(1));
    expect(api.addWorkout).not.toHaveBeenCalled();
    expect(api.patchWorkout).not.toHaveBeenCalled();
    expect(captured!.state.workouts).toHaveLength(3);
  });

  it('upgrades the highest-effort duplicate rather than the latest one', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      workouts: [
        makeWorkout('strength', { id: 'dup-medium', effort: 'medium', performedAt: new Date(now - 3 * HOUR_MS).toISOString() }),
        makeWorkout('strength', { id: 'dup-low', effort: 'low', performedAt: new Date(now - HOUR_MS).toISOString() }),
      ],
    });

    mountHome();
    await waitForSync();

    expect(strengthButton().textContent).toContain('Medium');

    fireEvent.click(strengthButton());
    fireEvent.click(screen.getByRole('button', { name: 'Hard' }));

    await waitFor(() => expect(api.patchWorkout).toHaveBeenCalledTimes(1));
    expect(api.patchWorkout).toHaveBeenCalledWith(
      'dup-medium',
      expect.objectContaining({ effort: 'hard' }),
    );
    expect(api.addWorkout).not.toHaveBeenCalled();
    expect(captured!.state.workouts).toHaveLength(2);
    const byId = new Map(captured!.state.workouts.map((w) => [w.id, w]));
    expect(byId.get('dup-medium')?.effort).toBe('hard');
    // The untouched duplicate keeps its own effort and timestamp.
    expect(byId.get('dup-low')?.effort).toBe('low');
  });

  it('never treats an unparseable timestamp as today and keeps the dirty record', async () => {
    seedState({
      timezone: 'UTC',
      workouts: [makeWorkout('strength', {
        id: 'dirty',
        effort: 'hard',
        performedAt: 'not-a-date',
      })],
    });

    mountHome();
    await waitForSync();

    // No chip on the button: the dirty record is not "today".
    expect(screen.getByRole('button', { name: 'Strength' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Strength' }));
    fireEvent.click(screen.getByRole('button', { name: 'Medium' }));

    await waitFor(() => expect(captured!.state.workouts).toHaveLength(2));
    expect(api.addWorkout).toHaveBeenCalledTimes(1);
    expect(api.patchWorkout).not.toHaveBeenCalled();
    // The invalid seed is never deleted or mutated.
    expect(captured!.state.workouts.some((w) => w.id === 'dirty')).toBe(true);
    // Nor is it counted toward the weekly goal.
    expect(countsText()).toContain('Strength 1/2');
  });

  it('resolves "today" in the configured zone, not the UTC date', async () => {
    // The clock module captures Date.now() at import time, so fake the Date
    // and re-import store/Home before mounting (same pattern as the inventory
    // timezone test).
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z').getTime());
      vi.resetModules();
      captured = null;
      localStorage.clear();
      seedState({
        timezone: 'Pacific/Kiritimati', // UTC+14: local time is 2026-06-01 14:00
        workouts: [
          // Local Jun 1 02:30 — today locally, still May 31 in UTC.
          makeWorkout('strength', {
            id: 'local-today',
            effort: 'low',
            performedAt: '2026-05-31T12:30:00.000Z',
          }),
          // Local May 31 02:30 — yesterday locally. Higher effort, so a UTC-day
          // comparison would wrongly show "Hard".
          makeWorkout('strength', {
            id: 'local-yesterday',
            effort: 'hard',
            performedAt: '2026-05-30T12:30:00.000Z',
          }),
        ],
      });
      api = (await import('@/lib/api')).api as unknown as MockedBackend;
      applyApiDefaults(api);
      homeModule = await import('@/pages/Home');
      storeModule = await import('@/lib/store');

      mountHome();
      await waitForSync();

      expect(strengthButton().textContent).toContain('Low');
      expect(strengthButton().textContent).not.toContain('Hard');
    } finally {
      vi.useRealTimers();
    }
  });
});
