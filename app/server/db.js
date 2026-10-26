// Database open/setup. Keeps the original behavior: create the data
// directory, enable WAL, then bring the schema up to the current version.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations.js';

export function openDatabase(dataDir, { log = console.log } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'migraine.db'));
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    runMigrations(db, { log });
  } catch (err) {
    // Never leak the handle when setup fails (future user_version guard,
    // WAL/migration errors): on Windows an open handle blocks temp-dir
    // cleanup. Rethrow the original error even if close itself fails.
    try {
      db.close();
    } catch {
      // close failed — the original error is the one worth reporting
    }
    throw err;
  }
  return db;
}
