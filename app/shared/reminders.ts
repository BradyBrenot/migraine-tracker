/**
 * Reminder domain rules shared by the browser (Settings/Calendar previews)
 * and the server scheduler. Everything here is pure/injectable: no clock,
 * network, storage, DOM, or database access.
 *
 * This module MUST stay erasable-syntax only and double-environment safe
 * (Vite bundle + Node 24 native type-stripping), like shared/datetime.ts.
 */

import type {
  DayStateStatus, ReminderSettings, WorkoutKind,
} from '../src/types/index.ts';
import {
  addDays, dayKeyStartMs, isValidDayKey, localDayKey, localMinuteOfDay,
  zonedDateTimeToMs, type DayKey,
} from './datetime.ts';
import {
  currentStock, type StockBaselineLike, type StockDoseLike, type StockRefillLike,
} from './inventory.ts';
import {
  countWorkoutsInWeek, weekGoalStatus,
  type WorkoutWeekCounts,
} from './workouts.ts';

/** Preventive dosing intervals in CALENDAR days (not fixed 24h arithmetic). */
export const PREVENTIVE_INTERVALS: Record<string, number> = {
  emgality: 30,
  botox: 84,
};

/** Due reminders fire at 09:00 in the configured local time zone. */
export const PREVENTIVE_DUE_TIME = '09:00';

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: true,
  preventive: true,
  lowStock: true,
  checkIn: true,
  exercise: true,
  weather: true,
  wakingStart: '09:00',
  wakingEnd: '21:00',
  checkInTime: '18:00',
  exerciseTime: '18:30',
  graceMinutes: 120,
};

const MIN_GRACE_MINUTES = 15;
const MAX_GRACE_MINUTES = 360;

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Secret/delivery configuration is environment-only. A reminder object that
 * carries any such field is rejected instead of silently persisted, so even a
 * hand-crafted PUT cannot copy an ntfy URL/token into the exported settings.
 */
const RESERVED_REMINDER_KEY = /(ntfy|token|secret|password|passwd|apikey|authorization|bearer|credential|publicappurl)/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Unknown keys that look like credentials/delivery config, normalized. */
export function reservedReminderSettingKeys(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  return Object.keys(value)
    .filter((key) => RESERVED_REMINDER_KEY.test(key.replace(/[^A-Za-z0-9]/g, '')));
}

/** Strict 'HH:MM' (24-hour) check. */
export function isValidTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && TIME_OF_DAY.test(value);
}

