import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  Attack, DayState, DayStateStatus, MedEvent, Refill, StockBaseline, TrackerState,
  Workout, WorkoutEffort, WorkoutKind,
} from '@/types';
import { MED_CATALOG } from '@/lib/meds';
import { uid } from '@/lib/format';
import { buildSeedData } from '@/lib/seed';
import { api as backend } from '@/lib/api';
import { bumpClock } from '@/lib/clock';
import { isValidTimeZone, systemTimeZone } from '../../shared/datetime.ts';
import { decideHydration, deriveSyncStatus, shouldCleanOnDrain, type SyncStatus } from '../../shared/sync.ts';
import { currentStock, DEFAULT_LOW_STOCK_THRESHOLD } from '../../shared/inventory.ts';
import {
  DEFAULT_REMINDER_SETTINGS, normalizeReminderSettings, reminderSettingsErrors,
} from '../../shared/reminders.ts';
import type { BackupRecordKey, ParsedBackup } from '../../shared/backup.ts';

const STORAGE_KEY = 'migraine-tracker-v1';
/** Separate key so the existing state cache keeps loading untouched. */
const SYNC_META_KEY = 'migraine-tracker-sync-v1';

/**
 * Durable bookkeeping for a low-stock latch that was set while the server was
 * unreachable. TrackerState already caches `lowStockAlertedAt`, but a clean
 * hydration may legitimately replace it with the server snapshot — without
 * separate bookkeeping the fact "this low episode was already announced, and
 * the server must be told" would be lost on reload, letting a reachable
 * server stay unlatched and a later session toast the same episode again.
 *
 * This key is deliberately NOT sync state: writing or clearing it never sets
 * dirty/failed and never influences hydration decisions.
 */
const LATCH_PENDING_KEY = 'migraine-tracker-lowstock-pending-v1';

function loadPendingLatch(): string | null {
  try {
    const raw = localStorage.getItem(LATCH_PENDING_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { latchedAt?: unknown };
    return typeof parsed.latchedAt === 'string' ? parsed.latchedAt : null;
  } catch {
    return null;
  }
}

function storePendingLatch(latchedAt: string | null): void {
  try {
    if (latchedAt === null) localStorage.removeItem(LATCH_PENDING_KEY);
    else localStorage.setItem(LATCH_PENDING_KEY, JSON.stringify({ latchedAt }));
  } catch {
    // storage unavailable — the in-memory ref still guards this session
  }
}

/**
 * Persisted sync bookkeeping (both latches survive reloads):
 * - `dirty`: this browser holds changes the server has never confirmed. Set
 *   the moment a write is enqueued (not only on failure), so a reload before
 *   confirmation can never let hydration replace the change silently.
 * - `failed`: a write failed and no later success may clear it; only a
 *   confirmed full exchange (complete upload, clean hydration, explicit
 *   use-server, confirmed reset) resolves it. Invariant: failed ⇒ dirty.
 *
 * Legacy shape note: older versions stored `{ dirty, diverged }` where dirty
 * was only set on failure. Any legacy marker therefore maps to BOTH latches —
 * the conservative reading (unconfirmed and unresolved).
 */
interface SyncMeta {
  dirty: boolean;
  failed: boolean;
}

const CLEAN_META: SyncMeta = { dirty: false, failed: false };

function loadSyncMeta(): SyncMeta {
  try {
    const raw = localStorage.getItem(SYNC_META_KEY);
    if (!raw) return { ...CLEAN_META };
    const parsed = JSON.parse(raw) as Partial<SyncMeta & { diverged?: boolean }>;
    const unconfirmed = parsed.dirty === true || parsed.diverged === true;
    return { dirty: unconfirmed, failed: unconfirmed };
  } catch {
    return { ...CLEAN_META };
  }
}

function defaultRules(): TrackerState['rules'] {
  const rules: TrackerState['rules'] = {};
  for (const m of MED_CATALOG) {
    if (m.defaultRule) rules[m.id] = { ...m.defaultRule };
  }
  return rules;
}

const DEFAULT_DOSES: Record<string, string> = {
  nurtec: '75 mg',
  tylenol: '500 mg',
  ibuprofen: '400 mg',
  naproxen: '220 mg',
};

/**
 * Default Nurtec low-stock alert level (plan: 2 tablets). The value lives in
 * shared/inventory.ts so the server's authoritative inventory route and the
 * reminder scheduler use the identical default; it is re-exported here to keep
 * the store's existing public shape (Settings/tests import it from here).
 */
export { DEFAULT_LOW_STOCK_THRESHOLD };

function isValidThreshold(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function emptyState(): TrackerState {
  return {
    attacks: [], meds: [], refills: [], workouts: [], dayStates: [],
    stockBaselines: [],
    rules: defaultRules(), doses: { ...DEFAULT_DOSES }, planned: {},
    timezone: systemTimeZone(),
    lowStockThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
    reminders: { ...DEFAULT_REMINDER_SETTINGS },
    lowStockAlertedAt: null,
    seeded: false,
  };
}

function loadState(): TrackerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as TrackerState;
    return {
      ...emptyState(),
      ...parsed,
      rules: { ...defaultRules(), ...(parsed.rules ?? {}) },
      doses: { ...DEFAULT_DOSES, ...(parsed.doses ?? {}) },
      planned: { ...(parsed.planned ?? {}) },
      // Older caches (and hand-edited data) may omit or corrupt the newer
      // arrays; a cache read must never hand the app a non-array.
      workouts: Array.isArray(parsed.workouts) ? parsed.workouts : [],
      dayStates: Array.isArray(parsed.dayStates) ? parsed.dayStates : [],
      stockBaselines: Array.isArray(parsed.stockBaselines) ? parsed.stockBaselines : [],
      timezone:
        typeof parsed.timezone === 'string' && isValidTimeZone(parsed.timezone)
          ? parsed.timezone
          : systemTimeZone(),
      lowStockThreshold: isValidThreshold(parsed.lowStockThreshold)
        ? parsed.lowStockThreshold
        : DEFAULT_LOW_STOCK_THRESHOLD,
      reminders: normalizeReminderSettings(parsed.reminders),
      lowStockAlertedAt:
        typeof parsed.lowStockAlertedAt === 'string' ? parsed.lowStockAlertedAt : null,
    };
  } catch {
    return emptyState();
  }
}

/** Legacy-peak derivation across the pain log (and an explicitly set peak).
 * Only used when the stored peak is unknown (-1); an explicit or previously
 * derived peak is authoritative and must not be rescan-resurrected. */
function recomputePeak(a: Attack): number {
  const levels = a.painLog.map((p) => p.level);
  if (a.peakPain >= 0) levels.push(a.peakPain);
  return levels.length ? Math.max(...levels) : -1;
}

/**
 * Runtime id guard for patch payloads.
 *
 * The store's public patch signatures already omit `id`, but JavaScript (or
 * `any`) callers can still pass one. A body id must never reassign a record:
 * the route/record id always wins, locally and on the wire. `undefined`
 * values are dropped too — JSON cannot transmit them, so treating such a key
 * as absent keeps the optimistic merge and the wire payload identical
 * (an explicit `null` is a meaningful clear and is kept). Returns a shallow
 * copy, so the caller's object is never mutated.
 */
function cleanPatch<T extends { id: string }>(patch: Partial<T>): Partial<Omit<T, 'id'>> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || value === undefined) continue;
    copy[key] = value;
  }
  return copy as Partial<Omit<T, 'id'>>;
}

/**
 * Minimal wire body for a record PATCH: only fields whose value in `next`
 * actually differs from `current`, and never `id` (the route id is
 * authoritative). `next` is the fully computed record, not the raw caller
 * patch, so derived fields (e.g. an attack's legacy peak) are still
 * transmitted when the local merge changed them.
 *
 * Comparison is structural (plain JSON data — the same shape that is
 * persisted and sent), so key presence matters: an explicit `null` clear
 * differs from a value and is kept, while unchanged arrays/objects are not
 * resent. An empty result means "nothing changed" and must not be sent.
 */
function changedFields<T extends object>(current: T, next: T): Partial<T> {
  const before = current as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const diff: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (key === 'id') continue;
    if (!sameContent(before[key], after[key])) diff[key] = after[key];
  }
  return diff as Partial<T>;
}

function hasChanges(patch: object): boolean {
  return Object.keys(patch).length > 0;
}

type ExportShape = Awaited<ReturnType<typeof backend.exportAll>>;

