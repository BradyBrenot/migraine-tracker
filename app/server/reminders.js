// Persistent reminder scheduler engine.
//
// Pure domain rules live in ../shared/reminders.ts. This module owns ONLY
// database transitions, condition re-evaluation, and transport calls. The
// clock and ntfy transport are injected, so tests never touch the network or
// the real clock. Internal reminder tables are not user backup content.

import { dayKeyStartMs, isValidTimeZone, localDayKey } from '../shared/datetime.ts';
import { baselineFromRow } from './mappers.js';
import { collectSettings } from './snapshot.js';
import {
  PREVENTIVE_INTERVALS, assessExercise, assessLowStock, checkInMissing,
  checkInOccurrenceKey, exerciseOccurrenceKey, isWithinWakingWindow,
  normalizeReminderSettings, preventiveDue, preventiveOccurrenceKey,
  stockOccurrenceKey, transientWindow,
} from '../shared/reminders.ts';

const PREVENTIVE_MEDS = [
  { id: 'emgality', name: 'Emgality' },
  { id: 'botox', name: 'Botox' },
];
const DEFAULT_LOW_STOCK_THRESHOLD = 2;
/** Bounded exponential backoff after a failed fetch or non-2xx response. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
const MAX_PER_TICK = 20;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createReminderEngine({
  db, transport, now = () => Date.now(), log = () => {},
} = {}) {
  if (typeof transport !== 'function') {
    throw new Error('reminder engine requires a transport');
  }

  let currentTick = null;

  function readSettings() {
    const raw = collectSettings(db);
    const timeZone = typeof raw.timezone === 'string' && isValidTimeZone(raw.timezone)
      ? raw.timezone
      : 'UTC';
    const threshold = Number.isInteger(raw.lowStockThreshold) && raw.lowStockThreshold >= 0
      ? raw.lowStockThreshold
      : DEFAULT_LOW_STOCK_THRESHOLD;
    return {
      reminders: normalizeReminderSettings(raw.reminders),
      timeZone,
      threshold,
      planned: isPlainObject(raw.planned) ? raw.planned : {},
    };
  }

  function buildContext(nowMs, settings) {
    const meds = db.prepare(
      "SELECT med_id, ts FROM meds WHERE med_id IN ('emgality','botox')",
    ).all().map((row) => ({ medId: row.med_id, ts: row.ts }));
    return {
      nowMs,
      settings,
      timeZone: settings.timeZone,
      day: localDayKey(nowMs, settings.timeZone),
      meds,
      dayStates: db.prepare('SELECT day, status FROM day_states').all(),
      workouts: db.prepare('SELECT performed_at, kind FROM workouts').all()
        .map((row) => ({ performedAt: row.performed_at, kind: row.kind })),
      attacks: db.prepare('SELECT start, "end" FROM attacks').all(),
      // Nurtec-only, exactly like GET /api/inventory/nurtec: a Tylenol
      // dose/refill/baseline must never move Nurtec stock (which would raise
      // false low-stock alerts). The inventory route is authoritative for the
      // scoping; keep these three predicates in sync with it.
      stock: {
        baselines: db.prepare(
          "SELECT * FROM stock_baselines WHERE med_id = 'nurtec'",
        ).all().map(baselineFromRow),
        doses: db.prepare(
          "SELECT id, ts, quantity FROM meds WHERE med_id = 'nurtec'",
        ).all(),
        refills: db.prepare(
          "SELECT id, date, quantity FROM refills WHERE med_id = 'nurtec'",
        ).all(),
      },
    };
  }

  // ── low-stock episode state (internal, never exported) ─────────────
  const LOW_STATE_KEY = 'low_stock';

  function readLowState() {
    const row = db.prepare('SELECT value FROM reminder_state WHERE key = ?').get(LOW_STATE_KEY);
    if (!row) return { phase: 'armed', episodeKey: null, episodeStartedAt: null };
    try {
      const value = JSON.parse(row.value);
      if (value && (value.phase === 'armed' || value.phase === 'low')) {
        return {
          phase: value.phase,
          episodeKey: typeof value.episodeKey === 'string' ? value.episodeKey : null,
          episodeStartedAt: typeof value.episodeStartedAt === 'string'
            ? value.episodeStartedAt : null,
        };
      }
    } catch {
      // corrupt internal state: treat as armed; a new low episode re-alerts.
    }
    return { phase: 'armed', episodeKey: null, episodeStartedAt: null };
  }

  function writeLowState(state, nowIso) {
    db.prepare(`INSERT INTO reminder_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(LOW_STATE_KEY, JSON.stringify(state), nowIso);
  }

  // ── occurrence bookkeeping ─────────────────────────────────────────
  const insertOccurrence = db.prepare(`INSERT OR IGNORE INTO reminder_occurrences
    (key, type, med_id, scheduled_at, expires_at, status, attempt, next_attempt_at,
     last_attempt_at, sent_at, last_error_category, last_error_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function ensurePending({
    key, type, medId = null, scheduledAt, expiresAt = null, nowIso,
  }) {
    const info = insertOccurrence.run(
      key, type, medId, scheduledAt, expiresAt, 'pending', 0, nowIso,
      null, null, null, null, nowIso, nowIso,
    );
    return info.changes > 0 ? 1 : 0;
  }

  /**
   * Record a skipped occurrence without ever re-sending. If a pending row
   * already exists it is transitioned; if none exists a terminal skipped row
   * is inserted so a later tick cannot resurrect the same occurrence key.
   */
  function recordSkip({
    key, type, medId = null, scheduledAt, expiresAt = null, reason, nowIso,
  }) {
    const updated = db.prepare(`UPDATE reminder_occurrences
      SET status = 'skipped', last_error_category = ?, updated_at = ?
      WHERE key = ? AND status = 'pending'`).run(reason, nowIso, key);
    if (updated.changes > 0) return 1;
    const inserted = insertOccurrence.run(
      key, type, medId, scheduledAt, expiresAt, 'skipped', 0, nowIso,
      null, null, reason, null, nowIso, nowIso,
    );
    return inserted.changes > 0 ? 1 : 0;
  }

  function skipPending(whereSql, params, reason, nowIso) {
    return db.prepare(`UPDATE reminder_occurrences
      SET status = 'skipped', last_error_category = ?, updated_at = ?
      WHERE status = 'pending' ${whereSql}`)
      .run(reason, nowIso, ...params).changes;
  }

  // ── occurrence generation (idempotent, deterministic keys) ────────
  function generate(ctx) {
    const { nowMs, settings, timeZone } = ctx;
    const reminders = settings.reminders;
    const nowIso = new Date(nowMs).toISOString();
    let generated = 0;
    let skipped = 0;

    // Preventive: one persistent occurrence per due episode (med + due day).
    for (const med of PREVENTIVE_MEDS) {
      const due = preventiveDue({
        medId: med.id,
        intervalDays: PREVENTIVE_INTERVALS[med.id],
        meds: ctx.meds,
        planned: settings.planned,
        now: nowMs,
        timeZone,
      });
      const currentKey = due.status === 'due' && due.dueDay
        ? preventiveOccurrenceKey(med.id, due.dueDay)
        : null;
      if (currentKey && reminders.preventive) {
        generated += ensurePending({
          key: currentKey,
          type: 'preventive',
          medId: med.id,
          scheduledAt: new Date(due.dueMs).toISOString(),
          nowIso,
        });
      }
      if (currentKey) {
        skipped += skipPending(
          "AND type = 'preventive' AND med_id = ? AND key <> ?",
          [med.id, currentKey], 'condition_gone', nowIso,
        );
      } else {
        // Not currently due (dose logged / planned moved / no schedule).
        skipped += skipPending(
          "AND type = 'preventive' AND med_id = ?",
          [med.id], 'condition_gone', nowIso,
        );
      }
    }

    // Low Nurtec stock: server-side episode, independent of the browser latch.
    const stock = assessLowStock({
      ...ctx.stock,
      now: nowMs,
      timeZone,
      threshold: settings.threshold,
    });
    let lowState = readLowState();
    if (stock.status === 'known' && !stock.low) {
      if (lowState.phase !== 'armed' || lowState.episodeKey !== null) {
        lowState = { phase: 'armed', episodeKey: null, episodeStartedAt: null };
        writeLowState(lowState, nowIso);
      }
      skipped += skipPending("AND type = 'stock'", [], 'condition_gone', nowIso);
    } else if (stock.status === 'known' && stock.low) {
      if (lowState.phase !== 'low' || !lowState.episodeKey) {
        lowState = {
          phase: 'low',
          episodeKey: nowIso,
          episodeStartedAt: nowIso,
        };
        writeLowState(lowState, nowIso);
      }
      const currentKey = stockOccurrenceKey(lowState.episodeKey);
      if (reminders.lowStock) {
        generated += ensurePending({
          key: currentKey,
          type: 'stock',
          medId: 'nurtec',
          scheduledAt: nowIso,
          nowIso,
        });
      }
      skipped += skipPending(
        "AND type = 'stock' AND key <> ?",
        [currentKey], 'condition_gone', nowIso,
      );
    }
    // Unknown stock: never alert. Existing pending rows are left in place but
    // send-time relevance returns false, so they cannot deliver.

    // Daily check-in: one occurrence per local day; transient grace window.
    if (reminders.checkIn) {
      const window = transientWindow(
        ctx.day, reminders.checkInTime, reminders.graceMinutes, timeZone,
      );
      if (nowMs >= window.scheduledMs) {
        const key = checkInOccurrenceKey(ctx.day);
        const base = {
          key,
          type: 'checkin',
          scheduledAt: window.scheduledAt,
          expiresAt: window.expiresAt,
          nowIso,
        };
        if (!checkInMissing(ctx.dayStates, ctx.day)) {
          skipped += recordSkip({ ...base, reason: 'condition_gone' });
        } else if (nowMs >= window.expiresMs) {
          skipped += recordSkip({ ...base, reason: 'expired' });
        } else {
          generated += ensurePending(base);
        }
      }
    }

    // Exercise: one occurrence per local day while the Sunday-week is behind.
    if (reminders.exercise) {
      const window = transientWindow(
        ctx.day, reminders.exerciseTime, reminders.graceMinutes, timeZone,
      );
      if (nowMs >= window.scheduledMs) {
        const key = exerciseOccurrenceKey(ctx.day);
        const assessment = assessExercise({
          workouts: ctx.workouts,
          dayStates: ctx.dayStates,
          attacks: ctx.attacks,
          day: ctx.day,
          now: nowMs,
          timeZone,
        });
        const base = {
          key,
          type: 'exercise',
          scheduledAt: window.scheduledAt,
          expiresAt: window.expiresAt,
          nowIso,
        };
        if (assessment.suppressed) {
          skipped += recordSkip({ ...base, reason: 'condition_gone' });
        } else if (nowMs >= window.expiresMs) {
          skipped += recordSkip({ ...base, reason: 'expired' });
        } else {
          generated += ensurePending(base);
        }
      }
    }

    return { generated, skipped };
  }

  // ── send-time relevance (conditions can disappear during retries) ──
  function typeEnabled(type, reminders) {
    if (type === 'preventive') return reminders.preventive;
    if (type === 'stock') return reminders.lowStock;
    if (type === 'checkin') return reminders.checkIn;
    if (type === 'exercise') return reminders.exercise;
    return false;
  }

  function occurrenceRelevant(row, ctx) {
    const { settings, timeZone } = ctx;
    const reminders = settings.reminders;
    if (row.type === 'preventive') {
      if (!reminders.preventive || !row.med_id) return false;
      const interval = PREVENTIVE_INTERVALS[row.med_id];
      if (!interval) return false;
      const due = preventiveDue({
        medId: row.med_id,
        intervalDays: interval,
        meds: ctx.meds,
        planned: settings.planned,
        now: ctx.nowMs,
        timeZone,
      });
      return due.status === 'due' && due.dueDay !== null
        && preventiveOccurrenceKey(row.med_id, due.dueDay) === row.key;
    }
    if (row.type === 'stock') {
      if (!reminders.lowStock) return false;
      const state = readLowState();
      if (state.phase !== 'low' || !state.episodeKey) return false;
      if (stockOccurrenceKey(state.episodeKey) !== row.key) return false;
      const stock = assessLowStock({
        ...ctx.stock,
        now: ctx.nowMs,
        timeZone,
        threshold: settings.threshold,
      });
      return stock.status === 'known' && stock.low;
    }
    if (row.type === 'checkin') {
      if (!reminders.checkIn) return false;
      return row.key === checkInOccurrenceKey(ctx.day)
        && checkInMissing(ctx.dayStates, ctx.day);
    }
    if (row.type === 'exercise') {
      if (!reminders.exercise) return false;
      if (row.key !== exerciseOccurrenceKey(ctx.day)) return false;
      const assessment = assessExercise({
        workouts: ctx.workouts,
        dayStates: ctx.dayStates,
        attacks: ctx.attacks,
        day: ctx.day,
        now: ctx.nowMs,
        timeZone,
      });
      return assessment.suppressed === null;
    }
    return false;
  }

  function formatDay(day, timeZone) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', timeZone,
    }).format(new Date(dayKeyStartMs(day, timeZone)));
  }

  function buildMessage(row, ctx) {
    const { timeZone, settings } = ctx;
    if (row.type === 'preventive') {
      const med = PREVENTIVE_MEDS.find((m) => m.id === row.med_id);
      const name = med ? med.name : row.med_id;
      const dueDay = row.key.split(':').slice(2).join(':');
      return {
        title: `${name} dose due`,
        body: `Your ${name} dose was due ${formatDay(dueDay, timeZone)}. `
          + 'Log it in the app when you take it.',
      };
    }
    if (row.type === 'stock') {
      const stock = assessLowStock({
        ...ctx.stock,
        now: ctx.nowMs,
        timeZone,
        threshold: settings.threshold,
      });
      const quantity = stock.quantity;
      return {
        title: 'Nurtec stock low',
        body: quantity !== null && quantity < 0
          ? `Recorded Nurtec stock is ${quantity} tablets (negative). Correct it in Settings.`
          : `${quantity} Nurtec tablets left, at or below your ${settings.threshold}-tablet alert level. `
            + 'Log a refill when you pick up more.',
      };
    }
    if (row.type === 'checkin') {
      return {
        title: 'Daily check-in',
        body: 'Log how you feel today: Well, Off, or Attack. One tap is enough.',
      };
    }
    const assessment = assessExercise({
      workouts: ctx.workouts,
      dayStates: ctx.dayStates,
      attacks: ctx.attacks,
      day: ctx.day,
      now: ctx.nowMs,
      timeZone,
    });
    if (assessment.state === 'off') {
      return {
        title: 'Gentle movement option',
        body: "Feeling off today? A 10-minute light walk or mobility counts. Log it when you're done.",
      };
    }
    return {
      title: 'Weekly movement check',
      body: 'Your weekly goals are still open: 2 strength and 3 cardio sessions. '
        + 'A short session still counts.',
    };
  }

  function classifyFailure(error) {
    if (error && typeof error.category === 'string') {
      return {
        category: error.category.slice(0, 40),
        status: Number.isInteger(error.status) ? error.status : null,
      };
    }
    return { category: 'unknown', status: null };
  }

  async function processPending(ctx) {
    const nowMs = ctx.nowMs;
    const nowIso = new Date(nowMs).toISOString();
    const rows = db.prepare(`SELECT * FROM reminder_occurrences
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY scheduled_at, key LIMIT ?`).all(nowIso, MAX_PER_TICK);
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of rows) {
      if (row.expires_at && nowIso >= row.expires_at) {
        skipped += recordSkip({
          key: row.key,
          type: row.type,
          medId: row.med_id,
          scheduledAt: row.scheduled_at,
          expiresAt: row.expires_at,
          reason: 'expired',
          nowIso,
        });
        continue;
      }
      if (!typeEnabled(row.type, ctx.settings.reminders)) {
        // Disabled per-type reminders are suppressed, not burned: a pending
        // persistent condition resumes when the user re-enables it.
        continue;
      }
      if (!occurrenceRelevant(row, ctx)) {
        skipped += skipPending(
          'AND key = ?', [row.key], 'condition_gone', nowIso,
        );
        continue;
      }
      // Persistent conditions wait for the next waking window; transient rows
      // were already skipped above once their grace period elapsed.
      if (!isWithinWakingWindow(nowMs, ctx.settings.reminders, ctx.timeZone)) continue;

      const claim = db.prepare(`UPDATE reminder_occurrences
        SET status = 'sending', attempt = attempt + 1, last_attempt_at = ?, updated_at = ?
        WHERE key = ? AND status = 'pending'`).run(nowIso, nowIso, row.key);
      if (!claim.changes) continue;

      const attempt = row.attempt + 1;
      try {
        const message = buildMessage(row, ctx);
        await transport(message);
        db.prepare(`UPDATE reminder_occurrences
          SET status = 'succeeded', sent_at = ?, next_attempt_at = ?,
              last_error_category = NULL, last_error_status = NULL, updated_at = ?
          WHERE key = ? AND status = 'sending'`)
          .run(nowIso, nowIso, nowIso, row.key);
        sent += 1;
      } catch (error) {
        const { category, status } = classifyFailure(error);
        const delayMinutes = BACKOFF_MINUTES[
          Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)
        ];
        const nextIso = new Date(nowMs + delayMinutes * 60000).toISOString();
        db.prepare(`UPDATE reminder_occurrences
          SET status = 'pending', next_attempt_at = ?, last_error_category = ?,
              last_error_status = ?, updated_at = ?
          WHERE key = ? AND status = 'sending'`)
          .run(nextIso, category, status, nowIso, row.key);
        failed += 1;
        // Category only; never an error message/URL/token/response body.
        log(`reminder delivery failed (${category})`);
      }
    }
    return { sent, failed, skipped };
  }

  async function runTick() {
    const nowMs = now();
    const settings = readSettings();
    if (!settings.reminders.enabled) {
      return { disabled: true, generated: 0, sent: 0, failed: 0, skipped: 0 };
    }
    const ctx = buildContext(nowMs, settings);
    const generated = generate(ctx);
    const delivery = await processPending(ctx);
    return {
      disabled: false,
      generated: generated.generated,
      sent: delivery.sent,
      failed: delivery.failed,
      skipped: generated.skipped + delivery.skipped,
    };
  }

  /**
   * Startup recovery for a process that died mid-send. The status was already
   * 'sending' (at-most-once transition); requeueing can duplicate a message
   * only if the HTTP request was accepted but the success write never ran.
   * This crash-around-send tradeoff is documented as a remaining risk.
   */
  function recoverInterrupted() {
    const nowIso = new Date(now()).toISOString();
    return db.prepare(`UPDATE reminder_occurrences
      SET status = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE status = 'sending'`).run(nowIso, nowIso).changes;
  }

  function tick() {
    if (currentTick) return currentTick;
    currentTick = runTick().finally(() => {
      currentTick = null;
    });
    return currentTick;
  }

  return { tick, recoverInterrupted };
}
