import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEATHER_SETTINGS,
  MAX_PRESSURE_DROP_THRESHOLD_HPA,
  PRESSURE_WINDOW_MS,
  assessPressureDrop,
  formatWeatherLocation,
  hourlyPressureSeries,
  normalizeGeocodeQuery,
  normalizeWeatherLocation,
  normalizeWeatherSettings,
  parseCurrentWeather,
  weatherLocationErrors,
  weatherOccurrenceKey,
  weatherSettingsErrors,
  weatherSignature,
} from './weather.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-04-10T12:00:00.000Z');

const boston = {
  id: 4930956,
  name: 'Boston',
  admin1: 'Massachusetts',
  country: 'United States',
  latitude: 42.35843,
  longitude: -71.05977,
};

/** Times starting at now (hourly), pressures in the same order. */
function series(pressures: number[], startMs = NOW): {
  times: number[];
  pressures: number[];
} {
  return {
    times: pressures.map((_, i) => startMs + i * HOUR),
    pressures,
  };
}

describe('DEFAULT_WEATHER_SETTINGS', () => {
  it('is disabled with no city and a 5 hPa starting threshold', () => {
    expect(DEFAULT_WEATHER_SETTINGS).toEqual({
      enabled: false,
      location: null,
      pressureDropThresholdHpa: 5,
    });
    expect(weatherSettingsErrors(DEFAULT_WEATHER_SETTINGS)).toEqual([]);
  });
});

describe('weather settings validation and normalization', () => {
  it('accepts a fixed location projection and drops unknown fields', () => {
    const raw = {
      enabled: true,
      location: { ...boston, label: 'home', token: 'nope' },
      pressureDropThresholdHpa: 6.5,
      provider: 'open-meteo',
    };
    // Nested secret-like fields fail closed.
    expect(weatherSettingsErrors(raw).some((e) => e.includes('location.token'))).toBe(true);
    expect(normalizeWeatherSettings(raw)).toEqual({
      enabled: true,
      location: boston,
      pressureDropThresholdHpa: 6.5,
    });
  });

  it('rejects bad coordinates, names, controls, and thresholds', () => {
    expect(weatherLocationErrors({ ...boston, latitude: 91 })).toContain(
      'location.latitude must be a finite number from -90 to 90',
    );
    expect(weatherLocationErrors({ ...boston, longitude: -181 })).toContain(
      'location.longitude must be a finite number from -180 to 180',
    );
    expect(weatherLocationErrors({ ...boston, latitude: Number.NaN }).length).toBeGreaterThan(0);
    expect(weatherLocationErrors({ ...boston, name: '' }).length).toBeGreaterThan(0);
    expect(weatherLocationErrors({ ...boston, name: 'Bad\nName' }).length).toBeGreaterThan(0);
    expect(weatherLocationErrors({ ...boston, id: 1.5 }).length).toBeGreaterThan(0);
    expect(normalizeWeatherLocation({ ...boston, latitude: 91 })).toBeNull();

    expect(weatherSettingsErrors({ ...DEFAULT_WEATHER_SETTINGS, pressureDropThresholdHpa: 0 }))
      .toContain(
        `pressureDropThresholdHpa must be a number from 1 to ${MAX_PRESSURE_DROP_THRESHOLD_HPA}`,
      );
    expect(weatherSettingsErrors({ ...DEFAULT_WEATHER_SETTINGS, pressureDropThresholdHpa: 26 }))
      .toHaveLength(1);
    expect(weatherSettingsErrors({ ...DEFAULT_WEATHER_SETTINGS, pressureDropThresholdHpa: Number.NaN }))
      .toHaveLength(1);
    expect(weatherSettingsErrors({ ...DEFAULT_WEATHER_SETTINGS, enabled: 'yes' }))
      .toContain('enabled must be true or false');
  });

  it('normalizes defaults independently and never leaks unknown keys', () => {
    expect(normalizeWeatherSettings(undefined)).toEqual(DEFAULT_WEATHER_SETTINGS);
    expect(normalizeWeatherSettings({
      enabled: true,
      location: { ...boston, latitude: 100 },
      pressureDropThresholdHpa: 2.5,
      ntfyUrl: 'secret',
    })).toEqual({
      enabled: true,
      location: null,
      pressureDropThresholdHpa: 2.5,
    });
  });

  it('validates city-search input strictly', () => {
    expect(normalizeGeocodeQuery('  Boston ')).toBe('Boston');
    expect(normalizeGeocodeQuery('a')).toBeNull();
    expect(normalizeGeocodeQuery('x'.repeat(101))).toBeNull();
    expect(normalizeGeocodeQuery('Bad\tCity')).toBeNull();
    expect(normalizeGeocodeQuery(42)).toBeNull();
  });

  it('formats a location without empty parts', () => {
    expect(formatWeatherLocation(boston)).toBe('Boston, Massachusetts, United States');
    expect(formatWeatherLocation({ ...boston, admin1: '', country: '' })).toBe('Boston');
    expect(formatWeatherLocation(null)).toBe('');
  });
});

