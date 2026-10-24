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
  exportAll: () => req<{ attacks: unknown[]; meds: unknown[]; refills?: unknown[]; settings: Record<string, unknown> }>('GET', '/api/export'),
  importAll: (payload: unknown) => req('POST', '/api/import', payload),
  resetAll: () => req('POST', '/api/reset'),

  addAttack: (a: unknown) => req('POST', '/api/attacks', a),
  patchAttack: (id: string, patch: unknown) => req('PATCH', `/api/attacks/${id}`, patch),
  deleteAttack: (id: string) => req('DELETE', `/api/attacks/${id}`),

  addMed: (m: unknown) => req('POST', '/api/meds', m),
  patchMed: (id: string, patch: unknown) => req('PATCH', `/api/meds/${id}`, patch),
  deleteMed: (id: string) => req('DELETE', `/api/meds/${id}`),

  addRefill: (r: unknown) => req('POST', '/api/refills', r),
  deleteRefill: (id: string) => req('DELETE', `/api/refills/${id}`),

  putSetting: (key: string, value: unknown) => req('PUT', `/api/settings/${key}`, value),
};
