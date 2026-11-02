import { describe, expect, it } from 'vitest';
import type { Attack } from '@/types';
import { attackDayKeys } from '../../shared/attackstats.ts';
import {
  attackDayKeysForFinished, buildAttackIndex, type FinishedAttack,
} from './attackToday.ts';

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
    expect(index.ongoing.map((entry) => entry.order)).toEqual([1, 3]);
    // Finished intervals are parsed, never clock-substituted.
    expect(index.finished[0].endMs).toBe(Date.parse('2026-06-01T11:00:00.000Z'));
    expect(index.finished.map((entry) => entry.order)).toEqual([0, 2]);
    expect(index.finished[0].attack.id).toBe('f1');
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
    expect(index.ongoing).toHaveLength(1);
    expect(index.ongoing[0]).toMatchObject({ startMs: null, order: 0 });
    expect(index.ongoing[0].attack.id).toBe('bad-start');
  });
});

describe('attackDayKeysForFinished', () => {
  it('caches per attack and timezone, revalidating both raw strings', () => {
    const a = attack({ id: 'cached' }) as FinishedAttack;

    const utc1 = attackDayKeysForFinished(a, 'UTC');
    const utc2 = attackDayKeysForFinished(a, 'UTC');
    expect(utc2).toBe(utc1);
    expect(utc1).toEqual(attackDayKeys(
      Date.parse(a.start), Date.parse(a.end), 'UTC',
    ));

    const ny = attackDayKeysForFinished(a, 'America/New_York');
    expect(ny).not.toBe(utc1);
    expect(ny).toEqual(attackDayKeys(
      Date.parse(a.start), Date.parse(a.end), 'America/New_York',
    ));

    // In-place mutation must not serve the old keys.
    a.start = '2026-06-10T09:00:00.000Z';
    a.end = '2026-06-10T11:00:00.000Z';
    expect(attackDayKeysForFinished(a, 'UTC')).toEqual(['2026-06-10']);
  });

  it('matches the uncached helper for a dirty finished end', () => {
    const a = attack({ id: 'dirty', end: 'garbage' }) as FinishedAttack;
    expect(attackDayKeysForFinished(a, 'UTC')).toEqual(attackDayKeys(
      Date.parse(a.start), null, 'UTC',
    ));
  });

  it('structurally refuses ongoing attacks', () => {
    const ongoing = attack({ id: 'open', end: null }) as unknown as FinishedAttack;
    expect(() => attackDayKeysForFinished(ongoing, 'UTC')).toThrow(TypeError);
  });
});
