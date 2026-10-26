export interface PainPoint {
  ts: string; // ISO timestamp
  level: number; // 0-10
}

export interface Attack {
  id: string;
  start: string; // ISO timestamp
  end: string | null; // null = ongoing
  painLog: PainPoint[]; // chronological pain check-ins
  peakPain: number; // cached max (0-10); -1 = not recorded
  symptoms: string[];
  triggers: string[];
  aura: boolean | null;
  notes: string;
  source: 'manual' | 'import';
}

export interface MedEvent {
  id: string;
  medId: string; // key into med catalog, or custom name
  dose?: string;
  /** Structured tablet count; null/absent = UNKNOWN (legacy free-text doses). */
  quantity?: number | null;
  ts: string; // ISO timestamp
  attackId: string | null;
  notes: string;
  source: 'manual' | 'import';
}

/** A pharmacy refill pickup (e.g. Nurtec 75 mg ×8) — historical burden signal. */
export interface Refill {
  id: string;
  medId: string;
  date: string; // YYYY-MM-DD (pickup day; time not tracked)
  /** Structured tablet count; null/absent = UNKNOWN (legacy notes are never parsed). */
  quantity?: number | null;
  notes: string; // e.g. quantity, pharmacy
  source: 'manual' | 'import';
}

/**
 * A dated ABSOLUTE stock count for one medication — either the initial
 * stock or a later manual correction (a correction replaces the running
 * count, it does not increment it). `effectiveAt`/`createdAt` are full ISO
 * instants; the stock calculation orders by effectiveAt, then createdAt,
 * then id.
 */
export interface StockBaseline {
  id: string;
  medId: string;
  effectiveAt: string; // full ISO instant
  quantity: number; // nonnegative tablet count
  notes: string;
  source: 'manual' | 'import';
  createdAt: string; // full ISO instant (set by the server on create)
}

export type WorkoutKind = 'strength' | 'cardio' | 'mobility';
export type WorkoutEffort = 'low' | 'medium' | 'hard';

/** A logged training session. */
export interface Workout {
  id: string;
  performedAt: string; // full ISO timestamp
  kind: WorkoutKind;
  effort: WorkoutEffort;
  durationMinutes: number | null; // optional
  notes: string;
  source: 'manual' | 'import';
}

export type DayStateStatus = 'well' | 'off' | 'attack';

/** Explicit per-day status; absence means "no explicit choice". */
export interface DayState {
  day: string; // local YYYY-MM-DD in state.timezone
  status: DayStateStatus;
  notes: string;
  updatedAt: string; // full ISO timestamp
}

export interface MedRule {
  limit: number; // max usage days
  windowDays: number; // per rolling window
}

/**
 * Non-secret reminder preferences. Delivery credentials live only in the
 * server environment (NTFY_URL/NTFY_TOKEN); PUBLIC_APP_URL is environment-only
 * too. Delivery bookkeeping is never part of client state.
 */
export interface ReminderSettings {
  /** Master switch. Server delivery itself still requires NTFY_URL. */
  enabled: boolean;
  preventive: boolean;
  lowStock: boolean;
  checkIn: boolean;
  exercise: boolean;
  /** Local waking window 'HH:MM'; end must be after start (no overnight). */
  wakingStart: string;
  wakingEnd: string;
  /** Local check-in time inside waking hours. */
  checkInTime: string;
  /** Local exercise reminder time inside waking hours. */
  exerciseTime: string;
  /** How long a missed daily/exercise prompt may still deliver. */
  graceMinutes: number;
}

export interface TrackerState {
  attacks: Attack[];
  meds: MedEvent[];
  refills: Refill[];
  workouts: Workout[];
  dayStates: DayState[];
  /** dated absolute stock counts (initial stock + manual corrections) */
  stockBaselines: StockBaseline[];
  /** per-med usage-day limits: { nurtec: {limit:15, windowDays:30}, ... } */
  rules: Record<string, MedRule>;
  /** per-med default dose strings, used when quick-logging */
  doses: Record<string, string>;
  /** manually scheduled next dose dates (medId → YYYY-MM-DD), e.g. Botox appointments */
  planned: Record<string, string>;
  /** IANA time zone used for local-day buckets and reminders; non-secret setting. */
  timezone: string;
  /** Low-stock alert level for Nurtec tablets (nonnegative integer; default 2). */
  lowStockThreshold: number;
  /** Non-secret per-type reminder times/toggles/waking window. */
  reminders: ReminderSettings;
  /**
   * One-shot low-stock alert latch: the ISO instant the user-visible alert
   * fired, or null while armed. Reminder-safe non-secret setting — re-arms
   * only once stock is replenished above the threshold (or explicit reset).
   */
  lowStockAlertedAt: string | null;
  seeded: boolean;
}
