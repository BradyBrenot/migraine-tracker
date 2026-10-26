import { describe, it, expect } from 'vitest';
import {
  decideHydration,
  deriveSyncStatus,
  latchFlag,
  shouldCleanOnDrain,
} from './sync.ts';

describe('decideHydration', () => {
  it('covers all eight boolean combinations', () => {
    // Server empty: pushing the full local snapshot (records AND settings)
    // is safe — there is nothing on the server to overwrite. Settings-only
    // offline changes (dirty, empty arrays) must take this upload path too;
    // a 'nothing' here would silently drop them and clear the dirty latch.
    expect(decideHydration(true, true, false)).toBe('upload-local');
    expect(decideHydration(true, true, true)).toBe('upload-local');
    expect(decideHydration(true, false, true)).toBe('upload-local');

    // Server empty + local clean + nothing local at all: genuinely nothing.
    expect(decideHydration(true, false, false)).toBe('nothing');

    // Server has data + local dirty: unconfirmed local state must never be
    // silently replaced. Notably dirty + EMPTY local + nonempty server is a
    // conflict, not a hydration: offline deletions are "dirty" and hydrating
    // here would resurrect records the user deliberately removed.
    expect(decideHydration(false, true, true)).toBe('conflict');
    expect(decideHydration(false, false, true)).toBe('conflict');

    // Server has data + local clean: adopting the server snapshot cannot
    // lose unsaved work.
    expect(decideHydration(false, true, false)).toBe('hydrate-server');
    expect(decideHydration(false, false, false)).toBe('hydrate-server');
  });
});

describe('deriveSyncStatus', () => {
  it('lets conflict dominate every other signal', () => {
    expect(
      deriveSyncStatus({ serverMode: true, diverged: true, failed: true, pending: 2 }),
    ).toBe('conflict');
  });

  it('reports conflict even in local mode', () => {
    expect(
      deriveSyncStatus({ serverMode: false, diverged: true, failed: false, pending: 0 }),
    ).toBe('conflict');
  });

  it('masks server failures and pending work in local mode', () => {
    expect(
      deriveSyncStatus({ serverMode: false, diverged: false, failed: true, pending: 3 }),
    ).toBe('local');
  });

  it('reports syncing while writes are pending, even after a failure', () => {
    expect(
      deriveSyncStatus({ serverMode: true, diverged: false, failed: false, pending: 2 }),
    ).toBe('syncing');
    expect(
      deriveSyncStatus({ serverMode: true, diverged: false, failed: true, pending: 1 }),
    ).toBe('syncing');
  });

  it('reports error only from the failure latch once the queue drains', () => {
    expect(
      deriveSyncStatus({ serverMode: true, diverged: false, failed: true, pending: 0 }),
    ).toBe('error');
  });

  it('reports synced when everything is clear', () => {
    expect(
      deriveSyncStatus({ serverMode: true, diverged: false, failed: false, pending: 0 }),
    ).toBe('synced');
  });
});

describe('latchFlag', () => {
  it('latches until an explicit clean event', () => {
    expect(latchFlag(false, false)).toBe(false);
    expect(latchFlag(false, true)).toBe(true);
    // Key property: a later clear-event (set=false) cannot unset an earlier
    // set — once failed/dirty, it stays until confirmed resolution.
    expect(latchFlag(true, false)).toBe(true);
    expect(latchFlag(true, true)).toBe(true);
  });
});

describe('shouldCleanOnDrain', () => {
  it('cleans only after a successful full drain with no failure and no divergence', () => {
    expect(shouldCleanOnDrain(true, false, false)).toBe(true);
    // Any failure during the drain keeps the latches — the newest success
    // must not clear an earlier failure.
    expect(shouldCleanOnDrain(true, true, false)).toBe(false);
    expect(shouldCleanOnDrain(true, false, true)).toBe(false);
    expect(shouldCleanOnDrain(false, false, false)).toBe(false);
  });
});
