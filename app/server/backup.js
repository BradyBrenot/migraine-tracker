// Daily JSON backup dump (one file per UTC day, newest `keep` retained).
// Extracted from the original server with the clock, directory, retention
// and logger injectable so tests can run it without touching real data.

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportEnvelope } from './snapshot.js';

const BACKUP_FILE = /^migraine-\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Writes <backupDir>/migraine-YYYY-MM-DD.json (unless it already exists)
 * and rotates old dumps. Returns the written path, or null when today's
 * backup already exists.
 */
export function dumpBackup({ db, backupDir, now = new Date(), keep = 31, log = console.log }) {
  mkdirSync(backupDir, { recursive: true });
  const today = now.toISOString().slice(0, 10);
  const file = join(backupDir, `migraine-${today}.json`);
  if (existsSync(file)) return null; // already done today

  const payload = JSON.stringify(exportEnvelope(db, now), null, 2);
  writeFileSync(file, payload);

  // rotate: keep the newest `keep` daily dumps
  const files = readdirSync(backupDir).filter((f) => BACKUP_FILE.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) {
    unlinkSync(join(backupDir, old));
  }
  log(`nightly backup written: ${file}`);
  return file;
}
