import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CloudRain, Droplets, Thermometer } from 'lucide-react';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';
import {
  DEFAULT_WEATHER_SETTINGS,
  WEATHER_WARNING_LEAD,
  formatWeatherLocation,
  normalizeWeatherSettings,
  type PressureWarning,
  type WeatherStatus,
} from '../../shared/weather.ts';

/** Foreground refresh cadence; the server caches upstream data (~15 min). */
export const WEATHER_POLL_MS = 15 * 60 * 1000;
/** Short retry while the server reports its first upstream fetch is in flight. */
export const WEATHER_LOADING_POLL_MS = 5 * 1000;

function dropText(dropHpa: number): string {
  const rounded = Math.round(dropHpa * 10) / 10;
  return `${rounded} hPa`;
}

function formatTarget(ms: number, timeZone: string | null): string {
  const date = new Date(ms);
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  };
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(date);
    } catch {
      // Unknown zone from upstream: fall back to the browser's zone.
    }
  }
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatUpdated(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function WarningBlock({ warning, timeZone }: { warning: PressureWarning; timeZone: string | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-2 rounded-lg border border-amber-900/70 bg-amber-950/40 px-3 py-2"
    >
      <p className="text-sm font-semibold text-amber-200">{WEATHER_WARNING_LEAD}</p>
      <p className="mt-0.5 text-xs text-amber-100/80">
        About {dropText(warning.dropHpa)} lower by {formatTarget(warning.targetTimeMs, timeZone)}.
      </p>
    </div>
  );
}

/**
 * Compact Home weather card, placed after the medication quick-log section.
 *
 * Scope: pressure DROPS only, with deliberately cautious wording. Current
 * temperature/humidity/pressure are neutral context and never trigger alerts.
 * Loading/error/stale states are non-blocking and never disable logging.
 */
export default function WeatherCard() {
  const { state } = useStore();
  const weather = normalizeWeatherSettings(state.weather ?? DEFAULT_WEATHER_SETTINGS);
  const [status, setStatus] = useState<WeatherStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);

  const enabled = weather.enabled;
  const hasLocation = weather.location !== null;
  const threshold = weather.pressureDropThresholdHpa;
  const locationKey = weather.location
    ? `${weather.location.id}:${weather.location.latitude}:${weather.location.longitude}`
    : 'none';

  useEffect(() => {
    if (!enabled || !hasLocation) {
      setStatus(null);
      setLoadError(false);
      setLoading(false);
      return;
    }
    // A new city or threshold invalidates the previous runtime status: clear it
    // before refetching so an old location's warning is never shown while the
    // new assessment is in flight. The server likewise drops its cached data on
    // a settings change.
    setStatus(null);
    setLoadError(false);
    let cancelled = false;
    let timer: number | null = null;
    // Non-overlapping refresh: each request schedules exactly one successor, so
    // a slow response can never stack overlapping polls. A `loading` response
    // means the server's first upstream fetch is still in flight, so retry
    // briefly instead of making the card go quiet for the full 15 minutes.
    const load = async () => {
      timer = null;
      setLoading(true);
      let nextStatus: WeatherStatus['status'] | null = null;
      try {
        const next = await api.getWeather();
        if (cancelled) return;
        setStatus(next);
        setLoadError(false);
        nextStatus = next.status;
      } catch {
        if (cancelled) return;
        // Keep any earlier successful status; surface a non-alarming message.
        setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
      const delay = nextStatus === 'loading' ? WEATHER_LOADING_POLL_MS : WEATHER_POLL_MS;
      timer = window.setTimeout(() => {
        void load();
      }, delay);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled, hasLocation, locationKey, threshold]);

  if (!enabled) return null;

  const savedPlace = formatWeatherLocation(weather.location);

  if (!hasLocation) {
    return (
      <section
        aria-labelledby="weather-card-title"
        className="rounded-xl border border-slate-800 bg-slate-900 p-3 shadow-sm"
      >
        <h2
          id="weather-card-title"
          className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-400"
        >
          <CloudRain className="h-4 w-4" /> Weather
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Pick a city in{' '}
          <Link to="/settings" className="font-semibold text-slate-200 underline underline-offset-2">
            Settings
          </Link>{' '}
          to see pressure-drop forecasts.
        </p>
      </section>
    );
  }

  const remote = status;
  const checking = (loading && !remote) || remote?.status === 'loading';
  const hasWarning = !!remote?.warning;
  const remoteFailed = loadError || (remote?.status === 'error' && !hasWarning);
  const remoteStale = !!remote && remote.stale === true;
  const current = remote?.current ?? null;
  const showValues = current !== null
    && (current.temperatureC !== null
      || current.humidityPercent !== null
      || current.pressureHpa !== null);
  const updated = formatUpdated(remote?.fetchedAt ?? null);
  const remotePlace = formatWeatherLocation(remote?.location ?? null) || savedPlace;

  return (
    <section
      aria-labelledby="weather-card-title"
      className="rounded-xl border border-slate-800 bg-slate-900 p-3 shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h2
          id="weather-card-title"
          className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-400"
        >
          <CloudRain className="h-4 w-4" /> Weather
        </h2>
        <span className="min-w-0 truncate text-xs text-slate-400">{remotePlace}</span>
      </div>

      {checking && (
        <p role="status" className="mt-1 text-xs text-slate-400">
          Checking the forecast…
        </p>
      )}

      {remoteFailed && (
        <p role="status" className="mt-1 text-xs text-slate-300">
          Forecast unavailable right now. Logging still works; try again later.
        </p>
      )}

      {remoteStale && !loadError && (
        <p role="status" className="mt-1 text-xs text-slate-300">
          Showing the last forecast — it may be out of date.
        </p>
      )}

      {remote && hasWarning && !loadError && (
        <WarningBlock warning={remote.warning!} timeZone={state.timezone} />
      )}

      {remote && !remoteFailed && !hasWarning && remote.status === 'ready' && !remote.stale && (
        <p role="status" className="mt-1 text-xs text-slate-400">
          No significant pressure drop forecast in the next 24 hours.
        </p>
      )}

      {showValues && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
          {current.temperatureC !== null && (
            <span className="flex items-center gap-1">
              <Thermometer className="h-3.5 w-3.5" />
              {Math.round(current.temperatureC)}°C
            </span>
          )}
          {current.humidityPercent !== null && (
            <span className="flex items-center gap-1">
              <Droplets className="h-3.5 w-3.5" />
              {Math.round(current.humidityPercent)}% humidity
            </span>
          )}
          {current.pressureHpa !== null && (
            <span>{Math.round(current.pressureHpa)} hPa now</span>
          )}
        </div>
      )}

      <p className="mt-2 text-[11px] text-slate-500">
        {updated ? `Updated ${updated}. ` : ''}
        <Link to="/settings" className="underline underline-offset-2 hover:text-slate-300">
          Weather settings
        </Link>
      </p>
    </section>
  );
}
