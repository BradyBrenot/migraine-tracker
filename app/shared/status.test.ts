import { describe, it, expect } from 'vitest';
import {
  buildStatus,
  STATUS_API_VERSION,
  type StatusAttack,
  type StatusInput,
} from './status.ts';
import { zonedDateTimeToMs } from './datetime.ts';

const NY = 'America/New_York';
const UTC = 'UTC';

/** Epoch ms of a wall-clock time in a zone ('YYYY-MM-DD', 'HH:MM'). */
function at(day: string, time: string, timeZone: string): number {
  return zonedDateTimeToMs(day, time, timeZone);
}

/** Canonical UTC instant of a wall-clock time in a zone. */
function iso(day: string, time: string, timeZone = NY): string {
  return new Date(at(day, time, timeZone)).toISOString();
}

// A fixed clock so every day bucket, count, and rollover is deterministic:
// 2026-06-15 12:00 in New York (16:00Z), mid-year with no DST transition near.
const NOW_DAY = '2026-06-15';
const nowMs = at(NOW_DAY, '12:00', NY);

/** Minimal stored attack row; overrides replace the defaults. */
function attack(overrides: Partial<StatusAttack> = {}): StatusAttack {
  return {
    id: 'a1',
    start: iso('2026-06-15', '10:00'),
    end: null,
    peakPain: -1,
    painLog: [],
    aura: null,
    ...overrides,
  };
}

/** Builder with the fixed clock, New York, and an empty server by default. */
function build(overrides: Partial<StatusInput> = {}) {
  return buildStatus({
    nowMs,
    timeZone: NY,
    attacks: [],
    dayStates: [],
    nurtec: { quantity: null, threshold: 2 },
    ...overrides,
  });
}

describe('buildStatus document frame', () => {
  it('returns the versioned empty document when nothing is recorded', () => {
    const status = build();
    expect(Object.keys(status).sort()).toEqual([
      'activeAttack', 'apiVersion', 'generatedAt', 'history', 'inventory',
      'lastAttack', 'state', 'timeZone', 'today',
    ]);
    expect(status.apiVersion).toBe(STATUS_API_VERSION);
    expect(status.apiVersion).toBe(1);
    expect(status.generatedAt).toBe(new Date(nowMs).toISOString());
    expect(status.timeZone).toBe(NY);
    expect(status.state).toBe('no_data');
    expect(status.activeAttack).toBeNull();
    expect(status.today).toEqual({ day: NOW_DAY, status: null, source: 'none' });
    expect(status.lastAttack).toBeNull();
    expect(status.history).toEqual({
      daysSinceLastAttackStart: null,
      attacksStartedLast30Days: 0,
      attackDaysLast7Days: 0,
      attackDaysLast30Days: 0,
    });
    expect(status.inventory).toEqual({
      nurtec: {
        status: 'unknown', quantity: null, level: 'unknown',
        low: false, negative: false, threshold: 2,
      },
    });
  });

  it('falls back to UTC for a missing/invalid zone and re-buckets the day', () => {
    // 2026-06-14 22:00 New York is 2026-06-15 02:00 UTC: the local day differs.
    const nearMidnight = at('2026-06-14', '22:00', NY);
    expect(build({ nowMs: nearMidnight }).today.day).toBe('2026-06-14');

    const fallback = build({ nowMs: nearMidnight, timeZone: 'Mars/Olympus' });
    expect(fallback.timeZone).toBe(UTC);
    expect(fallback.today.day).toBe('2026-06-15');
  });

  it('normalizes the nurtec aggregate with the shared classification', () => {
    const known = build({ nurtec: { quantity: 4, threshold: 2 } });
    expect(known.inventory.nurtec).toEqual({
      status: 'known', quantity: 4, level: 'ok', low: false, negative: false, threshold: 2,
    });

    const low = build({ nurtec: { quantity: 2, threshold: 2 } });
    expect(low.inventory.nurtec.level).toBe('low');
    expect(low.inventory.nurtec.low).toBe(true);

    const negative = build({ nurtec: { quantity: -3, threshold: 2 } });
    expect(negative.inventory.nurtec).toEqual({
      status: 'known', quantity: -3, level: 'negative', low: true, negative: true, threshold: 2,
    });

    // Garbage quantity/threshold degrade to unknown stock and the default level.
    const garbage = build({ nurtec: { quantity: Number.NaN, threshold: -5 } });
    expect(garbage.inventory.nurtec).toEqual({
      status: 'unknown', quantity: null, level: 'unknown',
      low: false, negative: false, threshold: 2,
    });
  });
});

