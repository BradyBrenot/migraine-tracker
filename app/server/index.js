// Migraine Tracker backend — Fastify + node:sqlite (built into Node 24+,
// no native dependencies). Serves the REST API and the built frontend
// (dist/) from one process.
//
// This file is startup wiring only: env resolution, database open +
// migrations (db.js/migrations.js), route construction (app.js), the
// nightly backup loop (backup.js), and listen. Data model mirrors the
// frontend's types:
//   attacks: id, start, end, pain_log (JSON), peak_pain, symptoms (JSON),
//            triggers (JSON), aura, notes, source
//   meds:    id, med_id, ts, dose, attack_id, notes, source
//   refills: id, med_id, date, notes, source
//   workouts: id, performed_at, kind, effort, duration_minutes, notes, source
//   day_states: day ('YYYY-MM-DD'), status, notes, updated_at
//   meds.quantity / refills.quantity: nullable tablet count (NULL = unknown)
//   stock_baselines: id, med_id, effective_at (ISO instant), quantity,
//                    notes, source, created_at — dated ABSOLUTE stock counts
//   settings: key/value (rules, doses, planned, timezone, lowStockThreshold,
//             lowStockAlert)

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';
import { safeDumpBackup } from './backup.js';
import { attackViewUrl, resolveAttackConfig, resolveReminderConfig } from './reminder-config.js';
import { createNtfyTransport } from './ntfy.js';
import { createReminderEngine } from './reminders.js';
import { startReminderScheduler } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, 'data');
const PORT = Number(process.env.PORT ?? 3000);
const DIST_DIR = resolve(__dirname, '..', 'dist');

const db = openDatabase(DATA_DIR);

// ── ntfy reminders + attack alerts (environment-only, cleanly disabled) ──
// NTFY_URL/NTFY_TOKEN/NTFY_ATTACK_URL/NTFY_ATTACK_TOKEN/PUBLIC_APP_URL are
// never persisted or logged: only enabled state and fixed reasons are printed.
// One engine and one scheduler serve both topics; a missing topic passes a
// null transport (attack-only or personal-only engine).
const reminderConfig = resolveReminderConfig(process.env);
const attackConfig = resolveAttackConfig(process.env);

if (reminderConfig.enabled) {
  console.log('ntfy reminders enabled');
} else {
  console.log(`ntfy reminders disabled: ${reminderConfig.reason}`);
}
if (attackConfig.enabled) {
  console.log('ntfy attack alerts enabled');
} else {
  console.log(`ntfy attack alerts disabled: ${attackConfig.reason}`);
}
// A shared topic still works, but the user should know both streams land in
// the same place. Fixed text, no values; printed once at startup.
if (reminderConfig.enabled && attackConfig.enabled
  && reminderConfig.ntfyUrl === attackConfig.ntfyUrl) {
  console.warn('ntfy attack topic matches the reminder topic');
}

let reminderScheduler = null;
let reminderEngine = null;
if (reminderConfig.enabled || attackConfig.enabled) {
  reminderEngine = createReminderEngine({
    db,
    transport: reminderConfig.enabled
      ? createNtfyTransport({
        ntfyUrl: reminderConfig.ntfyUrl,
        ntfyToken: reminderConfig.ntfyToken,
        publicAppUrl: reminderConfig.publicAppUrl,
      })
      : null,
    attackTransport: attackConfig.enabled
      ? createNtfyTransport({
        ntfyUrl: attackConfig.ntfyUrl,
        ntfyToken: attackConfig.ntfyToken,
        // Attack alerts always link to the partner read-only view, never the
        // writer UI. A malformed PUBLIC_APP_URL only disables the click link.
        publicAppUrl: attackViewUrl(attackConfig.publicAppUrl),
      })
      : null,
    now: () => Date.now(),
    log: console.warn,
  });
  reminderScheduler = startReminderScheduler({ engine: reminderEngine, log: console.log });
}

// Attack writes record the event synchronously, then trigger a single-flight
// scheduler tick for near-immediate delivery (the minute interval is the
// fallback). Never awaited: the API write is never delayed or failed by ntfy.
const onAttackChange = reminderEngine && attackConfig.enabled
  ? (event) => {
    reminderEngine.noteAttackWrite(event);
    void reminderScheduler?.tick();
  }
  : undefined;

const app = await buildApp({
  db,
  distDir: DIST_DIR,
  logger: true,
  onAttackChange,
  notificationStatus: {
    reminders: reminderConfig.enabled,
    attackAlerts: attackConfig.enabled,
  },
});

// ── nightly JSON backup dump ─────────────────────────────────────────
// Writes a full export to <DATA_DIR>/backups/migraine-YYYY-MM-DD.json once
// per day, keeping ~31 days of history. The dataset is bind-mounted, so
// Backrest picks these files up on its normal schedule.
const BACKUP_DIR = join(DATA_DIR, 'backups');
// safeDumpBackup catches write/rotate failures (logging one fixed message) so
// a broken backup can never crash startup or the hourly timer.
const runBackup = () => safeDumpBackup({ db, backupDir: BACKUP_DIR });

runBackup(); // on startup if today's dump doesn't exist yet
setInterval(runBackup, 3600_000).unref(); // then check hourly

// ── static frontend registration + listen ────────────────────────────
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`migraine-tracker listening on :${PORT}, data in ${DATA_DIR}`);
});

const shutdown = async () => {
  try {
    await reminderScheduler?.stop();
  } finally {
    await app.close();
  }
};
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
