// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { Attack, DayState, MedEvent, TrackerState, Workout } from '@/types';
import { dayKeyStartMs, localDayKey, zonedDateTimeToMs } from '../../shared/datetime.ts';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';
import { painkillerMismatchNote } from '@/lib/usage';

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
type CalendarPageModule = typeof import('@/pages/CalendarPage');

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
const ZONES = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'];

let api: MockedBackend;
let storeModule: StoreModule;
let calendarPageModule: CalendarPageModule;
let captured: StoreApi | null = null;

function Probe() {
  captured = storeModule.useStore();
  return null;
}

function mountCalendar(): void {
  const CalendarPage = calendarPageModule.default;
  render(
    <storeModule.StoreProvider>
      <CalendarPage />
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

function applyApiDefaults(backend: MockedBackend): void {
  backend.exportAll.mockResolvedValue({
    attacks: [] as Attack[],
    meds: [] as TrackerState['meds'],
    refills: [] as TrackerState['refills'],
    workouts: [] as Workout[],
    dayStates: [] as DayState[],
    settings: {} as Record<string, unknown>,
  });
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

function formatDayTitle(key: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(new Date(dayKeyStartMs(key, timeZone)));
}

/**
 * Pick a configured zone + a mid-month day in its current month, plus an
 * instant inside that configured-zone day whose machine-local day differs.
 * Mid-month keeps both days in the visible six-week grid regardless of the
 * machine zone.
 */
function findConfiguredDayDifferentFromSystem(): {
  timeZone: string;
  dayKey: string;
  machineKey: string;
  instantMs: number;
} {
  const now = Date.now();
  for (const timeZone of ZONES) {
    const todayKey = localDayKey(now, timeZone);
    // Day 15 always exists and is always inside the visible month grid.
    const dayKey = `${todayKey.slice(0, 7)}-15`;
    const start = dayKeyStartMs(dayKey, timeZone);
    for (let minutes = 30; minutes < 24 * 60; minutes += 30) {
      const instantMs = start + minutes * 60 * 1000;
      if (localDayKey(instantMs, timeZone) !== dayKey) continue;
      const machineKey = localDayKey(instantMs);
      if (machineKey !== dayKey) {
        return { timeZone, dayKey, machineKey, instantMs };
      }
    }
  }
  throw new Error(
    'could not construct an instant whose configured-zone day differs from the machine day',
  );
}

function clickDay(key: string): void {
  const cell = document.querySelector<HTMLButtonElement>(`[data-day="${key}"]`);
  if (!cell) throw new Error(`calendar cell not found for ${key}`);
  fireEvent.click(cell);
}

/**
 * Move the month cursor from the current configured-zone month to
 * `targetMonth` ('YYYY-MM') using the header arrows, so the test does not
 * depend on the machine's real date.
 */
function goToMonth(targetMonth: string, timeZone: string): void {
  const monthIndex = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7));
  const currentMonth = localDayKey(Date.now(), timeZone).slice(0, 7);
  const delta = monthIndex(targetMonth) - monthIndex(currentMonth);
  const label = delta < 0 ? 'Previous month' : 'Next month';
  for (let i = 0; i < Math.abs(delta); i++) fireEvent.click(screen.getByLabelText(label));
}

function makeWorkout(performedAt: number): Workout {
  return {
    id: 'seed-workout',
    performedAt: new Date(performedAt).toISOString(),
    kind: 'cardio',
    effort: 'medium',
    durationMinutes: 30,
    notes: '',
    source: 'manual',
  };
}

function makeAttack(dayKey: string, timeZone: string): Attack {
  const start = dayKeyStartMs(dayKey, timeZone) + 60 * 60 * 1000;
  return {
    id: 'seed-attack',
    start: new Date(start).toISOString(),
    end: new Date(start + 2 * 60 * 60 * 1000).toISOString(),
    painLog: [],
    peakPain: 6,
    symptoms: ['nausea'],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
  };
}

/** An attack from explicit instants (`end === null` = ongoing). */
function makeTimedAttack(id: string, startMs: number, endMs: number | null): Attack {
  return {
    id,
    start: new Date(startMs).toISOString(),
    end: endMs === null ? null : new Date(endMs).toISOString(),
    painLog: [],
    peakPain: 6,
    symptoms: [],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
  };
}

/** Day 15 of the configured zone's current month, always inside the grid. */
function midMonthDay(timeZone: string): string {
  return `${localDayKey(Date.now(), timeZone).slice(0, 7)}-15`;
}

function daysInMonthOf(dayKey: string): number {
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Text of the month header line ("X attack days of D · Y attacks"). */
function monthHeaderText(): string {
  const header = screen.getByText((_, element) => element?.tagName === 'P'
    && (element.textContent ?? '').includes('attack day'));
  return (header.textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  calendarPageModule = await import('@/pages/CalendarPage');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('CalendarPage configured-timezone day identity', () => {
  it('shows a workout under the configured-zone day, not the machine-local day', async () => {
    const { timeZone, dayKey, machineKey, instantMs } = findConfiguredDayDifferentFromSystem();
    seedState({ timezone: timeZone, workouts: [makeWorkout(instantMs)] });

    mountCalendar();
    await waitForSync();

    clickDay(dayKey);
    await waitFor(() => expect(screen.getByText('Cardio · medium')).toBeTruthy());
    expect(screen.getByRole('heading', { name: formatDayTitle(dayKey, timeZone) })).toBeTruthy();

    // The same instant belongs to a different machine-local day; that cell must
    // not show the workout.
    clickDay(machineKey);
    await waitFor(() => expect(screen.queryByText('Cardio · medium')).toBeNull());
    expect(
      screen.getByRole('heading', { name: formatDayTitle(machineKey, timeZone) }),
    ).toBeTruthy();
  });

  it('shows the configured-zone day state and its notes in that day sheet', async () => {
    const { timeZone, dayKey } = findConfiguredDayDifferentFromSystem();
    seedState({
      timezone: timeZone,
      dayStates: [{
        day: dayKey,
        status: 'off',
        notes: 'rough morning',
        updatedAt: new Date().toISOString(),
      }],
    });

    mountCalendar();
    await waitForSync();

    clickDay(dayKey);
    await waitFor(() => expect(screen.getByText('Day state')).toBeTruthy());
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText('rough morning')).toBeTruthy();
    expect(screen.getByRole('heading', { name: formatDayTitle(dayKey, timeZone) })).toBeTruthy();
  });

  it('keeps attack inference, workouts, and the sheet title on the same configured day', async () => {
    const { timeZone, dayKey, instantMs } = findConfiguredDayDifferentFromSystem();
    seedState({
      timezone: timeZone,
      attacks: [makeAttack(dayKey, timeZone)],
      workouts: [makeWorkout(instantMs)],
    });

    mountCalendar();
    await waitForSync();

    clickDay(dayKey);
    await waitFor(() => expect(screen.getByText('Off (from attacks)')).toBeTruthy());
    expect(screen.getByText('nausea')).toBeTruthy();
    expect(screen.getByText('Cardio · medium')).toBeTruthy();
    expect(screen.getByRole('heading', { name: formatDayTitle(dayKey, timeZone) })).toBeTruthy();
  });
});

describe('CalendarPage attack-day rule', () => {
  it('shows Attack for today while an attack is active, even over a Well record', async () => {
    const TZ = 'UTC';
    const today = localDayKey(Date.now(), TZ);
    seedState({
      timezone: TZ,
      attacks: [makeTimedAttack('active', Date.now() - 60 * 60 * 1000, null)],
      dayStates: [{
        day: today, status: 'well', notes: '', updatedAt: new Date().toISOString(),
      }],
    });

    mountCalendar();
    await waitForSync();
    clickDay(today);

    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(within(sheet).getByText('Day state')).toBeTruthy());
    expect(within(sheet).getByText('Attack')).toBeTruthy();
    expect(within(sheet).queryByText('Well')).toBeNull();
  });

  it('shows Off for a record-less day overlapped by an ended attack', async () => {
    const TZ = 'UTC';
    const today = localDayKey(Date.now(), TZ);
    seedState({
      timezone: TZ,
      attacks: [makeTimedAttack(
        'ended',
        Date.now() - 2 * 60 * 60 * 1000,
        Date.now() - 60 * 1000,
      )],
    });

    mountCalendar();
    await waitForSync();
    clickDay(today);

    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(within(sheet).getByText('Off (from attacks)')).toBeTruthy());
    expect(within(sheet).queryByText('Attack')).toBeNull();
  });
});

describe('CalendarPage medication day buckets', () => {
  it('shows valid meds on their configured-zone day and skips invalid timestamps', async () => {
    const TZ = 'UTC';
    const day = midMonthDay(TZ);
    const startMs = dayKeyStartMs(day, TZ) + 9 * 60 * 60 * 1000;
    const meds: MedEvent[] = [
      {
        id: 'valid-med', medId: 'tylenol', ts: new Date(startMs).toISOString(),
        dose: '500 mg', quantity: null, attackId: null, notes: '', source: 'manual',
      },
      {
        id: 'invalid-med', medId: 'nurtec', ts: 'not-a-date',
        dose: '', quantity: null, attackId: null, notes: '', source: 'manual',
      },
    ];
    seedState({ timezone: TZ, meds });

    mountCalendar();
    await waitForSync();

    const cell = document.querySelector<HTMLButtonElement>(`[data-day="${day}"]`);
    if (!cell) throw new Error(`calendar cell not found for ${day}`);
    // The day cell carries the valid dose's letter chip and nothing for the
    // unparseable row (which the old per-cell bucket also skipped).
    expect(cell.querySelector('[title="Tylenol"]')).toBeTruthy();
    expect(cell.querySelector('[title="Nurtec"]')).toBeNull();

    clickDay(day);
    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(within(sheet).getByText('500 mg')).toBeTruthy());
    expect(within(sheet).getByText('Tylenol')).toBeTruthy();
    expect(within(sheet).queryByText('Nurtec')).toBeNull();
  });
});

