import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

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

  it('keeps the exact non-ok error message and clears the timeout timer', async () => {
    fetchMock.mockResolvedValue(notOk(503));

    await expect(api.exportAll()).rejects.toThrow('GET /api/export → 503');

    expect(vi.getTimerCount()).toBe(0);
  });
});
