// Row mappers between the snake_case SQLite columns and the camelCase
// API/frontend shapes. Extracted verbatim from the original server so the
// wire format stays identical.

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Defensive, sanitizing read of a legacy JSON column. A hand-edited/damaged
 * row must not throw inside GET /api/export, the nightly backup, or restore's
 * post-commit snapshot read, so malformed JSON — and valid JSON that is not an
 * array — falls back to `[]`.
 *
 * A genuine array is filtered item by item: valid entries are kept and only
 * invalid ones are dropped. Dropping recoverable entries would be lossy beyond
 * the damage, which matters most for PATCH /api/attacks/:id: that route does a
 * read-merge-write (`{...attackFromRow(existing), ...patch}` → `attackToRow`),
 * so a whole-field fallback would destroy every valid item in the array when
 * the user edits an unrelated field. Raw column text is never exposed or
 * logged.
 */
function parseArrayColumn(raw, isValidItem) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isValidItem) : [];
}

// painLog items: plain objects with a string ts and finite numeric level.
const isPainLogItem = (p) => isPlainObject(p)
  && typeof p.ts === 'string'
  && typeof p.level === 'number' && Number.isFinite(p.level);

const isStringItem = (v) => typeof v === 'string';

export const attackFromRow = (r) => ({
  id: r.id, start: r.start, end: r.end,
  painLog: parseArrayColumn(r.pain_log, isPainLogItem), peakPain: r.peak_pain,
  symptoms: parseArrayColumn(r.symptoms, isStringItem),
  triggers: parseArrayColumn(r.triggers, isStringItem),
  aura: r.aura === null || r.aura === undefined ? null : !!r.aura,
  notes: r.notes, source: r.source,
});

export const attackToRow = (a) => ({
  id: a.id, start: a.start, end: a.end ?? null,
  pain_log: JSON.stringify(a.painLog ?? []), peak_pain: a.peakPain ?? -1,
  symptoms: JSON.stringify(a.symptoms ?? []), triggers: JSON.stringify(a.triggers ?? []),
  aura: a.aura === null || a.aura === undefined ? null : (a.aura ? 1 : 0),
  notes: a.notes ?? '', source: a.source ?? 'manual',
});

// quantity is the nullable structured tablet count (schema v3). SQL NULL →
// API null (UNKNOWN tablets); absent camelCase keys (legacy payloads) also
// map to null. Free-text dose/notes are never parsed into it.
export const medFromRow = (r) => ({
  id: r.id, medId: r.med_id, ts: r.ts, dose: r.dose,
  quantity: r.quantity === null || r.quantity === undefined ? null : r.quantity,
  attackId: r.attack_id, notes: r.notes, source: r.source,
});

export const medToRow = (m) => ({
  id: m.id, med_id: m.medId, ts: m.ts ?? new Date().toISOString(),
  dose: m.dose ?? '', quantity: m.quantity ?? null, attack_id: m.attackId ?? null,
  notes: m.notes ?? '', source: m.source ?? 'manual',
});

export const refillFromRow = (r) => ({
  id: r.id, medId: r.med_id, date: r.date,
  quantity: r.quantity === null || r.quantity === undefined ? null : r.quantity,
  notes: r.notes, source: r.source,
});

// POST /api/refills defaults source to 'manual'; bulk import passes 'import'.
export const refillToRow = (r, defaultSource = 'manual') => ({
  id: r.id, med_id: r.medId, date: r.date, quantity: r.quantity ?? null,
  notes: r.notes ?? '', source: r.source ?? defaultSource,
});

// stock_baselines: dated absolute stock counts. created_at is always set by
// the server on POST (import may carry its own value so a restore preserves
// the original tie-break ordering).
export const baselineFromRow = (r) => ({
  id: r.id, medId: r.med_id, effectiveAt: r.effective_at,
  quantity: r.quantity, notes: r.notes, source: r.source, createdAt: r.created_at,
});

export const baselineToRow = (b, createdAt = b.createdAt ?? new Date().toISOString()) => ({
  id: b.id, med_id: b.medId, effective_at: b.effectiveAt,
  quantity: b.quantity, notes: b.notes ?? '', source: b.source ?? 'manual',
  created_at: createdAt,
});

// workouts.duration_minutes is the only nullable numeric column: normalise
// both SQL NULL and a missing key to API null so clients never see undefined.
export const workoutFromRow = (r) => ({
  id: r.id, performedAt: r.performed_at, kind: r.kind, effort: r.effort,
  durationMinutes: r.duration_minutes === null || r.duration_minutes === undefined
    ? null
    : r.duration_minutes,
  notes: r.notes, source: r.source,
});

// POST /api/workouts defaults source to 'manual'; bulk import passes 'import'
// (same convention as meds/refills).
export const workoutToRow = (w, defaultSource = 'manual') => ({
  id: w.id, performed_at: w.performedAt, kind: w.kind, effort: w.effort,
  duration_minutes: w.durationMinutes ?? null,
  notes: w.notes ?? '', source: w.source ?? defaultSource,
});

// day_states day is the primary key ('YYYY-MM-DD', local calendar day).
export const dayStateFromRow = (r) => ({
  day: r.day, status: r.status, notes: r.notes, updatedAt: r.updated_at,
});

// The server sets updated_at on every write; the default only covers import
// payloads that predate/omit the field.
export const dayStateToRow = (d, now = new Date()) => ({
  day: d.day, status: d.status, notes: d.notes ?? '',
  updated_at: d.updatedAt ?? now.toISOString(),
});
