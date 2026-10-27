// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

/**
 * The static demo is writer-only: partner routes must redirect to `/` instead
 * of mounting the backend-polling read-only provider, and no hydration request
 * may be made.
 */

const apiMock = vi.hoisted(() => ({
  exportAll: vi.fn(),
  importAll: vi.fn(),
  putSetting: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: apiMock }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}));

type AppModule = typeof import('@/App');
let App: AppModule['default'];

beforeAll(async () => {
  vi.stubEnv('MODE', 'demo');
  vi.resetModules();
  App = (await import('@/App')).default;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('demo app routing', () => {
  it('redirects /view to the writer demo home with the permanent banner', async () => {
    renderAt('/view');

    await waitFor(() => expect(screen.getByTestId('demo-banner')).toBeTruthy());
    expect(screen.getByText(/synthetic sample data/)).toBeTruthy();
    expect(screen.queryByText('Read only')).toBeNull();
    expect(screen.queryByText('Partner view')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Now' })).toBeNull();
    expect(apiMock.exportAll).not.toHaveBeenCalled();
  });

  it('redirects the retired /view.html shell too', async () => {
    renderAt('/view.html');

    await waitFor(() => expect(screen.getByTestId('demo-banner')).toBeTruthy());
    expect(screen.queryByText('Read only')).toBeNull();
    expect(apiMock.exportAll).not.toHaveBeenCalled();
  });
});
