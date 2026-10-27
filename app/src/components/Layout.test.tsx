// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const store = vi.hoisted(() => ({
  activeAttack: null,
  demo: false,
  sync: { status: 'synced', pending: 0, diverged: false },
}));

/** Captures the props Layout passes to the generated Toaster wrapper. */
const toasterProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock('@/lib/store', () => ({ useStore: () => store }));
vi.mock('@/components/ui/sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    toasterProps.last = props;
    return null;
  },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import Layout from './Layout';

function renderLayout(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Layout />
    </MemoryRouter>,
  );
}

afterEach(() => {
  store.demo = false;
  cleanup();
});

describe('writer shell accessibility and responsive breakpoints', () => {
  it('starts with a skip link that targets the focusable main landmark', () => {
    renderLayout();

    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip.getAttribute('href')).toBe('#main-content');
    // It is the first focusable element in the shell, before the brand/nav.
    expect(document.querySelectorAll('a')[0]).toBe(skip);

    const main = document.querySelector('main');
    expect(main).not.toBeNull();
    expect(main!.id).toBe('main-content');
    expect(main!.getAttribute('tabindex')).toBe('-1');
    expect(main!.className).toContain('scroll-mt-20');
  });

  it('moves the desktop/mobile nav and main padding to the lg breakpoint in lockstep', () => {
    renderLayout();

    const desktop = screen.getByRole('navigation', { name: 'Primary' });
    expect(desktop.className).toContain('lg:flex');
    expect(desktop.className).not.toContain('md:flex');

    const mobile = screen.getByRole('navigation', { name: 'Primary mobile' });
    expect(mobile.className).toContain('lg:hidden');
    expect(mobile.className).not.toContain('md:hidden');

    const main = document.querySelector('main')!;
    expect(main.className).toContain('lg:pb-10');
    expect(main.className).not.toContain('md:pb-10');
  });

  it('keeps the header on one line with a truncating route title and shrink-proof pills', () => {
    renderLayout();

    // The header shows the current page, not brand text, and is not a heading.
    const title = document.querySelector('[data-testid="shell-title"]') as HTMLElement;
    expect(title.textContent).toBe('Log');
    expect(title.tagName).toBe('SPAN');
    expect(screen.queryByRole('heading', { name: 'Log' })).toBeNull();
    expect(title.className).toContain('min-w-0');
    expect(title.className).toContain('truncate');
    expect(title.parentElement?.className).toContain('flex-nowrap');

    // The sync pill keeps its full label instead of being squeezed by the title.
    const syncPill = screen.getByTitle(/^Sync:/);
    expect(syncPill.className).toContain('shrink-0');
  });

  it('labels unknown writer routes as Not found instead of a brand line', () => {
    render(
      <MemoryRouter initialEntries={['/nope']}>
        <Layout />
      </MemoryRouter>,
    );
    const title = document.querySelector('[data-testid="shell-title"]') as HTMLElement;
    expect(title.textContent).toBe('Not found');
  });

  it('exposes both navigation landmarks with their five writer links', () => {
    renderLayout();

    for (const label of ['Log', 'Calendar', 'Reports', 'History', 'Settings']) {
      expect(screen.getAllByRole('link', { name: label })).toHaveLength(2);
    }
  });
});

describe('demo disclosure', () => {
  it('shows the permanent demo banner and a Demo pill instead of sync state', () => {
    store.demo = true;
    renderLayout();

    const banner = screen.getByTestId('demo-banner');
    expect(banner.textContent).toContain('synthetic sample data');
    expect(banner.textContent).toContain('Do not enter real health information');
    // Mobile visibility: no responsive hiding class on the banner.
    expect(banner.className).not.toContain('hidden');

    expect(screen.getByTestId('demo-pill').textContent).toBe('Demo');
    expect(screen.queryByTitle(/^Sync:/)).toBeNull();
  });
});

describe('writer Toaster placement', () => {
  it('puts toasts at the bottom, clear of the sticky header and mobile nav', () => {
    renderLayout();

    expect(toasterProps.last?.position).toBe('bottom-center');
    // The offset must clear the fixed bottom nav (plus iOS safe area).
    const offset = toasterProps.last?.offset as { bottom?: string } | undefined;
    expect(offset?.bottom).toContain('4.75rem');
    expect(offset?.bottom).toContain('safe-area-inset-bottom');
    const mobileOffset = toasterProps.last?.mobileOffset as { bottom?: string } | undefined;
    expect(mobileOffset?.bottom).toContain('4.75rem');
  });
});
