// Migraine Tracker backend — Fastify + node:sqlite (built into Node 24+,
// no native dependencies). Serves the REST API and the built frontend
// (dist/) from one process.
//
// Data model mirrors the frontend's types:
//   attacks: id, start, end, pain_log (JSON), peak_pain, symptoms (JSON),
//            triggers (JSON), aura, notes, source
//   meds:    id, med_id, ts, dose, attack_id, notes, source
//   settings: key/value (rules, doses)

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, 'data');
const PORT = Number(process.env.PORT ?? 3000);
const DIST_DIR = resolve(__dirname, '..', 'dist');

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'migraine.db'));
db.exec('PRAGMA journal_mode = WAL;');

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

const attackFromRow = (r) => ({
  id: r.id, start: r.start, end: r.end,
  painLog: JSON.parse(r.pain_log), peakPain: r.peak_pain,
  symptoms: JSON.parse(r.symptoms), triggers: JSON.parse(r.triggers),
  aura: r.aura === null || r.aura === undefined ? null : !!r.aura,
  notes: r.notes, source: r.source,
});
const attackToRow = (a) => ({
  id: a.id, start: a.start, end: a.end ?? null,
  pain_log: JSON.stringify(a.painLog ?? []), peak_pain: a.peakPain ?? -1,
  symptoms: JSON.stringify(a.symptoms ?? []), triggers: JSON.stringify(a.triggers ?? []),
  aura: a.aura === null || a.aura === undefined ? null : (a.aura ? 1 : 0),
  notes: a.notes ?? '', source: a.source ?? 'manual',
});
const medFromRow = (r) => ({
  id: r.id, medId: r.med_id, ts: r.ts, dose: r.dose,
  attackId: r.attack_id, notes: r.notes, source: r.source,
});
const medToRow = (m) => ({
  id: m.id, med_id: m.medId, ts: m.ts ?? new Date().toISOString(),
  dose: m.dose ?? '', attack_id: m.attackId ?? null,
  notes: m.notes ?? '', source: m.source ?? 'manual',
});

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const app = Fastify({ logger: true });

// ── attacks ──────────────────────────────────────────────────────────
app.get('/api/attacks', () =>
  db.prepare('SELECT * FROM attacks ORDER BY start').all().map(attackFromRow));

app.post('/api/attacks', (req, reply) => {
  const row = attackToRow({ ...(req.body ?? {}), id: req.body?.id || uid() });
  db.prepare(`INSERT INTO attacks (id,start,"end",pain_log,peak_pain,symptoms,triggers,aura,notes,source)
    VALUES (@id,@start,@end,@pain_log,@peak_pain,@symptoms,@triggers,@aura,@notes,@source)`).run(row);
  reply.code(201);
  return attackFromRow(row);
});

app.patch('/api/attacks/:id', (req, reply) => {
  const existing = db.prepare('SELECT * FROM attacks WHERE id = ?').get(req.params.id);
  if (!existing) return reply.code(404).send({ error: 'not found' });
  const merged = { ...attackFromRow(existing), ...(req.body ?? {}), id: req.params.id };
  const row = attackToRow(merged);
  db.prepare(`UPDATE attacks SET start=@start,"end"=@end,pain_log=@pain_log,peak_pain=@peak_pain,
    symptoms=@symptoms,triggers=@triggers,aura=@aura,notes=@notes,source=@source WHERE id=@id`).run(row);
  return attackFromRow(row);
});

app.delete('/api/attacks/:id', (req, reply) => {
  const info = db.prepare('DELETE FROM attacks WHERE id = ?').run(req.params.id);
  if (!info.changes) return reply.code(404).send({ error: 'not found' });
  // keep meds but unlink
  db.prepare('UPDATE meds SET attack_id = NULL WHERE attack_id = ?').run(req.params.id);
  return { ok: true };
});

// ── meds ─────────────────────────────────────────────────────────────
app.get('/api/meds', () =>
  db.prepare('SELECT * FROM meds ORDER BY ts').all().map(medFromRow));

app.post('/api/meds', (req, reply) => {
  const row = medToRow({ ...(req.body ?? {}), id: req.body?.id || uid() });
  if (!row.med_id) return reply.code(400).send({ error: 'medId required' });
  db.prepare(`INSERT INTO meds (id,med_id,ts,dose,attack_id,notes,source)
    VALUES (@id,@med_id,@ts,@dose,@attack_id,@notes,@source)`).run(row);
  reply.code(201);
  return medFromRow(row);
});

app.patch('/api/meds/:id', (req, reply) => {
  const existing = db.prepare('SELECT * FROM meds WHERE id = ?').get(req.params.id);
  if (!existing) return reply.code(404).send({ error: 'not found' });
  const merged = { ...medFromRow(existing), ...(req.body ?? {}), id: req.params.id };
  const row = medToRow(merged);
  db.prepare(`UPDATE meds SET med_id=@med_id,ts=@ts,dose=@dose,attack_id=@attack_id,notes=@notes,source=@source WHERE id=@id`)
    .run(row);
  return medFromRow(row);
});