describe('pressure episode signature', () => {
  it('is stable for identical settings and changes with city/threshold', () => {
    const settings = { ...DEFAULT_WEATHER_SETTINGS, enabled: true, location: boston };
    expect(weatherSignature(settings)).toBe(weatherSignature({ ...settings }));
    expect(weatherSignature(settings)).not.toBe(
      weatherSignature({ ...settings, pressureDropThresholdHpa: 6 }),
    );
    expect(weatherSignature(settings)).not.toBe(
      weatherSignature({
        ...settings,
        location: { ...boston, latitude: 40 },
      }),
    );
    expect(weatherSignature({ ...settings, location: null })).toBe('none');
    expect(weatherOccurrenceKey('drop:1,2:5', '2026-04-10T12:00:00.000Z'))
      .toBe('weather:drop:1,2:5:2026-04-10T12:00:00.000Z');
  });
});

describe('assessPressureDrop', () => {
  it('uses the first sample at/after now as the baseline and ignores earlier ones', () => {
    // An earlier lower sample must not become the baseline.
    const input = {
      times: [NOW - HOUR, NOW, NOW + HOUR, NOW + 2 * HOUR],
      pressures: [990, 1013, 1008, 1012],
      nowMs: NOW,
      thresholdHpa: 5,
    };
    const result = assessPressureDrop(input);
    expect(result.state).toBe('warning');
    expect(result.baselineHpa).toBe(1013);
    expect(result.targetHpa).toBe(1008);
    expect(result.dropHpa).toBe(5);
  });

  it('treats exactly the threshold as a warning and just below as clear', () => {
    const exact = assessPressureDrop({
      ...series([1013, 1008]),
      nowMs: NOW,
      thresholdHpa: 5,
    });
    expect(exact.state).toBe('warning');
    expect(exact.dropHpa).toBe(5);

    const below = assessPressureDrop({
      ...series([1013, 1008.01]),
      nowMs: NOW,
      thresholdHpa: 5,
    });
    expect(below.state).toBe('clear');
    expect(below.dropHpa).toBeCloseTo(4.99, 10);
  });

  it('never warns on a rise', () => {
    const result = assessPressureDrop({
      ...series([1000, 1004, 1010]),
      nowMs: NOW,
      thresholdHpa: 1,
    });
    expect(result.state).toBe('clear');
    expect(result.targetHpa).toBe(1004);
    expect(result.dropHpa).toBe(-4);
  });

  it('includes a sample exactly 24h after the baseline and excludes later ones', () => {
    const inclusive = assessPressureDrop({
      times: [NOW, NOW + 24 * HOUR, NOW + 24 * HOUR + HOUR],
      pressures: [1013, 1000, 990],
      nowMs: NOW,
      thresholdHpa: 5,
    });
    expect(inclusive.state).toBe('warning');
    expect(inclusive.targetTimeMs).toBe(NOW + 24 * HOUR);
    expect(inclusive.targetHpa).toBe(1000);

    const outside = assessPressureDrop({
      times: [NOW, NOW + 24 * HOUR + 1],
      pressures: [1013, 900],
      nowMs: NOW,
      thresholdHpa: 5,
    });
    // No later sample inside the window: unknown, never an invented warning.
    expect(outside.state).toBe('unknown');
    expect(outside.baselineHpa).toBe(1013);
    expect(outside.windowEndMs).toBe(NOW + PRESSURE_WINDOW_MS);
  });

  it('returns unknown for short, mismatched, null, and NaN-only data', () => {
    expect(assessPressureDrop({
      times: [NOW], pressures: [1013], nowMs: NOW, thresholdHpa: 5,
    }).state).toBe('unknown');

    expect(assessPressureDrop({
      times: [NOW, NOW + HOUR], pressures: [1013], nowMs: NOW, thresholdHpa: 5,
    }).state).toBe('unknown');

    expect(assessPressureDrop({
      times: [null, NOW, NOW + HOUR],
      pressures: [1013, 1013, 1000],
      nowMs: NOW,
      thresholdHpa: 5,
    }).state).toBe('warning');

    expect(assessPressureDrop({
      times: [NOW, NOW + HOUR],
      pressures: [Number.NaN, 1000],
      nowMs: NOW,
      thresholdHpa: 5,
    }).state).toBe('unknown');

    expect(assessPressureDrop({
      times: [NOW, NOW + HOUR],
      pressures: [1013, 1000],
      nowMs: NOW,
      thresholdHpa: Number.NaN,
    }).state).toBe('unknown');
  });

  it('sorts unsorted samples and ignores implausible pressures', () => {
    const result = assessPressureDrop({
      times: [NOW + 2 * HOUR, NOW + HOUR, NOW],
      pressures: [1010, 1011, 1013],
      nowMs: NOW,
      thresholdHpa: 5,
    });
    expect(result.state).toBe('clear');
    expect(result.baselineHpa).toBe(1013);

    const garbage = assessPressureDrop({
      times: [NOW, NOW + HOUR],
      pressures: [Number.POSITIVE_INFINITY, 1000],
      nowMs: NOW,
      thresholdHpa: 5,
    });
    expect(garbage.state).toBe('unknown');
  });

  it('does not mix in any current-condition value', () => {
    // assessPressureDrop only receives the hourly series; a low `current`
    // pressure is simply not part of the input shape.
    const result = assessPressureDrop({
      ...series([1013, 1012]),
      nowMs: NOW,
      thresholdHpa: 5,
    });
    expect(result.state).toBe('clear');
    expect(result.baselineHpa).toBe(1013);
  });
});

