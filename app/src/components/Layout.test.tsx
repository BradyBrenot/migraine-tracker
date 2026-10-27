// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const store = vi.hoisted(() => ({
  activeAttack: null,
  sync: { status: 'synced', pending: 0, diverged: false },
}));

vi.mock('@/lib/store', () => ({ useStore: () => store }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
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

  it('keeps the header on one line with a truncating brand and shrink-proof pills', () => {
    renderLayout();

    const brand = screen.getByText(/Migraine Tracker/);
    expect(brand.className).toContain('min-w-0');
    expect(brand.className).toContain('truncate');
    expect(brand.parentElement?.className).toContain('flex-nowrap');

    // The sync pill keeps its full label instead of being squeezed by the brand.
    const syncPill = screen.getByTitle(/^Sync:/);
    expect(syncPill.className).toContain('shrink-0');
  });

  it('exposes both navigation landmarks with their five writer links', () => {
    renderLayout();

    for (const label of ['Log', 'Calendar', 'Reports', 'History', 'Settings']) {
      expect(screen.getAllByRole('link', { name: label })).toHaveLength(2);
    }
  });
});
