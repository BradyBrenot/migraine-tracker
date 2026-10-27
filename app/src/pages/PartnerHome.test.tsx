// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { StoreApi } from '@/lib/store';
import type {
  Attack, DayState, MedEvent, Refill, StockBaseline, Workout,
} from '@/types';
import { fmtTime } from '@/lib/format';
import { localDayKey } from '../../shared/datetime.ts';

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
type PartnerHomeModule = typeof import('@/pages/PartnerHome');

interface MockedBackend {
  exportAll: Mock;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const TZ = 'UTC';

let api: MockedBackend;
let storeModule: StoreModule;
let partnerHomeModule: PartnerHomeModule;
let captured: StoreApi | null = null;

function Probe() {
  captured = storeModule.useStore();
  return null;
}

function mountHome() {
  const PartnerHome = partnerHomeModule.default;
  return render(
    <storeModule.ReadOnlyStoreProvider>
      <PartnerHome />
      <Probe />
    </storeModule.ReadOnlyStoreProvider>,
  );
}

async function waitForSync(): Promise<void> {
  await waitFor(() => {
    expect(captured).not.toBeNull();
    expect(captured!.sync.status).toBe('synced');
  });
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

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function makeAttack(overrides: Partial<Attack> = {}): Attack {
  return {
    id: 'attack-1',
    start: at(-2 * 60 * 60 * 1000),
    end: null,
    painLog: [],
    peakPain: 5,
    symptoms: [],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
    ...overrides,
  };
}

function makeMed(overrides: Partial<MedEvent> = {}): MedEvent {
  return {
    id: 'med-1',
    medId: 'nurtec',
    ts: at(-60 * 60 * 1000),
    dose: '75 mg',
    quantity: 1,
    attackId: null,
    notes: '',
    source: 'manual',
    ...overrides,
  };
}

function emptyExport() {
  return {
    attacks: [] as Attack[],
    meds: [] as MedEvent[],
    refills: [] as Refill[],
    workouts: [] as Workout[],
    dayStates: [] as DayState[],
    stockBaselines: [] as StockBaseline[],
    settings: { timezone: TZ, lowStockThreshold: 2 } as Record<string, unknown>,
  };
}

function applyApiDefaults(backend: MockedBackend): void {
  backend.exportAll.mockResolvedValue(emptyExport());
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  captured = null;

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  applyApiDefaults(api);
  partnerHomeModule = await import('@/pages/PartnerHome');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  captured = null;
});

describe('PartnerHome (read-only Now)', () => {
  it('renders an active attack with duration and 0/10 pain without mutation controls', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack({
        peakPain: 0,
        painLog: [{ ts: at(-30 * 60 * 1000), level: 0 }],
      })],
    });

    mountHome();
    await waitForSync();