describe('CalendarPage out-of-month cells', () => {
  it('uses a darker in-month fill and a distinct out-of-month fill without dimming text', async () => {
    const TZ = 'UTC';
    seedState({ timezone: TZ });
    mountCalendar();
    await waitForSync();

    const cells = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-day]'));
    expect(cells.length).toBe(42);
    const monthPrefix = midMonthDay(TZ).slice(0, 7);
    const inMonth = cells.find((cell) => cell.dataset.day?.slice(0, 7) === monthPrefix);
    const outMonth = cells.find((cell) => cell.dataset.day?.slice(0, 7) !== monthPrefix);
    if (!inMonth || !outMonth) throw new Error('expected in- and out-of-month cells');

    expect(inMonth.className).toContain('bg-slate-950');
    expect(outMonth.className).toContain('bg-slate-900');

    // De-emphasis is a background choice, not opacity on the number.
    const outNumber = outMonth.querySelector('span');
    expect(outNumber?.className).toContain('text-slate-400');
    expect(outNumber?.className ?? '').not.toMatch(/(^|\s)opacity-/);

    // No cell may carry a border utility: the grid's gap-px + slate-800
    // background already draws the seams, and a per-cell border made them
    // uneven (3px vs 1px). This fails if the border is reintroduced.
    for (const cell of cells) {
      expect(cell.className).not.toMatch(/(^|\s)border($|\s|-)/);
    }
  });
});

