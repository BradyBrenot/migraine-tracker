import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

type FetchArgs = Parameters<typeof fetch>;

function okJson(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

function notOk(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

/** A fetch that only settles when its request signal is aborted. */
function hangingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api request timeout', () => {
  it('passes method, headers, body, and an abort signal to fetch', async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true }));
    const payload = { start: '2026-04-10T21:58:00.000Z' };

    await api.addAttack(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(path).toBe('/api/attacks');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify(payload));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a request that never settles after the 15s bound', async () => {
    fetchMock.mockImplementation(hangingFetch);

    let settled = false;
    const request = api.exportAll().finally(() => {
      settled = true;
    });
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a response body that never settles after the 15s bound', async () => {
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
      } as unknown as Response));

    let settled = false;
    const request = api.exportAll().finally(() => {
      settled = true;
    });
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(0); // let fetch resolve and body reading start
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(true);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves a successful response and clears the timeout timer', async () => {
    fetchMock.mockResolvedValue(okJson({ attacks: [] }));

    await expect(api.exportAll()).resolves.toEqual({ attacks: [] });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('posts a restore payload to the atomic restore endpoint', async () => {
    fetchMock.mockResolvedValue(okJson({ attacks: [], meds: [], settings: {} }));
    const payload = {
      schemaVersion: 4,
      attacks: [],
      meds: [],
      refills: [],
      workouts: [],
      dayStates: [],
      stockBaselines: [],
      settings: { timezone: 'UTC' },
    };

    await expect(api.restoreAll(payload)).resolves.toEqual({
      attacks: [], meds: [], settings: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(path).toBe('/api/restore');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify(payload));
  });

  it('keeps the exact non-ok error message and clears the timeout timer', async () => {
    fetchMock.mockResolvedValue(notOk(503));

    await expect(api.exportAll()).rejects.toThrow('GET /api/export → 503');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('throws an ApiError carrying the status for a non-ok response', async () => {
    fetchMock.mockResolvedValue(notOk(503));

    const error: unknown = await api.exportAll().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(503);
    expect(apiError.method).toBe('GET');
    expect(apiError.path).toBe('/api/export');
    expect(apiError.message).toBe('GET /api/export → 503');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a bulk restore by 120s instead of the ordinary 15s', async () => {
    fetchMock.mockImplementation(hangingFetch);

    let settled = false;
    const request = api.restoreAll({ attacks: [], meds: [] }).finally(() => {
      settled = true;
    });
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

    // Well past the ordinary bound the bulk request is still in flight.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(true);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an additive bulk import by 120s as well', async () => {
    fetchMock.mockImplementation(hangingFetch);

    let settled = false;
    const request = api.importAll({ attacks: [], meds: [] }).finally(() => {
      settled = true;
    });
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('dynamic path segment encoding', () => {
  // Imported record ids may contain every URL delimiter; a raw segment would
  // change the route or truncate the path.
  const rawId = 'a/b?c#d%e f';
  const encodedId = encodeURIComponent(rawId);

  beforeEach(() => {
    fetchMock.mockResolvedValue(okJson({ ok: true }));
  });

  it('encodes record ids in every PATCH and DELETE path', async () => {
    await api.patchAttack(rawId, {});
    await api.deleteAttack(rawId);
    await api.patchMed(rawId, {});
    await api.deleteMed(rawId);
    await api.patchRefill(rawId, {});
    await api.deleteRefill(rawId);
    await api.patchStockBaseline(rawId, {});
    await api.deleteStockBaseline(rawId);
    await api.patchWorkout(rawId, {});
    await api.deleteWorkout(rawId);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/attacks/${encodedId}`,
      `/api/attacks/${encodedId}`,
      `/api/meds/${encodedId}`,
      `/api/meds/${encodedId}`,
      `/api/refills/${encodedId}`,
      `/api/refills/${encodedId}`,
      `/api/stock-baselines/${encodedId}`,
      `/api/stock-baselines/${encodedId}`,
      `/api/workouts/${encodedId}`,
      `/api/workouts/${encodedId}`,
    ]);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
      'PATCH', 'DELETE', 'PATCH', 'DELETE', 'PATCH', 'DELETE',
      'PATCH', 'DELETE', 'PATCH', 'DELETE',
    ]);
    // The body is still plain JSON, not a form/encoded payload.
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({}));
  });

  it('encodes the day-state day and setting key segments', async () => {
    const rawDay = '2026/10/21?x#y% z';
    const rawKey = 'weird/key?x#y% z';

    await api.putDayState(rawDay, { status: 'well' });
    await api.putSetting(rawKey, { a: 1 });

    expect(fetchMock.mock.calls[0][0]).toBe(`/api/day-states/${encodeURIComponent(rawDay)}`);
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PUT');
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/settings/${encodeURIComponent(rawKey)}`);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('leaves ordinary ids unchanged and still bounded by the 15s timeout', async () => {
    await api.patchMed('plain-id_1', { notes: 'x' });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/meds/plain-id_1');
    // The request timer is cleared on success, exactly as before.
    expect(vi.getTimerCount()).toBe(0);
  });
});