describe('hourlyPressureSeries', () => {
  it('projects only hourly time/pressure_msl, converting unix seconds to epoch ms', () => {
    expect(hourlyPressureSeries({
      // Open-Meteo timeformat=unixtime returns SECONDS; the boundary converts.
      time: [NOW / 1000, (NOW + HOUR) / 1000],
      pressure_msl: [1013, 1008],
      current: { pressure_msl: 900 },
    })).toEqual({ times: [NOW, NOW + HOUR], pressures: [1013, 1008] });

    expect(hourlyPressureSeries({ time: [NOW / 1000], pressure_msl: [] })).toBeNull();
    expect(hourlyPressureSeries({ time: [NOW / 1000], pressure_msl: null })).toBeNull();
    expect(hourlyPressureSeries(null)).toBeNull();
  });

  it('converts realistic unix seconds to epoch ms and keeps unusable time entries NaN', () => {
    const parsed = hourlyPressureSeries({
      time: [NOW / 1000, (NOW + HOUR) / 1000],
      pressure_msl: [1013, 1008],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.times).toEqual([NOW, NOW + HOUR]);
    expect(new Date(parsed!.times[0]).toISOString()).toBe('2026-04-10T12:00:00.000Z');

    // Non-numeric entries are not converted; they stay unusable for assessment.
    expect(hourlyPressureSeries({
      time: [null, 'nope'], pressure_msl: [1013, 1008],
    })!.times).toEqual([Number.NaN, Number.NaN]);
  });
});

describe('parseCurrentWeather', () => {
  it('keeps neutral values independently and never invents them', () => {
    expect(parseCurrentWeather({
      temperature_2m: 18.4,
      relative_humidity_2m: 54,
      pressure_msl: 1012,
    })).toEqual({ temperatureC: 18.4, humidityPercent: 54, pressureHpa: 1012 });

    expect(parseCurrentWeather({
      temperature_2m: 18.4,
      relative_humidity_2m: 140,
      pressure_msl: Number.NaN,
    })).toEqual({ temperatureC: 18.4, humidityPercent: null, pressureHpa: null });

    expect(parseCurrentWeather(null)).toBeNull();
  });
});