describe('CalendarPage ongoing attacks', () => {
  const TZ = 'UTC';

  it('shows an em dash, not negative elapsed, for an ongoing attack with a future start', async () => {
    const now = Date.now();
    const startMs = now + 3 * 86400000;
    const startDay = localDayKey(startMs, TZ);
    seedState({
      timezone: TZ,
      attacks: [makeTimedAttack('future-ongoing', startMs, null)],
    });

    mountCalendar();
    await waitForSync();

    // The start day may be in the next month near a month boundary.
    if (startDay.slice(0, 7) !== localDayKey(now, TZ).slice(0, 7)) {
      fireEvent.click(screen.getByLabelText('Next month'));
    }
    clickDay(startDay);

    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(sheet.textContent).toContain('ongoing'));
    // Never "-1h" style nonsense; the duration is an em dash.
    expect(within(sheet).getByText('—')).toBeTruthy();
    expect(within(sheet).queryByText(/^-\d/)).toBeNull();
    // An ongoing attack has no end, so it can never be "end before start".
    expect(within(sheet).queryByText('End is before start')).toBeNull();
  });

  it('keeps elapsed-so-far for a valid ongoing attack', async () => {
    const now = Date.now();
    const startMs = now - 2 * 60 * 60 * 1000;
    seedState({
      timezone: TZ,
      attacks: [makeTimedAttack('running-ongoing', startMs, null)],
    });

    mountCalendar();
    await waitForSync();

    clickDay(localDayKey(now, TZ));
    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(sheet.textContent).toContain('ongoing'));
    expect(within(sheet).getByText('2h')).toBeTruthy();
  });
});

