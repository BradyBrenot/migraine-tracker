// Shared test helpers. Every test gets a disposable database directory
// under the OS temp area — never app/server/data — and closes the app
// (which closes the SQLite handle) before the directory is removed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { buildApp } from '../app.js';

export function makeTempDir(label = 'migraine-test') {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

export function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Opens a migrated database in a fresh temp dir and builds an app around
 * it. Returns { app, db, dir, dataDir, close } — close() releases the app,
 * database, and temp directory.
 */
export async function makeApp({ label = 'migraine-api' } = {}) {
  const dir = makeTempDir(label);
  const dataDir = join(dir, 'data');
  const db = openDatabase(dataDir, { log: () => {} });
  const app = await buildApp({ db, logger: false });
  return {
    app,
    db,
    dir,
    dataDir,
    close: async () => {
      await app.close(); // onClose hook closes the database
      cleanupDir(dir);
    },
  };
}

/**
 * The exact schema the pre-migration server created, WITHOUT setting
 * PRAGMA user_version — i.e. the legacy state of every existing install.
 */
export const LEGACY_DDL = `
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
`;
