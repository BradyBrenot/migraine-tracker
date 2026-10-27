// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type {
  Attack, DayState, MedEvent, Refill, StockBaseline, Workout,
} from '@/types';

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
type LayoutModule = typeof import('@/components/PartnerLayout');

interface MockedBackend {
  exportAll: Mock;
}

let api: MockedBackend;
let storeModule: StoreModule;
let layoutModule: LayoutModule;

function emptyExport() {
  return {
    attacks: [] as Attack[],
    meds: [] as MedEvent[],
    refills: [] as Refill[],
    workouts: [] as Workout[],
    dayStates: [] as DayState[],
    stockBaselines: [] as StockBaseline[],
    settings: {} as Record<string, unknown>,
  };
}

function renderLayout(): void {
  const PartnerLayout = layoutModule.default;
  render(
    <MemoryRouter initialEntries={['/view']}>
      <storeModule.ReadOnlyStoreProvider>
        <PartnerLayout />
      </storeModule.ReadOnlyStoreProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();

  api = (await import('@/lib/api')).api as unknown as MockedBackend;
  api.exportAll.mockResolvedValue(emptyExport());
  layoutModule = await import('@/components/PartnerLayout');
  storeModule = await import('@/lib/store');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('PartnerLayout', () => {
  it('shows the four viewer tabs, Read only, and no writer/settings affordances', async () => {
    renderLayout();
    await waitFor(() => expect(screen.getByText('Live')).toBeTruthy());

    // The header carries the current page, not brand text.
    expect(
      (document.querySelector('[data-testid="shell-title"]') as HTMLElement).textContent,
    ).toBe('Now');
    expect(screen.getByText('Partner view')).toBeTruthy();
    expect(screen.getByText('Read only')).toBeTruthy();

    for (const label of ['Now', 'Calendar', 'Reports', 'History']) {
      expect(screen.getAllByRole('link', { name: label })).toHaveLength(2);
    }

    const [desktopNow] = screen.getAllByRole('link', { name: 'Now' });
    expect(desktopNow.getAttribute('href')).toBe('/view');
    // The active tab is exposed to assistive tech, not only via colour.
    expect(desktopNow.getAttribute('aria-current')).toBe('page');

    // No Settings link and no writer sync pill / Toast surface.
    expect(screen.queryByRole('link', { name: /Settings/ })).toBeNull();
    expect(document.querySelector('a[href="/settings"]')).toBeNull();
    expect(screen.queryByText('Synced')).toBeNull();
    expect(document.querySelector('[data-sonner-toaster]')).toBeNull();

    const bottomNav = document.querySelector('nav.fixed');
    expect(bottomNav).not.toBeNull();
    const bottomGrid = bottomNav!.querySelector('div');
    expect(bottomGrid).not.toBeNull();
    expect(bottomGrid!.className).toContain('grid-cols-4');
    expect(within(bottomNav as HTMLElement).getAllByRole('link')).toHaveLength(4);
  });

  it('exposes a skip link, distinct nav landmarks, and lg breakpoints', async () => {
    renderLayout();
    await waitFor(() => expect(screen.getByText('Live')).toBeTruthy());

    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip.getAttribute('href')).toBe('#main-content');
    expect(document.querySelectorAll('a')[0]).toBe(skip);

    const main = document.querySelector('main');
    expect(main).not.toBeNull();
    expect(main!.id).toBe('main-content');
    expect(main!.getAttribute('tabindex')).toBe('-1');
    expect(main!.className).toContain('lg:pb-10');

    const desktop = screen.getByRole('navigation', { name: 'Partner primary' });
    expect(desktop.className).toContain('lg:flex');
    expect(desktop.className).not.toContain('md:flex');

    const mobile = screen.getByRole('navigation', { name: 'Partner mobile primary' });
    expect(mobile.className).toContain('lg:hidden');
    expect(mobile.className).not.toContain('md:hidden');
  });

  it('shows Unavailable before the first snapshot and Stale after a later failure', async () => {
    api.exportAll.mockRejectedValue(new Error('offline'));
    renderLayout();

    await waitFor(() => expect(screen.getByText('Unavailable')).toBeTruthy());
    expect(screen.queryByText('Live')).toBeNull();
    cleanup();

    api.exportAll.mockReset();
    api.exportAll.mockResolvedValue(emptyExport());
    renderLayout();
    await waitFor(() => expect(screen.getByText('Live')).toBeTruthy());

    api.exportAll.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByText('Stale')).toBeTruthy());
    expect(screen.queryByText('Unavailable')).toBeNull();
  });
});