describe('CalendarPage multi-day attacks across DST', () => {
  const TZ = 'America/New_York';

  it('keeps every configured-zone day of a DST-crossing attack and matches monthStats', async () => {
    const startMs = zonedDateTimeToMs('2026-03-07', '23:30', TZ);
    const endMs = zonedDateTimeToMs('2026-03-09', '01:00', TZ);
    seedState({
      timezone: TZ,
      attacks: [{ ...makeTimedAttack('dst-attack', startMs, endMs), symptoms: ['nausea'] }],
    });

    mountCalendar();
    await waitForSync();

    goToMonth('2026-03', TZ);
    await waitFor(() => {
      expect(document.querySelector('[data-day="2026-03-07"]')).not.toBeNull();
    });

    // Spring-forward loses an hour, but the attack still covers Mar 7, 8, and
    // 9. The header's monthStats and the per-day grid must agree.
    await waitFor(() => {
      expect(monthHeaderText()).toBe('3 attack days of 31 · 1 attack');
    });

    for (const day of ['2026-03-07', '2026-03-08', '2026-03-09']) {
      clickDay(day);
      const sheet = await screen.findByRole('dialog');
      await waitFor(() => expect(within(sheet).getByText('nausea')).toBeTruthy());
    }

    // 23:30 Mar 7 EST to 01:00 Mar 9 EDT is 24h30m elapsed (25h30m on the
    // wall clock): the DST transition must not inflate the duration.
    expect(within(await screen.findByRole('dialog')).getByText('24h 30m')).toBeTruthy();

    // The day before the interval and the day after it have no attack.
    clickDay('2026-03-06');
    await waitFor(() => expect(screen.getByText(/Nothing logged this day/)).toBeTruthy());
    clickDay('2026-03-10');
    await waitFor(() => expect(screen.getByText(/Nothing logged this day/)).toBeTruthy());
  });
});

describe('CalendarPage degenerate attacks', () => {
  const TZ = 'UTC';

  it('keeps an end-before-start attack on its start day with a warning and no negative duration', async () => {
    const day = midMonthDay(TZ);
    const previousDay = day.slice(0, 8) + String(Number(day.slice(8, 10)) - 1).padStart(2, '0');
    const startMs = dayKeyStartMs(day, TZ) + 10 * 60 * 60 * 1000;
    const endMs = dayKeyStartMs(previousDay, TZ) + 10 * 60 * 60 * 1000;
    seedState({
      timezone: TZ,
      attacks: [makeTimedAttack('bad-attack', startMs, endMs)],
    });

    mountCalendar();
    await waitForSync();

    // The month header counts it once: 1 attack day, 1 attack.
    await waitFor(() => {
      expect(monthHeaderText()).toBe(`1 attack day of ${daysInMonthOf(day)} · 1 attack`);
    });

    clickDay(day);
    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(within(sheet).getByText('End is before start')).toBeTruthy());
    // No confusing negative duration ("-1d 0h"); the duration is an em dash.
    expect(within(sheet).getByText('—')).toBeTruthy();
    expect(within(sheet).queryByText(/^-/)).toBeNull();
    expect(screen.getByRole('heading', { name: formatDayTitle(day, TZ) })).toBeTruthy();
  });

  it('counts a zero-duration attack at exactly local midnight as one attack day', async () => {
    const day = midMonthDay(TZ);
    const midnight = dayKeyStartMs(day, TZ);
    seedState({
      timezone: TZ,
      attacks: [makeTimedAttack('zero-attack', midnight, midnight)],
    });

    mountCalendar();
    await waitForSync();

    await waitFor(() => {
      expect(monthHeaderText()).toBe(`1 attack day of ${daysInMonthOf(day)} · 1 attack`);
    });

    clickDay(day);
    const sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(within(sheet).getByText('0m')).toBeTruthy());
    expect(within(sheet).queryByText('End is before start')).toBeNull();
  });
});