describe('buildStatus state precedence', () => {
  it('lets an explicit record win over an inferred attack day and a finished attack', () => {
    const status = build({
      attacks: [attack({ start: iso('2026-06-15', '09:00'), end: iso('2026-06-15', '10:00') })],
      dayStates: [{ day: NOW_DAY, status: 'well' }],
    });
    expect(status.state).toBe('well');
    expect(status.today).toEqual({ day: NOW_DAY, status: 'well', source: 'explicit' });
    // The attack still counts as an attack day even though the user said Well.
    expect(status.history.attackDaysLast7Days).toBe(1);
  });

  it('ignores an explicit record for another day', () => {
    const status = build({ dayStates: [{ day: '2026-06-14', status: 'well' }] });
    expect(status.today).toEqual({ day: NOW_DAY, status: null, source: 'none' });
    expect(status.state).toBe('no_data');
  });

  it('ignores a stored day status outside well/off/attack', () => {
    const status = build({ dayStates: [{ day: NOW_DAY, status: 'migraine' }] });
    expect(status.today).toEqual({ day: NOW_DAY, status: null, source: 'none' });
    expect(status.state).toBe('no_data');
  });

  it('reports an ongoing attack regardless of an explicit well/off record', () => {
    for (const status of ['well', 'off'] as const) {
      const doc = build({
        attacks: [attack({ start: iso('2026-06-15', '10:00'), end: null })],
        dayStates: [{ day: NOW_DAY, status }],
      });
      expect(doc.state).toBe('attack');
      expect(doc.activeAttack).not.toBeNull();
      expect(doc.today.status).toBe(status);
      expect(doc.today.source).toBe('explicit');
    }
  });

  it('infers off for a finished attack after 08:00 today', () => {
    const start = iso('2026-06-15', '09:00');
    const end = iso('2026-06-15', '11:00');
    const status = build({ attacks: [attack({ start, end })] });
    expect(status.state).toBe('off');
    expect(status.today).toEqual({ day: NOW_DAY, status: 'off', source: 'inferred' });
    expect(status.activeAttack).toBeNull();
    expect(status.lastAttack).toEqual({
      id: 'a1', start, end, ongoing: false, durationMinutes: 120, peakPain: null,
    });
  });

  it('keeps a legacy explicit attack day as state attack with activeAttack null', () => {
    const status = build({ dayStates: [{ day: NOW_DAY, status: 'attack' }] });
    expect(status.state).toBe('attack');
    expect(status.activeAttack).toBeNull();
    expect(status.today).toEqual({ day: NOW_DAY, status: 'attack', source: 'explicit' });
    expect(status.history.attackDaysLast7Days).toBe(0);
  });
});

describe('buildStatus and the 08:00 attack-day rule', () => {
  it('attributes a 01:00-02:00 attack today to yesterday', () => {
    const status = build({
      attacks: [attack({ start: iso('2026-06-15', '01:00'), end: iso('2026-06-15', '02:00') })],
    });
    expect(status.today.status).toBeNull();
    expect(status.today.source).toBe('none');
    expect(status.state).toBe('no_data');
    expect(status.history.attackDaysLast7Days).toBe(1); // 2026-06-14
    expect(status.history.attackDaysLast30Days).toBe(1);
    expect(status.history.attacksStartedLast30Days).toBe(1); // start day is 06-15
  });

  it('counts both adjacent days for an attack crossing 08:00', () => {
    const status = build({
      attacks: [attack({ start: iso('2026-06-14', '22:00'), end: iso('2026-06-15', '09:00') })],
    });
    expect(status.history.attackDaysLast7Days).toBe(2); // 06-14 and 06-15
    expect(status.today).toEqual({ day: NOW_DAY, status: 'off', source: 'inferred' });
  });

  it('counts only the previous day for an attack ending exactly at 08:00', () => {
    const status = build({
      attacks: [attack({ start: iso('2026-06-15', '06:00'), end: iso('2026-06-15', '08:00') })],
    });
    expect(status.history.attackDaysLast7Days).toBe(1); // half-open: 06-14 only
    expect(status.today.status).toBeNull();
    expect(status.state).toBe('no_data');
  });

  it('counts a night attack that ended before 08:00 on the previous day only', () => {
    const status = build({
      attacks: [attack({ start: iso('2026-06-14', '21:00'), end: iso('2026-06-15', '06:00') })],
    });
    expect(status.history.attackDaysLast7Days).toBe(1); // 06-14
    expect(status.today.status).toBeNull();
  });
});

