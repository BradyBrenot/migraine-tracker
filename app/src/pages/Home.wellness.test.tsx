// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { Attack, DayState, MedEvent, TrackerState, Workout, WorkoutKind } from '@/types';
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

/**
 * The start CTA also opens the pain dialog, which hides the page behind
 * `aria-hidden`. Close it before querying page roles.
 */
async function closePainDialog(): Promise<void> {
  const close = screen.queryByRole('button', { name: 'Close' });
  if (!close) return;
  fireEvent.click(close);
  await waitFor(() => expect(screen.queryByText('How bad is the pain right now?')).toBeNull());
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
    weather: { enabled: false, location: null, pressureDropThresholdHpa: 5 },
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

function makeMed(overrides: Partial<MedEvent> = {}): MedEvent {
  return {
    id: 'seed-med',
    medId: 'tylenol',
    ts: new Date().toISOString(),
    attackId: null,
    notes: '',
    source: 'manual',
    ...overrides,
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

    expect(screen.getByRole('heading', { level: 1, name: 'Migraine log' })).toBeTruthy();

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
    // Choice chips expose their selected state without changing their names.
    expect(screen.getByRole('button', { name: 'Well' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('false');
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
    // The recorded Off choice is now offered as pressed; Well is not.
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Well' }).getAttribute('aria-pressed')).toBe('false');
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
    // Opening the editor focuses the note so typing starts immediately.
    expect(document.activeElement).toBe(screen.getByLabelText('Day note'));
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

  it('keeps movement available on an explicit attack day and still allows an override', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({ timezone: 'UTC', dayStates: [makeDayState(todayKey)] });

    mountHome();
    await waitForSync();

    // Movement is never hidden: guidance is advisory, and the day state pill
    // still names Attack.
    expect(screen.getByRole('button', { name: /^Strength/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Cardio/ })).toBeTruthy();
    expect(screen.getByText('Rest if you need to — movement is optional.')).toBeTruthy();
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

  it('infers an Off day from an ended attack overlapping today when no record exists', async () => {
    const now = Date.now();
    seedState({ timezone: 'UTC', attacks: [makeEndedAttack(now)] });

    mountHome();
    await waitForSync();

    // Attack days are Off days. The record-less day shows Off with no choices,
    // and movement stays available because it is never inferred as impossible.
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.queryByText('Attack')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attack' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
    expect(screen.getByText('Easy day — a 10-min walk counts (Cardio · Low).')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Strength/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Cardio/ })).toBeTruthy();

    // Change still offers Well/Off, and an explicit recovery choice wins.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('button', { name: 'Well' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attack' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Well' }));
    await waitFor(() => expect(screen.getByText('Normal routine today.')).toBeTruthy());
  });

  it('keeps an active attack over an earlier Well record and retains wellness + movement', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({
      timezone: 'UTC',
      attacks: [makeAttack(now)],
      dayStates: [{ ...makeDayState(todayKey), status: 'well', notes: 'kept note' }],
    });

    mountHome();
    await waitForSync();

    // Exactly one guidance line (the wellness card); an earlier Well record can
    // no longer flip the pill to "Well" while the banner says otherwise.
    expect(screen.getAllByText('Rest if you need to — movement is optional.')).toHaveLength(1);
    expect(screen.queryByText('Well')).toBeNull();
    // Locked while the attack is active: Note stays, Change and Well/Off do not.
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Note' })).toBeTruthy();
    expect(screen.getByText('This week:')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Strength/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Cardio/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Attack ended' }));

    await waitFor(() => expect(screen.queryByText('Attack in progress')).toBeNull());
    // Ending a restored active attack applies the attack-day rule too: the day
    // becomes Off (Change enabled), never Well, with the note preserved.
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.queryByText('Well')).toBeNull();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Strength/ })).toBeTruthy();
    expect(screen.queryByText('Rest if you need to — movement is optional.')).toBeNull();
    await waitFor(() => expect(readPersisted().dayStates[0]).toMatchObject({
      day: todayKey,
      status: 'off',
      notes: 'kept note',
    }));
    expect(api.putDayState).toHaveBeenCalledWith(
      todayKey,
      { status: 'off', notes: 'kept note' },
    );

    // A Well chosen after the attack is explicit and persists untouched.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));
    await waitFor(() => expect(readPersisted().dayStates[0]).toMatchObject({
      day: todayKey,
      status: 'well',
      notes: 'kept note',
    }));
    expect(screen.getByText('Normal routine today.')).toBeTruthy();
  });

  it('latches an Off day state when a note is saved on an inferred attack day', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({ timezone: 'UTC', attacks: [makeEndedAttack(now)] });

    mountHome();
    await waitForSync();

    expect(screen.getByText('Off')).toBeTruthy();
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
      status: 'off',
      notes: 'postdrome, low energy',
    });
    expect(api.putDayState).toHaveBeenCalledWith(
      todayKey,
      { status: 'off', notes: 'postdrome, low energy' },
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

    expect(screen.getByText('Off')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Note' }));
    fireEvent.change(screen.getByLabelText('Day note'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // A blank draft has nothing to persist: the editor closes and no
    // valueless record is latched.
    expect(screen.queryByLabelText('Day note')).toBeNull();
    expect(screen.getByText('Off')).toBeTruthy();
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

      // Started yesterday but ended today: record-less attack day infers Off.
      expect(screen.getByText('Off')).toBeTruthy();
      expect(screen.queryByText('Attack')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Attack' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
      expect(screen.getByText('Easy day — a 10-min walk counts (Cardio · Low).')).toBeTruthy();
      expect(screen.getByRole('button', { name: /^Strength/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /^Cardio/ })).toBeTruthy();
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

  it('labels the primary CTA "Log another attack" and starts a second real attack', async () => {
    const now = Date.now();
    seedState({ timezone: 'UTC', attacks: [makeEndedAttack(now)] });

    mountHome();
    await waitForSync();

    expect(screen.queryByRole('button', { name: 'Start attack now' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Log another attack' }));

    await waitFor(() => expect(captured!.state.attacks).toHaveLength(2));
    expect(screen.getByText('How bad is the pain right now?')).toBeTruthy();
  });

  it('keeps the "Start attack now" CTA on a day with no attacks', async () => {
    mountHome();
    await waitForSync();

    // Both labels are actions, never a past-tense status.
    expect(screen.getByRole('button', { name: 'Start attack now' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Log another attack' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Attack started/ })).toBeNull();
  });

  it('clicking the main Start attack now CTA then 0 logs a real 0-pain attack, not an Off day', async () => {
    mountHome();
    await waitForSync();

    // The redundant bottom pain/edit secondary action is gone: while idle there
    // is no "Log pain" button at all, and "Edit details" only exists while an
    // attack is active (the attack card has its lowercase "details" link).
    expect(screen.queryByRole('button', { name: 'Log pain' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Start attack now' }));

    // The CTA starts the attack and opens the pain dialog for it.
    await waitFor(() => expect(captured!.state.attacks).toHaveLength(1));
    expect(screen.getByText('How bad is the pain right now?')).toBeTruthy();
    expect(screen.getByText('0 = no pain, but still an attack.')).toBeTruthy();
    for (let n = 0; n <= 10; n += 1) {
      expect(screen.getByRole('button', { name: String(n) })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole('button', { name: '0' }));

    await waitFor(() => expect(captured!.state.attacks[0].peakPain).toBe(0));
    expect(captured!.state.attacks).toHaveLength(1);
    const attack = captured!.state.attacks[0];
    expect(attack.end).toBeNull();
    expect(attack.peakPain).toBe(0);
    expect(attack.painLog.some((entry) => entry.level === 0)).toBe(true);
    // Only the CTA creates the attack; logging pain patches it instead.
    expect(api.addAttack).toHaveBeenCalledTimes(1);

    // The new attack drives the banner; the wellness card and movement stay on
    // screen, and the attack card remains the single "Log pain" affordance.
    await waitFor(() => expect(screen.getByText('Attack in progress')).toBeTruthy());
    expect(screen.getByText('Rest if you need to — movement is optional.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Strength/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Log pain' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();

    // It is an attack, never a day-state record (i.e. not an Off day).
    await waitFor(() => expect(readPersisted().attacks).toHaveLength(1));
    expect(readPersisted().dayStates).toHaveLength(0);
    expect(api.putDayState).not.toHaveBeenCalled();

    expect(sonner.toast.success).toHaveBeenCalledWith('Attack started — hang in there 💜', expect.anything());
    expect(sonner.toast.success).toHaveBeenCalledWith('Pain logged: 0/10');
  });

  it('still offers pain level 0 while an attack is active', async () => {
    seedState({ timezone: 'UTC', attacks: [makeAttack(Date.now())] });

    mountHome();
    await waitForSync();

    // Only the attack card offers "Log pain"; the removed bottom secondary
    // action (and its active-state "Edit details" label) is gone.
    expect(screen.getAllByRole('button', { name: 'Log pain' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();

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
    // The current effort is exposed as pressed; other efforts are not.
    expect(screen.getByRole('button', { name: 'Medium' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Hard' }).getAttribute('aria-pressed')).toBe('false');
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

describe("Home today's meds", () => {
  it('selects today by the configured timezone day, not the browser/UTC day', async () => {
    // Same fake-Date + re-import pattern as the workout timezone test: the
    // clock module captures Date.now() at import time.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z').getTime());
      vi.resetModules();
      captured = null;
      localStorage.clear();
      seedState({
        // UTC+14: local "now" is 2026-06-01 14:00, while UTC is still Jun 1
        // 00:00. Configured today = May 31 10:00Z .. Jun 1 10:00Z.
        timezone: 'Pacific/Kiritimati',
        meds: [
          // Local Jun 1 00:30 — the first half-hour of configured today, but
          // still yesterday in UTC/Europe.
          makeMed({ id: 'local-today-first', medId: 'local-today-first-med', ts: '2026-05-31T10:30:00.000Z' }),
          // Local Jun 1 02:30 — configured today, but May 31 in UTC.
          makeMed({ id: 'local-today', medId: 'local-today-med', ts: '2026-05-31T12:30:00.000Z' }),
          // Local May 31 23:00 — configured yesterday.
          makeMed({ id: 'local-yesterday', medId: 'local-yesterday-med', ts: '2026-05-31T09:00:00.000Z' }),
          // Local Jun 2 01:00 — configured tomorrow, still Jun 1 in UTC.
          makeMed({ id: 'local-tomorrow', medId: 'local-tomorrow-med', ts: '2026-06-01T11:00:00.000Z' }),
        ],
      });
      api = (await import('@/lib/api')).api as unknown as MockedBackend;
      applyApiDefaults(api);
      homeModule = await import('@/pages/Home');
      storeModule = await import('@/lib/store');

      mountHome();
      await waitForSync();

      // The meds section renders only for the configured local day. (The
      // check-in's "Today" label is a span; the meds header is the heading.)
      expect(screen.getByRole('heading', { name: 'Today' })).toBeTruthy();
      expect(screen.getByText('Local Today Med')).toBeTruthy();
      expect(screen.getByText('Local Today First Med')).toBeTruthy();
      expect(screen.queryByText('Local Yesterday Med')).toBeNull();
      expect(screen.queryByText('Local Tomorrow Med')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects today in a western configured zone too', async () => {
    // A second zone (UTC-7 in June) keeps the browser-day regression detectable
    // on hosts whose local day happens to match the UTC+14 case above.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z').getTime());
      vi.resetModules();
      captured = null;
      localStorage.clear();
      seedState({
        // Local "now" is 2026-05-31 17:00. Configured today =
        // May 31 07:00Z .. Jun 1 07:00Z.
        timezone: 'America/Los_Angeles',
        meds: [
          // Local May 31 00:30 — start of configured today.
          makeMed({ id: 'la-today-first', medId: 'la-today-first-med', ts: '2026-05-31T07:30:00.000Z' }),
          // Local May 31 05:30 — configured today (May 31 in UTC too).
          makeMed({ id: 'la-today', medId: 'la-today-med', ts: '2026-05-31T12:30:00.000Z' }),
          // Local May 31 23:30 — last half-hour of configured today.
          makeMed({ id: 'la-today-last', medId: 'la-today-last-med', ts: '2026-06-01T06:30:00.000Z' }),
          // Local May 30 23:30 — configured yesterday, but May 31 in UTC.
          makeMed({ id: 'la-yesterday', medId: 'la-yesterday-med', ts: '2026-05-31T06:30:00.000Z' }),
          // Local Jun 1 01:00 — configured tomorrow, but Jun 1 in UTC.
          makeMed({ id: 'la-tomorrow', medId: 'la-tomorrow-med', ts: '2026-06-01T08:00:00.000Z' }),
        ],
      });
      api = (await import('@/lib/api')).api as unknown as MockedBackend;
      applyApiDefaults(api);
      homeModule = await import('@/pages/Home');
      storeModule = await import('@/lib/store');

      mountHome();
      await waitForSync();

      expect(screen.getByRole('heading', { name: 'Today' })).toBeTruthy();
      expect(screen.getByText('La Today Med')).toBeTruthy();
      expect(screen.getByText('La Today First Med')).toBeTruthy();
      expect(screen.getByText('La Today Last Med')).toBeTruthy();
      expect(screen.queryByText('La Yesterday Med')).toBeNull();
      expect(screen.queryByText('La Tomorrow Med')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores meds with invalid timestamps instead of crashing', async () => {
    seedState({
      timezone: 'UTC',
      meds: [
        makeMed({ id: 'bad-unparseable', medId: 'bad-unparseable-med', ts: 'not-a-date' }),
        makeMed({ id: 'bad-empty', medId: 'bad-empty-med', ts: '' }),
        makeMed({ id: 'good', medId: 'good-med', ts: new Date().toISOString() }),
      ],
    });

    mountHome();
    await waitForSync();

    expect(screen.getByRole('heading', { name: 'Today' })).toBeTruthy();
    expect(screen.getByText('Good Med')).toBeTruthy();
    expect(screen.queryByText('Bad Unparseable Med')).toBeNull();
    expect(screen.queryByText('Bad Empty Med')).toBeNull();
  });

  it('omits the Today section when every timestamp is invalid', async () => {
    seedState({
      timezone: 'UTC',
      meds: [makeMed({ id: 'bad-only', medId: 'bad-only-med', ts: '2026-13-45T99:99:99Z' })],
    });

    mountHome();
    await waitForSync();

    expect(screen.queryByRole('heading', { name: 'Today' })).toBeNull();
    // The invalid record is still in state — hydration does not drop data.
    expect(captured!.state.meds).toHaveLength(1);
  });
});

describe('Home recent-dose surfacing', () => {
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const TIME_OPTIONS = { hour: 'numeric', minute: '2-digit' } as const;

  function quickButton(name: RegExp): HTMLButtonElement {
    return screen.getByRole('button', { name }) as HTMLButtonElement;
  }

  function medToastOptions(message: string): {
    description: string;
    action: { label: string; onClick: () => void };
  } {
    const call = (sonner.toast.success as Mock).mock.calls.find(
      ([toastMessage]) => toastMessage === message,
    );
    expect(call).toBeTruthy();
    return call![1] as { description: string; action: { label: string; onClick: () => void } };
  }

  it('shows a recent last-dose hint on the same quick card and still logs in one tap', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      meds: [makeMed({ id: 'recent-tylenol', medId: 'tylenol', ts: new Date(now - 25 * MINUTE_MS).toISOString() })],
    });

    mountHome();
    await waitForSync();

    const card = quickButton(/^Tylenol/);
    expect(within(card).getByText('Last 25m ago')).toBeTruthy();

    fireEvent.click(card);

    await waitFor(() => expect(api.addMed).toHaveBeenCalledTimes(1));
    expect(api.addMed).toHaveBeenCalledWith(expect.objectContaining({ medId: 'tylenol' }));
    await waitFor(() => expect(captured!.state.meds).toHaveLength(2));
  });

  it('shows no hint when the latest same-med dose is older than the window', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      meds: [makeMed({ id: 'old-tylenol', medId: 'tylenol', ts: new Date(now - 3 * HOUR_MS).toISOString() })],
    });

    mountHome();
    await waitForSync();

    expect(screen.getByRole('button', { name: /^Tylenol/ })).toBeTruthy();
    expect(screen.queryByText(/^Last /)).toBeNull();
  });

  it('ignores unparseable and empty timestamps without crashing the page', async () => {
    seedState({
      timezone: 'UTC',
      meds: [
        makeMed({ id: 'bad-unparseable', medId: 'tylenol', ts: 'not-a-date' }),
        makeMed({ id: 'bad-empty', medId: 'ibuprofen', ts: '' }),
      ],
    });

    mountHome();
    await waitForSync();

    // The rest of the page still renders and no hint is produced from junk.
    expect(screen.getByRole('button', { name: 'Start attack now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Tylenol/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Ibuprofen/ })).toBeTruthy();
    expect(screen.queryByText(/^Last /)).toBeNull();
  });

  it('hides a timestamp far in the future', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      meds: [makeMed({ id: 'future-tylenol', medId: 'tylenol', ts: new Date(now + 10 * MINUTE_MS).toISOString() })],
    });

    mountHome();
    await waitForSync();

    expect(screen.queryByText(/^Last /)).toBeNull();
  });

  it('tolerates a timestamp just inside the clock-skew window', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      meds: [makeMed({ id: 'skewed-tylenol', medId: 'tylenol', ts: new Date(now + 30 * 1000).toISOString() })],
    });

    mountHome();
    await waitForSync();

    // A fresh optimistic dose can trail the coarse clock by a few seconds; the
    // clamped age still reads as the sub-minute label.
    expect(screen.getByText('Last <1m ago')).toBeTruthy();
  });

  it('uses the latest same-med dose when several are in the window', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      meds: [
        makeMed({ id: 'older-tylenol', medId: 'tylenol', ts: new Date(now - 90 * MINUTE_MS).toISOString() }),
        makeMed({ id: 'newer-tylenol', medId: 'tylenol', ts: new Date(now - 25 * MINUTE_MS).toISOString() }),
      ],
    });

    mountHome();
    await waitForSync();

    expect(screen.getAllByText(/^Last /)).toHaveLength(1);
    expect(screen.getByText('Last 25m ago')).toBeTruthy();
    expect(screen.queryByText('Last 1h 30m ago')).toBeNull();
  });

  it('never shows the hint on a preventive card', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      meds: [makeMed({ id: 'recent-emgality', medId: 'emgality', ts: new Date(now - 20 * MINUTE_MS).toISOString() })],
    });

    mountHome();
    await waitForSync();

    expect(quickButton(/^Emgality/)).toBeTruthy();
    expect(screen.queryByText(/^Last /)).toBeNull();
  });

  it('adds previous-dose context to the log toast while keeping dose, time, and Undo', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      meds: [
        makeMed({
          id: 'old-nurtec',
          medId: 'nurtec',
          dose: '75 mg',
          ts: new Date(now - 25 * MINUTE_MS).toISOString(),
        }),
      ],
      doses: { nurtec: '75 mg' },
    });

    mountHome();
    await waitForSync();

    const timeBefore = new Date().toLocaleTimeString([], TIME_OPTIONS);
    fireEvent.click(quickButton(/^Nurtec/));
    const timeAfter = new Date().toLocaleTimeString([], TIME_OPTIONS);

    const options = medToastOptions('Nurtec logged');
    const description = options.description;
    expect(description).toContain('75 mg');
    // The localized log time is still present (between the dose and context).
    const timePart = description.split(' · ')[1];
    expect([timeBefore, timeAfter]).toContain(timePart);
    // Context describes the OLD dose, not the entry just added.
    expect(description).toContain('last dose 25m ago');
    expect(description).not.toContain('last dose <1m');
    expect(description).not.toContain('last dose 0m');
    expect(options.action.label).toBe('Undo');

    await waitFor(() => expect(captured!.state.meds).toHaveLength(2));
    const added = captured!.state.meds.find((m) => m.id !== 'old-nurtec');
    expect(added?.medId).toBe('nurtec');

    act(() => options.action.onClick());

    await waitFor(() => expect(captured!.state.meds).toHaveLength(1));
    expect(api.deleteMed).toHaveBeenCalledWith(added!.id);
    expect(captured!.state.meds[0].id).toBe('old-nurtec');
  });

  it('omits previous-dose context when the prior dose is older than the window', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      meds: [
        makeMed({
          id: 'old-nurtec',
          medId: 'nurtec',
          dose: '75 mg',
          ts: new Date(now - 3 * HOUR_MS).toISOString(),
        }),
      ],
      doses: { nurtec: '75 mg' },
    });

    mountHome();
    await waitForSync();

    fireEvent.click(quickButton(/^Nurtec/));

    const { description } = medToastOptions('Nurtec logged');
    expect(description).toContain('75 mg');
    expect(description).toMatch(/\d{1,2}:\d{2}/);
    expect(description).not.toContain('last dose');
    await waitFor(() => expect(captured!.state.meds).toHaveLength(2));
  });
});

describe('Home demo-data guard', () => {
  const DEMO_COPY = 'No data yet. This demo stores everything in your browser only.';
  const DEMO_BUTTON = 'Load 75 days of demo data';

  it('hides the demo block in confirmed server mode and never imports demo data', async () => {
    mountHome();
    await waitForSync();
    await waitFor(() => expect(captured!.serverMode).toBe(true));

    expect(screen.queryByText(DEMO_COPY)).toBeNull();
    expect(screen.queryByRole('button', { name: DEMO_BUTTON })).toBeNull();
    expect(api.importAll).not.toHaveBeenCalled();
  });

  it('keeps the demo block and still loads demo data locally when the server is unreachable', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));

    mountHome();
    // The rejected hydration leaves the store in local mode for good.
    await waitFor(() => expect(api.exportAll).toHaveBeenCalled());
    expect(captured!.serverMode).toBe(false);
    expect(captured!.sync.status).toBe('local');

    expect(screen.getByText(DEMO_COPY)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: DEMO_BUTTON }));

    await waitFor(() => expect(captured!.state.seeded).toBe(true));
    expect(captured!.state.attacks.length).toBeGreaterThan(0);
    expect(captured!.state.meds.length).toBeGreaterThan(0);
    // The store's serialized queue short-circuits writes while offline, so the
    // demo import never reaches the API at all — unchanged offline behavior.
    expect(api.importAll).not.toHaveBeenCalled();
    // Seeding flips `seeded`, so the existing condition hides the block.
    expect(screen.queryByText(DEMO_COPY)).toBeNull();
  });

  it('hides the demo block when only a medication exists locally', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));
    seedState({ timezone: 'UTC', meds: [makeMed({ id: 'local-med' })] });

    mountHome();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalled());
    expect(captured!.serverMode).toBe(false);
    expect(captured!.state.attacks).toHaveLength(0);
    expect(captured!.state.meds).toHaveLength(1);

    // Nonempty local data must never be replaced by demo seeding.
    expect(screen.queryByText(DEMO_COPY)).toBeNull();
    expect(screen.queryByRole('button', { name: DEMO_BUTTON })).toBeNull();
    expect(api.importAll).not.toHaveBeenCalled();
  });

  it('hides the demo block when only a workout exists locally', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));
    seedState({
      timezone: 'UTC',
      workouts: [makeWorkout('cardio', { id: 'local-workout' })],
    });

    mountHome();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalled());
    expect(captured!.serverMode).toBe(false);
    expect(captured!.state.attacks).toHaveLength(0);
    expect(captured!.state.workouts).toHaveLength(1);

    expect(screen.queryByText(DEMO_COPY)).toBeNull();
    expect(screen.queryByRole('button', { name: DEMO_BUTTON })).toBeNull();
    expect(api.importAll).not.toHaveBeenCalled();
  });

  it('keeps the demo block hidden for already-seeded local state', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));
    seedState({ seeded: true });

    mountHome();
    await waitFor(() => expect(api.exportAll).toHaveBeenCalled());
    expect(captured!.serverMode).toBe(false);

    expect(screen.queryByText(DEMO_COPY)).toBeNull();
    expect(screen.queryByRole('button', { name: DEMO_BUTTON })).toBeNull();
    expect(api.importAll).not.toHaveBeenCalled();
  });
});

