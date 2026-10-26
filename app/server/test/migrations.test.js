// Migration tests: fresh databases, representative legacy (user_version 0)
// databases with existing rows, and repeat-run idempotence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db.js';
import {
  currentUserVersion, runMigrations, MIGRATIONS, SCHEMA_VERSION,
} from '../migrations.js';
import { makeTempDir, cleanupDir, LEGACY_DDL } from './helpers.js';

test('fresh database migrates from version 0 to the current schema version', () => {
  const dir = makeTempDir('migraine-fresh');
  try {
    const db = openDatabase(dir, { log: () => {} });
    try {
      assert.equal(currentUserVersion(db), SCHEMA_VERSION);
      // baseline tables exist and are usable
      db.prepare(`INSERT INTO attacks (id,start) VALUES ('a1','2026-01-01T00:00:00Z')`).run();
      const row = db.prepare('SELECT * FROM attacks WHERE id = ?').get('a1');
      assert.equal(row.peak_pain, -1); // column default applied
      assert.equal(row.pain_log, '[]');
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('legacy database (current tables, user_version 0) migrates without data loss', () => {
  const dir = makeTempDir('migraine-legacy');
  try {
    // Simulate an existing install: original DDL, rows present, no version.
    const file = join(dir, 'migraine.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY_DDL);
    legacy.prepare(`INSERT INTO attacks (id,start,"end",pain_log,peak_pain,symptoms,triggers,aura,notes,source)
      VALUES ('atk1','2025-06-01T08:00:00Z','2025-06-01T20:00:00Z','[{"ts":"2025-06-01T09:00:00Z","level":8}]',8,
              '["nausea"]','["stress"]',1,'legacy notes','import')`).run();
    legacy.prepare(`INSERT INTO meds (id,med_id,ts,dose,attack_id,notes,source)
      VALUES ('m1','nurtec','2025-06-01T09:00:00Z','75 mg','atk1','with attack','manual')`).run();
    legacy.prepare(`INSERT INTO refills (id,med_id,date,notes,source)
      VALUES ('r1','nurtec','2025-05-20','8 tablets','manual')`).run();
    legacy.prepare(`INSERT INTO settings (key,value) VALUES ('rules','{"nurtec":{"limit":15,"windowDays":30}}')`).run();
    assert.equal(currentUserVersion(legacy), 0);
    legacy.close();

    const db = openDatabase(dir, { log: () => {} });
    try {
      assert.equal(currentUserVersion(db), SCHEMA_VERSION);
      const attack = db.prepare('SELECT * FROM attacks WHERE id = ?').get('atk1');
      assert.deepEqual(
        { start: attack.start, end: attack.end, pain_log: attack.pain_log, aura: attack.aura, notes: attack.notes, source: attack.source },
        { start: '2025-06-01T08:00:00Z', end: '2025-06-01T20:00:00Z', pain_log: '[{"ts":"2025-06-01T09:00:00Z","level":8}]', aura: 1, notes: 'legacy notes', source: 'import' },
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meds').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refills').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 1);
      const med = db.prepare('SELECT * FROM meds WHERE id = ?').get('m1');
      assert.equal(med.attack_id, 'atk1'); // link preserved
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('populated v0/v1/v2 databases upgrade to v4: rows intact, quantities NULL, new tables empty', () => {
  // Every pre-v3 version of the schema is represented by exactly the tables
  // that version had. The upgrade must keep every row, add the nullable
  // quantity columns with NULL (= unknown), create an empty stock_baselines
  // table, and create the two EMPTY internal reminder tables (v4).
  const cases = [
    { version: 0, withV2Tables: false },
    { version: 1, withV2Tables: false },
    { version: 2, withV2Tables: true },
  ];
  const tableNames = (db) => db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((r) => r.name);

  for (const { version, withV2Tables } of cases) {
    const dir = makeTempDir(`migraine-v${version}-to-current`);
    try {
      const file = join(dir, 'migraine.db');
      const old = new DatabaseSync(file);
      if (version === 0) old.exec(LEGACY_DDL); // a real pre-migration install
      else MIGRATIONS[0].up(old);
      if (withV2Tables) MIGRATIONS[1].up(old);
      if (version > 0) old.exec(`PRAGMA user_version = ${version}`);

      old.prepare(`INSERT INTO attacks (id,start,"end",pain_log,peak_pain,symptoms,triggers,aura,notes,source)
        VALUES ('atk1','2025-06-01T08:00:00Z','2025-06-01T20:00:00Z','[{"ts":"2025-06-01T09:00:00Z","level":8}]',8,
                '["nausea"]','["stress"]',1,'legacy notes','import')`).run();
      old.prepare(`INSERT INTO meds (id,med_id,ts,dose,attack_id,notes,source)
        VALUES ('m1','nurtec','2025-06-01T09:00:00Z','75 mg','atk1','with attack','manual')`).run();
      old.prepare(`INSERT INTO refills (id,med_id,date,notes,source)
        VALUES ('r1','nurtec','2025-05-20','8 tablets','manual')`).run();
      old.prepare(`INSERT INTO settings (key,value) VALUES ('rules','{"nurtec":{"limit":15,"windowDays":30}}')`).run();
      if (withV2Tables) {
        old.prepare(`INSERT INTO workouts (id,performed_at,kind,effort,duration_minutes,notes,source)
          VALUES ('w1','2025-05-30T07:00:00Z','cardio','low',20,'walk','manual')`).run();
        old.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
          VALUES ('2025-05-31','off','tired','2025-05-31T20:00:00Z')`).run();
      }
      assert.equal(currentUserVersion(old), version);
      old.close();

      const db = openDatabase(dir, { log: () => {} });
      try {
        assert.equal(SCHEMA_VERSION, 4);
        assert.equal(currentUserVersion(db), SCHEMA_VERSION);

        // every pre-existing row survived with its columns intact
        const attack = db.prepare('SELECT * FROM attacks WHERE id = ?').get('atk1');
        assert.deepEqual(
          {
            start: attack.start, end: attack.end, peak_pain: attack.peak_pain,
            aura: attack.aura, notes: attack.notes, source: attack.source,
          },
          {
            start: '2025-06-01T08:00:00Z', end: '2025-06-01T20:00:00Z', peak_pain: 8,
            aura: 1, notes: 'legacy notes', source: 'import',
          },
        );
        assert.deepEqual(JSON.parse(attack.pain_log), [{ ts: '2025-06-01T09:00:00Z', level: 8 }]);
        const med = db.prepare('SELECT * FROM meds WHERE id = ?').get('m1');
        assert.equal(med.dose, '75 mg');
        assert.equal(med.attack_id, 'atk1');
        assert.equal(med.quantity, null); // unknown tablets, never 0
        const refill = db.prepare('SELECT * FROM refills WHERE id = ?').get('r1');
        assert.equal(refill.notes, '8 tablets');
        assert.equal(refill.quantity, null);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 1);
        if (withV2Tables) {
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workouts').get().n, 1);
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM day_states').get().n, 1);
          assert.equal(db.prepare('SELECT notes FROM workouts WHERE id = ?').get('w1').notes, 'walk');
        }

        // inventory table is created empty and usable
        assert.ok(tableNames(db).includes('stock_baselines'));
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_baselines').get().n, 0);
        db.prepare(`INSERT INTO stock_baselines (id,med_id,effective_at,quantity,created_at)
          VALUES ('b1','nurtec','2025-06-02T00:00:00.000Z',5,'2025-06-02T00:00:00.000Z')`).run();
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_baselines').get().n, 1);

        // v4 internal reminder tables are created EMPTY: no upgrade may
        // invent delivery or episode state for an existing install.
        const names = tableNames(db);
        assert.ok(names.includes('reminder_occurrences'));
        assert.ok(names.includes('reminder_state'));
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_state').get().n, 0);
        // ...and they are usable (columns/defaults as designed)
        db.prepare(`INSERT INTO reminder_occurrences (key,type,scheduled_at,next_attempt_at,created_at,updated_at)
          VALUES ('checkin:2025-06-02','checkin','2025-06-02T22:00:00.000Z','2025-06-02T22:00:00.000Z',
                  '2025-06-02T22:00:00.000Z','2025-06-02T22:00:00.000Z')`).run();
        const occ = db.prepare('SELECT * FROM reminder_occurrences WHERE key = ?').get('checkin:2025-06-02');
        assert.equal(occ.status, 'pending');
        assert.equal(occ.attempt, 0);
      } finally {
        db.close();
      }
    } finally {
      cleanupDir(dir);
    }
  }
});

test('a representative current v3 database upgrades to v4 without touching inventory data', () => {
  // Checkpoint 5 installations are the realistic pre-checkpoint-6 schema:
  // quantities + stock_baselines already exist, reminder tables do not.
  const dir = makeTempDir('migraine-v3-to-v4');
  try {
    const file = join(dir, 'migraine.db');
    const old = new DatabaseSync(file);
    old.exec(LEGACY_DDL);
    MIGRATIONS[0].up(old);
    MIGRATIONS[1].up(old);
    MIGRATIONS[2].up(old);
    old.exec('PRAGMA user_version = 3');
    old.prepare(`INSERT INTO meds (id,med_id,ts,dose,quantity) VALUES
      ('m1','nurtec','2025-06-01T09:00:00Z','1 tablet',1)`).run();
    old.prepare(`INSERT INTO refills (id,med_id,date,notes,quantity) VALUES
      ('r1','nurtec','2025-05-20','pickup',8)`).run();
    old.prepare(`INSERT INTO stock_baselines (id,med_id,effective_at,quantity,notes,source,created_at) VALUES
      ('b1','nurtec','2025-05-21T00:00:00.000Z',9,'start','manual','2025-05-21T00:00:00.000Z')`).run();
    old.prepare(`INSERT INTO settings (key,value) VALUES ('timezone','"America/New_York"')`).run();
    assert.equal(currentUserVersion(old), 3);
    old.close();

    const db = openDatabase(dir, { log: () => {} });
    try {
      assert.equal(SCHEMA_VERSION, 4);
      assert.equal(currentUserVersion(db), 4);
      // Inventory data is untouched; only the new internal tables appear.
      assert.equal(db.prepare('SELECT quantity FROM meds WHERE id = ?').get('m1').quantity, 1);
      assert.equal(db.prepare('SELECT quantity FROM refills WHERE id = ?').get('r1').quantity, 8);
      const baseline = db.prepare('SELECT * FROM stock_baselines WHERE id = ?').get('b1');
      assert.equal(baseline.quantity, 9);
      assert.equal(baseline.effective_at, '2025-05-21T00:00:00.000Z');
      assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('timezone').value,
        '"America/New_York"');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_state').get().n, 0);
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('running migrations again is idempotent and touches nothing', () => {
  const dir = makeTempDir('migraine-idempotent');
  try {
    const db = openDatabase(dir, { log: () => {} });
    try {
      db.prepare(`INSERT INTO attacks (id,start) VALUES ('a1','2026-02-02T00:00:00Z')`).run();
      const second = runMigrations(db, { log: () => {} });
      assert.equal(second, SCHEMA_VERSION);
      assert.equal(currentUserVersion(db), SCHEMA_VERSION);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attacks').get().n, 1);
      // baseline DDL really is IF NOT EXISTS: no table recreation errors
      db.prepare(`INSERT INTO meds (id,med_id,ts) VALUES ('m1','nurtec','2026-02-02T01:00:00Z')`).run();
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meds').get().n, 1);
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('a database newer than this build fails fast and is not modified', () => {
  const dir = makeTempDir('migraine-future-db');
  try {
    // Simulate a DB written by a newer server (rolled-back deployment).
    const file = join(dir, 'migraine.db');
    const newer = new DatabaseSync(file);
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.exec('CREATE TABLE marker (id TEXT PRIMARY KEY)');
    newer.prepare(`INSERT INTO marker (id) VALUES ('x')`).run();
    newer.close();

    const db = new DatabaseSync(file);
    try {
      assert.throws(() => runMigrations(db, { log: () => {} }), /newer than this build supports/);

      // prove no schema/data modification happened before the throw
      assert.equal(currentUserVersion(db), SCHEMA_VERSION + 1); // untouched
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all().map((r) => r.name);
      assert.deepEqual(tables, ['marker']); // no baseline tables were created
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM marker').get().n, 1);
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('openDatabase closes the handle when the version guard throws; original error preserved', () => {
  const dir = makeTempDir('migraine-future-open');
  try {
    const file = join(dir, 'migraine.db');
    const newer = new DatabaseSync(file);
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.close();

    let caught = null;
    try {
      openDatabase(dir, { log: () => {} });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, 'openDatabase throws on a future-version DB');
    assert.match(caught.message, /newer than this build supports/);

    // the failed open must not leak its handle: on Windows an open SQLite
    // handle makes this rmSync throw EPERM
    cleanupDir(dir);
    assert.equal(existsSync(dir), false);
  } finally {
    cleanupDir(dir); // force:true makes this idempotent
  }
});

test('a failing migration rolls back DDL and user_version; original error propagates', () => {
  const dir = makeTempDir('migraine-rollback');
  try {
    const db = openDatabase(dir, { log: () => {} }); // already at SCHEMA_VERSION
    try {
      const failing = [{
        version: SCHEMA_VERSION + 1,
        name: 'deliberately failing migration',
        up(database) {
          database.exec('CREATE TABLE should_rollback (id TEXT PRIMARY KEY)');
          throw new Error('boom: deliberate migration failure');
        },
      }];
      assert.throws(
        () => runMigrations(db, { log: () => {}, migrations: failing }),
        /boom: deliberate migration failure/,
      );
      // version and DDL rolled back together
      assert.equal(currentUserVersion(db), SCHEMA_VERSION);
      const rolled = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
      ).all();
      assert.equal(rolled.length, 0);
      // database is still usable afterwards
      db.prepare(`INSERT INTO attacks (id,start) VALUES ('a1','2026-03-03T00:00:00Z')`).run();
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attacks').get().n, 1);
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