describe('buildStatus ongoing and last attack selection', () => {
  it('reports a future ongoing attack as attack with no negative duration', () => {
    const start = iso('2026-06-16', '10:00');
    const status = build({ attacks: [attack({ start, end: null, peakPain: 4 })] });
    expect(status.state).toBe('attack');
    expect(status.activeAttack?.start).toBe(start);
    expect(status.lastAttack).toEqual({
      id: 'a1', start, end: null, ongoing: true, durationMinutes: null, peakPain: 4,
    });
    expect(status.today.status).toBeNull(); // no attack overlaps today's window
  });

  it('picks the earliest ongoing attack by canonical order, then id', () => {
    const late = attack({ id: 'z', start: iso('2026-06-15', '11:00'), end: null });
    const early = attack({ id: 'm', start: iso('2026-06-15', '09:00'), end: null });
    // Array order must not matter.
    expect(build({ attacks: [late, early] }).activeAttack?.id).toBe('m');
    expect(build({ attacks: [early, late] }).activeAttack?.id).toBe('m');

    const sameStart = iso('2026-06-15', '09:00');
    const tied = build({
      attacks: [
        attack({ id: 'b', start: sameStart, end: null }),
        attack({ id: 'a', start: sameStart, end: null }),
      ],
    });
    expect(tied.activeAttack?.id).toBe('a');
  });

  it('reports the latest parseable start as lastAttack, ongoing or finished', () => {
    const status = build({
      attacks: [
        attack({ id: 'old', start: iso('2026-06-10', '12:00'), end: iso('2026-06-10', '13:00') }),
        attack({ id: 'open', start: iso('2026-06-14', '12:00'), end: null }),
      ],
    });
    expect(status.lastAttack?.id).toBe('open');
    expect(status.lastAttack?.ongoing).toBe(true);
    expect(status.history.daysSinceLastAttackStart).toBe(1);
  });

  it('breaks an exact start tie by the greater id', () => {
    const start = iso('2026-06-10', '12:00');
    const status = build({
      attacks: [
        attack({ id: 'a', start, end: iso('2026-06-10', '13:00') }),
        attack({ id: 'b', start, end: iso('2026-06-10', '14:00') }),
      ],
    });
    expect(status.lastAttack?.id).toBe('b');
  });

  it('ignores an attack with an unparseable start when selecting lastAttack', () => {
    const status = build({
      attacks: [
        attack({ id: 'bad', start: 'nope', end: '2026-06-15T10:00:00.000Z' }),
        attack({ id: 'good', start: iso('2026-06-10', '12:00'), end: iso('2026-06-10', '13:00') }),
      ],
    });
    expect(status.lastAttack?.id).toBe('good');
    expect(status.activeAttack).toBeNull();
  });

  it('normalizes peakPain and never reports an unknown -1', () => {
    const known = build({ attacks: [attack({ peakPain: 7 })] });
    expect(known.activeAttack?.peakPain).toBe(7);
    expect(known.lastAttack?.peakPain).toBe(7);
    expect(build({ attacks: [attack({ peakPain: -1 })] }).activeAttack?.peakPain).toBeNull();
    expect(build({ attacks: [attack({ peakPain: 11 })] }).activeAttack?.peakPain).toBeNull();
  });

  it('reports aura only when it is a real boolean', () => {
    expect(build({ attacks: [attack({ aura: true })] }).activeAttack?.aura).toBe(true);
    expect(build({ attacks: [attack({ aura: false })] }).activeAttack?.aura).toBe(false);
    expect(build({ attacks: [attack({ aura: null })] }).activeAttack?.aura).toBeNull();
  });
});

