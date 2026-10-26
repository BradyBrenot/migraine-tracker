/**
 * Shared sync-state decision helpers.
 *
 * This module MUST stay erasable-syntax only (no enums, namespaces, parameter
 * properties, or other code-emitting TypeScript constructs) and
 * double-environment safe: it is bundled by Vite for the browser and also
 * consumed directly by Node 24 via native type-stripping. Pure functions only
 * — no I/O, no clocks, no console, no DOM.
 */

export type SyncStatus = 'local' | 'synced' | 'syncing' | 'error' | 'conflict';

export interface SyncSignals {
  serverMode: boolean;
  /** Conflict detected, local kept, server writes paused. */
  diverged: boolean;
  /** A queued write failed; only a confirmed full exchange can clear it. */
  failed: boolean;
  /** Writes currently queued or in flight. */
  pending: number;
}

/**
 * Reduce raw sync signals to one user-facing status.
 *
 * Precedence: diverged -> 'conflict'; !serverMode -> 'local'; pending > 0 ->
 * 'syncing'; failed -> 'error'; else 'synced'.
 *
 * Safety rationale: an unresolved conflict always dominates (user data
 * diverged and automated writes are paused — that needs a human decision).
 * While writes are in flight the store is 'syncing', not 'error': a failure
 * latch must not mask work that may still succeed. 'error' comes solely from
 * the failure latch, never from merely being dirty.
 */
export function deriveSyncStatus(s: SyncSignals): SyncStatus {
  if (s.diverged) return 'conflict';
  if (!s.serverMode) return 'local';
  if (s.pending > 0) return 'syncing';
  if (s.failed) return 'error';
  return 'synced';
}

export type HydrationAction =
  | 'upload-local'
  | 'hydrate-server'
  | 'conflict'
  | 'nothing';

/**
 * Decide what happens when the browser store meets the server snapshot.
 *
 * - `serverEmpty && (dirty || localHasData)` -> 'upload-local': the server
 *   has nothing to overwrite, so pushing the full local snapshot (records
 *   AND settings) is safe. Settings-only offline changes (empty arrays but
 *   dirty) take this same path — treating them as 'nothing' would silently
 *   drop them and clear the dirty latch.
 * - `serverEmpty && !dirty && !localHasData` -> 'nothing': both sides empty.
 * - `!serverEmpty && dirty` -> 'conflict': unconfirmed local state must never
 *   be silently replaced. This also covers dirty with an empty local store —
 *   offline deletions are "dirty" and hydrating here would resurrect records
 *   the user deliberately removed.
 * - otherwise -> 'hydrate-server': local is clean, so adopting the server
 *   snapshot cannot lose unsaved work.
 */
export function decideHydration(
  serverEmpty: boolean,
  localHasData: boolean,
  dirty: boolean,
): HydrationAction {
  if (!serverEmpty) return dirty ? 'conflict' : 'hydrate-server';
  if (dirty || localHasData) return 'upload-local';
  return 'nothing';
}

/**
 * Monotonic latch: `prev || set`. Once a flag is set it stays set until an
 * explicit, confirmed clean event — later non-set events may never unset it.
 */
export function latchFlag(prev: boolean, set: boolean): boolean {
  return prev || set;
}

/**
 * May the dirty/failed latches clear now that the write queue has fully
 * drained on a successful newest write? Only when nothing failed during the
 * drain and no divergence pause is active. A single failure in the drain
 * keeps both latches: later successes must never clear an earlier failure.
 */
export function shouldCleanOnDrain(
  succeeded: boolean,
  failed: boolean,
  diverged: boolean,
): boolean {
  return succeeded && !failed && !diverged;
}
