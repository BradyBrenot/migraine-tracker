// Full-data snapshots shared by GET /api/export and the nightly backup.
// New record types must be added here (and to import/reset) deliberately.

import { SCHEMA_VERSION } from './migrations.js';
import { isReservedSettingsKey } from './validate.js';
import { normalizeReminderSettings } from '../shared/reminders.ts';
import { normalizeWeatherSettings } from '../shared/weather.ts';
import {
  attackFromRow, medFromRow, refillFromRow, workoutFromRow, dayStateFromRow,
  baselineFromRow,
} from './mappers.js';

/**
 * Public, non-secret settings only. Reserved environment/secret-like rows are
 * filtered even if a legacy/manual database insert bypassed the PUT route, so
 * /api/settings, /api/export and the nightly backup can never leak them.
 * `reminders` is normalized to its known non-secret shape, dropping any
 * nested delivery fields a hand-edited/legacy row may contain. `weather` is
 * normalized the same way (saved city/coordinates + threshold only; runtime
 * forecast data never lives in the settings table).
 */
export function collectSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (isReservedSettingsKey(row.key)) continue;
    let value;
    try {
      value = JSON.parse(row.value);
    } catch {
      // A manually corrupted legacy row must not break export/backup or the
      // scheduler's settings read; skip it rather than expose raw text.
      continue;
    }
    if (row.key === 'reminders') out[row.key] = normalizeReminderSettings(value);
    else if (row.key === 'weather') out[row.key] = normalizeWeatherSettings(value);
    else out[row.key] = value;
  }
  return out;
}

/** { attacks, meds, refills, workouts, dayStates, stockBaselines, settings } */
export function exportSnapshot(db) {
  return {
    attacks: db.prepare('SELECT * FROM attacks ORDER BY start').all().map(attackFromRow),
    meds: db.prepare('SELECT * FROM meds ORDER BY ts').all().map(medFromRow),
    refills: db.prepare('SELECT * FROM refills ORDER BY date').all().map(refillFromRow),
    workouts: db.prepare('SELECT * FROM workouts ORDER BY performed_at').all().map(workoutFromRow),
    dayStates: db.prepare('SELECT * FROM day_states ORDER BY day').all().map(dayStateFromRow),
    stockBaselines: db.prepare('SELECT * FROM stock_baselines ORDER BY effective_at, created_at')
      .all()
      .map(baselineFromRow),
    settings: collectSettings(db),
  };
}

/** Snapshot plus version envelope metadata. */
export function exportEnvelope(db, now = new Date()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    ...exportSnapshot(db),
  };
}