describe('buildStatus instants and latestPain', () => {
  it('normalizes naive and offset-bearing start/end strings to canonical UTC', () => {
    const naiveStart = '2026-06-15T12:00:00';
    const naiveEnd = '2026-06-15T14:30:00';
    const naive = build({ attacks: [attack({ start: naiveStart, end: naiveEnd })] });
    expect(naive.lastAttack?.start).toBe(new Date(naiveStart).toISOString());
    expect(naive.lastAttack?.end).toBe(new Date(naiveEnd).toISOString());
    expect(naive.lastAttack?.durationMinutes).toBe(150);

    const offsetStart = '2026-06-15T12:00:00-04:00';
    const offsetEnd = '2026-06-15T14:00:00-04:00';
    const offset = build({ attacks: [attack({ start: offsetStart, end: offsetEnd })] });
    expect(offset.lastAttack?.start).toBe(new Date(offsetStart).toISOString());
    expect(offset.lastAttack?.end).toBe(new Date(offsetEnd).toISOString());
    expect(offset.lastAttack?.durationMinutes).toBe(120);
  });

  it('degrades unparseable starts/ends to nulls without throwing', () => {
    const badOngoing = build({
      attacks: [attack({ start: 'not-a-date', end: null, peakPain: 3 })],
    });
    expect(badOngoing.state).toBe('attack');
    expect(badOngoing.activeAttack).toEqual({
      id: 'a1', start: null, peakPain: 3, latestPain: null, aura: null,
    });
    expect(badOngoing.lastAttack).toBeNull();
    expect(badOngoing.history.daysSinceLastAttackStart).toBeNull();
    expect(badOngoing.history.attacksStartedLast30Days).toBe(0);

    const start = iso('2026-06-15', '09:00');
    const badEnd = build({ attacks: [attack({ start, end: 'garbage' })] });
    expect(badEnd.activeAttack).toBeNull();
    expect(badEnd.lastAttack).toEqual({
      id: 'a1', start, end: null, ongoing: false, durationMinutes: null, peakPain: null,
    });
    // A finished attack with an unusable end degrades to its start instant.
    expect(badEnd.today.status).toBe('off');

    const emptyStart = build({ attacks: [attack({ start: '', end: null })] });
    expect(emptyStart.lastAttack).toBeNull();
    expect(emptyStart.activeAttack?.start).toBeNull();
  });

  it('never throws on a parseable but out-of-domain instant', () => {
    const FAR = '+275760-09-13T00:00:00.000Z';
    expect(Date.parse(FAR)).toBe(8.64e15); // parses, but its day key is not 4-digit

    const status = build({ attacks: [attack({ id: 'far', start: FAR, end: null })] });
    expect(status.activeAttack?.start).toBe(FAR);
    expect(status.lastAttack?.start).toBe(FAR);
    expect(status.history.daysSinceLastAttackStart).toBeNull();
    expect(status.history.attacksStartedLast30Days).toBe(0);
    expect(status.history.attackDaysLast7Days).toBe(0);
    expect(status.history.attackDaysLast30Days).toBe(0);
    expect(status.today.status).toBeNull();
  });

  it('uses the greatest parsed pain timestamp, normalizes it, ignores junk', () => {
    const status = build({
      attacks: [attack({
        painLog: [
          { ts: '2026-06-15T13:00:00.000-04:00', level: 3 }, // 17:00Z
          { ts: '2026-06-15T20:00:00.000Z', level: 5 },
          { ts: 'garbage', level: 9 },
          { ts: '2026-06-15T19:00:00.000Z', level: 7 },
          { ts: '2026-06-15T18:00:00.000Z', level: Number.NaN },
        ],
      })],
    });
    expect(status.activeAttack?.latestPain).toEqual({
      ts: '2026-06-15T20:00:00.000Z', level: 5,
    });
    expect(status.activeAttack).not.toHaveProperty('painLog');
    expect(status.activeAttack).not.toHaveProperty('notes');
  });

  it('keeps the later array element for an exact pain-instant tie', () => {
    const status = build({
      attacks: [attack({
        painLog: [
          { ts: '2026-06-15T18:00:00.000Z', level: 2 },
          { ts: '2026-06-15T14:00:00.000-04:00', level: 8 }, // same instant, later
        ],
      })],
    });
    expect(status.activeAttack?.latestPain).toEqual({
      ts: '2026-06-15T18:00:00.000Z', level: 8,
    });
  });
});

