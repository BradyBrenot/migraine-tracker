// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type { Attack, DayState, MedEvent, Refill, StockBaseline, TrackerState, Workout } from '@/types';
import { DEFAULT_REMINDER_SETTINGS } from '../../shared/reminders.ts';

/** Fixed reference instant: October 2026, so the default month is stable. */
const NOW = Date.UTC(2026, 9, 27, 12);

vi.mock('@/lib/clock', () => ({
  useNow: () => NOW,
  bumpClock: vi.fn(),
}));

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
type ReportsModule = typeof import('@/pages/Reports');

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

const STORAGE_KEY = 'migraine-tracker-v1';

let api: MockedBackend;
let storeModule: StoreModule;
let reportsModule: ReportsModule;
let captured: StoreApi | null = null;

function Probe() {
  captured = storeModule.useStore();
  return null;
}

function mountReports(): void {
  const Reports = reportsModule.default;
  render(
    <storeModule.StoreProvider>
      <Reports />
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
    meds: [] as MedEvent[],
    refills: [] as Refill[],
    workouts: [] as Workout[],
    dayStates: [] as DayState[],
    stockBaselines: [] as StockBaseline[],
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

function makeAttack(partial: Partial<Attack> & { id: string; start: string }): Attack {
  return {
    end: null,
    painLog: [],
    peakPain: 5,
    symptoms: [],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
    ...partial,
  };
}

function makeMed(partial: Partial<MedEvent> & { id: string; ts: string }): MedEvent {
  return {
    medId: 'nurtec',
    attackId: null,
    notes: '',
    source: 'manual',
    ...partial,
  };
}

/** The stat card whose label is `label` (card = label's parent element). */
function statCard(label: string): HTMLElement {
  return screen.getByText(label).parentElement as HTMLElement;
}

/** Inline width of the medication-days bar row for a "<n> days · <n> doses" label. */
function medUsageBarWidth(label: string): string {
  const labelEl = screen.getByText(label);
  const row = labelEl.parentElement?.parentElement;
  const bar = row?.lastElementChild?.firstElementChild as HTMLElement | null | undefined;
  return bar?.style.width ?? '';
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;
  // Recharts' ResponsiveContainer needs ResizeObserver, absent in jsdom.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  reportsModule = await import('@/pages/Reports');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('Reports selected-month cards', () => {
  it('shows unknown rather than a known zero for a month with no records', async () => {
    // Only September has data; the default October view is unknown.
    seedState({
      attacks: [makeAttack({
        id: 'september',
        start: '2026-09-10T08:00:00.000Z',
        end: '2026-09-10T10:00:00.000Z',
      })],
    });

    mountReports();
    await waitForSync();

    expect(screen.getByRole('heading', { level: 1, name: 'Reports' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('no data this month')).toHaveLength(2));
    expect(statCard('Attacks').textContent).toContain('—');
    expect(statCard('Days affected').textContent).toContain('—');
    // Not a confirmed clear month.
    expect(statCard('Attacks').textContent).not.toMatch(/Attacks0/);
  });

  it('treats a medication-only month as known data with real zero attack days', async () => {
    seedState({
      meds: [makeMed({ id: 'med-1', ts: '2026-10-05T08:00:00.000Z' })],
    });

    mountReports();
    await waitForSync();

    await waitFor(() => expect(screen.queryAllByText('no data this month')).toHaveLength(0));
    expect(statCard('Attacks').textContent).toContain('Attacks0');
    expect(statCard('Days affected').textContent).toContain('Days affected0');
  });

  it('counts 0/-1 attacks and averages only reported pain (0,4,-1 => 2.0)', async () => {
    seedState({
      attacks: [
        makeAttack({
          id: 'zero-pain',
          start: '2026-10-05T08:00:00.000Z',
          end: '2026-10-05T09:00:00.000Z',
          peakPain: 0,
        }),
        makeAttack({
          id: 'four-pain',
          start: '2026-10-07T08:00:00.000Z',
          end: '2026-10-07T09:00:00.000Z',
          peakPain: 4,
        }),
        makeAttack({
          id: 'unreported-pain',
          start: '2026-10-09T08:00:00.000Z',
          end: '2026-10-09T09:00:00.000Z',
          peakPain: -1,
        }),
      ],
    });

    mountReports();
    await waitForSync();

    await waitFor(() => expect(screen.getByText('out of 10')).toBeTruthy());
    // The -1 attack still counts as an attack and a day...
    expect(statCard('Attacks').textContent).toContain('Attacks3');
    expect(statCard('Days affected').textContent).toContain('Days affected3');
    // ...but is excluded from the denominator: (0 + 4) / 2 = 2.0, not 1.3.
    expect(statCard('Avg peak pain').textContent).toContain('2.0');
  });

  it('aggregates selected-month med days per med and scales bars to the busiest med', async () => {
    seedState({
      meds: [
        // Two Nurtec doses on one day plus one on another: 2 distinct days.
        makeMed({ id: 'nurtec-1', ts: '2026-10-05T08:00:00.000Z' }),
        makeMed({ id: 'nurtec-2', ts: '2026-10-05T18:00:00.000Z' }),
        makeMed({ id: 'nurtec-3', ts: '2026-10-07T08:00:00.000Z' }),
        makeMed({ id: 'tylenol-1', medId: 'tylenol', ts: '2026-10-06T08:00:00.000Z' }),
        // Unparseable legacy timestamps never create a usage row.
        makeMed({ id: 'bad', medId: 'ibuprofen', ts: 'not-a-date' }),
      ],
    });

    mountReports();
    await waitForSync();

    await waitFor(() => expect(screen.getByText('2 days · 3 doses')).toBeTruthy());
    expect(screen.getByText('1 day · 1 dose')).toBeTruthy();

    const medSection = screen.getByText('Medication days').closest('section');
    if (!medSection) throw new Error('medication days section not found');
    expect(within(medSection).queryByText('Ibuprofen')).toBeNull();

    // Nurtec has the most distinct days this month: full width; Tylenol 1/2.
    expect(medUsageBarWidth('2 days · 3 doses')).toBe('100%');
    expect(medUsageBarWidth('1 day · 1 dose')).toBe('50%');
  });
});

describe('Reports rolling medication window', () => {
  it('labels the rolling parenthetical with the configured window, not a hardcoded 30d', async () => {
    seedState({
      rules: { nurtec: { limit: 4, windowDays: 7 } },
      meds: [
        makeMed({ id: 'nurtec-yesterday', ts: '2026-10-26T08:00:00.000Z' }),
        makeMed({ id: 'nurtec-today', ts: '2026-10-27T08:00:00.000Z' }),
      ],
    });

    mountReports();
    await waitForSync();

    await waitFor(() => expect(screen.getByText('(2/4 in 7d)')).toBeTruthy());
    expect(screen.queryByText(/in 30d/)).toBeNull();

    // The span selector is a pressed-state group, not a tablist.
    expect(screen.getByRole('button', { name: '12mo' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '3mo' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('resolves a malformed legacy rule to the catalog window instead of NaN', async () => {
    seedState({
      // Legacy/imported shape with no windowDays.
      rules: { nurtec: { limit: 15 } } as unknown as TrackerState['rules'],
      meds: [makeMed({ id: 'nurtec-1', ts: '2026-10-27T08:00:00.000Z' })],
    });

    mountReports();
    await waitForSync();

    await waitFor(() => expect(screen.getByText('1 day · 1 dose')).toBeTruthy());
    expect(screen.queryByText(/NaN|undefinedd/)).toBeNull();
    // The missing window falls back per field to the 30-day default rather than
    // dropping the rolling count (or rendering "undefinedd").
    expect(screen.getByText('(1/15 in 30d)')).toBeTruthy();
  });

  it('renders a zero limit as an over-limit count instead of dropping it', async () => {
    // Shared backup validation allows a nonnegative limit; 0 means any use is
    // already over the limit, so the parenthetical must render and be styled.
    seedState({
      rules: { nurtec: { limit: 0, windowDays: 30 } },
      meds: [makeMed({ id: 'nurtec-zero', ts: '2026-10-27T08:00:00.000Z' })],
    });

    mountReports();
    await waitForSync();

    const count = await screen.findByText('(1/0 in 30d)');
    expect(count.className).toContain('text-red-400');
  });

  it('keeps the compact export toolbar in the monthly summary header, separate from the charts', async () => {
    seedState({});
    mountReports();
    await waitForSync();

    const group = screen.getByRole('group', { name: 'Report range' });
    expect(group).toBeTruthy();
    expect(within(group).getByRole('button', { name: '12mo' })).toBeTruthy();

    // The download is a compact, borderless toolbar in the Monthly summary
    // header area (Markdown is obvious from the visible label), not its own box.
    const download = screen.getByRole('button', { name: 'Download .md report' });
    expect(download.textContent).toContain('Download .md');
    expect(screen.queryByRole('heading', { name: 'Report download' })).toBeNull();

    // Range + download share one labelled export group (semantics, not a box).
    const toolbar = screen.getByRole('group', { name: 'Report download' });
    expect(toolbar.contains(group)).toBe(true);
    expect(toolbar.contains(download)).toBe(true);
    // The group stays one visual unit but may wrap at narrow widths/zoom.
    expect(toolbar.className).toContain('flex-wrap');
    // Touch floor on every control while the group stays visually compact.
    expect(screen.getByRole('button', { name: '12mo' }).className).toContain('min-h-10');
    expect(screen.getByRole('button', { name: '12mo' }).className).toContain('min-w-10');
    expect(download.className).toContain('h-10');

    const monthly = screen.getByRole('heading', { name: 'Monthly summary' });
    expect(monthly.closest('section')!.contains(group)).toBe(true);
    expect(monthly.closest('section')!.contains(download)).toBe(true);
    // Range + download share one compact group above month navigation and stats.
    expect(group.parentElement).toBe(download.parentElement);
    const previousMonth = screen.getByRole('button', { name: 'Previous month' });
    expect(
      Boolean(download.compareDocumentPosition(previousMonth) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(
        download.compareDocumentPosition(statCard('Attacks')) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    // The month section is a historical summary, not "this month".
    expect(screen.queryByRole('heading', { name: 'This month' })).toBeNull();
    expect(screen.getByRole('heading', { name: '12-month trends' })).toBeTruthy();
    // Triggers/symptoms are scoped to the monthly summary, above the trends.
    const trends = screen.getByRole('heading', { name: '12-month trends' });
    const triggers = screen.getByRole('heading', { name: 'Top triggers' });
    const symptoms = screen.getByRole('heading', { name: 'Top symptoms' });
    expect(monthly.closest('section')!.contains(triggers)).toBe(true);
    expect(monthly.closest('section')!.contains(symptoms)).toBe(true);
    expect(
      Boolean(triggers.compareDocumentPosition(trends) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(symptoms.compareDocumentPosition(trends) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    // Preventive scheduling lives on Calendar only; the duplicate panel is gone.
    expect(screen.queryByText('Preventive timing')).toBeNull();
    // The charts have their own fixed captions and live outside the group.
    expect(screen.getByText(/Always the last 12 months/)).toBeTruthy();
    expect(
      within(group).queryByText('Attack days per month'),
    ).toBeNull();
  });
});

describe('Reports combined painkiller MOH summary', () => {
  it('shows one aggregate count instead of three per-med rolling numbers', async () => {
    seedState({
      meds: [
        makeMed({ id: 'tylenol-1', medId: 'tylenol', ts: '2026-10-05T08:00:00.000Z' }),
        makeMed({ id: 'ibuprofen-1', medId: 'ibuprofen', ts: '2026-10-05T12:00:00.000Z' }),
        makeMed({ id: 'naproxen-1', medId: 'naproxen', ts: '2026-10-07T09:00:00.000Z' }),
      ],
    });

    mountReports();
    await waitForSync();

    // Same-day Tylenol + Ibuprofen are ONE day; plus Naproxen on another day.
    await waitFor(() => expect(screen.getByText('Painkillers combined')).toBeTruthy());
    expect(screen.getByText('2 / 15 days in the last 30 days')).toBeTruthy();
    // The aggregate state is a labelled group, not just a truncated sentence.
    expect(screen.getByRole('group', {
      name: 'Painkillers medication-overuse summary',
    })).toBeTruthy();

    // Each med keeps its own monthly day/dose row.
    expect(screen.getAllByText(/1 day · 1 dose/)).toHaveLength(3);

    // No misleading per-med rolling counts for the shared-limit painkillers.
    expect(screen.queryByText(/\(\d+\/\d+ in \d+d\)/)).toBeNull();
  });

  it('keeps the individual rolling parenthetical for Nurtec only', async () => {
    seedState({
      rules: { nurtec: { limit: 4, windowDays: 7 } },
      meds: [makeMed({ id: 'nurtec-1', ts: '2026-10-27T08:00:00.000Z' })],
    });

    mountReports();
    await waitForSync();

    expect(await screen.findByText('(1/4 in 7d)')).toBeTruthy();
    expect(screen.queryByText('Painkillers combined')).toBeNull();
  });

  it('resolves mismatched and partial painkiller rules without NaN', async () => {
    seedState({
      rules: {
        tylenol: { limit: 8, windowDays: 30 },
        ibuprofen: { limit: 15, windowDays: 45 },
        naproxen: { limit: 10, windowDays: 30 },
      },
      meds: [makeMed({ id: 'tylenol-1', medId: 'tylenol', ts: '2026-10-05T08:00:00.000Z' })],
    });

    mountReports();
    await waitForSync();

    // Lowest limit (8) + widest window (45) resolve the shared summary.
    expect(await screen.findByText('1 / 8 days in the last 45 days')).toBeTruthy();
    expect(screen.getByText(/Saved painkiller rules differ/)).toBeTruthy();
    expect(screen.queryByText(/NaN|undefined/)).toBeNull();
  });
});

describe('Reports near-limit semantics', () => {
  it('treats reaching the Nurtec limit as near, not over', async () => {
    seedState({
      rules: { nurtec: { limit: 2, windowDays: 30 } },
      meds: [
        makeMed({ id: 'nurtec-a', ts: '2026-10-20T08:00:00.000Z' }),
        makeMed({ id: 'nurtec-b', ts: '2026-10-21T08:00:00.000Z' }),
      ],
    });

    mountReports();
    await waitForSync();

    const count = await screen.findByText('(2/2 in 30d)');
    expect(count.className).toContain('text-amber-300');
    expect(count.className).not.toContain('text-red-400');
  });

  it('does not warn on an unused low shared limit, then warns near once used', async () => {
    const rule = { limit: 2, windowDays: 30 };
    // No painkiller events at all: no aggregate block, no warning.
    seedState({ rules: { tylenol: rule, ibuprofen: rule, naproxen: rule } });
    mountReports();
    await waitForSync();
    expect(screen.queryByRole('group', {
      name: 'Painkillers medication-overuse summary',
    })).toBeNull();
    expect(screen.queryByText(/0 \/ 2 days/)).toBeNull();

    cleanup();
    seedState({
      rules: { tylenol: rule, ibuprofen: rule, naproxen: rule },
      meds: [makeMed({ id: 'pk-1', medId: 'tylenol', ts: '2026-10-20T08:00:00.000Z' })],
    });
    mountReports();
    await waitForSync();

    const summary = await screen.findByText('1 / 2 days in the last 30 days');
    expect(summary.className).toContain('text-amber-300');
    expect(summary.className).not.toContain('text-red-400');
    expect(screen.queryByText(/NaN|undefined/)).toBeNull();
  });

  it('flags over only past the limit', async () => {
    const rule = { limit: 2, windowDays: 30 };
    seedState({
      rules: { tylenol: rule, ibuprofen: rule, naproxen: rule },
      meds: [
        makeMed({ id: 'pk-1', medId: 'tylenol', ts: '2026-10-19T08:00:00.000Z' }),
        makeMed({ id: 'pk-2', medId: 'ibuprofen', ts: '2026-10-20T08:00:00.000Z' }),
        makeMed({ id: 'pk-3', medId: 'naproxen', ts: '2026-10-21T08:00:00.000Z' }),
      ],
    });

    mountReports();
    await waitForSync();

    const summary = await screen.findByText('3 / 2 days in the last 30 days');
    expect(summary.className).toContain('text-red-400');
  });
});