describe('Home attack undo and configured Nurtec rule', () => {
  it('offers Undo for starting an attack and deletes the just-created record', async () => {
    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Start attack now' }));
    await waitFor(() => expect(captured!.state.attacks).toHaveLength(1));

    const startCall = (sonner.toast.success as Mock).mock.calls.find(
      ([message]) => String(message).startsWith('Attack started'),
    );
    expect(startCall).toBeTruthy();
    const action = startCall![1].action as { label: string; onClick: () => void };
    expect(action.label).toBe('Undo');

    act(() => action.onClick());
    await waitFor(() => expect(captured!.state.attacks).toHaveLength(0));
    expect(api.deleteAttack).toHaveBeenCalledTimes(1);
  });

  it('offers Undo for ending an attack and reopens it through the same queue', async () => {
    seedState({ timezone: 'UTC', attacks: [makeAttack(Date.now())] });
    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Attack ended' }));
    await waitFor(() => expect(captured!.state.attacks[0].end).not.toBeNull());

    const endCall = (sonner.toast.success as Mock).mock.calls.find(
      ([message]) => String(message) === 'Attack ended — logged.',
    );
    expect(endCall).toBeTruthy();
    const action = endCall![1].action as { label: string; onClick: () => void };
    expect(action.label).toBe('Undo');

    act(() => action.onClick());
    await waitFor(() => expect(captured!.state.attacks[0].end).toBeNull());
    // Reopening is an end-patch, never a delete.
    expect(api.patchAttack).toHaveBeenLastCalledWith(
      captured!.state.attacks[0].id,
      expect.objectContaining({ end: null }),
    );
    expect(api.deleteAttack).not.toHaveBeenCalled();
  });

  it('reopening via end-Undo writes no day state, and the later real end leaves the day Off', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({
      timezone: 'UTC',
      attacks: [makeAttack(now)],
      dayStates: [{ ...makeDayState(todayKey), status: 'well', notes: 'kept' }],
    });

    mountHome();
    await waitForSync();

    // First real end: the restored active attack leaves today Off.
    fireEvent.click(screen.getByRole('button', { name: 'Attack ended' }));
    await waitFor(() => expect(captured!.state.attacks[0].end).not.toBeNull());
    await waitFor(() => expect(readPersisted().dayStates[0]).toMatchObject({
      status: 'off',
      notes: 'kept',
    }));
    expect(api.putDayState).toHaveBeenCalledTimes(1);

    const endCall = (sonner.toast.success as Mock).mock.calls.find(
      ([message]) => String(message) === 'Attack ended — logged.',
    );
    expect(endCall).toBeTruthy();
    const undoEnd = endCall![1].action as { label: string; onClick: () => void };

    // The user goes back to an explicit Well after the attack.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));
    await waitFor(() => expect(readPersisted().dayStates[0]).toMatchObject({ status: 'well' }));
    const writesBeforeReopen = api.putDayState.mock.calls.length;

    // Reopening is a history edit: today's Well must survive untouched.
    act(() => undoEnd.onClick());
    await waitFor(() => expect(captured!.state.attacks[0].end).toBeNull());
    expect(api.putDayState).toHaveBeenCalledTimes(writesBeforeReopen);
    expect(readPersisted().dayStates[0]).toMatchObject({ status: 'well', notes: 'kept' });

    // The later REAL end enforces Off again, with Change available.
    fireEvent.click(screen.getByRole('button', { name: 'Attack ended' }));
    await waitFor(() => expect(readPersisted().dayStates[0]).toMatchObject({ status: 'off' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy());
  });

  it('derives the Nurtec badge from the configured rule and window', async () => {
    const now = Date.now();
    seedState({
      timezone: 'UTC',
      rules: { nurtec: { limit: 10, windowDays: 14 } },
      meds: [
        {
          id: 'n1', medId: 'nurtec', ts: new Date(now - 86400000).toISOString(),
          dose: '75 mg', quantity: 1, attackId: null, notes: '', source: 'manual',
        },
        {
          id: 'n2', medId: 'nurtec', ts: new Date(now).toISOString(),
          dose: '75 mg', quantity: 1, attackId: null, notes: '', source: 'manual',
        },
      ],
    });

    mountHome();
    await waitForSync();

    const badge = screen.getByText('2/10');
    expect(badge.getAttribute('title')).toContain('2 of 10 allowed days');
    expect(badge.getAttribute('title')).toContain('last 14 days');
  });
});

describe('Home combined painkiller usage chip', () => {
  it('shows the same combined Painkillers chip on all three acute analgesics', async () => {
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString();
    seedState({
      timezone: 'UTC',
      // Mismatched rules resolve conservatively: lowest limit (8), widest
      // window (45) across Tylenol, Ibuprofen and Naproxen.
      rules: {
        tylenol: { limit: 8, windowDays: 45 },
        ibuprofen: { limit: 15, windowDays: 30 },
        naproxen: { limit: 10, windowDays: 30 },
      },
      meds: [
        // Two painkillers on one day count once; Naproxen on another day is
        // only inside the wider 45-day window.
        {
          id: 'pk-1', medId: 'tylenol', ts: daysAgo(3), dose: '', quantity: null,
          attackId: null, notes: '', source: 'manual',
        },
        {
          id: 'pk-2', medId: 'ibuprofen', ts: daysAgo(3), dose: '', quantity: null,
          attackId: null, notes: '', source: 'manual',
        },
        {
          id: 'pk-3', medId: 'naproxen', ts: daysAgo(35), dose: '', quantity: null,
          attackId: null, notes: '', source: 'manual',
        },
      ],
    });

    mountHome();
    await waitForSync();

    // One aggregate chip, identical on every painkiller card.
    const chips = screen.getAllByText('2/8');
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(chip.getAttribute('title')).toContain('Painkillers combined');
      expect(chip.getAttribute('title')).toContain('2 of 8 allowed days');
      expect(chip.getAttribute('title')).toContain('last 45 days');
      expect(chip.getAttribute('aria-label')).toContain('Painkillers combined');
      expect(chip.getAttribute('aria-label')).toContain('last 45 days');
      expect(chip.getAttribute('aria-label')).toContain('within limit');
      expect(chip.className).toContain('bg-slate-800');
    }

    // Nurtec keeps its own independent rolling count.
    expect(screen.getAllByText('0/15')).toHaveLength(1);
  });

  it('names the over-limit state in the combined painkiller accessible label', async () => {
    seedState({
      timezone: 'UTC',
      rules: {
        tylenol: { limit: 2, windowDays: 30 },
        ibuprofen: { limit: 2, windowDays: 30 },
        naproxen: { limit: 2, windowDays: 30 },
      },
      meds: [1, 2, 3].map((n) => ({
        id: `pk-over-${n}`, medId: 'tylenol' as const,
        ts: new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString(), dose: '',
        quantity: null, attackId: null, notes: '', source: 'manual' as const,
      })),
    });

    mountHome();
    await waitForSync();

    const chips = screen.getAllByText('3/2');
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(chip.getAttribute('aria-label')).toContain('over limit');
      expect(chip.className).toContain('bg-red-950');
    }
  });
});

