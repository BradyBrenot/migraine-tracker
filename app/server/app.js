// Fastify app factory: all routes, validation, export/import, and static
// serving. Returns a Fastify instance that is NOT listening, so tests can
// use inject() against a disposable database. The production entrypoint is
// index.js.

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  attackFromRow, attackToRow, medFromRow, medToRow, refillFromRow, refillToRow,
  workoutFromRow, workoutToRow, dayStateFromRow, dayStateToRow,
  baselineFromRow, baselineToRow,
} from './mappers.js';
import {
  attackErrors, medErrors, refillErrors, workoutErrors, dayStateErrors,
  baselineErrors, isValidDay, isValidSettingsKey, validateImportBody,
} from './validate.js';
import { exportEnvelope, collectSettings } from './snapshot.js';
import { parseBackup } from '../shared/backup.ts';
import { currentStock, classifyStock } from '../shared/inventory.ts';
import { isValidTimeZone } from '../shared/datetime.ts';
import { normalizeReminderSettings, reminderSettingsErrors } from '../shared/reminders.ts';

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// Treat a missing/garbage JSON body as {} (the old `req.body ?? {}` spread
// behavior); validators then produce a controlled 400 where required
// fields are absent.
const bodyObject = (req) => (isPlainObject(req.body) ? req.body : {});