describe('CalendarPage accessible day cells', () => {
  const TZ = 'UTC';

  it('keeps the date and adds concise attack and medication counts', async () => {
    const day = midMonthDay(TZ);
    const otherDay = `${day.slice(0, 8)}16`;
    const startMs = dayKeyStartMs(day, TZ) + 8 * 60 * 60 * 1000;
    seedState({
      timezone: TZ,
      attacks: [makeTimedAttack('label-attack', startMs, startMs + 60 * 60 * 1000)],
      meds: [{
        id: 'label-med', medId: 'tylenol', ts: new Date(startMs).toISOString(),
        dose: '', quantity: null, attackId: null, notes: '', source: 'manual',
      }],
    });

    mountCalendar();
    await waitForSync();

    expect(screen.getByRole('heading', { level: 1, name: 'Calendar' })).toBeTruthy();
    const cell = document.querySelector<HTMLButtonElement>(`[data-day="${day}"]`);
    if (!cell) throw new Error(`calendar cell not found for ${day}`);
    const label = cell.getAttribute('aria-label') ?? '';
    // The configured-zone date still leads the name, so the existing
    // date-based lookup semantics are preserved...
    expect(label).toContain(formatDayTitle(day, TZ));
    // ...and the visual chips' information is now available to screen readers.
    expect(label).toContain('1 attack');
    expect(label).toContain('1 medication');

    const empty = document.querySelector<HTMLButtonElement>(`[data-day="${otherDay}"]`);
    expect(empty?.getAttribute('aria-label')).toContain('no attacks or medications');
  });

  it('associates the schedule-date label with its date input', async () => {
    seedState({ timezone: TZ });
    mountCalendar();
    await waitForSync();

    fireEvent.click(screen.getByRole('button', { name: 'Schedule next Emgality' }));
    const dateInput = await screen.findByLabelText('Date');
    expect((dateInput as HTMLInputElement).type).toBe('date');
  });
});

