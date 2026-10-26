// Thin API client. Same-origin in production (the server serves the
// frontend); via Vite dev proxy locally. All failures throw — callers
// (the store) catch and stay in localStorage demo mode.

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  exportAll: () => req<{ attacks: unknown[]; meds: unknown[]; refills?: unknown[]; workouts?: unknown[]; dayStates?: unknown[]; stockBaselines?: unknown[]; settings: Record<string, unknown> }>('GET', '/api/export'),
  importAll: (payload: unknown) => req('POST', '/api/import', payload),
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