    expect(screen.getByText('Attack in progress')).toBeTruthy();
    expect(screen.getByText('2h')).toBeTruthy();
    expect(screen.getByText(/started/)).toBeTruthy();
    expect(screen.getByText(/Peak/)).toBeTruthy();
    expect(screen.getAllByText('0/10').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('No active attack')).toBeNull();
    // The viewer page exposes no mutation buttons or dialogs at all.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('never treats an ended attack as active', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack({
        start: at(-3 * 60 * 60 * 1000),
        end: at(-60 * 60 * 1000),
        peakPain: 6,
      })],
    });

    mountHome();
    await waitForSync();

    expect(screen.getByText('No active attack')).toBeTruthy();
    expect(screen.queryByText('Attack in progress')).toBeNull();
    expect(screen.getByText(/Last attack ended/)).toBeTruthy();
    // The ended attack still makes today an Off day (inferred, no record).
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.queryByText('Well')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows Attack while an attack is active even over an explicit Well record', async () => {
    const today = localDayKey(NOW, TZ);
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack()],
      dayStates: [{ day: today, status: 'well', notes: '', updatedAt: at(-4 * 60 * 60 * 1000) }],
    });

    mountHome();
    await waitForSync();

    expect(screen.getByText('Attack in progress')).toBeTruthy();
    // Explicit record exists, so the plain label is used — never Well.
    expect(screen.getByText('Attack')).toBeTruthy();
    expect(screen.queryByText('Well')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it("shows today's day state, meds, workouts, and Nurtec stock/use", async () => {
    const today = localDayKey(NOW, TZ);
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      dayStates: [{ day: today, status: 'off', notes: '', updatedAt: at(-4 * 60 * 60 * 1000) }],
      meds: [{
        id: 'med-1', medId: 'nurtec', ts: at(-60 * 60 * 1000), dose: '75 mg',
        quantity: 1, attackId: null, notes: '', source: 'manual',
      }],
      workouts: [{
        id: 'workout-1', performedAt: at(-3 * 60 * 60 * 1000), kind: 'cardio',
        effort: 'hard', durationMinutes: 30, notes: '', source: 'manual',
      }],
      stockBaselines: [{
        id: 'baseline-1', medId: 'nurtec', effectiveAt: at(-5 * 24 * 60 * 60 * 1000),
        quantity: 8, notes: '', source: 'manual', createdAt: at(-5 * 24 * 60 * 60 * 1000),
      }],
    });

    mountHome();
    await waitForSync();

    expect(screen.getAllByText('Off').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Easy day — resting and taking it slow.')).toBeTruthy();
    expect(screen.getAllByText('Nurtec').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('75 mg')).toBeTruthy();
    expect(screen.getByText('1 tab')).toBeTruthy();
    expect(screen.getByText('Cardio · hard')).toBeTruthy();
    expect(screen.getByText('30m')).toBeTruthy();
    expect(screen.getByText('7 tablets')).toBeTruthy();
    expect(screen.getByText('1 / 15 days used in the last 30')).toBeTruthy();
    expect(screen.getByText(/Alert level: 2/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows the active attack instead of an explicit Well record in Today', async () => {
    const today = localDayKey(NOW, TZ);
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack()],
      dayStates: [{ day: today, status: 'well', notes: '', updatedAt: at(-4 * 60 * 60 * 1000) }],
    });

    mountHome();
    await waitForSync();

    expect(screen.getByText('Attack in progress')).toBeTruthy();
    // Today's status label follows the displayed Now state, not the Well record.
    expect(screen.getByText('Attack')).toBeTruthy();
    expect(screen.queryByText('Well')).toBeNull();
    expect(screen.queryByText('Normal routine today.')).toBeNull();
    // Once on the active-attack card, once in Today's guidance.
    expect(
      screen.getAllByText('Rest if you need to — recovery comes first.').length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('skips workouts with a malformed performedAt instead of crashing', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      workouts: [
        {
          id: 'workout-valid', performedAt: at(-3 * 60 * 60 * 1000), kind: 'cardio',
          effort: 'hard', durationMinutes: 30, notes: '', source: 'manual',
        },
        {
          id: 'workout-malformed', performedAt: 'not-a-date', kind: 'strength',
          effort: 'medium', durationMinutes: null, notes: '', source: 'manual',
        },
      ],
    });

    mountHome();
    await waitForSync();

    expect(screen.getByText('Cardio · hard')).toBeTruthy();
    expect(screen.queryByText('Strength · medium')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows loading and then unavailable messaging when the first snapshot fails', async () => {
    const pending = createDeferred<ReturnType<typeof emptyExport>>();
    api.exportAll.mockReturnValue(pending.promise);

    mountHome();
    expect(screen.getByText('Loading current status…')).toBeTruthy();

    await act(async () => {
      pending.reject(new Error('offline'));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText('Current status unavailable')).toBeTruthy());
    expect(screen.queryByText('No active attack')).toBeNull();
    expect(captured!.serverMode).toBe(false);
    expect(captured!.sync.status).toBe('error');
  });

  it('keeps showing the last snapshot with a stale banner after a failed refresh', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack()],
    });

    mountHome();
    await waitForSync();
    expect(screen.getByText('Attack in progress')).toBeTruthy();

    api.exportAll.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(captured!.sync.status).toBe('error'));

    expect(screen.getByText('Showing the last data received — reconnecting automatically.')).toBeTruthy();
    expect(screen.getByText('Attack in progress')).toBeTruthy();
    expect(screen.queryByText('Current status unavailable')).toBeNull();
  });

  it('shows medications linked to the active attack inside the attack card', async () => {
    const linkedTs = at(-30 * 60 * 1000);
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack()],
      meds: [
        makeMed({ id: 'med-linked', attackId: 'attack-1', ts: linkedTs }),
        makeMed({
          id: 'med-unlinked', medId: 'tylenol', attackId: null,
          ts: at(-45 * 60 * 1000), dose: '500 mg', quantity: 2,
        }),
      ],
    });

    mountHome();
    await waitForSync();

    const attackCard = screen.getByText('Attack in progress').closest('section') as HTMLElement;
    const inCard = within(attackCard);

    expect(inCard.getByText('Medications for this attack')).toBeTruthy();
    expect(inCard.getByText('Nurtec')).toBeTruthy();
    expect(inCard.getByText('75 mg')).toBeTruthy();
    expect(inCard.getByText('1 tab')).toBeTruthy();
    expect(inCard.getByText(fmtTime(linkedTs))).toBeTruthy();
    // Today's all-medications list is a separate section: unlinked meds never
    // appear inside the attack card.
    expect(inCard.queryByText('Tylenol')).toBeNull();
    expect(inCard.queryByText('500 mg')).toBeNull();
    expect(inCard.queryByText('2 tab')).toBeNull();
    expect(inCard.queryByText('No medication linked to this attack.')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows the attack-medication empty state without hiding unlinked meds today', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack()],
      meds: [makeMed({ id: 'med-unlinked', attackId: null })],
    });

    mountHome();
    await waitForSync();

    const attackCard = screen.getByText('Attack in progress').closest('section') as HTMLElement;
    expect(within(attackCard).getByText('No medication linked to this attack.')).toBeTruthy();
    expect(within(attackCard).queryByText('Nurtec')).toBeNull();

    // The same unlinked dose still renders under Today's Medications.
    const todaySection = screen.getByText('Today').closest('section') as HTMLElement;
    const inToday = within(todaySection);
    expect(inToday.getByText('Nurtec')).toBeTruthy();
    expect(inToday.getByText('75 mg')).toBeTruthy();
    expect(inToday.getByText('1 tab')).toBeTruthy();
  });

  it('lists attack-linked medications newest first', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack()],
      meds: [
        makeMed({
          id: 'med-old', medId: 'ibuprofen', attackId: 'attack-1',
          ts: at(-60 * 60 * 1000), dose: '200 mg',
        }),
        makeMed({
          id: 'med-new', medId: 'nurtec', attackId: 'attack-1',
          ts: at(-10 * 60 * 1000),
        }),
        makeMed({
          id: 'med-mid', medId: 'tylenol', attackId: 'attack-1',
          ts: at(-30 * 60 * 1000), dose: '500 mg',
        }),
      ],
    });

    mountHome();
    await waitForSync();

    const attackCard = screen.getByText('Attack in progress').closest('section') as HTMLElement;
    const rows = within(attackCard).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Nurtec');
    expect(rows[1].textContent).toContain('Tylenol');
    expect(rows[2].textContent).toContain('Ibuprofen');
  });

  it('keeps attack-linked meds with a malformed timestamp and shows an em dash', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack()],
      meds: [
        makeMed({
          id: 'med-bad', medId: 'tylenol', attackId: 'attack-1',
          ts: 'not-a-date', dose: '500 mg',
        }),
        makeMed({ id: 'med-good', attackId: 'attack-1', ts: at(-30 * 60 * 1000) }),
      ],
    });

    mountHome();
    await waitForSync();

    const attackCard = screen.getByText('Attack in progress').closest('section') as HTMLElement;
    const rows = within(attackCard).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // Malformed timestamps sort last and never reach fmtTime.
    expect(rows[0].textContent).toContain('Nurtec');
    expect(rows[1].textContent).toContain('Tylenol');
    expect(within(rows[1]).getByText('—')).toBeTruthy();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  it('renders 0/10 pain and attack-linked meds together', async () => {
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack({ peakPain: 0 })],
      meds: [makeMed({ id: 'med-linked', attackId: 'attack-1' })],
    });

    mountHome();
    await waitForSync();

    expect(screen.getAllByText('0/10').length).toBeGreaterThanOrEqual(1);
    const attackCard = screen.getByText('Attack in progress').closest('section') as HTMLElement;
    expect(within(attackCard).getByText('Nurtec')).toBeTruthy();
    expect(within(attackCard).getByText('75 mg')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps every meaningful secondary text style at slate-400 or stronger', async () => {
    // text-slate-500 / text-slate-600 fail contrast on this page's slate-900 and
    // slate-950 surfaces, so meaningful secondary text must be slate-400+.
    const assertReadable = (container: HTMLElement) => {
      expect(container.querySelector('.text-slate-500')).toBeNull();
      expect(container.querySelector('.text-slate-600')).toBeNull();
    };
    const today = localDayKey(NOW, TZ);

    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack()],
      dayStates: [{ day: today, status: 'off', notes: '', updatedAt: at(-4 * 60 * 60 * 1000) }],
      meds: [
        makeMed({ id: 'med-linked', attackId: 'attack-1' }),
        makeMed({ id: 'med-unlinked', attackId: null }),
      ],
      workouts: [{
        id: 'workout-1', performedAt: at(-3 * 60 * 60 * 1000), kind: 'cardio',
        effort: 'hard', durationMinutes: 30, notes: '', source: 'manual',
      }],
      stockBaselines: [{
        id: 'baseline-1', medId: 'nurtec', effectiveAt: at(-5 * 24 * 60 * 60 * 1000),
        quantity: 8, notes: '', source: 'manual', createdAt: at(-5 * 24 * 60 * 60 * 1000),
      }],
    });

    const active = mountHome();
    await waitForSync();
    assertReadable(active.container);
    cleanup();

    // Calm state covers "Last attack ended …" and the footer notice.
    captured = null;
    api.exportAll.mockResolvedValue({
      ...emptyExport(),
      attacks: [makeAttack({ start: at(-3 * 60 * 60 * 1000), end: at(-60 * 60 * 1000) })],
    });
    const calm = mountHome();
    await waitForSync();
    expect(screen.getByText(/Last attack ended/)).toBeTruthy();
    assertReadable(calm.container);
    cleanup();

    // Empty state covers the "Not logged" label and both empty-state lines.
    captured = null;
    api.exportAll.mockResolvedValue(emptyExport());
    const empty = mountHome();
    await waitForSync();
    expect(screen.getByText('Not logged')).toBeTruthy();
    expect(screen.getAllByText('None logged today.')).toHaveLength(2);
    assertReadable(empty.container);
  });
});
