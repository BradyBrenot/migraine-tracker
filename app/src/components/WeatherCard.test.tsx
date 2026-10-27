// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { TrackerState } from '@/types';
import type { WeatherSettings, WeatherStatus } from '../../shared/weather.ts';

const store = vi.hoisted(() => ({
  state: {} as TrackerState,
}));

vi.mock('@/lib/store', () => ({ useStore: () => store }));

const api = vi.hoisted(() => ({
  getWeather: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api }));

import WeatherCard, { WEATHER_POLL_MS, WEATHER_LOADING_POLL_MS } from './WeatherCard';

const BOSTON = {
  id: 4930956,
  name: 'Boston',
  admin1: 'Massachusetts',
  country: 'United States',
  latitude: 42.35843,
  longitude: -71.05977,
};

const ENABLED = {
  enabled: true,
  location: BOSTON,
  pressureDropThresholdHpa: 5,
};

function makeState(weather: WeatherSettings = ENABLED): TrackerState {
  return { weather, timezone: 'America/New_York' } as TrackerState;
}

function ready(overrides: Partial<WeatherStatus> = {}): WeatherStatus {
  return {
    status: 'ready',
    location: BOSTON,
    current: { temperatureC: 14.2, humidityPercent: 61, pressureHpa: 1010 },
    warning: {
      baselineHpa: 1013,
      targetHpa: 1005,
      dropHpa: 8,
      targetTimeMs: Date.parse('2026-04-10T22:00:00.000Z'),
      thresholdHpa: 5,
    },
    fetchedAt: '2026-04-10T12:00:00.000Z',
    stale: false,
    thresholdHpa: 5,
    timeZone: 'America/New_York',
    ...overrides,
  };
}

function renderCard(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <WeatherCard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  store.state = makeState();
  api.getWeather.mockReset();
  api.getWeather.mockResolvedValue(ready());
});

afterEach(() => {
  cleanup();
});

describe('WeatherCard', () => {
  it('renders nothing while the feature is disabled and never polls', () => {
    store.state = makeState({ enabled: false, location: null, pressureDropThresholdHpa: 5 });
    const { container } = renderCard();
    expect(container.innerHTML).toBe('');
    expect(api.getWeather).not.toHaveBeenCalled();
  });

  it('shows a compact Settings setup link when enabled without a city', () => {
    store.state = makeState({ enabled: true, location: null, pressureDropThresholdHpa: 5 });
    renderCard();
    expect(screen.getByText(/Pick a city in/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
    expect(api.getWeather).not.toHaveBeenCalled();
  });

  it('shows the cautious pressure warning plus neutral values', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText(/a possible trigger for some people/)).toBeTruthy());
    expect(screen.getByText(/8 hPa lower by/)).toBeTruthy();
    expect(screen.getByText(/14°C/)).toBeTruthy();
    expect(screen.getByText(/61% humidity/)).toBeTruthy();
    expect(screen.getByText(/1010 hPa now/)).toBeTruthy();
    expect(screen.getByText(/Boston, Massachusetts, United States/)).toBeTruthy();
    // Never stronger medical claims.
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/migraine is likely|predicted migraine|risk score/i);
  });

  it('shows a stale notice while keeping the last warning non-blocking', async () => {
    api.getWeather.mockResolvedValue(ready({ stale: true, status: 'error' }));
    renderCard();
    await waitFor(() => expect(
      screen.getByText(/Showing the last forecast — it may be out of date/),
    ).toBeTruthy());
    expect(screen.getByText(/a possible trigger for some people/)).toBeTruthy();
  });

  it('shows a calm error state without medical wording', async () => {
    api.getWeather.mockResolvedValue(ready({ status: 'error', stale: true, warning: null }));
    renderCard();
    await waitFor(() => expect(screen.getByText(/Forecast unavailable right now/)).toBeTruthy());
    expect(screen.getByText(/Logging still works/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/likely|predicted|risk score/i);
  });

  it('reports no pressure drop without alarming wording', async () => {
    api.getWeather.mockResolvedValue(ready({ warning: null }));
    renderCard();
    await waitFor(() => expect(
      screen.getByText(/No significant pressure drop forecast in the next 24 hours/),
    ).toBeTruthy());
  });

  it('clears the prior warning and refetches when the threshold changes', async () => {
    const view = renderCard();
    await waitFor(() => expect(
      screen.getByText(/a possible trigger for some people/),
    ).toBeTruthy());

    let resolveSecond: (value: WeatherStatus) => void = () => {};
    api.getWeather.mockImplementationOnce(() => new Promise<WeatherStatus>((resolve) => {
      resolveSecond = resolve;
    }));

    store.state = makeState({ ...ENABLED, pressureDropThresholdHpa: 9 });
    view.rerender(
      <MemoryRouter>
        <WeatherCard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(api.getWeather).toHaveBeenCalledTimes(2));
    // The old threshold's warning must not linger during the new fetch.
    expect(screen.queryByText(/a possible trigger for some people/)).toBeNull();

    resolveSecond(ready({ warning: null, thresholdHpa: 9 }));
    await waitFor(() => expect(screen.getByText(
      /No significant pressure drop forecast in the next 24 hours/,
    )).toBeTruthy());
  });

  it('links to Settings from the populated card', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Weather settings' })).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Weather settings' }).getAttribute('href'))
      .toBe('/settings');
  });

  it('shows a checking message and retries quickly while the first forecast is loading', async () => {
    vi.useFakeTimers();
    try {
      api.getWeather
        .mockResolvedValueOnce(ready({
          status: 'loading', warning: null, current: null, fetchedAt: null,
        }))
        .mockResolvedValueOnce(ready());
      renderCard();

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(api.getWeather).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Checking the forecast…')).toBeTruthy();

      // The normal 15-minute cadence must not apply while the first upstream
      // fetch is still in flight: a short retry is scheduled instead.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WEATHER_LOADING_POLL_MS - 1);
      });
      expect(api.getWeather).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(api.getWeather).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('Checking the forecast…')).toBeNull();
      expect(screen.getByText(/a possible trigger for some people/)).toBeTruthy();

      // Once a usable forecast arrives, the regular cadence is back.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WEATHER_POLL_MS - 1);
      });
      expect(api.getWeather).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('formats the warning target in the app timezone, matching the notification', async () => {
    store.state = { ...makeState(), timezone: 'Asia/Tokyo' } as TrackerState;
    api.getWeather.mockResolvedValue(ready({ timeZone: 'America/New_York' }));
    renderCard();
    const expected = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Asia/Tokyo',
    }).format(new Date(Date.parse('2026-04-10T22:00:00.000Z')));
    await waitFor(() => expect(document.body.textContent).toContain(`lower by ${expected}`));
  });
});
