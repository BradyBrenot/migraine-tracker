import { describe, expect, it } from 'vitest';
import type { MedEvent } from '@/types';
import { buildMedIndex, lowerBound } from './medIndex.ts';

let seq = 0;

function med(medId: string, ts: string): MedEvent {
  seq++;
  return {
    id: `m-${seq}`,
    medId,
    ts,
    attackId: null,
    notes: '',
    source: 'manual',
  };
}

describe('buildMedIndex', () => {
  it('groups by medId, sorts unsorted input, and keeps duplicates', () => {
    const index = buildMedIndex([
      med('nurtec', '2026-06-03T09:00:00.000Z'),
      med('tylenol', '2026-06-01T09:00:00.000Z'),
      med('nurtec', '2026-06-01T09:00:00.000Z'),
      med('nurtec', '2026-06-02T09:00:00.000Z'),
      med('nurtec', '2026-06-02T09:00:00.000Z'),
    ]);

    const nurtec = index.byId.get('nurtec');
    expect(nurtec?.instantsAsc).toEqual([
      Date.parse('2026-06-01T09:00:00.000Z'),
      Date.parse('2026-06-02T09:00:00.000Z'),
      Date.parse('2026-06-02T09:00:00.000Z'),
      Date.parse('2026-06-03T09:00:00.000Z'),
    ]);
    expect(nurtec?.latestMs).toBe(Date.parse('2026-06-03T09:00:00.000Z'));
  });

  it('skips unparseable timestamps and handles an empty history', () => {
    const index = buildMedIndex([
      med('nurtec', 'not-a-date'),
      med('nurtec', '2026-06-01T09:00:00.000Z'),
    ]);
    expect(index.byId.get('nurtec')?.instantsAsc)
      .toEqual([Date.parse('2026-06-01T09:00:00.000Z')]);

    expect(buildMedIndex([]).byId.size).toBe(0);
  });

  it('keeps future instants in the index', () => {
    const future = '2030-01-01T09:00:00.000Z';
    const index = buildMedIndex([med('nurtec', future)]);
    expect(index.byId.get('nurtec')?.latestMs).toBe(Date.parse(future));
  });
});

describe('lowerBound', () => {
  it('returns the first index >= the cutoff', () => {
    const arr = [10, 20, 20, 30];
    expect(lowerBound(arr, 5)).toBe(0);
    expect(lowerBound(arr, 10)).toBe(0);
    expect(lowerBound(arr, 11)).toBe(1);
    expect(lowerBound(arr, 20)).toBe(1);
    expect(lowerBound(arr, 31)).toBe(4);
    expect(lowerBound([], 10)).toBe(0);
  });
});
