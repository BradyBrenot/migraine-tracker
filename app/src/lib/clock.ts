import { useSyncExternalStore } from 'react';

/**
 * Render-safe wall clock as a proper external store.
 *
 * Components must not call `Date.now()` during render (it is impure and makes
 * renders unreproducible). Instead they subscribe here: a single shared
 * interval ticks every CLOCK_INTERVAL_MS and notifies subscribers, and
 * `getClockNow()` returns a value that is stable between ticks — exactly the
 * contract `useSyncExternalStore` requires.
 *
 * Resolution is deliberately coarse (~15s): it drives "attack running for
 * 2h 15m" style displays, not precision timing. Precision instants are always
 * captured inside event handlers, never during render.
 */

const CLOCK_INTERVAL_MS = 15000;

let now = Date.now(); // module init — outside any render
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  const t = Date.now();
  if (t !== now) {
    now = t;
    for (const l of listeners) l();
  }
}

function subscribeClock(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (!timer) timer = setInterval(tick, CLOCK_INTERVAL_MS);
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getClockNow(): number {
  return now;
}

/**
 * Render-safe forced refresh for optimistic mutations.
 *
 * Call ONLY from event handlers or effects — never during render — to capture
 * a fresh wall-clock instant into the shared store and wake subscribers. The
 * coarse 15s interval alone means UI computed from `useNow()` can look stale
 * right after an optimistic change (e.g. the Home stock badge ignoring a dose
 * logged "now" because the dose instant is newer than the last tick).
 * `bumpClock()` makes such recomputation immediate while preserving the
 * `useSyncExternalStore` contract: the snapshot stays stable between
 * notifications, no timers are created or removed, and subscription cleanup
 * is unchanged.
 */
export function bumpClock(): void {
  now = Date.now();
  for (const l of listeners) l();
}

/** Coarse, render-safe "now" (epoch ms) that updates ~every 15s while subscribed. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, getClockNow);
}