describe('CalendarPage decision cards and aggregate painkillers', () => {
  const TZ = 'UTC';

  function med(id: string, medId: string, ts: string): MedEvent {
    return {
      id, medId, ts, dose: '', quantity: null, attackId: null, notes: '', source: 'manual',
    };
  }

  /** Nurtec + Painkillers cards, exactly two in one row, below the grid. */
  function renderWithCards(): { nurtec: HTMLElement; painkillers: HTMLElement } {
    const nurtec = screen.getByTitle(/^Nurtec:/);
    const painkillers = screen.getByTitle(/^Painkillers/);
    const grid = document.querySelector('[data-day]') as HTMLElement;
    // Both cards follow the month grid...
    expect(grid.compareDocumentPosition(nurtec) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(grid.compareDocumentPosition(painkillers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // ...and stay above the preventive schedule.
    const schedule = screen.getByRole('heading', { name: 'Preventive schedule' });
    expect(nurtec.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(painkillers.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One row at every width: a two-column grid with no responsive stacking.
    const row = nurtec.parentElement as HTMLElement;
    expect(row.className).toContain('grid-cols-2');
    expect(row.contains(painkillers)).toBe(true);
    return { nurtec, painkillers };
  }

  it('keeps both cards below the grid and promotes them during an attack', async () => {
    seedState({ timezone: TZ });
    mountCalendar();
    await waitForSync();

    let cards = renderWithCards();
    expect(cards.nurtec.className).not.toContain('ring-attack-border');

    cleanup();
    const now = Date.now();
    seedState({
      timezone: TZ,
      attacks: [makeTimedAttack('active', now - 60 * 60 * 1000, null)],
    });
    mountCalendar();
    await waitForSync();

    cards = renderWithCards();
    expect(cards.nurtec.className).toContain('ring-attack-border');
    expect(cards.painkillers.className).toContain('ring-attack-border');
  });

  it('counts one MoH day for different painkillers taken on the same day', async () => {
    const day = midMonthDay(TZ);
    const nextDay = day.slice(0, 8) + String(Number(day.slice(8, 10)) + 1).padStart(2, '0');
    const at = (key: string, hour: number) =>
      new Date(dayKeyStartMs(key, TZ) + hour * 60 * 60 * 1000).toISOString();
    seedState({
      timezone: TZ,
      meds: [
        med('t1', 'tylenol', at(day, 8)),
        med('i1', 'ibuprofen', at(day, 12)),
        med('n1', 'naproxen', at(nextDay, 9)),
      ],
    });

    mountCalendar();
    await waitForSync();
    const { painkillers } = renderWithCards();

    // Two dates, three different meds and three doses: TWO medication days.
    expect(painkillers.textContent).toContain('2');
    expect(painkillers.textContent).toContain('/ 15 days');
    // The compact detail names which painkillers contributed.
    expect(painkillers.textContent).toContain('Tylenol');
    expect(painkillers.title).toContain('2 of 15 allowed days');
  });

  it('resolves mismatched painkiller rules conservatively and explains it', async () => {
    seedState({
      timezone: TZ,
      rules: {
        tylenol: { limit: 8, windowDays: 30 },
        ibuprofen: { limit: 15, windowDays: 45 },
        naproxen: { limit: 10, windowDays: 30 },
      },
    });

    mountCalendar();
    await waitForSync();
    const { painkillers } = renderWithCards();

    // Lowest limit, widest window.
    expect(painkillers.textContent).toContain('/ 8 days');
    expect(screen.getByText(/lowest limit \(8\)/)).toBeTruthy();
    expect(screen.getByText(/widest window/)).toBeTruthy();
    expect(screen.queryByText(/NaN|undefined/)).toBeNull();
  });

  it('never drops a preventive chip when the day cell truncates acute chips', async () => {
    const day = midMonthDay(TZ);
    const at = new Date(dayKeyStartMs(day, TZ) + 9 * 60 * 60 * 1000).toISOString();
    seedState({
      timezone: TZ,
      meds: [
        med('p1', 'emgality', at),
        med('t1', 'tylenol', at),
        med('t2', 'tylenol', at),
        med('t3', 'tylenol', at),
        med('t4', 'tylenol', at),
        med('t5', 'tylenol', at),
      ],
    });

    mountCalendar();
    await waitForSync();

    const cell = document.querySelector<HTMLElement>(`[data-day="${day}"]`);
    if (!cell) throw new Error('day cell missing');
    // The preventive dose is pinned first. The +n indicator shares the four-slot
    // budget: one preventive + two acute + "+3" = exactly two grid rows.
    expect(cell.querySelector('[title="Emgality"]')).toBeTruthy();
    expect(cell.querySelectorAll('[title="Tylenol"]')).toHaveLength(2);
    expect(cell.textContent).toContain('+3');
    const chipGrid = cell.querySelector<HTMLElement>('[data-med-chip-grid]');
    expect(chipGrid?.className).toContain('grid-cols-2');
    expect(chipGrid?.children).toHaveLength(4);
    // Accessible name carries the preventive information too.
    expect(cell.getAttribute('aria-label')).toContain('preventive: Emgality');
  });

  it('summarises the full decision-card state for assistive tech', async () => {
    seedState({ timezone: TZ, rules: { nurtec: { limit: 2, windowDays: 30 } } });
    mountCalendar();
    await waitForSync();

    const nurtec = screen.getByRole('group', {
      name: /^Nurtec: 0 of 2 allowed days in the last 30 days, within limit$/,
    });
    expect(nurtec).toBeTruthy();
    expect(screen.getByRole('group', {
      name: /^Painkillers: 0 of 15 allowed days in the last 30 days, within limit$/,
    })).toBeTruthy();

    // A low but UNUSED limit must not warn anywhere.
    expect(screen.queryByText('watch your intake')).toBeNull();

    cleanup();
    seedState({
      timezone: TZ,
      rules: { nurtec: { limit: 2, windowDays: 30 } },
      meds: [med('low-limit-dose', 'nurtec', new Date().toISOString())],
    });
    mountCalendar();
    await waitForSync();

    // Reaching the limit is "near", not over.
    expect(screen.getByRole('group', {
      name: /^Nurtec: 1 of 2 allowed days in the last 30 days, near limit$/,
    })).toBeTruthy();
    expect(screen.getByText('watch your intake')).toBeTruthy();
  });

  it('marks an ongoing attack without motion and states it in the day name', async () => {
    const now = Date.now();
    const startMs = now - 60 * 60 * 1000;
    seedState({
      timezone: TZ,
      attacks: [makeTimedAttack('ongoing-cue', startMs, null)],
    });
    mountCalendar();
    await waitForSync();

    const cell = document.querySelector<HTMLElement>(`[data-day="${localDayKey(startMs, TZ)}"]`);
    if (!cell) throw new Error('day cell missing');
    expect(cell.getAttribute('aria-label')).toContain('attack ongoing');

    // The bar itself is static but visually distinct (inset ring, no pulse).
    const bar = document.querySelector<HTMLElement>('[title*="— ongoing"]');
    expect(bar).toBeTruthy();
    expect(bar!.className).toContain('ring-2');
    expect(bar!.className).not.toContain('animate-pulse');
  });

  it('tells the read-only viewer who can change mismatched rules', () => {
    // The partner has no Settings route, so its copy must not direct the reader
    // there; the writer copy keeps the action.
    const rule = { limit: 8, windowDays: 45 };
    const writer = painkillerMismatchNote(false, rule);
    const partner = painkillerMismatchNote(true, rule);

    expect(writer).toContain('lowest limit (8)');
    expect(writer).toContain('widest window (45d)');
    expect(writer).toContain('until you save one shared rule in Settings.');

    expect(partner).toContain('This read-only view cannot change it');
    expect(partner).toContain('the writer app');
    expect(partner).not.toContain('until you save');
    expect(partner).toContain('lowest limit (8)');
  });

  it('renders the preventive schedule below the month grid and medication limits', async () => {
    seedState({ timezone: TZ });
    mountCalendar();
    await waitForSync();

    const grid = document.querySelector('[data-day]') as HTMLElement;
    const painkillers = screen.getByTitle(/^Painkillers/);
    const schedule = screen.getByRole('button', { name: 'Schedule next Emgality' });
    // Newest decision: grid -> medication limits -> preventive schedule.
    expect(grid.compareDocumentPosition(painkillers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(painkillers.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('CalendarPage zero-limit decision card', () => {
  const TZ = 'UTC';

  function cardBar(card: HTMLElement): HTMLElement {
    const bar = card.querySelector('[data-decision-bar]');
    if (!bar) throw new Error('decision bar missing');
    return bar as HTMLElement;
  }

  it('shows an empty bar for an unused zero limit and a full bar once used', async () => {
    seedState({ timezone: TZ, rules: { nurtec: { limit: 0, windowDays: 30 } } });
    mountCalendar();
    await waitForSync();

    const unused = screen.getByTitle(/^Nurtec:/);
    expect(cardBar(unused).style.width).toBe('0%');
    // 0 used with a 0 limit is not "over": over means used > limit.
    expect(unused.textContent).not.toContain('over limit');

    cleanup();
    seedState({
      timezone: TZ,
      rules: { nurtec: { limit: 0, windowDays: 30 } },
      meds: [{
        id: 'zero-limit-dose',
        medId: 'nurtec',
        ts: new Date().toISOString(),
        dose: '75 mg',
        quantity: 1,
        attackId: null,
        notes: '',
        source: 'manual',
      }],
    });
    mountCalendar();
    await waitForSync();

    const used = screen.getByTitle(/^Nurtec:/);
    expect(cardBar(used).style.width).toBe('100%');
    expect(used.textContent).toContain('over limit');
  });
});
