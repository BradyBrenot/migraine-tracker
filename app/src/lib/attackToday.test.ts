import { describe, expect, it } from 'vitest';
import type { Attack } from '@/types';
import { buildAttackIndex } from './attackToday.ts';

function attack(partial: Partial<Attack> & Pick<Attack, 'id'>): Attack {
  return {
    start: '2026-06-01T09:00:00.000Z',
    end: '2026-06-01T11:00:00.000Z',
    painLog: [],
    peakPain: 5,
    symptoms: [],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
    ...partial,
  };
}

describe('buildAttackIndex', () => {
  it('partitions on the raw end === null and preserves input order', () => {
    const attacks = [
      attack({ id: 'f1' }),
      attack({ id: 'o1', start: '2026-06-02T08:00:00.000Z', end: null }),
      attack({ id: 'f2', start: '2026-06-03T09:00:00.000Z', end: '2026-06-03T10:00:00.000Z' }),
      attack({ id: 'o2', start: '2026-06-04T08:00:00.000Z', end: null }),
    ];

    const index = buildAttackIndex(attacks);
    expect(index.finished).toHaveLength(2);
    expect(index.ongoing).toHaveLength(2);
    expect(index.ongoing[0].startMs).toBe(Date.parse('2026-06-02T08:00:00.000Z'));
    expect(index.ongoing[1].startMs).toBe(Date.parse('2026-06-04T08:00:00.000Z'));
    // Finished intervals are parsed, never clock-substituted.
    expect(index.finished[0].endMs).toBe(Date.parse('2026-06-01T11:00:00.000Z'));
  });

  it('keeps a dirty finished end in the finished bucket as degenerate', () => {
    const index = buildAttackIndex([
      attack({ id: 'dirty-end', end: 'garbage' }),
      attack({ id: 'empty-end', end: '' }),
      // A runtime `undefined` is not `null`, matching parseAttackTimes' strict
      // check: it is a finished attack with an unusable end.
      attack({ id: 'undefined-end', end: undefined as unknown as null }),
    ]);

    expect(index.ongoing).toHaveLength(0);
    expect(index.finished).toHaveLength(3);
    for (const entry of index.finished) {
      expect(entry.startMs).toBe(Date.parse('2026-06-01T09:00:00.000Z'));
      expect(entry.endMs).toBeNull();
    }
  });

  it('keeps an ongoing attack with an unusable start in the ongoing bucket', () => {
    const index = buildAttackIndex([
      attack({ id: 'bad-start', start: 'not-a-date', end: null }),
    ]);
    expect(index.finished).toHaveLength(0);
    expect(index.ongoing).toEqual([{ startMs: null }]);
  });
});