/** Minutes since local midnight for a 'HH:MM' string, or null when invalid. */
export function minutesOfTimeOfDay(value: string): number | null {
  if (!isValidTimeOfDay(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function withinWindow(minutes: number, start: number, end: number): boolean {
  // Overnight windows are deliberately not supported (the Settings UI rejects
  // end <= start); this also keeps the default 09:00-21:00 unambiguous.
  return end > start && minutes >= start && minutes < end;
}

/**
 * Human-readable validation for the compact Settings form and the server's
 * settings route. Returns [] when valid. Never repairs values; call
 * normalizeReminderSettings for defensive loading of legacy/manual rows.
 */
export function reminderSettingsErrors(value: unknown): string[] {
  if (!isPlainObject(value)) return ['reminder settings must be an object'];
  const errors: string[] = [];
  for (const key of reservedReminderSettingKeys(value)) {
    errors.push(`reminder settings must not contain ${key}`);
  }
  for (const key of ['enabled', 'preventive', 'lowStock', 'checkIn', 'exercise'] as const) {
    if (typeof value[key] !== 'boolean') errors.push(`${key} must be true or false`);
  }
  // `weather` was added after the first reminder payloads shipped. It stays
  // optional on input so older clients and legacy backups/rows still validate
  // (normalizeReminderSettings fills the true default), but a present value
  // must be a boolean — a malformed toggle is never silently accepted.
  if (value.weather !== undefined && typeof value.weather !== 'boolean') {
    errors.push('weather must be true or false');
  }
  for (const key of ['wakingStart', 'wakingEnd', 'checkInTime', 'exerciseTime'] as const) {
    if (!isValidTimeOfDay(value[key])) errors.push(`${key} must be a 24-hour HH:MM time`);
  }
  const start = isValidTimeOfDay(value.wakingStart)
    ? minutesOfTimeOfDay(value.wakingStart) : null;
  const end = isValidTimeOfDay(value.wakingEnd)
    ? minutesOfTimeOfDay(value.wakingEnd) : null;
  if (start !== null && end !== null && end <= start) {
    errors.push('waking hours must end after they start (overnight windows are not supported)');
  }
  if (start !== null && end !== null && end > start) {
    for (const key of ['checkInTime', 'exerciseTime'] as const) {
      const minutes = isValidTimeOfDay(value[key]) ? minutesOfTimeOfDay(value[key]) : null;
      if (minutes !== null && !withinWindow(minutes, start, end)) {
        errors.push(`${key} must fall inside waking hours`);
      }
    }
  }
  if (
    typeof value.graceMinutes !== 'number'
    || !Number.isInteger(value.graceMinutes)
    || value.graceMinutes < MIN_GRACE_MINUTES
    || value.graceMinutes > MAX_GRACE_MINUTES
  ) {
    errors.push(`graceMinutes must be a whole number from ${MIN_GRACE_MINUTES} to ${MAX_GRACE_MINUTES}`);
  }
  return errors;
}

/**
 * Defensive merge used when reading localStorage/server settings: every
 * missing or invalid field falls back independently, so one bad legacy value
 * can never break the scheduler or the Settings page.
 */
export function normalizeReminderSettings(value: unknown): ReminderSettings {
  const out: ReminderSettings = { ...DEFAULT_REMINDER_SETTINGS };
  if (!isPlainObject(value)) return out;

  for (const key of ['enabled', 'preventive', 'lowStock', 'checkIn', 'exercise', 'weather'] as const) {
    if (typeof value[key] === 'boolean') out[key] = value[key];
  }

  let wakingStart = isValidTimeOfDay(value.wakingStart)
    ? value.wakingStart : DEFAULT_REMINDER_SETTINGS.wakingStart;
  let wakingEnd = isValidTimeOfDay(value.wakingEnd)
    ? value.wakingEnd : DEFAULT_REMINDER_SETTINGS.wakingEnd;
  if ((minutesOfTimeOfDay(wakingEnd) ?? 0) <= (minutesOfTimeOfDay(wakingStart) ?? 0)) {
    wakingStart = DEFAULT_REMINDER_SETTINGS.wakingStart;
    wakingEnd = DEFAULT_REMINDER_SETTINGS.wakingEnd;
  }
  out.wakingStart = wakingStart;
  out.wakingEnd = wakingEnd;

  const start = minutesOfTimeOfDay(wakingStart)!;
  const end = minutesOfTimeOfDay(wakingEnd)!;
  for (const key of ['checkInTime', 'exerciseTime'] as const) {
    const candidate = isValidTimeOfDay(value[key])
      ? value[key] : DEFAULT_REMINDER_SETTINGS[key];
    const minutes = minutesOfTimeOfDay(candidate)!;
    if (withinWindow(minutes, start, end)) {
      out[key] = candidate;
      continue;
    }
    // The documented defaults (18:00/18:30) only exist inside the default
    // 09:00-21:00 window. For a narrower window they would make the normalized
    // output invalid, so fall back to an in-window time (wakingStart) instead.
    const fallback = DEFAULT_REMINDER_SETTINGS[key];
    out[key] = withinWindow(minutesOfTimeOfDay(fallback)!, start, end)
      ? fallback : wakingStart;
  }

  if (
    typeof value.graceMinutes === 'number'
    && Number.isInteger(value.graceMinutes)
    && value.graceMinutes >= MIN_GRACE_MINUTES
    && value.graceMinutes <= MAX_GRACE_MINUTES
  ) {
    out.graceMinutes = value.graceMinutes;
  }
  return out;
}

/** True during waking hours [start, end); overnight windows are invalid. */
export function isWithinWakingWindow(
  instantMs: number,
  settings: Pick<ReminderSettings, 'wakingStart' | 'wakingEnd'>,
  timeZone: string,
): boolean {
  const start = minutesOfTimeOfDay(settings.wakingStart);
  const end = minutesOfTimeOfDay(settings.wakingEnd);
  if (start === null || end === null) return false;
  return withinWindow(localMinuteOfDay(instantMs, timeZone), start, end);
}

export interface PreventiveDueInput {
  medId: string;
  intervalDays: number;
  meds: { medId: string; ts: string }[];
  planned?: Record<string, string>;
  now: number;
  timeZone: string;
  dueTime?: string;
}

export interface PreventiveDue {
  medId: string;
  intervalDays: number;
  /** 'none' = never logged and no valid planned date (no reminder at all). */
  status: 'none' | 'scheduled' | 'due';
  planned: boolean;
  dueDay: DayKey | null;
  /** Epoch ms of the due instant (09:00 local by default). */
  dueMs: number | null;
  lastDoseMs: number | null;
}

/**
 * Shared Emgality/Botox due calculation.
 *
 * - A valid planned `YYYY-MM-DD` overrides the automatic schedule.
 * - Automatic due = local day of the latest dose + interval CALENDAR days at
 *   09:00 in the configured zone (never last-dose-instant + interval*24h).
 * - Never logged and no planned date => 'none' (no due reminder).
 */
export function preventiveDue({
  medId, intervalDays, meds, planned = {}, now, timeZone,
  dueTime = PREVENTIVE_DUE_TIME,
}: PreventiveDueInput): PreventiveDue {
  let lastDoseMs: number | null = null;
  for (const med of meds) {
    if (med.medId !== medId) continue;
    const ms = Date.parse(med.ts);
    if (Number.isFinite(ms) && (lastDoseMs === null || ms > lastDoseMs)) lastDoseMs = ms;
  }

  const plannedRaw = planned[medId];
  const plannedDay = typeof plannedRaw === 'string' && isValidDayKey(plannedRaw)
    ? plannedRaw : null;

  let dueDay: DayKey | null = null;
  if (plannedDay) dueDay = plannedDay;
  else if (lastDoseMs !== null) dueDay = addDays(localDayKey(lastDoseMs, timeZone), intervalDays);

  if (!dueDay) {
    return {
      medId, intervalDays, status: 'none', planned: false,
      dueDay: null, dueMs: null, lastDoseMs,
    };
  }

  const dueMs = zonedDateTimeToMs(dueDay, dueTime, timeZone);
  return {
    medId,
    intervalDays,
    status: now >= dueMs ? 'due' : 'scheduled',
    planned: plannedDay !== null,
    dueDay,
    dueMs,
    lastDoseMs,
  };
}

/** True when no explicit day-state record exists for `day`. */
export function checkInMissing(
  dayStates: { day: string; status: DayStateStatus }[],
  day: DayKey,
): boolean {
  return !dayStates.some((d) => d.day === day);
}

export interface ExerciseAssessmentInput {
  workouts: { performedAt: string; kind: WorkoutKind }[];
  dayStates: { day: string; status: DayStateStatus }[];
  attacks: { start: string; end: string | null }[];
  day: DayKey;
  now: number;
  timeZone: string;
}

export interface ExerciseAssessment {
  /** 'attack' or 'goals-met'; null means a reminder is still appropriate. */
  suppressed: 'attack' | 'goals-met' | null;
  /** Effective day state, including an inferred attack day. */
  state: DayStateStatus | 'unknown';
  counts: WorkoutWeekCounts;
  strengthMet: boolean;
  cardioMet: boolean;
}

/**
 * Exercise reminder condition for one local day.
 *
 * - An explicit Attack day record suppresses the reminder entirely.
 * - When no explicit record exists, an Attack inferred from an attack
 *   overlapping the assessed local day also suppresses it.
 * - INDEPENDENTLY of the day-state record, an attack that is active at `now`
 *   suppresses the reminder even beside an explicit Well/Off record. Active
 *   means: a valid start at or before `now` (a future-start attack is not
 *   active), overlapping the assessed local day, and either no end yet
 *   (null/undefined/empty, as the server treats `end: ''` as ongoing) or a
 *   valid end strictly later than `now`. Ended attacks (end <= now) and
 *   future-start attacks never trigger this override, so an ended attack keeps
 *   the existing explicit-record recovery semantics. An open end is known to
 *   reach only up to `now` (the same cap `hasAttackThatDay` uses), so a future
 *   assessed local day is never suppressed by it.
 * - Off alone does NOT suppress the reminder: the server uses gentler
 *   light-option wording instead.
 * - Goals met suppresses the reminder; the attack override still wins over
 *   goals-met, matching the explicit-attack precedence.
 * - Mobility is tracked but never satisfies strength/cardio (shared counts).
 *
 * `state` always prefers an explicit record (display/wording), falling back to
 * an inferred attack day, and is not itself changed by the active-at-now rule.
 * Recovery after an attack ends is assessment-level (state/wording) only: an
 * exercise occurrence already skipped as `condition_gone` is terminal and is
 * never resurrected later that same local day; only future local days assess
 * fresh.
 */
export function assessExercise({
  workouts, dayStates, attacks, day, now, timeZone,
}: ExerciseAssessmentInput): ExerciseAssessment {
  const dayStart = dayKeyStartMs(day, timeZone);
  const dayEnd = dayKeyStartMs(addDays(day, 1), timeZone);
  const hasAttackThatDay = attacks.some((attack) => {
    const start = Date.parse(attack.start);
    if (!Number.isFinite(start)) return false;
    const end = attack.end ? Date.parse(attack.end) : now;
    return Number.isFinite(end) && start < dayEnd && end > dayStart;
  });
  const attackActiveNow = attacks.some((attack) => {
    const start = Date.parse(attack.start);
    if (!Number.isFinite(start) || start > now || start >= dayEnd) return false;
    if (!attack.end) {
      // No end yet: still ongoing, but an open end is only known to reach up to
      // `now` (same cap hasAttackThatDay uses), so the assessed local day must
      // already have started; a future assessed day is never suppressed.
      return now > dayStart;
    }
    const end = Date.parse(attack.end);
    return Number.isFinite(end) && end > now && end > dayStart;
  });
  const record = dayStates.find((d) => d.day === day) ?? null;
  const state: DayStateStatus | 'unknown' = record
    ? record.status
    : hasAttackThatDay ? 'attack' : 'unknown';

  const counts = countWorkoutsInWeek(workouts, day, timeZone);
  const goals = weekGoalStatus(counts);
  const suppressed = attackActiveNow || state === 'attack'
    ? 'attack'
    : goals.strengthMet && goals.cardioMet ? 'goals-met' : null;

  return {
    suppressed,
    state,
    counts,
    strengthMet: goals.strengthMet,
    cardioMet: goals.cardioMet,
  };
}

export interface LowStockInput {
  baselines: StockBaselineLike[];
  doses: StockDoseLike[];
  refills: StockRefillLike[];
  now: number;
  timeZone: string;
  threshold: number;
}

export interface LowStockAssessment {
  status: 'unknown' | 'known';
  quantity: number | null;
  threshold: number;
  /** Never true when stock is unknown; negative counts are low. */
  low: boolean;
}

/** Server/client-shared low-stock condition (threshold includes equality). */
export function assessLowStock(input: LowStockInput): LowStockAssessment {
  const stock = currentStock(
    { baselines: input.baselines, doses: input.doses, refills: input.refills },
    { now: input.now, timeZone: input.timeZone },
  );
  return {
    status: stock.status,
    quantity: stock.quantity,
    threshold: input.threshold,
    low: stock.status === 'known'
      && stock.quantity !== null
      && stock.quantity <= input.threshold,
  };
}

export function checkInOccurrenceKey(day: DayKey): string {
  return `checkin:${day}`;
}

export function exerciseOccurrenceKey(day: DayKey): string {
  return `exercise:${day}`;
}

export function preventiveOccurrenceKey(medId: string, dueDay: DayKey): string {
  return `preventive:${medId}:${dueDay}`;
}

/** Episode keys are ISO instants, so they survive restarts deterministically. */
export function stockOccurrenceKey(episodeKey: string): string {
  return `stock:nurtec:${episodeKey}`;
}

export interface TransientWindow {
  scheduledMs: number;
  expiresMs: number;
  scheduledAt: string;
  expiresAt: string;
}

/** Scheduled local time + grace window for a one-per-local-day reminder. */
export function transientWindow(
  day: DayKey,
  time: string,
  graceMinutes: number,
  timeZone: string,
): TransientWindow {
  const scheduledMs = zonedDateTimeToMs(day, time, timeZone);
  const expiresMs = scheduledMs + graceMinutes * 60000;
  return {
    scheduledMs,
    expiresMs,
    scheduledAt: new Date(scheduledMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
  };
}