/** Parse the persisted low-stock alert latch out of the server setting. */
function lowStockAlertedAtFromSetting(value: unknown): string | null {
  const latchedAt = isPlainRecord(value) ? value.latchedAt : undefined;
  return typeof latchedAt === 'string' ? latchedAt : null;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Map a server export onto local state fields. Server is canonical; a valid
 * server timezone wins, otherwise the browser zone is kept. */
function serverSnapshotToState(data: ExportShape, fallbackTz: string): Partial<TrackerState> {
  const tzRaw = data.settings?.timezone;
  const snapshot: Partial<TrackerState> = {
    attacks: data.attacks as Attack[],
    meds: data.meds as MedEvent[],
    refills: ((data.refills ?? []) as Refill[]),
    workouts: ((data.workouts ?? []) as Workout[]),
    dayStates: ((data.dayStates ?? []) as DayState[]),
    stockBaselines: ((data.stockBaselines ?? []) as StockBaseline[]),
    rules: { ...defaultRules(), ...((data.settings?.rules as TrackerState['rules']) ?? {}) },
    doses: { ...DEFAULT_DOSES, ...((data.settings?.doses as Record<string, string>) ?? {}) },
    planned: { ...((data.settings?.planned as Record<string, string>) ?? {}) },
    timezone: typeof tzRaw === 'string' && isValidTimeZone(tzRaw) ? tzRaw : fallbackTz,
    lowStockAlertedAt: lowStockAlertedAtFromSetting(data.settings?.lowStockAlert),
  };
  // The threshold is only adopted when the server holds a valid one; a
  // server that predates the setting must not reset the local choice.
  if (isValidThreshold(data.settings?.lowStockThreshold)) {
    snapshot.lowStockThreshold = data.settings?.lowStockThreshold;
  }
  // Same policy for reminder preferences: adopt a server object when present;
  // otherwise keep the browser's local defaults/choices. The server scheduler
  // normalizes defensively, and secrets never live in this setting.
  if (isPlainRecord(data.settings?.reminders)) {
    snapshot.reminders = normalizeReminderSettings(data.settings.reminders);
  }
  return snapshot;
}

/** Every record type a backup can restore, in preview order. */
const BACKUP_RECORD_KEYS: readonly BackupRecordKey[] = [
  'attacks', 'meds', 'refills', 'workouts', 'dayStates', 'stockBaselines',
];

/**
 * Identity used for additive dedup. A missing/null/empty id means the server
 * will generate one, so such a record can never collide with an existing one.
 */
function backupIdKey(id: unknown): string {
  return typeof id === 'string' ? id : '';
}

/**
 * Keep only records an additive merge must add: day states key on `day`,
 * everything else on `id`. An empty id has no identity yet — the server
 * generates one — so it can never collide and always counts as new.
 * `existingKeys` is mutated so repeated keys inside one backup window are not
 * added twice (parseBackup already keeps the first of each non-empty key).
 */
function keepNewRecords<T>(
  existingKeys: Set<string>,
  incoming: readonly T[],
  keyOf: (record: T) => string,
): T[] {
  const added: T[] = [];
  for (const record of incoming) {
    const key = keyOf(record);
    if (key !== '') {
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
    }
    added.push(record);
  }
  return added;
}

/** The six record arrays a backup restores, keyed like TrackerState. */
type BackupRecords = Pick<
  TrackerState,
  'attacks' | 'meds' | 'refills' | 'workouts' | 'dayStates' | 'stockBaselines'
>;

/**
 * Copy every backup record into a fully-defaulted TrackerState record before
 * it is sent OR applied.
 *
 * `parseBackup` validates but deliberately keeps the ORIGINAL objects, and a
 * legal/legacy record may omit optional fields. The app — not the server —
 * sorts and renders these records, so a raw record (a baseline without
 * `createdAt`, an attack without `symptoms`) would crash a comparator or a
 * page. The defaults below mirror the server mappers exactly
 * (server/mappers.js): attacks default `source` to 'manual' (attackToRow),
 * while the bulk import/restore paths default meds, refills, workouts and
 * baselines to 'import'; absent `updatedAt`/`createdAt`/`ts` become "now".
 *
 * Ids: a blank/missing id gets one here so the local record, the wire payload
 * and the server row share it (without this the optimistic copy could never
 * edit or delete the server row). Day states are keyed by `day`, no id.
 *
 * Records are copied, never mutated; one timestamp is captured here so every
 * defaulted time field in this merge/replace pass is identical locally and on
 * the wire.
 */
function normalizedBackupRecords(backup: ParsedBackup): BackupRecords {
  const nowIso = new Date().toISOString();
  return {
    attacks: backup.attacks.map((a): Attack => ({
      id: a.id || uid(),
      start: a.start,
      end: a.end ?? null,
      painLog: [...(a.painLog ?? [])],
      peakPain: a.peakPain ?? -1,
      symptoms: [...(a.symptoms ?? [])],
      triggers: [...(a.triggers ?? [])],
      aura: a.aura ?? null,
      notes: a.notes ?? '',
      source: a.source ?? 'manual',
    })),
    meds: backup.meds.map((m): MedEvent => ({
      id: m.id || uid(),
      medId: m.medId,
      ts: m.ts ?? nowIso,
      dose: m.dose ?? '',
      quantity: m.quantity ?? null,
      attackId: m.attackId ?? null,
      notes: m.notes ?? '',
      source: m.source ?? 'import',
    })),
    refills: backup.refills.map((r): Refill => ({
      id: r.id || uid(),
      medId: r.medId,
      date: r.date,
      quantity: r.quantity ?? null,
      notes: r.notes ?? '',
      source: r.source ?? 'import',
    })),
    workouts: backup.workouts.map((w): Workout => ({
      id: w.id || uid(),
      performedAt: w.performedAt,
      kind: w.kind,
      effort: w.effort,
      durationMinutes: w.durationMinutes ?? null,
      notes: w.notes ?? '',
      source: w.source ?? 'import',
    })),
    dayStates: backup.dayStates.map((d): DayState => ({
      day: d.day,
      status: d.status,
      notes: d.notes ?? '',
      updatedAt: d.updatedAt ?? nowIso,
    })),
    stockBaselines: backup.stockBaselines.map((b): StockBaseline => ({
      id: b.id || uid(),
      medId: b.medId,
      effectiveAt: b.effectiveAt,
      quantity: b.quantity,
      notes: b.notes ?? '',
      source: b.source ?? 'import',
      createdAt: b.createdAt ?? nowIso,
    })),
  };
}

// Sort orders match the store's own mutation conventions (see the array
// updates below): attacks by start, meds by ts, refills by date, workouts by
// performedAt, day states by day, baselines by effectiveAt then createdAt.
const byAttackStart = (a: Attack, b: Attack): number => a.start.localeCompare(b.start);
const byMedTs = (a: MedEvent, b: MedEvent): number => a.ts.localeCompare(b.ts);
const byRefillDate = (a: Refill, b: Refill): number => a.date.localeCompare(b.date);
const byWorkoutPerformedAt = (a: Workout, b: Workout): number =>
  a.performedAt.localeCompare(b.performedAt);
const byDayStateDay = (a: DayState, b: DayState): number => a.day.localeCompare(b.day);
const byBaselineEffectiveAt = (a: StockBaseline, b: StockBaseline): number =>
  a.effectiveAt.localeCompare(b.effectiveAt) || a.createdAt.localeCompare(b.createdAt);

/** The settings a replacement restores, in TrackerState shape. */
type RestoredSettings = Pick<
  TrackerState,
  | 'rules' | 'doses' | 'planned' | 'timezone' | 'lowStockThreshold'
  | 'reminders' | 'lowStockAlertedAt'
>;

/**
 * Effective replacement settings: every key present in the backup, and the
 * same defaults `emptyState()` uses for absent ones. Deliberately NOT
 * `serverSnapshotToState`, whose partial-hydration policy keeps the local
 * threshold/reminders/timezone when the server omits them (a legacy server
 * must not reset a local choice). A replacement is not hydration: it restores
 * the backup exactly, so absent settings take DEFAULTS and therefore agree
 * between browser-only and connected restores.
 *
 * This is the single projection used by both the local adoption and the
 * connected wire payload (see `restorePayloadSettings`), so the server can
 * never persist a different effective setting than the browser shows.
 */
function restoredSettingsFrom(backup: ParsedBackup): RestoredSettings {
  return {
    rules: { ...defaultRules(), ...((backup.settings.rules as TrackerState['rules']) ?? {}) },
    doses: { ...DEFAULT_DOSES, ...((backup.settings.doses as Record<string, string>) ?? {}) },
    planned: { ...((backup.settings.planned as Record<string, string>) ?? {}) },
    timezone: backup.settings.timezone ?? systemTimeZone(),
    lowStockThreshold: backup.settings.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD,
    // The parser normalizes reminders when present, so absent means "not in
    // the backup" → the defaults, exactly like a fresh state.
    reminders: backup.settings.reminders ?? { ...DEFAULT_REMINDER_SETTINGS },
    lowStockAlertedAt: backup.settings.lowStockAlert?.latchedAt ?? null,
  };
}

/**
 * Wire shape of a replacement's settings (server storage names). Sending the
 * FULL defaulted projection matters: /api/restore stores only the keys present
 * in the payload, so a legacy backup without settings would otherwise leave
 * the server with none while the browser adopts defaults locally.
 */
function restorePayloadSettings(settings: RestoredSettings) {
  return {
    rules: settings.rules,
    doses: settings.doses,
    planned: settings.planned,
    timezone: settings.timezone,
    lowStockThreshold: settings.lowStockThreshold,
    lowStockAlert: { latchedAt: settings.lowStockAlertedAt },
    reminders: settings.reminders,
  };
}

/**
 * Full-replacement state from a parsed backup and its normalized records.
 * Connected restores take RECORDS from the returned canonical envelope
 * (server-generated fields, echoed ids) but the SAME `settings` projection
 * that was sent to the server. `seeded` is a local-only marker; merge never
 * touches it.
 */
function restoredBackupState(
  backup: ParsedBackup,
  records: BackupRecords,
  settings: RestoredSettings,
): TrackerState {
  return {
    attacks: [...records.attacks].sort(byAttackStart),
    meds: [...records.meds].sort(byMedTs),
    refills: [...records.refills].sort(byRefillDate),
    workouts: [...records.workouts].sort(byWorkoutPerformedAt),
    dayStates: [...records.dayStates].sort(byDayStateDay),
    stockBaselines: [...records.stockBaselines].sort(byBaselineEffectiveAt),
    ...settings,
    seeded: backup.seeded ?? false,
  };
}

/**
 * Deep-compare idiom used by the rebase: the repo already compares reminder
 * drafts with JSON.stringify, and these values are plain JSON data (the same
 * thing that is persisted and sent on the wire), so structural differences
 * are exactly what matters. Key order is stable for locally mutated records
 * (spread keeps it), so this does not report spurious edits.
 */
function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Three-way record rebase for a connected replacement.
 *
 * `base` is the state captured when replaceBackup was invoked, `current` the
 * live state (writes made later are applied optimistically), and `restored`
 * the replacement built from the server's canonical envelope. Later writes'
 * server tasks are ALREADY QUEUED BEHIND the restore in the serialized queue,
 * so once the queue drains the server holds the backup plus those later
 * effects; keeping them locally is what makes the two agree. Rules per key
 * (`id`; day states by `day`):
 * - in `current` but not `base` → added after invocation → keep current;
 * - in `base` but not `current` → deleted after invocation → must stay absent;
 * - in both with different content → edited after invocation → keep current;
 * - otherwise → the `restored` version (server-generated fields and ids).
 *
 * Known corner: any queued write that targets a record the restored backup
 * does NOT contain hits a 404 after the restore, latching `failed`. That
 * covers deletions (queued DELETE) AND edits of such records (queued PATCH):
 * the replacement erased the row the request addresses. Local state stays
 * correct and the latch behaves like any other failed write (sticky until a
 * confirmed full exchange) — no special case is worth corrupting the local
 * view for.
 */
function rebaseRecords<T>(
  base: readonly T[],
  current: readonly T[],
  restored: readonly T[],
  keyOf: (record: T) => string,
): T[] {
  const baseByKey = new Map(base.map((record) => [keyOf(record), record]));
  const currentByKey = new Map(current.map((record) => [keyOf(record), record]));
  const result = new Map<string, T>();
  for (const record of restored) {
    const key = keyOf(record);
    if (baseByKey.has(key) && !currentByKey.has(key)) continue;
    result.set(key, record);
  }
  for (const [key, record] of currentByKey) {
    const before = baseByKey.get(key);
    if (before === undefined || !sameContent(before, record)) result.set(key, record);
  }
  return [...result.values()];
}

/**
 * Three-way rebase of the replacement's settings: a field the user changed
 * after invocation keeps its local value; every other field follows the
 * backup (with defaults for absent keys). See `rebaseRecords`.
 */
function rebaseRestoreState(
  base: TrackerState,
  current: TrackerState,
  restored: TrackerState,
): TrackerState {
  const changed = (field: keyof TrackerState): boolean =>
    !sameContent(base[field], current[field]);
  return {
    attacks: rebaseRecords(base.attacks, current.attacks, restored.attacks, (a) => a.id)
      .sort(byAttackStart),
    meds: rebaseRecords(base.meds, current.meds, restored.meds, (m) => m.id).sort(byMedTs),
    refills: rebaseRecords(base.refills, current.refills, restored.refills, (r) => r.id)
      .sort(byRefillDate),
    workouts: rebaseRecords(base.workouts, current.workouts, restored.workouts, (w) => w.id)
      .sort(byWorkoutPerformedAt),
    dayStates: rebaseRecords(
      base.dayStates, current.dayStates, restored.dayStates, (d) => d.day,
    ).sort(byDayStateDay),
    stockBaselines: rebaseRecords(
      base.stockBaselines, current.stockBaselines, restored.stockBaselines, (b) => b.id,
    ).sort(byBaselineEffectiveAt),
    rules: changed('rules') ? current.rules : restored.rules,
    doses: changed('doses') ? current.doses : restored.doses,
    planned: changed('planned') ? current.planned : restored.planned,
    timezone: changed('timezone') ? current.timezone : restored.timezone,
    lowStockThreshold: changed('lowStockThreshold')
      ? current.lowStockThreshold : restored.lowStockThreshold,
    reminders: changed('reminders') ? current.reminders : restored.reminders,
    lowStockAlertedAt: changed('lowStockAlertedAt')
      ? current.lowStockAlertedAt : restored.lowStockAlertedAt,
    seeded: changed('seeded') ? current.seeded : restored.seeded,
  };
}

export interface StoreApi {
  state: TrackerState;
  activeAttack: Attack | null;
  /**
   * true for the partner viewer: state is fetched from the server snapshot,
   * mutations are disabled, and no localStorage/sync bookkeeping is used.
   */
  readOnly: boolean;
  /** true once we've confirmed a backend is reachable */
  serverMode: boolean;
  /** sync health for compact UI surfaces (Layout pill, Settings) */
  sync: {
    status: SyncStatus;
    /** queued writes currently in flight */
    pending: number;
    /** local changes not confirmed on the server */
    dirty: boolean;
    /** a write failed; resolved only by a confirmed full exchange */
    failed: boolean;
    /** divergence detected; server writes paused until explicit resolution */
    diverged: boolean;
  };
  // attacks
  startAttack: (start?: Date) => Attack;
  endAttack: (id: string, end?: Date) => void;
  updateAttack: (id: string, patch: Partial<Omit<Attack, 'id'>>) => void;
  deleteAttack: (id: string) => void;
  logPain: (attackId: string, level: number, when?: Date) => void;
  // meds
  logMed: (medId: string, when?: Date, attackId?: string | null, dose?: string, notes?: string, quantity?: number | null) => MedEvent;
  updateMed: (id: string, patch: Partial<Omit<MedEvent, 'id'>>) => void;
  deleteMed: (id: string) => void;
  // refills (pharmacy pickups)
  addRefill: (medId: string, date: string, notes?: string, quantity?: number | null) => Refill;
  updateRefill: (id: string, patch: Partial<Omit<Refill, 'id'>>) => void;
  deleteRefill: (id: string) => void;
  // stock baselines (dated absolute Nurtec counts)
  addStockBaseline: (input: { medId: string; effectiveAt?: string; quantity: number; notes?: string }) => StockBaseline;
  updateStockBaseline: (id: string, patch: Partial<Omit<StockBaseline, 'id' | 'createdAt'>>) => void;
  deleteStockBaseline: (id: string) => void;
  // workouts (training log)
  addWorkout: (input: {
    performedAt?: string;
    kind: WorkoutKind;
    effort: WorkoutEffort;
    durationMinutes?: number | null;
    notes?: string;
  }) => Workout;
  updateWorkout: (id: string, patch: Partial<Omit<Workout, 'id'>>) => void;
  deleteWorkout: (id: string) => void;
  // day states (one explicit status per local day)
  setDayState: (day: string, status: DayStateStatus, notes?: string) => void;
  // settings
  setTimezone: (tz: string) => void;
  setLowStockThreshold: (tablets: number) => void;
  /**
   * Merge + validate non-secret reminder preferences. Returns validation
   * errors (and applies nothing) when the merge is invalid.
   */
  updateReminders: (patch: Partial<TrackerState['reminders']>) => string[];
  /** Clear the one-shot low-stock alert latch without waiting for replenishment. */
  resetLowStockAlert: () => void;
  // bulk
  importData: (attacks: Attack[], meds: MedEvent[]) => void;
  setRule: (medId: string, limit: number, windowDays: number) => void;
  setDoseDefault: (medId: string, dose: string) => void;
  setPlannedDose: (medId: string, date: string | null) => void;
  loadDemoData: () => void;
  /**
   * Destructive local + server erase.
   *
   * The local erase is synchronous and optimistic (state, low-stock
   * bookkeeping and the divergence pause are cleared before the server task is
   * queued). The returned promise resolves only once the serialized task has
   * fully completed — `/api/reset` confirmed AND the follow-up timezone
   * re-publication confirmed inside the same task — and after that task's
   * queue bookkeeping (pending counter, dirty/failed latches) has run, so an
   * awaiter that reads `sync` sees the final state. It rejects when that task
   * fails (reset or timezone publish) or under the normal offline/diverged
   * queue rejection; the dirty/failed latches keep their existing behaviour
   * either way. Report success to the user only after it resolves.
   *
   * The generic "Server sync failed" toast is suppressed for this task
   * (`suppressSyncErrorToast`): Settings shows its own specific
   * "Erased in this browser — server erase unconfirmed" error instead. The
   * console log and dirty/failed latches are unchanged.
   */
  resetAll: () => Promise<void>;
  /**
   * Conflict resolution (explicit + destructive): discard this browser's
   * unsynced state and adopt the current server snapshot. Export a local
   * backup first — Settings offers that before this action.
   */
  resolveUseServer: () => Promise<void>;
  /**
   * Additive JSON-backup merge: only records whose key (id; dayStates by day)
   * is missing locally. Settings are never touched. `added` reports per-type
   * counts; `synced` resolves once the additive server import (if any) is
   * confirmed and rejects under the normal offline/diverged queue rules.
   */
  mergeBackup: (backup: ParsedBackup) => {
    added: Record<BackupRecordKey, number>;
    synced: Promise<void>;
  };
  /**
   * Destructive JSON-backup replacement. Connected: awaits the atomic
   * server restore and adopts the returned canonical snapshot (never an
   * optimistic local erase). Browser-only: applies locally and stays
   * dirty/failed until a full exchange confirms it.
   */
  replaceBackup: (backup: ParsedBackup) => Promise<void>;
}

const StoreCtx = createContext<StoreApi | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TrackerState>(loadState);
  const [serverMode, setServerMode] = useState(false);
  const [meta, setMeta] = useState<SyncMeta>(loadSyncMeta);
  const [diverged, setDiverged] = useState(false);
  const [pending, setPending] = useState(0);

  // Synchronous source of truth: mutations apply through the ref first so a
  // sequence of calls in ONE event (AttackFormDialog: startAttack → endAttack
  // → logPain → updateAttack) computes each backend payload from up-to-date
  // state. We never rely on React running a setState updater eagerly.
  const stateRef = useRef(state);
  const serverRef = useRef(false);
  const metaRef = useRef(meta);
  const divergedRef = useRef(false);
  const pendingRef = useRef(0);
  /** Total server-path tasks ever enqueued; identifies "newest write". */
  const genRef = useRef(0);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Hydrate once per provider lifetime. A ref (not module-level state) keeps
   * React StrictMode's effect double-invocation from hydrating twice while
   * still re-hydrating when the provider genuinely remounts — e.g. returning
   * from the `/view` route tree to the writer routes.
   */
  const hydrateStartedRef = useRef(false);

  const applyState = useCallback((updater: (s: TrackerState) => TrackerState) => {
    const next = updater(stateRef.current);
    stateRef.current = next;
    setState(next);
    // Optimistic changes must be visible immediately: Home/Settings derive
    // badges and defaults from the coarse render clock (15s ticks), so wake
    // it after every applied mutation. applyState only ever runs from event
    // handlers/effects — bumpClock is never called during render.
    bumpClock();
  }, []);

  const setSyncMeta = useCallback((next: SyncMeta) => {
    metaRef.current = next;
    setMeta(next);
    try {
      localStorage.setItem(SYNC_META_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable — the in-memory latch still protects this session
    }
  }, []);

  const markDirty = useCallback(() => {
    if (!metaRef.current.dirty) setSyncMeta({ ...metaRef.current, dirty: true });
  }, [setSyncMeta]);

  /**
   * localStorage is always a cache; the server (when reachable) is canonical.
   * Every state change is persisted (with storage-error tolerance) so an
   * immediate reload — or a reload mid-sync — keeps the exact local data.
   */
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // storage full/blocked — in-memory state still works this session
    }
  }, [state]);

  /**
   * Serialized backend write queue. Tasks run strictly one at a time in call
   * order, so multi-step flows (POST attack → PATCH end → PATCH pain → PATCH
   * details) reach the server in order.
   *
   * Latch rules:
   * - Every server-path task marks the store dirty when enqueued: until the
   *   server confirms it, a reload must not let hydration discard it.
   * - Any rejection additionally latches `failed` (sticky; later successes
   *   never clear it). Offline/diverged mutations set BOTH (nothing will
   *   confirm them automatically).
   * - Dirty clears only when the newest write finishes successfully with the
   *   queue fully drained, no failure latched, and no divergence active.
   * - A confirming full exchange (`resolvesOfflineDrain` first-contact upload,
   *   `resolvesServerReset` confirmed reset) resolves earlier failures: if
   *   later writes remain queued it clears only `failed`; if it is the newest
   *   write and the queue drains cleanly it clears both latches.
   *
   * Failure feedback: a rejection always logs and latches dirty+failed, and
   * shows the generic "Server sync failed" toast when the failure latch was
   * not already set. `suppressSyncErrorToast` suppresses ONLY that generic
   * toast — it is for callers that surface their own specific failure feedback
   * (resetAll → Settings' "Erased in this browser — server erase unconfirmed")
   * so the user does not get two overlapping errors. Console logging, latches
   * and queue bookkeeping are never affected.
   */
  const enqueue = useCallback(
    (
      label: string,
      run: () => Promise<unknown>,
      opts: {
        force?: boolean;
        resolvesOfflineDrain?: boolean;
        resolvesServerReset?: boolean;
        suppressSyncErrorToast?: boolean;
      } = {},
    ): Promise<void> => {
      if (!serverRef.current || (divergedRef.current && !opts.force)) {
        // Offline/local or diverged: the change is unconfirmed AND failed —
        // no automatic path will confirm it; a full exchange is required.
        setSyncMeta({ dirty: true, failed: true });
        const reason = serverRef.current ? 'diverged' : 'offline';
        const rejected = Promise.reject(new Error(`${reason}: ${label} kept locally`));
        rejected.catch(() => undefined); // handled; awaiters still see the rejection
        return rejected;
      }
      pendingRef.current += 1;
      setPending(pendingRef.current);
      const myGen = ++genRef.current;
      markDirty(); // unconfirmed until the server acknowledges
      let succeeded = false;
      let failure: unknown;
      const task = queueRef.current.then(run);
      // `settled` carries the latches and bookkeeping and never rejects, so it
      // is safe to use as the queue tail; the returned outcome re-raises the
      // task failure only for callers that await this task.
      const settled = task.then(
        () => {
          succeeded = true;
        },
        (e: unknown) => {
          failure = e;
          const wasFailed = metaRef.current.failed;
          setSyncMeta({ dirty: true, failed: true });
          console.error(`[sync] ${label} failed:`, e);
          if (!wasFailed && opts.suppressSyncErrorToast !== true) {
            toast.error('Server sync failed', {
              description: 'Your change is saved on this device and marked unsynced.',
            });
          }
        },
      ).finally(() => {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        setPending(pendingRef.current);
        const isFullExchange = opts.resolvesOfflineDrain === true || opts.resolvesServerReset === true;
        if (!succeeded) {
          // The rejection handler above already re-latched dirty+failed; a
          // failure (including a failed full exchange) stays sticky.
          return;
        }
        if (genRef.current !== myGen || pendingRef.current !== 0) {
          // Later writes are still unconfirmed; their completion governs
          // cleaning. A succeeded full exchange resolves earlier failures
          // even here (the server now mirrors this browser), while dirty
          // stays until those writes finish — and they re-latch `failed`
          // if they themselves fail. This must run BEFORE any pending-count
          // early return: a full exchange completing with writes queued is
          // still a confirmed exchange for everything before it.
          if (isFullExchange && metaRef.current.failed) setSyncMeta({ dirty: true, failed: false });
          return;
        }
        // Newest write finished successfully and the queue fully drained.
        if (isFullExchange || shouldCleanOnDrain(true, metaRef.current.failed, divergedRef.current)) {
          setSyncMeta({ ...CLEAN_META });
        }
      });
      queueRef.current = settled.catch(() => undefined);
      // Resolves AFTER `settled` (bookkeeping included); rejects with the
      // original task failure. Fire-and-forget callers must not surface an
      // unhandled rejection, so the internal handler below claims the
      // rejection while awaiters still observe it.
      const outcome = settled.then(() => {
        if (!succeeded) throw failure;
      });
      outcome.catch(() => undefined);
      return outcome;
    },
    [markDirty, setSyncMeta],
  );

  // Hydrate from the backend on first load.
  useEffect(() => {
    if (hydrateStartedRef.current) return;
    hydrateStartedRef.current = true;
    (async () => {
      let data: ExportShape;
      try {
        data = await backend.exportAll();
      } catch {
        // Server unreachable — stay in localStorage mode. Unconfirmed changes
        // keep their persisted dirty/failed latches, so a later successful
        // hydration cannot silently replace them with server data.
        return;
      }
      serverRef.current = true;
      setServerMode(true);

      const serverAttacks = data.attacks as Attack[];
      const serverMeds = data.meds as MedEvent[];
      const serverRefills = (data.refills ?? []) as Refill[];
      const serverWorkouts = (data.workouts ?? []) as Workout[];
      const serverDayStates = (data.dayStates ?? []) as DayState[];
      const serverBaselines = (data.stockBaselines ?? []) as StockBaseline[];
      const serverEmpty = serverAttacks.length === 0 && serverMeds.length === 0
        && serverRefills.length === 0 && serverWorkouts.length === 0
        && serverDayStates.length === 0 && serverBaselines.length === 0;
      const local = stateRef.current;
      const localHasData = local.attacks.length > 0 || local.meds.length > 0
        || local.refills.length > 0 || local.workouts.length > 0
        || local.dayStates.length > 0 || local.stockBaselines.length > 0;
      const decision = decideHydration(serverEmpty, localHasData, metaRef.current.dirty);

      // Non-secret timezone setting: adopt the server's copy when present,
      // otherwise publish the browser zone without blocking hydration.
      const persistBrowserTz = () => {
        const tz = stateRef.current.timezone;
        if (typeof data.settings?.timezone !== 'string' || !isValidTimeZone(data.settings.timezone)) {
          backend.putSetting('timezone', tz).catch((e) =>
            console.warn('[sync] timezone setting write failed (non-critical):', e));
        }
      };

      switch (decision) {
        case 'upload-local': {
          // First contact: the server is empty — push the full local snapshot
          // (records + settings + timezone). Reads stateRef at run time so
          // changes made during the export round-trip are included. A full
          // success resolves any earlier offline failure latch; dirty clears
          // only when no later writes remain queued.
          const upload = enqueue('first-contact upload', async () => {
            const s = stateRef.current;
            await backend.importAll({
              attacks: s.attacks,
              meds: s.meds,
              refills: s.refills,
              workouts: s.workouts,
              dayStates: s.dayStates,
              stockBaselines: s.stockBaselines,
            });
            await backend.putSetting('rules', s.rules);
            await backend.putSetting('doses', s.doses);
            await backend.putSetting('planned', s.planned);
            await backend.putSetting('timezone', s.timezone);
            await backend.putSetting('lowStockThreshold', s.lowStockThreshold);
            await backend.putSetting('lowStockAlert', { latchedAt: s.lowStockAlertedAt });
            await backend.putSetting('reminders', s.reminders);
          }, { resolvesOfflineDrain: true });
          void upload
            .then(() => {
              toast.success(`Synced ${stateRef.current.attacks.length} attacks and ${stateRef.current.meds.length} med entries to the server`);
            })
            .catch(() => {
              toast.error('Initial upload to the server failed', {
                description: 'Your data is safe on this device and marked unsynced.',
              });
            });
          break;
        }
        case 'hydrate-server': {
          // Normal clean cache hydration: local had nothing unconfirmed, so
          // the server snapshot replaces it.
          applyState((s) => ({ ...s, ...serverSnapshotToState(data, s.timezone) }));
          setSyncMeta({ ...CLEAN_META });
          persistBrowserTz();
          break;
        }
        case 'conflict': {
          // The server has data while local changes were never confirmed —
          // keep local state, pause server writes, ask the user (Settings).
          divergedRef.current = true;
          setDiverged(true);
          toast.warning('Unsynced changes on this device', {
            description: 'They differ from the server copy. Open Settings → Data to download a backup or switch to the server data.',
            duration: 12000,
          });
          break;
        }
        case 'nothing': {
          // Both sides empty and nothing unconfirmed — nothing to protect.
          setSyncMeta({ ...CLEAN_META });
          persistBrowserTz();
          break;
        }
      }
    })();
  }, [applyState, enqueue, setSyncMeta]);

  /**
   * In-session low-stock episode guard. `alerted` means this provider has
   * already announced the current low episode (including a persisted latch it
   * adopted), so only stock recovering above the threshold returns it to
   * `armed`. This keeps StrictMode double-invocation, a hydration snapshot
   * replacing the latch, and an explicit reset while still low from
   * re-announcing the same episode.
   */
  const lowStockEpisodeRef = useRef<'unknown' | 'armed' | 'alerted'>('unknown');
  /**
   * Latch set locally while offline, awaiting publication to the server.
   * Initialized from durable bookkeeping (not just memory) so a reload keeps
   * the "must publish / was already announced" fact. The useRef argument
   * re-evaluates per render but only the first result is kept; the read is
   * the same cheap deterministic localStorage access loadState() does.
   */
  const pendingLatchPersistRef = useRef<string | null>(loadPendingLatch());
  /**
   * The pending latch currently being published, if any. Set synchronously
   * before the write is enqueued so StrictMode's double effects (and any
   * immediate re-render) cannot enqueue the same publication twice.
   */
  const publishingLatchRef = useRef<string | null>(null);

  /** Keep the durable pending-latch bookkeeping in step with the ref. */
  const setPendingLatch = useCallback((latchedAt: string | null) => {
    pendingLatchPersistRef.current = latchedAt;
    storePendingLatch(latchedAt);
  }, []);

  /**
   * One-shot Nurtec low-stock latch (plan §4): alert once when stock crosses
   * into low, re-arm only after replenishment above the threshold or an
   * explicit reset, and never clamp/ignore a negative count.
   *
   * Decisions always read `stateRef.current` (the freshest optimistic state),
   * so captured render values only decide *when* to re-evaluate. An automatic
   * background write must never latch dirty/failed while offline, so server
   * writes are gated on `serverRef.current` and every enqueue promise gets a
   * catch; the local latch still persists through the localStorage effect.
   */
  useEffect(() => {
    // Stock is evaluated first because it decides whether a deferred latch is
    // still meaningful: replenishment above the threshold ends the episode, so
    // a pending latch must never be published after that.
    const snapshot = stateRef.current;
    // Mirror GET /api/inventory/nurtec: inventory is Nurtec-scoped today.
    const stock = currentStock(
      {
        baselines: snapshot.stockBaselines.filter((b) => b.medId === 'nurtec'),
        doses: snapshot.meds.filter((m) => m.medId === 'nurtec'),
        refills: snapshot.refills.filter((r) => r.medId === 'nurtec'),
      },
      { now: Date.now(), timeZone: snapshot.timezone },
    );
    const replenished = stock.status === 'known' && stock.quantity !== null
      && stock.quantity > snapshot.lowStockThreshold;

    // A latch set while offline (this or a previous session — the ref is
    // initialized from durable bookkeeping) is adopted and published once the
    // server is reachable and no divergence pause is active.
    const pendingLatch = pendingLatchPersistRef.current;
    if (pendingLatch !== null) {
      if (replenished) {
        // Replenished before the deferred publication ran: the episode is
        // over, so the bookkeeping is obsolete and must not reach the server.
        setPendingLatch(null);
      } else if (serverRef.current && !divergedRef.current) {
        const currentLatch = stateRef.current.lowStockAlertedAt;
        if (currentLatch !== null && currentLatch !== pendingLatch) {
          // The server supplied its own latch for this episode. Its copy is
          // canonical, so republishing would be a duplicate write; the stale
          // pending bookkeeping is simply dropped.
          setPendingLatch(null);
          lowStockEpisodeRef.current = 'alerted';
        } else {
          if (currentLatch === null) {
            // Re-adopt the latch the offline session already announced (a
            // clean hydration may have replaced it with a snapshot lacking
            // it) — never re-toasted, and the server must learn the episode
            // is latched.
            applyState((prev) => ({ ...prev, lowStockAlertedAt: pendingLatch }));
          }
          lowStockEpisodeRef.current = 'alerted';
          if (publishingLatchRef.current !== pendingLatch) {
            // Clear only after the server CONFIRMS the write: an unconfirmed
            // attempt must leave the durable bookkeeping intact for a later
            // pass. The in-flight ref prevents duplicate enqueues regardless
            // of StrictMode double effects or immediate re-renders.
            publishingLatchRef.current = pendingLatch;
            enqueue('putSetting(lowStockAlert)', () =>
              backend.putSetting('lowStockAlert', { latchedAt: pendingLatch }))
              .then(() => {
                if (publishingLatchRef.current === pendingLatch) {
                  publishingLatchRef.current = null;
                }
                // Confirmed publication — drop the durable bookkeeping. The
                // value guard ensures a newer pending latch is never cleared
                // by an older success.
                if (pendingLatchPersistRef.current === pendingLatch) setPendingLatch(null);
              })
              .catch(() => {
                // Keep the bookkeeping so a later effect pass retries. This
                // only touches a ref/localStorage, never React state, so it
                // cannot start a render/write loop.
                if (publishingLatchRef.current === pendingLatch) {
                  publishingLatchRef.current = null;
                }
              });
          }
        }
      }
    }

    const s = stateRef.current;

    // No applicable baseline: the condition cannot be evaluated. Strict no-op
    // — never toast, never write, never clear an existing latch. (Pending
    // publication above is still allowed: the episode was real even if the
    // hydrated snapshot does not carry a baseline.)
    if (stock.status !== 'known' || stock.quantity === null) return;

    if (stock.quantity > s.lowStockThreshold) {
      lowStockEpisodeRef.current = 'armed';
      if (s.lowStockAlertedAt === null) return;
      applyState((prev) => ({ ...prev, lowStockAlertedAt: null }));
      // Replenished: any latch still awaiting publication is obsolete.
      setPendingLatch(null);
      if (serverRef.current) {
        enqueue('putSetting(lowStockAlert)', () =>
          backend.putSetting('lowStockAlert', { latchedAt: null })).catch(() => undefined);
      }
      return;
    }

    if (s.lowStockAlertedAt !== null) {
      // Already latched (possibly by another session): adopting it is not a
      // new crossing, so no toast and no rewrite.
      lowStockEpisodeRef.current = 'alerted';
      return;
    }
    // Still-low after an explicit reset: the user silenced this episode, so
    // wait for replenishment above the threshold before alerting again.
    if (lowStockEpisodeRef.current === 'alerted') return;

    lowStockEpisodeRef.current = 'alerted';
    const latchedAt = new Date().toISOString();
    applyState((prev) => ({ ...prev, lowStockAlertedAt: latchedAt }));
    if (serverRef.current) {
      enqueue('putSetting(lowStockAlert)', () =>
        backend.putSetting('lowStockAlert', { latchedAt })).catch(() => undefined);
    } else {
      // Offline: keep the latch in durable bookkeeping so a reload adopts it
      // (no second toast) and publishes it exactly once once the server is
      // reachable. This bookkeeping never touches the sync latches.
      setPendingLatch(latchedAt);
    }
    if (stock.quantity < 0) {
      toast.warning(`Nurtec stock is ${stock.quantity}`, {
        description: `Recorded stock is negative — correct it in Settings (alert level ${s.lowStockThreshold}).`,
      });
    } else {
      toast.warning(`${stock.quantity} Nurtec tablet${stock.quantity === 1 ? '' : 's'} left`, {
        description: `At or below your ${s.lowStockThreshold}-tablet alert level. Log a refill when you pick up more.`,
      });
    }
  }, [
    applyState, enqueue, setPendingLatch, serverMode,
    state.meds, state.refills, state.stockBaselines,
    state.lowStockThreshold, state.timezone,
    // `state.lowStockAlertedAt` is deliberately NOT a dependency: this effect
    // writes the latch itself, and depending on its own output would make the
    // post-adoption render immediately retry a publication that just failed
    // (an automatic render/write loop). Real re-evaluations arrive through the
    // records above or an explicit reset/replenishment handler.
  ]);

  /** Conflict resolution: adopt the current server snapshot after the user's
   * explicit choice. Failure keeps local data and the divergence latch. */
  const resolveUseServer = useCallback(async () => {
    try {
      const data = await backend.exportAll();
      serverRef.current = true;
      setServerMode(true);
      applyState((s) => ({ ...s, ...serverSnapshotToState(data, s.timezone) }));
      divergedRef.current = false;
      setDiverged(false);
      setSyncMeta({ ...CLEAN_META });
      toast.success('This device now uses the server data.');
    } catch {
      toast.error('Could not load the server copy', {
        description: 'Nothing was changed — your local data was kept. Check the connection and try again.',
      });
    }
  }, [applyState, setSyncMeta]);

  const sync = useMemo<StoreApi['sync']>(() => ({
    status: deriveSyncStatus({ serverMode, diverged, failed: meta.failed, pending }),
    pending,
    dirty: meta.dirty,
    failed: meta.failed,
    diverged,
  }), [serverMode, diverged, meta, pending]);

  const api = useMemo<StoreApi>(() => {
    const activeAttack =
      state.attacks.find((a) => a.end === null) ?? null;

    return {
      state,
      activeAttack,
      readOnly: false,
      serverMode,
      sync,
      startAttack: (start = new Date()) => {
        const a: Attack = {
          id: uid(), start: start.toISOString(), end: null,
          painLog: [], peakPain: -1,
          symptoms: [], triggers: [], aura: null, notes: '', source: 'manual',
        };
        applyState((s) => ({ ...s, attacks: [...s.attacks, a] }));
        enqueue('addAttack', () => backend.addAttack(a));
        return a;
      },
      endAttack: (id, end = new Date()) => {
        const endIso = end.toISOString();
        applyState((s) => ({
          ...s,
          attacks: s.attacks.map((x) => (x.id === id ? { ...x, end: endIso } : x)),
        }));
        enqueue('patchAttack(end)', () => backend.patchAttack(id, { end: endIso }));
      },
      updateAttack: (id, patch) => {
        // Payload computed synchronously from the state ref (never inside a
        // setState updater), so ordered save() sequences send correct data.
        const current = stateRef.current.attacks.find((x) => x.id === id);
        if (!current) return;
        // The route/record id always wins over any runtime `id` in the patch.
        const safePatch = cleanPatch<Attack>(patch);
        const merged: Attack = { ...current, ...safePatch, id };
        if (typeof safePatch.peakPain === 'number') {
          // An explicit peak (including a downward correction) wins verbatim;
          // never re-derive it from old pain-log history.
          merged.peakPain = safePatch.peakPain;
        } else if (current.peakPain >= 0) {
          // Metadata edits must not rescan history and resurrect a peak the
          // user deliberately lowered.
          merged.peakPain = current.peakPain;
        } else {
          // Legacy record with no cached peak: derive it once from its log.
          merged.peakPain = recomputePeak(merged);
        }
        // Diff against the fully merged record (never the raw patch): the
        // legacy peak derivation above is a real change that must reach the
        // server, while untouched metadata (and a synthetic pain entry) is
        // never resent. A no-op edit changes nothing and latches nothing.
        const diff = changedFields(current, merged);
        if (!hasChanges(diff)) return;
        applyState((s) => ({
          ...s,
          attacks: s.attacks.map((x) => (x.id === id ? merged : x)),
        }));
        enqueue('patchAttack(update)', () => backend.patchAttack(id, diff));
      },
      deleteAttack: (id) => {
        applyState((s) => ({
          ...s,
          attacks: s.attacks.filter((x) => x.id !== id),
          meds: s.meds.map((m) => (m.attackId === id ? { ...m, attackId: null } : m)),
        }));
        enqueue('deleteAttack', () => backend.deleteAttack(id));
      },
      logPain: (attackId, level, when = new Date()) => {
        const current = stateRef.current.attacks.find((x) => x.id === attackId);
        if (!current) return;
        const next: Attack = {
          ...current,
          painLog: [...current.painLog, { ts: when.toISOString(), level }]
            .sort((x, y) => x.ts.localeCompare(y.ts)),
        };
        // Fold only the new entry into the stored peak. Rescanning the whole
        // log here would resurrect a peak the user lowered via edit.
        next.peakPain = Math.max(current.peakPain, level);
        applyState((s) => ({
          ...s,
          attacks: s.attacks.map((x) => (x.id === attackId ? next : x)),
        }));
        enqueue('patchAttack(pain)', () =>
          backend.patchAttack(attackId, { painLog: next.painLog, peakPain: next.peakPain }));
      },
      logMed: (medId, when = new Date(), attackId = null, dose = '', notes = '', quantity = null) => {
        const m: MedEvent = {
          id: uid(), medId, ts: when.toISOString(), attackId, notes, dose,
          quantity: quantity ?? null, source: 'manual',
        };
        applyState((s) => ({ ...s, meds: [...s.meds, m] }));
        enqueue('addMed', () => backend.addMed(m));
        return m;
      },
      updateMed: (id, patch) => {
        // Early return for an unknown id: no local change AND no queued PATCH
        // (which would 404 on the server and latch `failed`).
        const current = stateRef.current.meds.find((m) => m.id === id);
        if (!current) return;
        // Runtime id guard: the route/record id always wins over a body id.
        const safePatch = cleanPatch<MedEvent>(patch);
        const merged: MedEvent = { ...current, ...safePatch, id };
        // Only fields the edit actually changed go on the wire (never `id`,
        // never unchanged values, explicit nulls kept); an empty diff sends
        // nothing at all.
        const diff = changedFields(current, merged);
        if (!hasChanges(diff)) return;
        applyState((s) => ({
          ...s,
          meds: s.meds.map((m) => (m.id === id ? merged : m)),
        }));
        // The server merges a partial patch into the existing row.
        enqueue('patchMed', () => backend.patchMed(id, diff));
      },
      deleteMed: (id) => {
        applyState((s) => ({ ...s, meds: s.meds.filter((m) => m.id !== id) }));
        enqueue('deleteMed', () => backend.deleteMed(id));
      },
      addRefill: (medId, date, notes = '', quantity = null) => {
        const r: Refill = { id: uid(), medId, date, notes, quantity: quantity ?? null, source: 'manual' };
        applyState((s) => ({
          ...s,
          refills: [...s.refills, r].sort((a, b) => a.date.localeCompare(b.date)),
        }));
        enqueue('addRefill', () => backend.addRefill(r));
        return r;
      },
      updateRefill: (id, patch) => {
        const current = stateRef.current.refills.find((r) => r.id === id);
        if (!current) return;
        const merged: Refill = { ...current, ...cleanPatch<Refill>(patch), id };
        const diff = changedFields(current, merged);
        if (!hasChanges(diff)) return;
        applyState((s) => ({
          ...s,
          refills: s.refills
            .map((r) => (r.id === id ? merged : r))
            .sort((a, b) => a.date.localeCompare(b.date)),
        }));
        enqueue('patchRefill', () => backend.patchRefill(id, diff));
      },
      deleteRefill: (id) => {
        applyState((s) => ({ ...s, refills: s.refills.filter((r) => r.id !== id) }));
        enqueue('deleteRefill', () => backend.deleteRefill(id));
      },
      addStockBaseline: (input) => {
        const b: StockBaseline = {
          id: uid(),
          medId: input.medId,
          effectiveAt: input.effectiveAt ?? new Date().toISOString(),
          quantity: input.quantity,
          notes: input.notes ?? '',
          source: 'manual',
          createdAt: new Date().toISOString(),
        };
        applyState((s) => ({
          ...s,
          stockBaselines: [...s.stockBaselines, b].sort((x, y) =>
            x.effectiveAt.localeCompare(y.effectiveAt) || x.createdAt.localeCompare(y.createdAt)),
        }));
        // The server sets its own created_at (tie-break only); the local copy
        // keeps the optimistic record stable.
        enqueue('addStockBaseline', () => backend.addStockBaseline(b));
        return b;
      },
      updateStockBaseline: (id, patch) => {
        const current = stateRef.current.stockBaselines.find((b) => b.id === id);
        if (!current) return;
        const merged: StockBaseline = { ...current, ...cleanPatch<StockBaseline>(patch), id };
        const diff = changedFields(current, merged);
        if (!hasChanges(diff)) return;
        applyState((s) => ({
          ...s,
          stockBaselines: s.stockBaselines
            .map((b) => (b.id === id ? merged : b))
            .sort((x, y) =>
              x.effectiveAt.localeCompare(y.effectiveAt) || x.createdAt.localeCompare(y.createdAt)),
        }));
        enqueue('patchStockBaseline', () => backend.patchStockBaseline(id, diff));
      },
      deleteStockBaseline: (id) => {
        applyState((s) => ({
          ...s,
          stockBaselines: s.stockBaselines.filter((b) => b.id !== id),
        }));
        enqueue('deleteStockBaseline', () => backend.deleteStockBaseline(id));
      },
      addWorkout: (input) => {
        const w: Workout = {
          id: uid(),
          performedAt: input.performedAt ?? new Date().toISOString(),
          kind: input.kind,
          effort: input.effort,
          durationMinutes: input.durationMinutes ?? null,
          notes: input.notes ?? '',
          source: 'manual',
        };
        applyState((s) => ({
          ...s,
          workouts: [...s.workouts, w].sort((a, b) => a.performedAt.localeCompare(b.performedAt)),
        }));
        enqueue('addWorkout', () => backend.addWorkout(w));
        return w;
      },
      updateWorkout: (id, patch) => {
        const current = stateRef.current.workouts.find((w) => w.id === id);
        if (!current) return;
        const merged: Workout = { ...current, ...cleanPatch<Workout>(patch), id };
        const diff = changedFields(current, merged);
        if (!hasChanges(diff)) return;
        applyState((s) => ({
          ...s,
          workouts: s.workouts
            .map((w) => (w.id === id ? merged : w))
            .sort((a, b) => a.performedAt.localeCompare(b.performedAt)),
        }));
        enqueue('patchWorkout', () => backend.patchWorkout(id, diff));
      },
      deleteWorkout: (id) => {
        applyState((s) => ({ ...s, workouts: s.workouts.filter((w) => w.id !== id) }));
        enqueue('deleteWorkout', () => backend.deleteWorkout(id));
      },
      setDayState: (day, status, notes) => {
        const current = stateRef.current.dayStates.find((d) => d.day === day);
        // Computed before applyState so the local record and payload agree.
        const updatedAt = new Date().toISOString();
        const next: DayState = {
          day,
          status,
          notes: notes ?? current?.notes ?? '',
          updatedAt,
        };
        applyState((s) => ({
          ...s,
          dayStates: current
            ? s.dayStates.map((d) => (d.day === day ? next : d))
            : [...s.dayStates, next].sort((a, b) => a.day.localeCompare(b.day)),
        }));
        enqueue('putDayState', () => backend.putDayState(day, { status, notes: next.notes }));
      },
      importData: (attacks, meds) => {
        applyState((s) => ({
          ...s,
          attacks: [...s.attacks, ...attacks].sort((a, b) => a.start.localeCompare(b.start)),
          meds: [...s.meds, ...meds].sort((a, b) => a.ts.localeCompare(b.ts)),
        }));
        enqueue('import', () => backend.importAll({ attacks, meds }));
      },
      setRule: (medId, limit, windowDays) => {
        const rules = { ...stateRef.current.rules, [medId]: { limit, windowDays } };
        applyState((s) => ({ ...s, rules }));
        enqueue('putSetting(rules)', () => backend.putSetting('rules', rules));
      },
      setDoseDefault: (medId, dose) => {
        const doses = { ...stateRef.current.doses, [medId]: dose };
        applyState((s) => ({ ...s, doses }));
        enqueue('putSetting(doses)', () => backend.putSetting('doses', doses));
      },
      setPlannedDose: (medId, date) => {
        const planned = { ...stateRef.current.planned };
        if (date) planned[medId] = date;
        else delete planned[medId];
        applyState((s) => ({ ...s, planned }));
        enqueue('putSetting(planned)', () => backend.putSetting('planned', planned));
      },
      setTimezone: (tz) => {
        // Silently ignore invalid zones: the setting must always be a usable
        // IANA id (day buckets depend on it).
        if (!isValidTimeZone(tz)) return;
        applyState((s) => ({ ...s, timezone: tz }));
        enqueue('putSetting(timezone)', () => backend.putSetting('timezone', tz));
      },
      setLowStockThreshold: (tablets) => {
        // Ignore invalid values (same policy as setTimezone): the threshold
        // must stay a nonnegative whole tablet count.
        if (!isValidThreshold(tablets)) return;
        applyState((s) => ({ ...s, lowStockThreshold: tablets }));
        enqueue('putSetting(lowStockThreshold)', () => backend.putSetting('lowStockThreshold', tablets));
      },
      updateReminders: (patch) => {
        const current = normalizeReminderSettings(stateRef.current.reminders);
        const mergedRaw = { ...current, ...patch };
        const errors = reminderSettingsErrors(mergedRaw);
        if (errors.length) return errors;
        const merged = normalizeReminderSettings(mergedRaw);
        applyState((s) => ({ ...s, reminders: merged }));
        enqueue('putSetting(reminders)', () => backend.putSetting('reminders', merged));
        return [];
      },
      resetLowStockAlert: () => {
        applyState((s) => ({ ...s, lowStockAlertedAt: null }));
        // An explicit reset also cancels any latch still queued for
        // publication — the user silenced the episode, so a stale latch must
        // never surface later. (The enqueue below is a deliberate user
        // action and keeps the current sync semantics.)
        setPendingLatch(null);
        enqueue('putSetting(lowStockAlert)', () => backend.putSetting('lowStockAlert', { latchedAt: null }));
      },
      loadDemoData: () => {
        const seed = buildSeedData();
        applyState((s) => ({
          ...s,
          attacks: seed.attacks,
          meds: seed.meds,
          seeded: true,
        }));
        // Existing caveat (unchanged): server-side import is additive, so
        // demo records are added to whatever the server already holds.
        enqueue('import(demo)', () => backend.importAll(seed));
      },
      resetAll: () => {
        applyState(() => emptyState());
        // A full erase is a brand-new state, not a silence of the current
        // episode: re-arm from scratch so a low baseline added afterwards in
        // this session alerts again, and drop any latch queued while offline
        // — both the in-memory ref AND its durable bookkeeping, so a stale
        // pre-reset alert can never be adopted or published after a reload.
        // This is deliberately distinct from resetLowStockAlert, which
        // silences the CURRENT low episode until replenishment.
        lowStockEpisodeRef.current = 'unknown';
        setPendingLatch(null);
        // Local data is gone by explicit choice: lift the write pause now,
        // but do NOT pre-clear dirty/failed — the confirmed server reset
        // governs those. Offline reset stays dirty+failed so old server data
        // cannot silently return on a later hydration.
        divergedRef.current = false;
        setDiverged(false);
        // The returned promise reports the SERVER outcome: it resolves once
        // this task (reset + timezone publish) and its latch bookkeeping have
        // completed, and rejects if either server call did (or on the
        // offline/diverged early rejection above). The local erase stays
        // synchronous/optimistic.
        return enqueue('reset', async () => {
          await backend.resetAll();
          // /api/reset deletes every setting, so the server would fall back to
          // UTC for inventory/reminders while this browser uses its local zone.
          // Re-publish ONLY the non-secret timezone (a reset is a fresh start:
          // rules/doses/planned/threshold/reminders keep server defaults). The
          // write stays inside this serialized task, so it cannot race a later
          // setTimezone and its completion still belongs to the reset exchange.
          // A failed publish fails the whole reset task on purpose: silently
          // reporting "synced" while the server keeps a UTC zone would leave
          // the bug in place. The normal rejection latch (dirty+failed) then
          // holds until a later confirmed full exchange, exactly like any
          // other unconfirmed write.
          const tz = stateRef.current.timezone;
          if (isValidTimeZone(tz)) await backend.putSetting('timezone', tz);
        }, { force: true, resolvesServerReset: true, suppressSyncErrorToast: true });
      },
      mergeBackup: (backup) => {
        // Compute the additive diff synchronously from the freshest state so
        // local duplicates can never be appended twice, like the server's
        // additive import (record ids; dayStates by day). Records are
        // normalized (ids + mapper defaults) BEFORE the diff so the local
        // copy, the import payload and the server row agree field for field.
        const current = stateRef.current;
        const incoming = normalizedBackupRecords(backup);
        const newAttacks = keepNewRecords(
          new Set(current.attacks.map((a) => a.id)), incoming.attacks,
          (a) => backupIdKey(a.id),
        );
        const newMeds = keepNewRecords(
          new Set(current.meds.map((m) => m.id)), incoming.meds,
          (m) => backupIdKey(m.id),
        );
        const newRefills = keepNewRecords(
          new Set(current.refills.map((r) => r.id)), incoming.refills,
          (r) => backupIdKey(r.id),
        );
        const newWorkouts = keepNewRecords(
          new Set(current.workouts.map((w) => w.id)), incoming.workouts,
          (w) => backupIdKey(w.id),
        );
        const newDayStates = keepNewRecords(
          new Set(current.dayStates.map((d) => d.day)), incoming.dayStates, (d) => d.day,
        );
        const newBaselines = keepNewRecords(
          new Set(current.stockBaselines.map((b) => b.id)),
          incoming.stockBaselines, (b) => backupIdKey(b.id),
        );

        const added: Record<BackupRecordKey, number> = {
          attacks: newAttacks.length,
          meds: newMeds.length,
          refills: newRefills.length,
          workouts: newWorkouts.length,
          dayStates: newDayStates.length,
          stockBaselines: newBaselines.length,
        };
        const totalAdded = BACKUP_RECORD_KEYS.reduce((sum, key) => sum + added[key], 0);

        if (totalAdded === 0) {
          // A no-op merge must not latch dirty/failed or touch the server.
          return { added, synced: Promise.resolve() };
        }

        // Settings are deliberately untouched: the state spread keeps the
        // current rules/doses/planned/timezone/threshold/reminders verbatim.
        applyState(() => ({
          ...current,
          attacks: [...current.attacks, ...newAttacks]
            .sort((a, b) => a.start.localeCompare(b.start)),
          meds: [...current.meds, ...newMeds].sort((a, b) => a.ts.localeCompare(b.ts)),
          refills: [...current.refills, ...newRefills]
            .sort((a, b) => a.date.localeCompare(b.date)),
          workouts: [...current.workouts, ...newWorkouts]
            .sort((a, b) => a.performedAt.localeCompare(b.performedAt)),
          dayStates: [...current.dayStates, ...newDayStates]
            .sort((a, b) => a.day.localeCompare(b.day)),
          stockBaselines: [...current.stockBaselines, ...newBaselines].sort((x, y) =>
            x.effectiveAt.localeCompare(y.effectiveAt)
            || x.createdAt.localeCompare(y.createdAt)),
        }));

        // Only the new records go to the existing additive endpoint; its
        // queue/latch/offline/divergence semantics are unchanged. `enqueue`
        // already resolves only when the task and its bookkeeping are done.
        const synced = enqueue('import(merge)', () => backend.importAll({
          attacks: newAttacks,
          meds: newMeds,
          refills: newRefills,
          workouts: newWorkouts,
          dayStates: newDayStates,
          stockBaselines: newBaselines,
        }));
        return { added, synced };
      },
      replaceBackup: (backup) => {
        const duplicateTotal = BACKUP_RECORD_KEYS
          .reduce((sum, key) => sum + backup.duplicateCounts[key], 0);
        if (duplicateTotal > 0) {
          // A replacement has to be exact; silent keep-first would restore
          // different data than the file contains.
          return Promise.reject(
            new Error('duplicate ids in backup; replacement must be exact'),
          );
        }

        // Normalize ONCE: the same fully-defaulted arrays feed the wire
        // payload, a browser-only local apply, and (via the envelope echo)
        // connected adoption, so all three converge on identical ids AND
        // defaults (no comparator or page ever sees a missing field).
        const records = normalizedBackupRecords(backup);
        // The effective settings the replacement adopts locally, sent in full
        // so the server persists exactly the same values (it stores only the
        // keys present in the payload).
        const settings = restoredSettingsFrom(backup);

        const payload = {
          schemaVersion: backup.schemaVersion,
          attacks: records.attacks,
          meds: records.meds,
          refills: records.refills,
          workouts: records.workouts,
          dayStates: records.dayStates,
          stockBaselines: records.stockBaselines,
          settings: restorePayloadSettings(settings),
        };

        if (serverRef.current) {
          // Capture the pre-restore state SYNCHRONOUSLY (before enqueue): the
          // rebase below compares it with the state at completion time to
          // find writes made after this invocation.
          const base = stateRef.current;
          // Connected (including while diverged): force is correct because
          // this is an explicit conflict-resolution/destructive choice.
          // Never erase/replace local state optimistically — await the atomic
          // server restore, then adopt ITS canonical records.
          const task = enqueue('restore', async () => {
            const envelope = await backend.restoreAll(payload);
            // Records come from the returned canonical envelope (they carry
            // server-generated fields like dayState updatedAt/baseline
            // createdAt and echo the ids we sent), while settings use the
            // SAME effective projection already sent in the payload — a
            // replacement must not inherit `serverSnapshotToState`'s
            // partial-hydration policy, and browser/server must agree without
            // follow-up setting writes.
            const restored = restoredBackupState(backup, {
              attacks: envelope.attacks as Attack[],
              meds: envelope.meds as MedEvent[],
              refills: (envelope.refills ?? []) as Refill[],
              workouts: (envelope.workouts ?? []) as Workout[],
              dayStates: (envelope.dayStates ?? []) as DayState[],
              stockBaselines: (envelope.stockBaselines ?? []) as StockBaseline[],
            }, settings);
            // Three-way rebase: writes made while the restore was in flight
            // are already applied locally AND their server tasks are queued
            // behind the restore, so keeping them is exactly what the server
            // will hold once the queue drains (see rebaseRecords/rebaseRestoreState).
            applyState((current) => rebaseRestoreState(base, current, restored));
            // The replaced data's low-stock episode bookkeeping is stale.
            lowStockEpisodeRef.current = 'unknown';
            setPendingLatch(null);
          }, { force: true, resolvesServerReset: true });

          return task.then(() => {
            // Only a CONFIRMED replacement resolves the conflict; the queue's
            // drain rules own the dirty/failed latches, so do not set them here.
            divergedRef.current = false;
            setDiverged(false);
          });
        }

        // Browser-only: apply the validated replacement locally. Absent
        // settings take defaults by construction, and even an EMPTY backup is a
        // deliberate replacement that must stay dirty+failed so later
        // hydration can never silently restore the server's old records.
        applyState(() => restoredBackupState(backup, records, settings));
        // The old pending low-stock bookkeeping belonged to the replaced data.
        lowStockEpisodeRef.current = 'unknown';
        setPendingLatch(null);
        setSyncMeta({ dirty: true, failed: true });
        // The local apply succeeded; it is merely unconfirmed.
        return Promise.resolve();
      },
      resolveUseServer,
    };
  }, [
    state, serverMode, sync, applyState, enqueue, resolveUseServer,
    setPendingLatch, setSyncMeta,
  ]);

  return <StoreCtx.Provider value={api}>{children}</StoreCtx.Provider>;
}