export async function buildApp({
  db, distDir, logger = false, onAttackChange, notificationStatus,
} = {}) {
  const app = Fastify({ logger });

  // ── attacks ────────────────────────────────────────────────────────
  // onAttackChange is an optional synchronous notification hook (startup
  // wiring records attack alerts). It is never awaited and never allowed to
  // affect the status code or body; DELETE and bulk import never call it.
  function notifyAttackChange(event) {
    try {
      onAttackChange?.(event);
    } catch {
      // never fail the write
    }
  }

  app.get('/api/attacks', () =>
    db.prepare('SELECT * FROM attacks ORDER BY start').all().map(attackFromRow));

  app.post('/api/attacks', (req, reply) => {
    const body = bodyObject(req);
    const errors = attackErrors(body);
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const row = attackToRow({ ...body, id: body.id || uid() });
    db.prepare(`INSERT INTO attacks (id,start,"end",pain_log,peak_pain,symptoms,triggers,aura,notes,source)
      VALUES (@id,@start,@end,@pain_log,@peak_pain,@symptoms,@triggers,@aura,@notes,@source)`).run(row);
    const attack = attackFromRow(row);
    notifyAttackChange({ before: null, after: attack });
    reply.code(201);
    return attack;
  });

  app.patch('/api/attacks/:id', (req, reply) => {
    const existing = db.prepare('SELECT * FROM attacks WHERE id = ?').get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const patch = bodyObject(req);
    const errors = attackErrors(patch, { partial: true });
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    // null/undefined patch fields keep existing values; explicit nulls clear
    // (end/aura) exactly like the old spread merge. Only the patch fields
    // themselves are validated: dirty legacy rows (stored fields that predate
    // validation) must remain editable instead of being rejected wholesale.
    // The route id always wins over any id in the body.
    const merged = { ...attackFromRow(existing), ...patch, id: req.params.id };
    const row = attackToRow(merged);
    db.prepare(`UPDATE attacks SET start=@start,"end"=@end,pain_log=@pain_log,peak_pain=@peak_pain,
      symptoms=@symptoms,triggers=@triggers,aura=@aura,notes=@notes,source=@source WHERE id=@id`).run(row);
    const attack = attackFromRow(row);
    notifyAttackChange({ before: attackFromRow(existing), after: attack });
    return attack;
  });

  app.delete('/api/attacks/:id', (req, reply) => {
    const info = db.prepare('DELETE FROM attacks WHERE id = ?').run(req.params.id);
    if (!info.changes) return reply.code(404).send({ error: 'not found' });
    // keep meds but unlink
    db.prepare('UPDATE meds SET attack_id = NULL WHERE attack_id = ?').run(req.params.id);
    return { ok: true };
  });

  // ── meds ───────────────────────────────────────────────────────────
  app.get('/api/meds', () =>
    db.prepare('SELECT * FROM meds ORDER BY ts').all().map(medFromRow));

  app.post('/api/meds', (req, reply) => {
    const body = bodyObject(req);
    const errors = medErrors(body);
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const row = medToRow({ ...body, id: body.id || uid() });
    db.prepare(`INSERT INTO meds (id,med_id,ts,dose,quantity,attack_id,notes,source)
      VALUES (@id,@med_id,@ts,@dose,@quantity,@attack_id,@notes,@source)`).run(row);
    reply.code(201);
    return medFromRow(row);
  });

  app.patch('/api/meds/:id', (req, reply) => {
    const existing = db.prepare('SELECT * FROM meds WHERE id = ?').get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const patch = bodyObject(req);
    const errors = medErrors(patch, { partial: true });
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    // Validate only the patch (see the attacks PATCH note): dirty legacy
    // stored fields stay editable; route id wins over any body id. An
    // explicit null quantity clears the structured count (unknown again).
    const merged = { ...medFromRow(existing), ...patch, id: req.params.id };
    const row = medToRow(merged);
    db.prepare(`UPDATE meds SET med_id=@med_id,ts=@ts,dose=@dose,quantity=@quantity,
      attack_id=@attack_id,notes=@notes,source=@source WHERE id=@id`)
      .run(row);
    return medFromRow(row);
  });

  app.delete('/api/meds/:id', (req, reply) => {
    const info = db.prepare('DELETE FROM meds WHERE id = ?').run(req.params.id);
    if (!info.changes) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ── refills (pharmacy pickups) ─────────────────────────────────────
  app.get('/api/refills', () =>
    db.prepare('SELECT * FROM refills ORDER BY date').all().map(refillFromRow));

  app.post('/api/refills', (req, reply) => {
    const body = bodyObject(req);
    const errors = refillErrors(body);
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const row = refillToRow({ ...body, id: body.id || uid() });
    db.prepare('INSERT INTO refills (id,med_id,date,quantity,notes,source) VALUES (@id,@med_id,@date,@quantity,@notes,@source)').run(row);
    reply.code(201);
    return refillFromRow(row);
  });

  app.patch('/api/refills/:id', (req, reply) => {
    const existing = db.prepare('SELECT * FROM refills WHERE id = ?').get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const patch = bodyObject(req);
    const errors = refillErrors(patch, { partial: true });
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    // Same partial-merge rules as the other PATCH routes; quantity can be
    // set or cleared (null → unknown tablets) per correction.
    const merged = { ...refillFromRow(existing), ...patch, id: req.params.id };
    const row = refillToRow(merged);
    db.prepare('UPDATE refills SET med_id=@med_id,date=@date,quantity=@quantity,notes=@notes,source=@source WHERE id=@id')
      .run(row);
    return refillFromRow(row);
  });

  app.delete('/api/refills/:id', (req, reply) => {
    const info = db.prepare('DELETE FROM refills WHERE id = ?').run(req.params.id);
    if (!info.changes) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ── workouts (training log) ────────────────────────────────────────
  app.get('/api/workouts', () =>
    db.prepare('SELECT * FROM workouts ORDER BY performed_at').all().map(workoutFromRow));

  app.post('/api/workouts', (req, reply) => {
    const body = bodyObject(req);
    const errors = workoutErrors(body);
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const row = workoutToRow({ ...body, id: body.id || uid() });
    db.prepare(`INSERT INTO workouts (id,performed_at,kind,effort,duration_minutes,notes,source)
      VALUES (@id,@performed_at,@kind,@effort,@duration_minutes,@notes,@source)`).run(row);
    reply.code(201);
    return workoutFromRow(row);
  });

  app.patch('/api/workouts/:id', (req, reply) => {
    const existing = db.prepare('SELECT * FROM workouts WHERE id = ?').get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const patch = bodyObject(req);
    // Only patch fields are validated (see the attacks PATCH note); the route
    // id always wins over any id in the body.
    const errors = workoutErrors(patch, { partial: true });
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const merged = { ...workoutFromRow(existing), ...patch, id: req.params.id };
    const row = workoutToRow(merged);
    db.prepare(`UPDATE workouts SET performed_at=@performed_at,kind=@kind,effort=@effort,
      duration_minutes=@duration_minutes,notes=@notes,source=@source WHERE id=@id`).run(row);
    return workoutFromRow(row);
  });

  app.delete('/api/workouts/:id', (req, reply) => {
    const info = db.prepare('DELETE FROM workouts WHERE id = ?').run(req.params.id);
    if (!info.changes) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ── day states (one status per local calendar day) ─────────────────
  app.get('/api/day-states', () =>
    db.prepare('SELECT * FROM day_states ORDER BY day').all().map(dayStateFromRow));

  // Upsert: the :day path segment is the key, and updated_at is always set by
  // the server (client values are ignored) so the newest write always wins.
  app.put('/api/day-states/:day', (req, reply) => {
    if (!isValidDay(req.params.day)) {
      return reply.code(400).send({ error: 'day must be a real calendar date in YYYY-MM-DD form' });
    }
    const body = bodyObject(req);
    const errors = dayStateErrors(body);
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const row = dayStateToRow({
      ...body, day: req.params.day, updatedAt: new Date().toISOString(),
    });
    db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
      VALUES (@day,@status,@notes,@updated_at)
      ON CONFLICT(day) DO UPDATE SET status=excluded.status,notes=excluded.notes,updated_at=excluded.updated_at`)
      .run(row);
    return dayStateFromRow(row);
  });

  // ── stock baselines (absolute Nurtec counts: initial stock + corrections)
  app.get('/api/stock-baselines', () =>
    db.prepare('SELECT * FROM stock_baselines ORDER BY effective_at, created_at, id')
      .all()
      .map(baselineFromRow));

  // POST and PATCH always set created_at server-side; it only exists to
  // break exact-instant ties in the stock calculation.
  app.post('/api/stock-baselines', (req, reply) => {
    const body = bodyObject(req);
    const errors = baselineErrors(body);
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const row = baselineToRow(
      { ...body, id: body.id || uid(), createdAt: new Date().toISOString() },
    );
    db.prepare(`INSERT INTO stock_baselines (id,med_id,effective_at,quantity,notes,source,created_at)
      VALUES (@id,@med_id,@effective_at,@quantity,@notes,@source,@created_at)`).run(row);
    reply.code(201);
    return baselineFromRow(row);
  });

  app.patch('/api/stock-baselines/:id', (req, reply) => {
    const existing = db.prepare('SELECT * FROM stock_baselines WHERE id = ?').get(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const patch = bodyObject(req);
    const errors = baselineErrors(patch, { partial: true });
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const merged = { ...baselineFromRow(existing), ...patch, id: req.params.id };
    const row = baselineToRow(merged, existing.created_at); // createdAt is immutable
    db.prepare(`UPDATE stock_baselines SET med_id=@med_id,effective_at=@effective_at,
      quantity=@quantity,notes=@notes,source=@source,created_at=@created_at WHERE id=@id`)
      .run(row);
    return baselineFromRow(row);
  });

  app.delete('/api/stock-baselines/:id', (req, reply) => {
    const info = db.prepare('DELETE FROM stock_baselines WHERE id = ?').run(req.params.id);
    if (!info.changes) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ── authoritative inventory (currently Nurtec only) ────────────────
  // Current stock computed from DB records + settings via the SAME shared
  // pure calculation the browser uses (server is authoritative; the client
  // only mirrors it optimistically). The checkpoint 6 reminder scheduler
  // can call this domain calculation without any browser state.
  const DEFAULT_LOW_STOCK_THRESHOLD = 2;

  function inventoryTimeZone() {
    const tz = collectSettings(db).timezone;
    return typeof tz === 'string' && isValidTimeZone(tz) ? tz : 'UTC';
  }

  function lowStockThreshold() {
    const raw = collectSettings(db).lowStockThreshold;
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
      ? raw
      : DEFAULT_LOW_STOCK_THRESHOLD;
  }

  app.get('/api/inventory/nurtec', () => {
    const nowMs = Date.now();
    const baselines = db.prepare(
      "SELECT * FROM stock_baselines WHERE med_id = 'nurtec'").all().map(baselineFromRow);
    const doses = db.prepare(
      "SELECT id, ts, quantity FROM meds WHERE med_id = 'nurtec'").all();
    const refills = db.prepare(
      "SELECT id, date, quantity FROM refills WHERE med_id = 'nurtec'").all();
    const stock = currentStock(
      { baselines, doses, refills },
      { now: nowMs, timeZone: inventoryTimeZone() },
    );
    const threshold = lowStockThreshold();
    return {
      medId: 'nurtec',
      status: stock.status,
      quantity: stock.quantity,
      level: classifyStock(stock.quantity, threshold),
      threshold,
      low: stock.quantity !== null && stock.quantity <= threshold,
      negative: stock.quantity !== null && stock.quantity < 0,
      baselineId: stock.baselineId,
      baselineEffectiveAt: stock.baselineEffectiveAt,
      timeZone: inventoryTimeZone(),
      computedAt: new Date(nowMs).toISOString(),
    };
  });

  // ── settings (rules + dose defaults) ───────────────────────────────
  app.get('/api/settings', () => collectSettings(db));

  app.put('/api/settings/:key', (req, reply) => {
    if (!isValidSettingsKey(req.params.key)) {
      return reply.code(400).send({ error: 'invalid settings key' });
    }
    // Reminder preferences have a shared, strict shape. Delivery secrets are
    // environment-only: reserved keys are rejected above, nested secret-like
    // fields are rejected here, and only the known non-secret shape is stored.
    if (req.params.key === 'reminders') {
      const errors = reminderSettingsErrors(req.body);
      if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
      const normalized = normalizeReminderSettings(req.body);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(req.params.key, JSON.stringify(normalized));
      return { ok: true };
    }
    if (req.params.key === 'timezone') {
      if (typeof req.body !== 'string' || !isValidTimeZone(req.body)) {
        return reply.code(400).send({ error: 'timezone must be a valid IANA time zone' });
      }
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(req.params.key, JSON.stringify(req.body ?? null));
    return { ok: true };
  });

  // ── bulk import / export ───────────────────────────────────────────
  // Fastify's default 1 MiB body limit is far too small for a pretty-printed
  // nightly dump (indent + a full history easily exceeds it), so both bulk
  // routes opt into an explicit 25 MiB limit. Nothing else about the handlers
  // changes: /api/import stays additive and /api/restore stays destructive.
  const BACKUP_BODY_LIMIT = 25 * 1024 * 1024;
  // Import stays additive (INSERT OR IGNORE): duplicates and existing rows
  // are never overwritten, settings are not restored, and the whole payload
  // commits or rolls back atomically.
  app.post('/api/import', { bodyLimit: BACKUP_BODY_LIMIT }, (req, reply) => {
    const check = validateImportBody(req.body);
    if (!check.ok) return reply.code(400).send({ error: check.error });
    const { attacks, meds, refills, workouts, dayStates, stockBaselines } = check.value;
    const insertA = db.prepare(`INSERT OR IGNORE INTO attacks (id,start,"end",pain_log,peak_pain,symptoms,triggers,aura,notes,source)
      VALUES (@id,@start,@end,@pain_log,@peak_pain,@symptoms,@triggers,@aura,@notes,@source)`);
    const insertM = db.prepare(`INSERT OR IGNORE INTO meds (id,med_id,ts,dose,quantity,attack_id,notes,source)
      VALUES (@id,@med_id,@ts,@dose,@quantity,@attack_id,@notes,@source)`);
    const insertR = db.prepare(`INSERT OR IGNORE INTO refills (id,med_id,date,quantity,notes,source)
      VALUES (@id,@med_id,@date,@quantity,@notes,@source)`);
    const insertW = db.prepare(`INSERT OR IGNORE INTO workouts (id,performed_at,kind,effort,duration_minutes,notes,source)
      VALUES (@id,@performed_at,@kind,@effort,@duration_minutes,@notes,@source)`);
    const insertD = db.prepare(`INSERT OR IGNORE INTO day_states (day,status,notes,updated_at)
      VALUES (@day,@status,@notes,@updated_at)`);
    const insertB = db.prepare(`INSERT OR IGNORE INTO stock_baselines (id,med_id,effective_at,quantity,notes,source,created_at)
      VALUES (@id,@med_id,@effective_at,@quantity,@notes,@source,@created_at)`);
    db.exec('BEGIN');
    try {
      for (const a of attacks) insertA.run(attackToRow({ ...a, id: a.id || uid() }));
      for (const m of meds) insertM.run(medToRow({ ...m, id: m.id || uid(), source: m.source ?? 'import' }));
      for (const r of refills) insertR.run(refillToRow({ ...r, id: r.id || uid() }, 'import'));
      for (const w of workouts) insertW.run(workoutToRow({ ...w, id: w.id || uid(), source: w.source ?? 'import' }));
      // day_states keep any updatedAt present in the payload (so a restore
      // preserves history) and fall back to "now" when the field is absent;
      // stock_baselines do the same for createdAt.
      for (const d of dayStates) insertD.run(dayStateToRow(d));
      for (const b of stockBaselines) {
        insertB.run(baselineToRow({ ...b, id: b.id || uid(), source: b.source ?? 'import' }));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return {
      ok: true,
      attacks: attacks.length,
      meds: meds.length,
      refills: refills.length,
      workouts: workouts.length,
      dayStates: dayStates.length,
      stockBaselines: stockBaselines.length,
    };
  });

  // ── destructive restore ────────────────────────────────────────────
  // POST /api/restore REPLACES every user record and the restorable
  // non-secret settings (unlike additive /api/import). The whole payload is
  // parsed and re-validated before anything is written, duplicate keys are
  // rejected because a replacement must be byte-exact, and one transaction
  // clears the same rows /api/reset clears and inserts the backup. Internal
  // reminder bookkeeping is cleared too so old occurrences are not reused.
  // Direct attack alerts never fire here, matching import/reset.
  app.post('/api/restore', { bodyLimit: BACKUP_BODY_LIMIT }, (req, reply) => {
    // A missing body parses as undefined and fails, so a destructive request
    // can never wipe data by accident.
    const parsed = parseBackup(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const backup = parsed.backup;

    const duplicates = Object.entries(backup.duplicateCounts)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key}: ${count}`);
    if (duplicates.length) {
      return reply.code(400).send({ error: `duplicate ids in ${duplicates.join(', ')}` });
    }

    // Defense in depth: the shared parser is also bundled for the browser, so
    // the server's own item validators stay authoritative for what is written.
    const check = validateImportBody({
      schemaVersion: backup.schemaVersion ?? null,
      attacks: backup.attacks,
      meds: backup.meds,
      refills: backup.refills,
      workouts: backup.workouts,
      dayStates: backup.dayStates,
      stockBaselines: backup.stockBaselines,
    });
    if (!check.ok) return reply.code(400).send({ error: check.error });
    const { attacks, meds, refills, workouts, dayStates, stockBaselines } = check.value;

    // Plain INSERT (not OR IGNORE): duplicates were rejected above, and any
    // constraint failure must roll the whole replacement back.
    const insertA = db.prepare(`INSERT INTO attacks (id,start,"end",pain_log,peak_pain,symptoms,triggers,aura,notes,source)
      VALUES (@id,@start,@end,@pain_log,@peak_pain,@symptoms,@triggers,@aura,@notes,@source)`);
    const insertM = db.prepare(`INSERT INTO meds (id,med_id,ts,dose,quantity,attack_id,notes,source)
      VALUES (@id,@med_id,@ts,@dose,@quantity,@attack_id,@notes,@source)`);
    const insertR = db.prepare(`INSERT INTO refills (id,med_id,date,quantity,notes,source)
      VALUES (@id,@med_id,@date,@quantity,@notes,@source)`);
    const insertW = db.prepare(`INSERT INTO workouts (id,performed_at,kind,effort,duration_minutes,notes,source)
      VALUES (@id,@performed_at,@kind,@effort,@duration_minutes,@notes,@source)`);
    const insertD = db.prepare(`INSERT INTO day_states (day,status,notes,updated_at)
      VALUES (@day,@status,@notes,@updated_at)`);
    const insertB = db.prepare(`INSERT INTO stock_baselines (id,med_id,effective_at,quantity,notes,source,created_at)
      VALUES (@id,@med_id,@effective_at,@quantity,@notes,@source,@created_at)`);
    // Same storage shape as PUT /api/settings/:key (one JSON value per row).
    const insertS = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );

    db.exec('BEGIN');
    let envelope;
    try {
      db.exec(`DELETE FROM meds; DELETE FROM attacks; DELETE FROM refills; DELETE FROM workouts;
        DELETE FROM day_states; DELETE FROM stock_baselines; DELETE FROM settings;
        DELETE FROM reminder_occurrences; DELETE FROM reminder_state;`);
      // Record inserts use the same mappers/defaults as /api/import so a
      // restored envelope round-trips exactly (including payload updatedAt /
      // createdAt tie-breakers and the 'import' source default).
      for (const a of attacks) insertA.run(attackToRow({ ...a, id: a.id || uid() }));
      for (const m of meds) insertM.run(medToRow({ ...m, id: m.id || uid(), source: m.source ?? 'import' }));
      for (const r of refills) insertR.run(refillToRow({ ...r, id: r.id || uid() }, 'import'));
      for (const w of workouts) insertW.run(workoutToRow({ ...w, id: w.id || uid(), source: w.source ?? 'import' }));
      for (const d of dayStates) insertD.run(dayStateToRow(d));
      for (const b of stockBaselines) {
        insertB.run(baselineToRow({ ...b, id: b.id || uid(), source: b.source ?? 'import' }));
      }
      // Only whitelisted, validated keys reach backup.settings; skipped and
      // reserved keys are never written.
      for (const [key, value] of Object.entries(backup.settings)) {
        insertS.run(key, JSON.stringify(value));
      }
      // The canonical export is built INSIDE the transaction, before COMMIT.
      // Reading it after the commit would turn a read/parse failure (e.g. a
      // corrupted JSON settings column inherited from legacy data) into a 500
      // for an already-committed destructive replacement, leaving the client
      // with an uncertain outcome. Reading here means the route either returns
      // a fully valid envelope for a committed replacement or fails with the
      // ROLLBACK leaving everything untouched.
      envelope = exportEnvelope(db);
      db.exec('COMMIT');
    } catch (e) {
      // A failed write must leave the device exactly as it was. ROLLBACK
      // itself can fail when the connection already unwound; the original
      // error is the one worth surfacing.
      try {
        db.exec('ROLLBACK');
      } catch {
        // nothing to roll back
      }
      throw e;
    }
    return envelope;
  });

  app.get('/api/export', () => exportEnvelope(db));

  // Non-secret notification configuration only. Missing/malformed values are
  // false; extra fields (URLs, tokens, reasons) are never echoed.
  app.get('/api/health', () => ({
    ok: true,
    notifications: {
      reminders: notificationStatus?.reminders === true,
      attackAlerts: notificationStatus?.attackAlerts === true,
    },
  }));

  app.post('/api/reset', () => {
    db.exec(`DELETE FROM meds; DELETE FROM attacks; DELETE FROM refills; DELETE FROM workouts;
      DELETE FROM day_states; DELETE FROM stock_baselines; DELETE FROM settings;
      DELETE FROM reminder_occurrences; DELETE FROM reminder_state;`);
    return { ok: true };
  });

  // ── static frontend ────────────────────────────────────────────────
  if (distDir && existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir });
    // Partner shell exists only in a dist built by the current config; with a
    // stale dist (no view.html) /view falls back to the writer shell exactly
    // like before, and sendFile can never re-enter this handler (ENOENT would
    // callNotFound → infinite loop).
    const partnerEntry = existsSync(join(distDir, 'view.html')) ? 'view.html' : null;
    // SPA fallback: unknown non-API GETs → /view and nested partner routes get
    // the partner document (partner manifest); every other route gets the
    // writer document. Query strings must not affect the choice.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        const path = req.url.split('?')[0];
        const partner = partnerEntry && (path === '/view' || path.startsWith('/view/'));
        return reply.sendFile(partner ? partnerEntry : 'index.html');
      }
      reply.code(404).send({ error: 'not found' });
    });
  }

  // Tests rely on this to release the SQLite file handle; harmless in prod.
  app.addHook('onClose', async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  return app;
}
