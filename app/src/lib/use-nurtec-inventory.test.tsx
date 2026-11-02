// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { nurtecInventory } from './inventory.ts';
import { useNurtecInventory } from './use-nurtec-inventory.ts';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');

function makeState() {
  return {
    stockBaselines: [{
      id: 'b1',
      medId: 'nurtec',
      effectiveAt: '2026-06-01T00:00:00.000Z',
      quantity: 10,
      notes: '',
      source: 'manual' as const,
      createdAt: '2026-06-01T00:00:00.000Z',
    }],
    meds: [
      {
        id: 'm-past',
        medId: 'nurtec',
        ts: '2026-06-10T12:00:00.000Z',
        quantity: 1,
        attackId: null,
        notes: '',
        source: 'manual' as const,
      },
      {
        id: 'm-future',
        medId: 'nurtec',
        ts: '2026-06-15T12:00:10.000Z',
        quantity: 1,
        attackId: null,
        notes: '',
        source: 'manual' as const,
      },
    ],
    refills: [],
    timezone: 'UTC',
    lowStockThreshold: 2,
  };
}

describe('useNurtecInventory', () => {
  it('matches the array implementation and updates as now crosses a future dose', () => {
    const state = makeState();
    const { result, rerender } = renderHook(
      ({ now }) => useNurtecInventory(state, now),
      { initialProps: { now: NOW } },
    );

    expect(result.current).toEqual(nurtecInventory(state, NOW));
    expect(result.current.quantity).toBe(9); // only the past dose is effective

    rerender({ now: NOW + 15000 });
    expect(result.current).toEqual(nurtecInventory(state, NOW + 15000));
    expect(result.current.quantity).toBe(8); // future dose is now effective
  });
});
