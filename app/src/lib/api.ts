// Thin API client. Same-origin in production (the server serves the
// frontend); via Vite dev proxy locally. All failures throw — callers
// (the store) catch and stay in localStorage demo mode.
//
// Every request is bounded: a stalled server must reject (and release the
// store's serialized write queue) instead of hanging forever.

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Bulk backup routes accept a 25 MiB body and one transaction may rewrite
 * every row, so the ordinary 15s bound would abort a large (destructive)
 * restore while the server is still working.
 */
const BULK_REQUEST_TIMEOUT_MS = 120_000;

/**
 * A server response that was received and is not ok, so the HTTP status is
 * known. Network failures and timeouts deliberately keep propagating as
 * TypeError/AbortError instead: callers must be able to tell "the server
 * rejected this" (4xx → nothing was written) from "no answer, outcome
 * unknown". The message format is unchanged from the original plain Error.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status: number) {
    super(`${method} ${path} → ${status}`);
    this.name = 'ApiError';
    this.method = method;
    this.path = path;
    this.status = status;
  }
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new ApiError(method, path, res.status);
    // Await the body inside the try so a response whose body stalls is bounded
    // by the same timeout instead of hanging after the headers arrived.
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Non-secret notification configuration reported by GET /api/health. */
export interface HealthResponse {
  ok: boolean;
  notifications?: {
    reminders?: boolean;
    attackAlerts?: boolean;
  };
}

/**
 * Canonical full-data snapshot returned by both GET /api/export and the
 * atomic POST /api/restore. Record arrays are typed loosely here (the store
 * casts validated records) and older servers may omit the newer arrays.
 */
export interface ExportEnvelope {
  schemaVersion?: number;
  exportedAt?: string;
  attacks: unknown[];
  meds: unknown[];
  refills?: unknown[];
  workouts?: unknown[];
  dayStates?: unknown[];
  stockBaselines?: unknown[];
  settings: Record<string, unknown>;
}

export const api = {
  getHealth: () => req<HealthResponse>('GET', '/api/health'),

  exportAll: () => req<ExportEnvelope>('GET', '/api/export'),
  importAll: (payload: unknown) =>
    req('POST', '/api/import', payload, { timeoutMs: BULK_REQUEST_TIMEOUT_MS }),
  /**
   * Destructive, atomic replacement of every server record and restorable
   * setting. The returned envelope is canonical, like GET /api/export.
   */
  restoreAll: (payload: unknown) =>
    req<ExportEnvelope>('POST', '/api/restore', payload, { timeoutMs: BULK_REQUEST_TIMEOUT_MS }),
  resetAll: () => req('POST', '/api/reset'),

  addAttack: (a: unknown) => req('POST', '/api/attacks', a),
  patchAttack: (id: string, patch: unknown) => req('PATCH', `/api/attacks/${id}`, patch),
  deleteAttack: (id: string) => req('DELETE', `/api/attacks/${id}`),

  addMed: (m: unknown) => req('POST', '/api/meds', m),
  patchMed: (id: string, patch: unknown) => req('PATCH', `/api/meds/${id}`, patch),
  deleteMed: (id: string) => req('DELETE', `/api/meds/${id}`),

  addRefill: (r: unknown) => req('POST', '/api/refills', r),
  patchRefill: (id: string, patch: unknown) => req('PATCH', `/api/refills/${id}`, patch),
  deleteRefill: (id: string) => req('DELETE', `/api/refills/${id}`),

  addStockBaseline: (b: unknown) => req('POST', '/api/stock-baselines', b),
  patchStockBaseline: (id: string, patch: unknown) => req('PATCH', `/api/stock-baselines/${id}`, patch),
  deleteStockBaseline: (id: string) => req('DELETE', `/api/stock-baselines/${id}`),

  addWorkout: (w: unknown) => req('POST', '/api/workouts', w),
  patchWorkout: (id: string, patch: unknown) => req('PATCH', `/api/workouts/${id}`, patch),
  deleteWorkout: (id: string) => req('DELETE', `/api/workouts/${id}`),
  listWorkouts: () => req('GET', '/api/workouts'),

  listDayStates: () => req('GET', '/api/day-states'),
  putDayState: (day: string, body: unknown) => req('PUT', `/api/day-states/${day}`, body),

  putSetting: (key: string, value: unknown) => req('PUT', `/api/settings/${key}`, value),
};