app.delete('/api/meds/:id', (req, reply) => {
  const info = db.prepare('DELETE FROM meds WHERE id = ?').run(req.params.id);
  if (!info.changes) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

// ── refills (pharmacy pickups) ───────────────────────────────────────
const refillFromRow = (r) => ({
  id: r.id, medId: r.med_id, date: r.date, notes: r.notes, source: r.source,
});

app.get('/api/refills', () =>
  db.prepare('SELECT * FROM refills ORDER BY date').all().map(refillFromRow));

app.post('/api/refills', (req, reply) => {
  const r = req.body ?? {};
  const row = {
    id: r.id || uid(), med_id: r.medId, date: r.date,
    notes: r.notes ?? '', source: r.source ?? 'manual',
  };
  if (!row.med_id || !row.date) return reply.code(400).send({ error: 'medId and date required' });
  db.prepare('INSERT INTO refills (id,med_id,date,notes,source) VALUES (@id,@med_id,@date,@notes,@source)').run(row);
  reply.code(201);
  return refillFromRow(row);
});

app.delete('/api/refills/:id', (req, reply) => {
  const info = db.prepare('DELETE FROM refills WHERE id = ?').run(req.params.id);
  if (!info.changes) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

// ── settings (rules + dose defaults) ─────────────────────────────────
app.get('/api/settings', () => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
});

app.put('/api/settings/:key', (req) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(req.params.key, JSON.stringify(req.body ?? null));
  return { ok: true };
});

// ── bulk import / export ─────────────────────────────────────────────
app.post('/api/import', (req) => {
  const { attacks = [], meds = [], refills = [] } = req.body ?? {};
  const insertA = db.prepare(`INSERT OR IGNORE INTO attacks (id,start,"end",pain_log,peak_pain,symptoms,triggers,aura,notes,source)
    VALUES (@id,@start,@end,@pain_log,@peak_pain,@symptoms,@triggers,@aura,@notes,@source)`);
  const insertM = db.prepare(`INSERT OR IGNORE INTO meds (id,med_id,ts,dose,attack_id,notes,source)
    VALUES (@id,@med_id,@ts,@dose,@attack_id,@notes,@source)`);
  const insertR = db.prepare(`INSERT OR IGNORE INTO refills (id,med_id,date,notes,source)
    VALUES (@id,@med_id,@date,@notes,@source)`);
  db.exec('BEGIN');
  try {
    for (const a of attacks) insertA.run(attackToRow({ ...a, id: a.id || uid() }));
    for (const m of meds) insertM.run(medToRow({ ...m, id: m.id || uid(), source: m.source ?? 'import' }));
    for (const r of refills) insertR.run({
      id: r.id || uid(), med_id: r.medId, date: r.date,
      notes: r.notes ?? '', source: r.source ?? 'import',
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, attacks: attacks.length, meds: meds.length, refills: refills.length };
});

app.get('/api/export', () => ({
  attacks: db.prepare('SELECT * FROM attacks ORDER BY start').all().map(attackFromRow),
  meds: db.prepare('SELECT * FROM meds ORDER BY ts').all().map(medFromRow),
  refills: db.prepare('SELECT * FROM refills ORDER BY date').all().map(refillFromRow),
  settings: Object.fromEntries(
    db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)])),
}));

app.get('/api/health', () => ({ ok: true }));

app.post('/api/reset', () => {
  db.exec('DELETE FROM meds; DELETE FROM attacks; DELETE FROM refills; DELETE FROM settings;');
  return { ok: true };
});

// ── nightly JSON backup dump ─────────────────────────────────────────
// Writes a full export to <DATA_DIR>/backups/migraine-YYYY-MM-DD.json once
// per day, keeping ~31 days of history. The dataset is bind-mounted, so
// Backrest picks these files up on its normal schedule.
const BACKUP_DIR = join(DATA_DIR, 'backups');

function dumpBackup() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const file = join(BACKUP_DIR, `migraine-${today}.json`);
  if (existsSync(file)) return; // already done today
  const payload = JSON.stringify({
    exportedAt: new Date().toISOString(),
    attacks: db.prepare('SELECT * FROM attacks ORDER BY start').all().map(attackFromRow),
    meds: db.prepare('SELECT * FROM meds ORDER BY ts').all().map(medFromRow),
    refills: db.prepare('SELECT * FROM refills ORDER BY date').all().map(refillFromRow),
    settings: Object.fromEntries(
      db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)])),
  }, null, 2);
  writeFileSync(file, payload);
  // rotate: keep the newest 31 daily dumps
  const files = readdirSync(BACKUP_DIR).filter((f) => /^migraine-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - 31))) {
    unlinkSync(join(BACKUP_DIR, old));
  }
  console.log(`nightly backup written: ${file}`);
}

dumpBackup(); // on startup if today's dump doesn't exist yet
setInterval(dumpBackup, 3600_000); // then check hourly

// ── static frontend ──────────────────────────────────────────────────
if (existsSync(DIST_DIR)) {
  await app.register(fastifyStatic, { root: DIST_DIR });
  // SPA fallback: unknown non-API GETs → index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    reply.code(404).send({ error: 'not found' });
  });
}

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`migraine-tracker listening on :${PORT}, data in ${DATA_DIR}`);
});