const READ_ONLY_ERROR = 'This partner view is read-only; changes are not allowed.';

/** Defensive denial shared by every mutation on the viewer contract. */
function denyReadOnly(): never {
  throw new Error(READ_ONLY_ERROR);
}

/** Viewer refresh cadence; must stay inside the 15-30s product window. */
const READ_ONLY_REFRESH_MS = 20000;

/**
 * Read-only partner viewer store.
 *
 * Deliberately shares the `useStore()` context contract with the writer app so
 * the existing Calendar/Reports/History pages can be reused, but it has none of
 * `StoreProvider`'s persistence or write machinery:
 * - starts from a fresh in-memory empty state (never `loadState`);
 * - reads only `GET /api/export` and maps it with the canonical snapshot
 *   conversion;
 * - never touches `migraine-tracker-v1`, the sync metadata, or the pending
 *   low-stock latch;
 * - never uploads on first contact, queues writes, or changes settings;
 * - every mutation rejects defensively (the UI should never render one).
 *
 * Refresh is single-flight and keeps the last successful snapshot when a later
 * request fails, so the partner sees stale data rather than an empty screen.
 */
export function ReadOnlyStoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TrackerState>(() => emptyState());
  const [serverMode, setServerMode] = useState(false);
  const [status, setStatus] = useState<SyncStatus>('syncing');

  const inFlightRef = useRef(false);
  const mountedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const data = await backend.exportAll();
      if (!mountedRef.current) return;
      setState((prev) => ({ ...emptyState(), ...serverSnapshotToState(data, prev.timezone) }));
      setServerMode(true);
      setStatus('synced');
    } catch {
      // Keep the previous snapshot (stale) and never latch writer dirty/failed.
      if (mountedRef.current) setStatus('error');
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    const interval = window.setInterval(() => {
      void refresh();
    }, READ_ONLY_REFRESH_MS);
    const onFocus = () => {
      void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  const activeAttack = useMemo(
    () => state.attacks.find((a) => a.end === null) ?? null,
    [state.attacks],
  );

  const sync = useMemo<StoreApi['sync']>(() => ({
    status,
    pending: 0,
    dirty: false,
    failed: false,
    diverged: false,
  }), [status]);

  const api = useMemo<StoreApi>(() => ({
    state,
    activeAttack,
    readOnly: true,
    serverMode,
    sync,
    startAttack: denyReadOnly,
    endAttack: denyReadOnly,
    updateAttack: denyReadOnly,
    deleteAttack: denyReadOnly,
    logPain: denyReadOnly,
    logMed: denyReadOnly,
    updateMed: denyReadOnly,
    deleteMed: denyReadOnly,
    addRefill: denyReadOnly,
    updateRefill: denyReadOnly,
    deleteRefill: denyReadOnly,
    addStockBaseline: denyReadOnly,
    updateStockBaseline: denyReadOnly,
    deleteStockBaseline: denyReadOnly,
    addWorkout: denyReadOnly,
    updateWorkout: denyReadOnly,
    deleteWorkout: denyReadOnly,
    setDayState: denyReadOnly,
    setTimezone: denyReadOnly,
    setLowStockThreshold: denyReadOnly,
    updateReminders: denyReadOnly,
    resetLowStockAlert: denyReadOnly,
    importData: denyReadOnly,
    setRule: denyReadOnly,
    setDoseDefault: denyReadOnly,
    setPlannedDose: denyReadOnly,
    loadDemoData: denyReadOnly,
    resetAll: denyReadOnly,
    mergeBackup: denyReadOnly,
    replaceBackup: () => Promise.reject(new Error(READ_ONLY_ERROR)),
    resolveUseServer: () => Promise.reject(new Error(READ_ONLY_ERROR)),
  }), [state, activeAttack, serverMode, sync]);

  return <StoreCtx.Provider value={api}>{children}</StoreCtx.Provider>;
}

// The context hook must live beside its provider; this file is a deliberate
// Fast Refresh boundary exception (state + actions are one unit).
// eslint-disable-next-line react-refresh/only-export-components
export function useStore(): StoreApi {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore outside provider');
  return ctx;
}