describe('buildStatus history windows', () => {
  const windowAttacks = (): StatusAttack[] => [
    attack({ id: 'a', start: iso('2026-06-10', '10:00'), end: iso('2026-06-10', '11:00') }),
    attack({ id: 'b', start: iso('2026-06-10', '15:00'), end: iso('2026-06-10', '16:00') }),
    attack({ id: 'c', start: iso('2026-06-09', '12:00'), end: iso('2026-06-09', '13:00') }),
    attack({ id: 'd', start: iso('2026-06-08', '09:00'), end: iso('2026-06-08', '10:00') }),
    attack({ id: 'e', start: iso('2026-05-17', '09:00'), end: iso('2026-05-17', '10:00') }),
    attack({ id: 'f', start: iso('2026-05-16', '09:00'), end: iso('2026-05-16', '10:00') }),
  ];

  it('counts distinct attack days and started attacks over the exact windows', () => {
    const status = build({ attacks: windowAttacks() });
    // today = 2026-06-15. 7-day window = 06-09..06-15, 30-day = 05-17..06-15.
    expect(status.history.attackDaysLast7Days).toBe(2); // 06-09, 06-10 (b deduped)
    expect(status.history.attackDaysLast30Days).toBe(4); // + 06-08, 05-17
    expect(status.history.attacksStartedLast30Days).toBe(5); // 05-16 (today-30) excluded
    // lastAttack is the latest start: 06-10 15:00 (b).
    expect(status.lastAttack?.id).toBe('b');
    expect(status.history.daysSinceLastAttackStart).toBe(5);
  });

  it('clamps daysSinceLastAttackStart at 0 for a future start', () => {
    const status = build({
      attacks: [attack({ start: iso('2026-06-16', '10:00'), end: iso('2026-06-16', '09:00') })],
    });
    expect(status.history.daysSinceLastAttackStart).toBe(0);
    // A parseable end before the start is still reported; only the duration is
    // suppressed.
    expect(status.lastAttack?.end).toBe(iso('2026-06-16', '09:00'));
    expect(status.lastAttack?.durationMinutes).toBeNull(); // end before start
  });

  it('keeps the 7/30-day windows across the DST fall-back', () => {
    const afterFallBack = at('2026-11-05', '12:00', NY); // 2026-11-01 falls back
    const status = buildStatus({
      nowMs: afterFallBack,
      timeZone: NY,
      attacks: [attack({
        start: iso('2026-10-31', '22:00'),
        end: iso('2026-11-02', '09:00'),
      })],
      dayStates: [],
      nurtec: { quantity: null, threshold: 2 },
    });
    // 10-31, the 25-hour 11-01, and 11-02 — never a skipped or repeated day.
    expect(status.history.attackDaysLast7Days).toBe(3);
    expect(status.history.attackDaysLast30Days).toBe(3);
    expect(status.today.status).toBeNull();
  });

  it('rolls today over at local midnight, not UTC midnight', () => {
    const midnight = at('2026-06-16', '00:00', NY);
    const lastStart = iso('2026-06-12', '12:00');
    const finished = attack({ start: lastStart, end: iso('2026-06-12', '13:00') });

    const before = build({ nowMs: midnight - 1, attacks: [finished] });
    expect(before.today.day).toBe('2026-06-15');
    expect(before.history.daysSinceLastAttackStart).toBe(3);

    const after = build({ nowMs: midnight, attacks: [finished] });
    expect(after.today.day).toBe('2026-06-16');
    expect(after.history.daysSinceLastAttackStart).toBe(4);
  });
});