describe('Home content order (approved design)', () => {
  function isBefore(a: Node, b: Node): boolean {
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  it('puts acute medications after the start control, then wellness/movement, then preventives', async () => {
    seedState({ timezone: 'UTC' });
    mountHome();
    await waitForSync();

    const start = screen.getByRole('button', { name: 'Start attack now' });
    const meds = screen.getByRole('heading', { name: 'Took a med' });
    const movement = screen.getByText('Movement');
    const well = screen.getByRole('button', { name: 'Well' });
    const preventive = screen.getByRole('heading', { name: 'Preventive' });

    expect(isBefore(start, meds)).toBe(true);
    // Acute medication comes first; its grid holds no preventive buttons.
    expect(isBefore(meds, well)).toBe(true);
    expect(isBefore(meds, movement)).toBe(true);
    expect(isBefore(well, movement)).toBe(true);
    // Preventive medication stays visible, after wellness/movement.
    expect(isBefore(movement, preventive)).toBe(true);
    expect(screen.getByRole('button', { name: /Emgality/ })).toBeTruthy();
    expect(screen.getByText('How was today?')).toBeTruthy();
  });

  it('keeps the Movement label and controls on one compact wrapping row', async () => {
    seedState({ timezone: 'UTC' });
    mountHome();
    await waitForSync();

    const label = screen.getByText('Movement');
    const row = label.parentElement as HTMLElement;
    expect(row.className).toContain('flex-wrap');
    // Label and both controls share the row container (one line when it fits).
    expect(row.contains(screen.getByRole('button', { name: /^Strength/ }))).toBe(true);
    expect(row.contains(screen.getByRole('button', { name: /^Cardio/ }))).toBe(true);
    // Weekly progress is still rendered in the same compact block.
    expect(row.contains(screen.getByText('This week:'))).toBe(true);
  });

  it('keeps the same order while an attack is active (nothing hidden)', async () => {
    seedState({ timezone: 'UTC', attacks: [makeAttack(Date.now())] });
    mountHome();
    await waitForSync();

    const pain = screen.getByRole('button', { name: 'Log pain' });
    const ended = screen.getByRole('button', { name: 'Attack ended' });
    const meds = screen.getByRole('heading', { name: 'Took a med' });
    const movement = screen.getByText('Movement');
    const preventive = screen.getByRole('heading', { name: 'Preventive' });

    expect(isBefore(pain, ended)).toBe(true);
    expect(isBefore(ended, meds)).toBe(true);
    expect(isBefore(meds, movement)).toBe(true);
    expect(isBefore(movement, preventive)).toBe(true);
    // Nothing is hidden or collapsed: the movement controls remain usable.
    expect(screen.getByRole('button', { name: /^Strength/ })).toBeTruthy();
    const weather = screen.queryByRole('heading', { name: 'Weather' });
    if (weather) expect(isBefore(preventive, weather)).toBe(true);
  });
});

describe('Home attack undo safety', () => {
  it('refuses to reopen an ended attack while another attack is active', async () => {
    seedState({ timezone: 'UTC', attacks: [makeAttack(Date.now())] });
    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Attack ended' }));
    await waitFor(() => expect(captured!.state.attacks[0].end).not.toBeNull());
    const endCall = (sonner.toast.success as Mock).mock.calls.find(
      ([message]) => String(message) === 'Attack ended — logged.',
    );
    expect(endCall).toBeTruthy();
    const undoEnd = endCall![1].action as { onClick: () => void };

    // Start attack B before the stale toast action is used.
    fireEvent.click(screen.getByRole('button', { name: 'Log another attack' }));
    await waitFor(() => expect(captured!.state.attacks).toHaveLength(2));
    const attackB = captured!.state.attacks.find((a) => a.end === null);
    expect(attackB).toBeTruthy();
    // Dismiss the pain dialog the start CTA opened.
    fireEvent.click(screen.getByRole('button', { name: '0' }));
    await waitFor(() => expect(screen.queryByText('How bad is the pain right now?')).toBeNull());

    act(() => undoEnd.onClick());

    await waitFor(() => expect(sonner.toast.warning).toHaveBeenCalledWith(
      'Another attack is in progress',
      expect.anything(),
    ));
    // A stays ended; B is the only open attack.
    expect(
      captured!.state.attacks.filter((a) => a.end === null).map((a) => a.id),
    ).toEqual([attackB!.id]);
    expect(
      captured!.state.attacks.find((a) => a.id !== attackB!.id)!.end,
    ).not.toBeNull();

    // Later logging is associated with B, never diverted back to A.
    fireEvent.click(screen.getByRole('button', { name: /Nurtec/ }));
    await waitFor(() => expect(captured!.state.meds).toHaveLength(1));
    expect(captured!.state.meds[0].attackId).toBe(attackB!.id);
  });
});

describe('Home acknowledgement and low-limit warnings', () => {
  it('shows Attack with no Change, choices, or day-marked text while an attack is active', async () => {
    seedState({ timezone: 'UTC', attacks: [makeAttack(Date.now())] });
    mountHome();
    await waitForSync();

    // Attack status stays primary under the banner, and the day check-in is
    // locked for the attack: no Well/Off and no Change, anywhere.
    expect(screen.getByText('Attack')).toBeTruthy();
    expect(screen.queryByText(/day marked/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
  });

  it('does not warn for an unused low limit but warns once a day is used', async () => {
    seedState({ timezone: 'UTC', rules: { nurtec: { limit: 2, windowDays: 30 } } });
    mountHome();
    await waitForSync();

    const nurtecCard = screen.getByRole('button', { name: /Nurtec/ });
    const unused = within(nurtecCard).getByText('0/2');
    expect(unused.className).toContain('bg-slate-800');
    expect(unused.className).not.toContain('bg-amber-950');
    expect(unused.className).not.toContain('bg-red-950');

    cleanup();
    seedState({
      timezone: 'UTC',
      rules: { nurtec: { limit: 2, windowDays: 30 } },
      meds: [{
        id: 'low-limit-dose',
        medId: 'nurtec',
        ts: new Date().toISOString(),
        dose: '75 mg',
        quantity: 1,
        attackId: null,
        notes: '',
        source: 'manual',
      }],
    });
    mountHome();
    await waitForSync();

    // 1/2 is near (reaching the limit is not over).
    const used = within(screen.getByRole('button', { name: /Nurtec/ })).getByText('1/2');
    expect(used.className).toContain('bg-amber-950');
    expect(used.className).not.toContain('bg-red-950');
  });
});

describe('Home attack-day rule', () => {
  it('turns a prior Well day Off for the active attack and restores Choice after it ends', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({
      timezone: 'UTC',
      dayStates: [{
        ...makeDayState(todayKey),
        status: 'well',
        notes: 'good day',
      }],
    });

    mountHome();
    await waitForSync();
    expect(screen.getByText('Well')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start attack now' }));
    await waitFor(() => expect(screen.getByText('Attack in progress')).toBeTruthy());
    await closePainDialog();

    // Attack is displayed, with no Change and no "day marked …" announcement.
    expect(screen.getByText('Attack')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
    expect(screen.queryByText(/day marked/)).toBeNull();

    // The real transition rewrote today's existing record to Off, notes intact.
    await waitFor(() => expect(readPersisted().dayStates[0]).toMatchObject({
      day: todayKey,
      status: 'off',
      notes: 'good day',
    }));
    expect(api.putDayState).toHaveBeenCalledWith(
      todayKey,
      { status: 'off', notes: 'good day' },
    );

    // Ending the attack keeps the day Off but returns Change and the choices.
    fireEvent.click(screen.getByRole('button', { name: 'Attack ended' }));
    await waitFor(() => expect(screen.queryByText('Attack in progress')).toBeNull());
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Well' }));
    await waitFor(() => expect(readPersisted().dayStates[0]).toMatchObject({
      day: todayKey,
      status: 'well',
      notes: 'good day',
    }));
    expect(screen.getByText('Normal routine today.')).toBeTruthy();
  });

  it('starts a real attack without creating a day-state row when none exists', async () => {
    seedState({ timezone: 'UTC' });

    mountHome();
    await waitForSync();
    expect(screen.getByRole('button', { name: 'Well' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start attack now' }));
    await waitFor(() => expect(captured!.state.attacks).toHaveLength(1));
    await closePainDialog();

    // Inference covers record-less attack days: no row is written, so an
    // unperformed check-in stays unperformed.
    expect(captured!.state.dayStates).toHaveLength(0);
    expect(readPersisted().dayStates).toHaveLength(0);
    expect(api.putDayState).not.toHaveBeenCalled();
    expect(screen.getByText('Attack')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('writes nothing when a mount restores an already-active attack', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({
      timezone: 'UTC',
      attacks: [makeAttack(now)],
      dayStates: [{
        ...makeDayState(todayKey),
        status: 'well',
        notes: 'kept',
      }],
    });

    mountHome();
    await waitForSync();
    await act(async () => {
      await Promise.resolve();
    });

    // No hydration/mount effect applies the attack-day rule: the restored
    // active attack must not rewrite the day or diverge from the server.
    expect(api.putDayState).not.toHaveBeenCalled();
    expect(readPersisted().dayStates[0]).toMatchObject({ status: 'well', notes: 'kept' });
    expect(screen.getByText('Attack')).toBeTruthy();
  });

  it('restores the prior Well day when undoing an accidental attack start', async () => {
    const now = Date.now();
    const todayKey = localDayKey(now, 'UTC');
    seedState({
      timezone: 'UTC',
      dayStates: [{
        ...makeDayState(todayKey),
        status: 'well',
        notes: 'good day',
      }],
    });

    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Start attack now' }));
    await waitFor(() => expect(readPersisted().dayStates[0]).toMatchObject({ status: 'off' }));

    const startCall = (sonner.toast.success as Mock).mock.calls.find(
      ([message]) => String(message).startsWith('Attack started'),
    );
    expect(startCall).toBeTruthy();
    const action = startCall![1].action as { label: string; onClick: () => void };
    expect(action.label).toBe('Undo');

    act(() => action.onClick());

    await waitFor(() => expect(captured!.state.attacks).toHaveLength(0));
    await waitFor(() => expect(readPersisted().dayStates[0]).toMatchObject({
      day: todayKey,
      status: 'well',
      notes: 'good day',
    }));
    // Undo is a plain delete; the store's provenance restores the day in the
    // same state update (one Off write, one restore write — no double write).
    expect(api.putDayState).toHaveBeenLastCalledWith(
      todayKey,
      { status: 'well', notes: 'good day' },
    );
    expect(api.putDayState).toHaveBeenCalledTimes(2);
  });

  it('closes an open Change editor when an attack locks the day', async () => {
    seedState({ timezone: 'UTC' });

    mountHome();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('button', { name: 'Well' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start attack now' }));
    await waitFor(() => expect(screen.getByText('Attack in progress')).toBeTruthy());
    await closePainDialog();

    expect(screen.queryByRole('button', { name: 'Well' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText('Attack')).toBeTruthy();
  });

  it('rolls the active attack into the next day without writing a record', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-15T23:59:50.000Z').getTime());
      vi.resetModules();
      captured = null;
      localStorage.clear();
      seedState({
        timezone: 'UTC',
        attacks: [{ ...makeAttack(Date.now()), id: 'crosses-midnight' }],
        dayStates: [{
          day: '2026-06-15', status: 'off', notes: 'rough day',
          updatedAt: new Date(Date.now()).toISOString(),
        }],
      });
      api = (await import('@/lib/api')).api as unknown as MockedBackend;
      applyApiDefaults(api);
      homeModule = await import('@/pages/Home');
      storeModule = await import('@/lib/store');
      const clock = await import('@/lib/clock');

      mountHome();
      await waitForSync();
      expect(screen.getByText('Attack in progress')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();

      // Cross midnight: the keyed check-in remounts for the new day, which has
      // no record of its own and stays Attack while the attack is active.
      act(() => {
        vi.setSystemTime(new Date('2026-06-16T00:00:10.000Z').getTime());
        clock.bumpClock();
      });

      await waitFor(() => expect(screen.getByText('Attack in progress')).toBeTruthy());
      expect(screen.getByText('Attack')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();

      // Yesterday's record is untouched and the new day was never backfilled.
      const persisted = readPersisted();
      expect(persisted.dayStates).toHaveLength(1);
      expect(persisted.dayStates[0]).toMatchObject({ day: '2026-06-15', status: 'off' });
      expect(api.putDayState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
