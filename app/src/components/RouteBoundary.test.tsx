// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazy, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Outlet, Route, Routes } from 'react-router';
import RouteBoundary from '@/components/RouteBoundary';

/** Persistent shell: chrome outside the boundary, only the outlet inside it. */
function Shell() {
  return (
    <div>
      <nav>
        <Link to="/broken">Broken</Link>
        <Link to="/ok">Ok</Link>
      </nav>
      <p>Persistent chrome</p>
      <RouteBoundary>
        <Outlet />
      </RouteBoundary>
    </div>
  );
}

function renderAt(initialPath: string, broken: ReactNode): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/broken" element={broken} />
          <Route path="/ok" element={<p>Second page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RouteBoundary', () => {
  it('turns a rejected lazy import into an accessible error and resets on navigation', async () => {
    const Failing = lazy(() => Promise.reject(new Error('chunk load failed')));
    // React logs caught render errors; keep the test output readable.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderAt('/broken', <Failing />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('This page could not be loaded.')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeTruthy();

    // Only the outlet content failed: the shell/chrome is still mounted.
    expect(screen.getByText('Persistent chrome')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ok' })).toBeTruthy();

    // Navigating to another route remounts the boundary, so it cannot stay
    // stuck on the previous chunk's error.
    fireEvent.click(screen.getByRole('link', { name: 'Ok' }));
    await waitFor(() => expect(screen.getByText('Second page')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Persistent chrome')).toBeTruthy();

    errorSpy.mockRestore();
  });

  it('keeps the chrome mounted and announces loading while a chunk is pending', () => {
    const Pending = lazy(() => new Promise<{ default: () => ReactNode }>(() => {}));

    renderAt('/broken', <Pending />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Loading');
    expect(screen.getByText('Persistent chrome')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ok' })).toBeTruthy();
  });
});
