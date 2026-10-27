// Daily JSON backup dump (one file per UTC day, newest `keep` retained).
// Extracted from the original server with the clock, directory, retention
// and logger injectable so tests can run it without touching real data.

import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { exportEnvelope } from './snapshot.js';

const BACKUP_FILE = /^migraine-\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Fixed, non-secret failure log line. The safe wrapper below never logs the
 * error object: filesystem errors can contain paths, and a future failure
 * could carry data or credentials.
 */
export const BACKUP_FAILURE_MESSAGE = 'nightly backup failed';

/**
 * Writes <backupDir>/migraine-YYYY-MM-DD.json (unless it already exists)
 * and rotates old dumps. Returns the written path, or null when today's
 * backup already exists.
 *
 * The payload is written to a unique temp file in the SAME directory and then
 * renamed into place, so an interrupted/failed write can never leave a
 * partial daily dump: rename(2) within one filesystem is atomic and either
 * publishes the complete file or leaves the destination absent. The temp file
 * is removed on any write/rename failure and is never rotated (its name does
 * not match BACKUP_FILE).
 *
 * `writeFile`/`rename`/`unlink` exist so tests can inject failures.
 */
export function dumpBackup({
  db, backupDir, now = new Date(), keep = 31, log = console.log,
  writeFile = writeFileSync, rename = renameSync, unlink = unlinkSync,
}) {
  mkdirSync(backupDir, { recursive: true });
  const today = now.toISOString().slice(0, 10);
  const file = join(backupDir, `migraine-${today}.json`);
  if (existsSync(file)) return null; // already done today

  const payload = JSON.stringify(exportEnvelope(db, now), null, 2);
  const temp = join(backupDir, `.migraine-${today}.${randomUUID()}.tmp`);
  try {
    writeFile(temp, payload);
    rename(temp, file);
  } catch (error) {
    try {
      unlink(temp); // best effort: the failed write may not have created it
    } catch {
      // nothing to clean up
    }
    throw error;
  }

  // rotate: keep the newest `keep` daily dumps (temp files never match)
  const files = readdirSync(backupDir).filter((f) => BACKUP_FILE.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) {
    unlink(join(backupDir, old));
  }
  log(`nightly backup written: ${file}`);
  return file;
}

/**
 * Runs dumpBackup without ever throwing, for the startup call and the hourly
 * timer in index.js. A failure is logged as one fixed line (never the error,
 * path, or payload) and reported as null; the caller continues running.
 * `dump` and `onError` are injectable for tests.
 */
export function safeDumpBackup({
  dump = dumpBackup, onError = console.error, ...options
} = {}) {
  try {
    return dump(options);
  } catch {
    onError(BACKUP_FAILURE_MESSAGE);
    return null;
  }
}
