// Schema migrations tracked via PRAGMA user_version.
//
// Version 0 covers every database created by the original single-file
// server: the tables already exist (CREATE TABLE IF NOT EXISTS) but no
// user_version was ever set. Migration 1 therefore re-asserts the same
// baseline DDL non-destructively, so fresh databases and existing
// installations converge on version 1 with zero data loss. Later feature
// migrations append to MIGRATIONS with strictly increasing versions and
// must stay additive — CREATE TABLE/INDEX and `ALTER TABLE … ADD COLUMN`
// with a NULL default only — so upgrades never drop or rewrite data.

export const SCHEMA_VERSION = 4;

export const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline schema (attacks, meds, refills, settings)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attacks (
          id TEXT PRIMARY KEY,
          start TEXT NOT NULL,
          "end" TEXT,
          pain_log TEXT NOT NULL DEFAULT '[]',
          peak_pain INTEGER NOT NULL DEFAULT -1,
          symptoms TEXT NOT NULL DEFAULT '[]',
          triggers TEXT NOT NULL DEFAULT '[]',
          aura INTEGER,
          notes TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'manual'
        );
        CREATE TABLE IF NOT EXISTS meds (
          id TEXT PRIMARY KEY,
          med_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          dose TEXT NOT NULL DEFAULT '',
          attack_id TEXT,
          notes TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'manual'
        );
        CREATE TABLE IF NOT EXISTS refills (
          id TEXT PRIMARY KEY,
          med_id TEXT NOT NULL,
          date TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'manual'
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Purely additive: new tables only, no existing table is touched, so
    // upgrading a v0/v1 install keeps every stored record. `day_states.day`
    // is the local calendar day ('YYYY-MM-DD') and is the natural key; the
    // server always overwrites updated_at, so it is never a client field.
    version: 2,
    name: 'workouts and day states',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workouts (
          id TEXT PRIMARY KEY,
          performed_at TEXT NOT NULL,
          kind TEXT NOT NULL,
          effort TEXT NOT NULL,
          duration_minutes INTEGER,
          notes TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'manual'
        );
        CREATE TABLE IF NOT EXISTS day_states (
          day TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Inventory (checkpoint 5). Nullable `quantity` columns on meds/refills:
    // SQL NULL means UNKNOWN tablets (every pre-v3 row maps to null — free
    // text is never parsed). stock_baselines holds dated ABSOLUTE stock
    // counts (initial stock and later corrections); `effective_at` is a full
    // ISO instant, `created_at` breaks exact-instant ties by insertion
    // order, and the index supports the per-med ordering the stock
    // calculation performs.
    version: 3,
    name: 'inventory quantities and stock baselines',
    up(db) {
      db.exec(`
        ALTER TABLE meds ADD COLUMN quantity INTEGER;
        ALTER TABLE refills ADD COLUMN quantity INTEGER;
        CREATE TABLE IF NOT EXISTS stock_baselines (
          id TEXT PRIMARY KEY,
          med_id TEXT NOT NULL,
          effective_at TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'manual',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_stock_baselines_med
          ON stock_baselines (med_id, effective_at);
      `);
    },
  },
  {
    // Reminder scheduler bookkeeping (checkpoint 6). Both tables are
    // INTERNAL: they are deliberately absent from /api/export, the nightly
    // backup, /api/import and the client snapshot. `reminder_occurrences`
    // holds deterministic occurrence keys and delivery state (pending,
    // sending, succeeded, skipped) with bounded retry bookkeeping;
    // `reminder_state` holds non-user-visible episode state such as the
    // Nurtec low-stock re-arm latch. Additive only: no existing table changes.
    version: 4,
    name: 'reminder occurrences and internal episode state',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reminder_occurrences (
          key TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          med_id TEXT,
          scheduled_at TEXT NOT NULL,
          expires_at TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          attempt INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_attempt_at TEXT,
          sent_at TEXT,
          last_error_category TEXT,
          last_error_status INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reminder_occurrences_due
          ON reminder_occurrences (status, next_attempt_at);
        CREATE TABLE IF NOT EXISTS reminder_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];

export function currentUserVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

/**
 * Runs all pending migrations in order; safe to call repeatedly.
 * `migrations` defaults to MIGRATIONS and is injectable so tests can exercise
 * failure/rollback without production-only hooks.
 *
 * A database written by a NEWER build (user_version > SCHEMA_VERSION) is
 * rejected before any work: an older server must fail fast instead of
 * operating on (and possibly corrupting) a schema it does not understand.
 */
export function runMigrations(db, { log = () => {}, migrations = MIGRATIONS } = {}) {
  const current = currentUserVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${current} is newer than this build supports (max ${SCHEMA_VERSION}); `
      + 'refusing to start. Run a build that includes this schema version, or restore a backup.',
    );
  }
  let version = current;
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      // Report the original migration error even if ROLLBACK itself fails
      // (e.g. no active transaction); swallowing the rollback failure keeps
      // the root cause visible.
      try {
        db.exec('ROLLBACK');
      } catch {
        // nothing to roll back
      }
      throw err;
    }
    version = migration.version;
    log(`migrated database to schema version ${migration.version} (${migration.name})`);
  }
  return version;
}
