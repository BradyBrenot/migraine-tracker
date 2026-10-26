/**
 * Nurtec stock calculation shared by the browser (optimistic display) and
 * the server (authoritative GET /api/inventory/nurtec and, later, the
 * checkpoint 6 reminder scheduler — this module must stay usable without
 * any browser state).
 *
 * Semantics (documented contract, mirrored by tests):
 * - A dose's effective instant is its `ts` (full ISO instant).
 * - A refill's effective instant is the START of its local `YYYY-MM-DD` day
 *   in the configured time zone (refills are date-only records).
 * - A baseline applies when `effectiveAt <= now`; future baselines are not
 *   applicable yet.
 * - The governing baseline is the LATEST applicable one, ordered by
 *   effective instant, then createdAt (insertion clock), then id (stable
 *   tie-break for identical instants).
 * - Only events STRICTLY AFTER the governing baseline's effective instant
 *   alter it (an event at exactly the baseline instant is subsumed by the
 *   baseline's absolute count). Events after `now` do not count either.
 * - Same-day corrections: because a refill's instant is the start of its
 *   day, a correction at ANY time on day D supersedes that day's earlier
 *   events — including date-only refills of day D — and is itself the new
 *   absolute count.
 * - stock = baseline.quantity + known refill quantities − known dose
 *   quantities. Unknown quantities (null/undefined/garbage) change nothing.
 * - Negative results are kept (reconciliation warning); never clamped.
 * - With no applicable baseline the stock is UNKNOWN — never zero.
 *
 * This module MUST stay erasable-syntax only and double-environment safe
 * (Vite bundle + Node 24 native type-stripping), like shared/datetime.ts.
 */

import { dayKeyStartMs } from './datetime.ts';

/** An absolute stock baseline/correction record (medication-scoped). */
export interface StockBaselineLike {
  id: string;
  /** Full ISO instant from which this absolute count holds. */
  effectiveAt: string;
  /** Nonnegative tablet count (validated upstream). */
  quantity: number;
  /** Full ISO instant of when the record was created (tie-break). */
  createdAt: string;
}

/** A medication dose event; only `ts` and `quantity` matter here. */
export interface StockDoseLike {
  id: string;
  /** Full ISO instant of the dose. */
  ts: string;
  /** Tablets taken, or null/undefined when unknown (legacy free text). */
  quantity?: number | null;
}

/** A pharmacy pickup; `date` is a local 'YYYY-MM-DD' day key. */
export interface StockRefillLike {
  id: string;
  date: string;
  /** Tablets acquired, or null/undefined when unknown. */
  quantity?: number | null;
}

export interface StockInput {
  baselines: StockBaselineLike[];
  doses: StockDoseLike[];
  refills: StockRefillLike[];
}

export interface StockOptions {
  /** "Now" as epoch ms or a full ISO instant string. */
  now: number | string;
  /** IANA zone used to resolve date-only refill days to instants. */
  timeZone: string;
}

export interface StockResult {
  /** 'known' once an applicable baseline exists; 'unknown' before it. */
  status: 'unknown' | 'known';
  /** Tablets on hand; null when unknown. May be negative. */
  quantity: number | null;
  /** id / effectiveAt of the governing baseline, if any. */
  baselineId: string | null;
  baselineEffectiveAt: string | null;
}

function toMs(value: number | string): number {
  return typeof value === 'number' ? value : Date.parse(value);
}

/** A quantity counts only when it is an actual finite number. */
function knownQuantity(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Effective instant of an event in epoch ms, or null when the record cannot
 * be ordered (malformed timestamp/date). Unorderable records are skipped by
 * design: the server validates new writes, so this only guards dirty legacy
 * rows from poisoning the whole calculation.
 */
function doseInstant(dose: StockDoseLike): number | null {
  const ms = Date.parse(dose.ts);
  return Number.isFinite(ms) ? ms : null;
}

function refillInstant(refill: StockRefillLike, timeZone: string): number | null {
  try {
    return dayKeyStartMs(refill.date, timeZone);
  } catch {
    return null; // malformed day key
  }
}

/**
 * Deterministic current-stock calculation. Pure: inject `now` and
 * `timeZone`; never reads the clock or the DOM.
 */
export function currentStock(
  { baselines, doses, refills }: StockInput,
  { now, timeZone }: StockOptions,
): StockResult {
  const nowMs = toMs(now);

  // 1. Governing baseline: latest APPLICABLE one (effectiveAt <= now),
  //    ordered by (effectiveAt, createdAt, id).
  let baseline: StockBaselineLike | null = null;
  let baselineMs = Number.NaN;
  for (const b of baselines) {
    const effectiveMs = Date.parse(b.effectiveAt);
    if (!Number.isFinite(effectiveMs) || effectiveMs > nowMs) continue; // future/garbage
    if (
      baseline === null
      || effectiveMs > baselineMs
      || (effectiveMs === baselineMs && (
        Date.parse(b.createdAt) > Date.parse(baseline.createdAt)
        || (Date.parse(b.createdAt) === Date.parse(baseline.createdAt) && b.id > baseline.id)
      ))
    ) {
      baseline = b;
      baselineMs = effectiveMs;
    }
  }

  if (baseline === null) {
    return { status: 'unknown', quantity: null, baselineId: null, baselineEffectiveAt: null };
  }

  // 2. Events strictly after the baseline instant and not in the future.
  //    Unknown quantities never change the stock; unorderable ones are
  //    skipped (see above).
  let stock = baseline.quantity;
  for (const r of refills) {
    const at = refillInstant(r, timeZone);
    if (at === null || at <= baselineMs || at > nowMs) continue;
    if (knownQuantity(r.quantity)) stock += r.quantity;
  }
  for (const d of doses) {
    const at = doseInstant(d);
    if (at === null || at <= baselineMs || at > nowMs) continue;
    if (knownQuantity(d.quantity)) stock -= d.quantity;
  }

  return {
    status: 'known',
    quantity: stock,
    baselineId: baseline.id,
    baselineEffectiveAt: baseline.effectiveAt,
  };
}

export type StockLevel = 'unknown' | 'ok' | 'low' | 'negative';

/**
 * Display classification. Negative wins over low (reconciliation warning);
 * unknown is never low.
 */
export function classifyStock(quantity: number | null, threshold: number): StockLevel {
  if (quantity === null) return 'unknown';
  if (quantity < 0) return 'negative';
  if (quantity <= threshold) return 'low';
  return 'ok';
}
