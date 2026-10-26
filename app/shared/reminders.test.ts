import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REMINDER_SETTINGS,
  PREVENTIVE_DUE_TIME,
  PREVENTIVE_INTERVALS,
  assessExercise,
  assessLowStock,
  checkInMissing,
  checkInOccurrenceKey,
  exerciseOccurrenceKey,
  isWithinWakingWindow,
  normalizeReminderSettings,
  preventiveDue,
  preventiveOccurrenceKey,
  reminderSettingsErrors,
  reservedReminderSettingKeys,
  stockOccurrenceKey,
  transientWindow,
} from './reminders.ts';
import type { DayKey } from './datetime.ts';

const NY = 'America/New_York';

type WorkoutKind = 'strength' | 'cardio' | 'mobility';
type DayStatus = 'well' | 'off' | 'attack';

function workout(performedAt: string, kind: WorkoutKind) {
  return { performedAt, kind };
}

function dayState(day: string, status: DayStatus) {
  return { day, status };
}

function attack(start: string, end: string | null) {
  return { start, end };
}

function baseline(id: string, effectiveAt: string, quantity: number) {
  return { id, effectiveAt, quantity, createdAt: effectiveAt };
}

describe('DEFAULT_REMINDER_SETTINGS', () => {
  it('has the documented non-secret shape and passes validation', () => {
    expect(DEFAULT_REMINDER_SETTINGS).toEqual({
      enabled: true,
      preventive: true,
      lowStock: true,
      checkIn: true,
      exercise: true,
      wakingStart: '09:00',
      wakingEnd: '21:00',
      checkInTime: '18:00',
      exerciseTime: '18:30',
      graceMinutes: 120,
    });
    expect(Object.keys(DEFAULT_REMINDER_SETTINGS)).toHaveLength(10);
    expect(reminderSettingsErrors(DEFAULT_REMINDER_SETTINGS)).toEqual([]);
    expect(reservedReminderSettingKeys(DEFAULT_REMINDER_SETTINGS)).toEqual([]);

    expect(PREVENTIVE_DUE_TIME).toBe('09:00');
    expect(PREVENTIVE_INTERVALS).toEqual({ emgality: 30, botox: 84 });
  });

  it('does not reserve unrelated reminder setting names', () => {
    const errors = reminderSettingsErrors({
      ...DEFAULT_REMINDER_SETTINGS,
      enabled: false,
      preventive: false,
      lowStock: false,
      checkIn: false,
      exercise: false,
    });
    expect(errors).toEqual([]);
  });
});

describe('preventiveDue', () => {
  it('uses a planned day and fires at 09:00 local', () => {
    const input = {
      medId: 'emgality',
      intervalDays: PREVENTIVE_INTERVALS.emgality,
      meds: [{ medId: 'emgality', ts: '2026-09-01T15:00:00.000Z' }],
      planned: { emgality: '2026-11-05' },
      timeZone: NY,
    };

    // 09:00 EST on 2026-11-05 is 14:00Z.
    const before = preventiveDue({ ...input, now: Date.parse('2026-11-05T13:59:59.999Z') });
    expect(before).toMatchObject({
      medId: 'emgality',
      intervalDays: 30,
      status: 'scheduled',
      planned: true,
      dueDay: '2026-11-05',
      dueMs: Date.UTC(2026, 10, 5, 14),
    });

    const atDue = preventiveDue({ ...input, now: Date.parse('2026-11-05T14:00:00.000Z') });
    expect(atDue.status).toBe('due');
    expect(atDue.dueMs).toBe(Date.UTC(2026, 10, 5, 14));
  });

  it('adds Emgality interval CALENDAR days and uses the post-DST local 09:00', () => {
    const dose = '2026-02-10T15:00:00.000Z'; // 10:00 EST on Feb 10
    const input = {
      medId: 'emgality',
      intervalDays: PREVENTIVE_INTERVALS.emgality,
      meds: [{ medId: 'emgality', ts: dose }],
      timeZone: NY,
    };

    const result = preventiveDue({ ...input, now: Date.parse('2026-03-12T12:59:00.000Z') });
    // Feb 10 + 30 calendar days = Mar 12; 09:00 EDT is 13:00Z, not 15:00Z.
    expect(result).toMatchObject({
      status: 'scheduled',
      planned: false,
      dueDay: '2026-03-12',
      lastDoseMs: Date.parse(dose),
    });
    expect(result.dueMs).toBe(Date.UTC(2026, 2, 12, 13));
    expect(result.dueMs).toBe(Date.parse('2026-03-12T13:00:00.000Z'));
    // Deliberately not last-dose instant + 30 * 24h (that would be 15:00Z).
    expect(result.dueMs).not.toBe(Date.parse(dose) + 30 * 86_400_000);

    expect(preventiveDue({ ...input, now: Date.UTC(2026, 2, 12, 13) }).status).toBe('due');
  });

  it('adds the Botox interval in calendar days', () => {
    const dose = '2026-02-01T17:00:00.000Z'; // 12:00 EST on Feb 1
    const result = preventiveDue({
      medId: 'botox',
      intervalDays: PREVENTIVE_INTERVALS.botox,
      meds: [{ medId: 'botox', ts: dose }],
      timeZone: NY,
      now: Date.parse('2026-04-26T12:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'scheduled',
      planned: false,
      dueDay: '2026-04-26',
      lastDoseMs: Date.parse(dose),
    });
    // 09:00 EDT on Apr 26 is 13:00Z.
    expect(result.dueMs).toBe(Date.parse('2026-04-26T13:00:00.000Z'));
  });

  it('returns none when never logged and no valid planned date exists', () => {
    expect(preventiveDue({
      medId: 'emgality',
      intervalDays: 30,
      meds: [],
      planned: {},
      timeZone: NY,
      now: Date.parse('2026-06-10T12:00:00.000Z'),
    })).toEqual({
      medId: 'emgality',
      intervalDays: 30,
      status: 'none',
      planned: false,
      dueDay: null,
      dueMs: null,
      lastDoseMs: null,
    });

    // An impossible YYYY-MM-DD is ignored, not treated as a plan.
    expect(preventiveDue({
      medId: 'emgality',
      intervalDays: 30,
      meds: [],
      planned: { emgality: '2026-02-30' },
      timeZone: NY,
      now: Date.parse('2026-06-10T12:00:00.000Z'),
    }).status).toBe('none');
  });

  it('ignores invalid med timestamps and chooses the latest valid dose', () => {
    const result = preventiveDue({
      medId: 'emgality',
      intervalDays: 30,
      meds: [
        { medId: 'emgality', ts: '2026-01-15T15:00:00.000Z' },
        { medId: 'emgality', ts: 'not-a-date' },
        { medId: 'emgality', ts: '2026-02-10T15:00:00.000Z' },
        { medId: 'botox', ts: '2026-05-01T12:00:00.000Z' },
      ],
      planned: { emgality: '2026-02-30' }, // invalid: ignore
      timeZone: NY,
      now: Date.parse('2026-03-01T12:00:00.000Z'),
    });

    expect(result.lastDoseMs).toBe(Date.parse('2026-02-10T15:00:00.000Z'));
    expect(result.planned).toBe(false);
    expect(result.dueDay).toBe('2026-03-12');
  });

  it('returns none when every dose timestamp is invalid', () => {
    expect(preventiveDue({
      medId: 'emgality',
      intervalDays: 30,
      meds: [{ medId: 'emgality', ts: 'garbage' }],
      timeZone: NY,
      now: Date.parse('2026-03-01T12:00:00.000Z'),
    }).status).toBe('none');
  });
});

describe('isWithinWakingWindow', () => {
  const settings = { wakingStart: '09:00', wakingEnd: '21:00' };

  it('treats 09:00 as inside and 21:00 as outside (half-open)', () => {
    // 2026-06-10 is EDT (UTC-4).
    expect(isWithinWakingWindow(Date.parse('2026-06-10T12:59:00.000Z'), settings, NY)).toBe(false); // 08:59
    expect(isWithinWakingWindow(Date.parse('2026-06-10T13:00:00.000Z'), settings, NY)).toBe(true); // 09:00
    expect(isWithinWakingWindow(Date.parse('2026-06-11T00:59:00.000Z'), settings, NY)).toBe(true); // 20:59
    expect(isWithinWakingWindow(Date.parse('2026-06-11T01:00:00.000Z'), settings, NY)).toBe(false); // 21:00
  });

  it('uses local minutes on DST transition days', () => {
    // Spring forward 2026-03-08: 08:59 EDT and 09:00 EDT.
    expect(isWithinWakingWindow(Date.parse('2026-03-08T12:59:00.000Z'), settings, NY)).toBe(false);
    expect(isWithinWakingWindow(Date.parse('2026-03-08T13:00:00.000Z'), settings, NY)).toBe(true);

    // Fall back 2026-11-01: 08:59 EST and 09:00 EST.
    expect(isWithinWakingWindow(Date.parse('2026-11-01T13:59:00.000Z'), settings, NY)).toBe(false);
    expect(isWithinWakingWindow(Date.parse('2026-11-01T14:00:00.000Z'), settings, NY)).toBe(true);
  });
});

describe('transientWindow', () => {
  it('combines the scheduled local time with the grace expiry', () => {
    const window = transientWindow('2026-06-10', '18:00', 120, NY);
    expect(window.scheduledAt).toBe('2026-06-10T22:00:00.000Z');
    expect(window.expiresAt).toBe('2026-06-11T00:00:00.000Z');
    expect(window.scheduledMs).toBe(Date.parse('2026-06-10T22:00:00.000Z'));
    expect(window.expiresMs - window.scheduledMs).toBe(120 * 60_000);
  });

  it('shifts a nonexistent spring-forward time forward by the DST gap', () => {
    const window = transientWindow('2026-03-08', '02:30', 60, NY);
    // 02:30 does not exist; the documented contract resolves it to 03:30 EDT.
    expect(window.scheduledAt).toBe('2026-03-08T07:30:00.000Z');
    expect(window.expiresAt).toBe('2026-03-08T08:30:00.000Z');
    expect(window.expiresMs - window.scheduledMs).toBe(60 * 60_000);
  });

  it('resolves an ambiguous fall-back time to the first occurrence', () => {
    const window = transientWindow('2026-11-01', '01:30', 30, NY);
    // 01:30 occurs twice; the earlier (EDT) instant is 05:30Z.
    expect(window.scheduledAt).toBe('2026-11-01T05:30:00.000Z');
    expect(window.expiresAt).toBe('2026-11-01T06:00:00.000Z');
    expect(window.expiresMs - window.scheduledMs).toBe(30 * 60_000);
  });
});

describe('checkInMissing', () => {
  it('suppresses only an exact matching day record, whatever its status', () => {
    const dayStates = [
      dayState('2026-06-10', 'well'),
      dayState('2026-06-11', 'off'),
      dayState('2026-06-12', 'attack'),
    ];

    expect(checkInMissing(dayStates, '2026-06-10')).toBe(false);
    expect(checkInMissing(dayStates, '2026-06-11')).toBe(false);
    expect(checkInMissing(dayStates, '2026-06-12')).toBe(false);
    expect(checkInMissing(dayStates, '2026-06-13')).toBe(true);
    expect(checkInMissing([], '2026-06-10')).toBe(true);
  });

  it('compares day keys exactly, not as instants or loosely formatted strings', () => {
    const dayStates = [dayState('2026-06-10', 'well')];
    expect(checkInMissing(dayStates, '2026-06-10T00:00:00.000Z')).toBe(true);
    expect(checkInMissing(dayStates, '2026-6-10')).toBe(true);
    expect(checkInMissing(dayStates, '2026-06-1')).toBe(true);
  });
});

describe('assessExercise', () => {
  // Wednesday 2026-06-10 belongs to the Sunday 2026-06-07 (EDT) week.
  const DAY = '2026-06-10';
  const NOW = Date.parse('2026-06-10T20:00:00.000Z');
  const goalsMet = [
    workout('2026-06-08T12:00:00.000Z', 'strength'),
    workout('2026-06-09T12:00:00.000Z', 'strength'),
    workout('2026-06-10T12:00:00.000Z', 'cardio'),
    workout('2026-06-11T12:00:00.000Z', 'cardio'),
    workout('2026-06-12T12:00:00.000Z', 'cardio'),
  ];

  function assess(input: {
    workouts?: ReturnType<typeof workout>[];
    dayStates?: ReturnType<typeof dayState>[];
    attacks?: ReturnType<typeof attack>[];
    day?: DayKey;
    now?: number;
  }) {
    return assessExercise({
      workouts: input.workouts ?? [],
      dayStates: input.dayStates ?? [],
      attacks: input.attacks ?? [],
      day: input.day ?? DAY,
      now: input.now ?? NOW,
      timeZone: NY,
    });
  }

  it('suppresses a week that met both goals', () => {
    expect(assess({ workouts: goalsMet })).toMatchObject({
      suppressed: 'goals-met',
      state: 'unknown',
      counts: { strength: 2, cardio: 3, mobility: 0 },
      strengthMet: true,
      cardioMet: true,
    });
  });

  it('does not suppress when one goal is short', () => {
    const oneShort = [
      workout('2026-06-08T12:00:00.000Z', 'strength'),
      workout('2026-06-10T12:00:00.000Z', 'cardio'),
      workout('2026-06-11T12:00:00.000Z', 'cardio'),
      workout('2026-06-12T12:00:00.000Z', 'cardio'),
    ];
    expect(assess({ workouts: oneShort })).toMatchObject({
      suppressed: null,
      counts: { strength: 1, cardio: 3, mobility: 0 },
      strengthMet: false,
      cardioMet: true,
    });
  });

  it('counts mobility separately and never lets it satisfy strength or cardio', () => {
    const mobilityHeavy = [
      workout('2026-06-08T12:00:00.000Z', 'strength'),
      workout('2026-06-09T12:00:00.000Z', 'cardio'),
      workout('2026-06-10T12:00:00.000Z', 'cardio'),
      workout('2026-06-11T12:00:00.000Z', 'mobility'),
      workout('2026-06-12T12:00:00.000Z', 'mobility'),
      workout('2026-06-13T12:00:00.000Z', 'mobility'),
    ];
    expect(assess({ workouts: mobilityHeavy })).toMatchObject({
      suppressed: null,
      counts: { strength: 1, cardio: 2, mobility: 3 },
      strengthMet: false,
      cardioMet: false,
    });
  });

  it('uses Sunday-start weeks with half-open local bounds', () => {
    const boundaries = [
      // One millisecond before the Sunday 2026-06-07 (EDT) week start.
      workout('2026-06-07T03:59:59.999Z', 'strength'),
      // Exactly the next Sunday 2026-06-14 local midnight.
      workout('2026-06-14T04:00:00.000Z', 'cardio'),
    ];
    expect(assess({ workouts: boundaries }).counts).toEqual({
      strength: 0,
      cardio: 0,
      mobility: 0,
    });
    expect(assess({ workouts: boundaries }).suppressed).toBeNull();

    // Exactly the week start is included; the goals plus boundaries stay met.
    const atWeekStart = workout('2026-06-07T04:00:00.000Z', 'mobility');
    expect(assess({ workouts: [atWeekStart] }).counts).toEqual({
      strength: 0,
      cardio: 0,
      mobility: 1,
    });
    expect(assess({ workouts: [...goalsMet, ...boundaries] })).toMatchObject({
      suppressed: 'goals-met',
      counts: { strength: 2, cardio: 3, mobility: 0 },
    });
  });

  it('lets an explicit attack suppress even when the goals are met', () => {
    expect(assess({
      workouts: goalsMet,
      dayStates: [dayState(DAY, 'attack')],
    })).toMatchObject({
      suppressed: 'attack',
      state: 'attack',
      strengthMet: true,
      cardioMet: true,
    });
  });

  it('infers an attack from an overlapping attack when no day state exists', () => {
    const result = assess({
      attacks: [attack('2026-06-10T10:00:00.000Z', '2026-06-10T15:00:00.000Z')],
    });
    expect(result).toMatchObject({ suppressed: 'attack', state: 'attack' });
    expect(result.counts).toEqual({ strength: 0, cardio: 0, mobility: 0 });

    // Touching the local day boundary does NOT overlap [dayStart, dayEnd).
    expect(assess({
      attacks: [attack('2026-06-09T20:00:00.000Z', '2026-06-10T04:00:00.000Z')],
    }).state).toBe('unknown');
    expect(assess({
      attacks: [attack('2026-06-11T04:00:00.000Z', '2026-06-11T10:00:00.000Z')],
    }).state).toBe('unknown');
  });

  it('keeps an explicit well day even when an attack overlaps', () => {
    expect(assess({
      dayStates: [dayState(DAY, 'well')],
      attacks: [attack('2026-06-10T10:00:00.000Z', '2026-06-10T15:00:00.000Z')],
    })).toMatchObject({ suppressed: null, state: 'well' });
  });

  it('does not suppress an explicit off day (gentler wording handles it)', () => {
    expect(assess({
      dayStates: [dayState(DAY, 'off')],
      attacks: [attack('2026-06-10T10:00:00.000Z', '2026-06-10T15:00:00.000Z')],
    })).toMatchObject({ suppressed: null, state: 'off' });
  });

  it('suppresses an explicitly well day when an attack is still active now', () => {
    expect(assess({
      dayStates: [dayState(DAY, 'well')],
      attacks: [attack('2026-06-10T18:00:00.000Z', null)],
    })).toMatchObject({ suppressed: 'attack', state: 'well' });
  });

  it('suppresses an explicitly off day when an attack is still active now', () => {
    expect(assess({
      dayStates: [dayState(DAY, 'off')],
      attacks: [attack('2026-06-10T18:00:00.000Z', null)],
    })).toMatchObject({ suppressed: 'attack', state: 'off' });
  });

  it('treats a recorded end later than now as active over an explicit off day', () => {
    expect(assess({
      dayStates: [dayState(DAY, 'off')],
      attacks: [attack('2026-06-10T18:00:00.000Z', '2026-06-10T21:00:00.000Z')],
    })).toMatchObject({ suppressed: 'attack', state: 'off' });
  });

  it('does not treat an end exactly at now as active', () => {
    // NOW is 20:00Z; an end of exactly now means the attack has ended.
    expect(assess({
      dayStates: [dayState(DAY, 'well')],
      attacks: [attack('2026-06-10T18:00:00.000Z', '2026-06-10T20:00:00.000Z')],
    })).toMatchObject({ suppressed: null, state: 'well' });
  });

  it('does not treat a future-start attack as active now', () => {
    expect(assess({
      dayStates: [dayState(DAY, 'well')],
      attacks: [attack('2026-06-10T21:00:00.000Z', null)],
    })).toMatchObject({ suppressed: null, state: 'well' });
  });

  it('does not suppress a future assessed day for an ongoing attack', () => {
    // The 2026-06-11 NY day starts at 2026-06-11T04:00Z, after NOW; an open end
    // is only known to reach up to now, so it cannot overlap that day.
    expect(assess({
      attacks: [attack('2026-06-10T18:00:00.000Z', null)],
      day: '2026-06-11',
    })).toMatchObject({ suppressed: null, state: 'unknown' });

    expect(assess({
      dayStates: [dayState('2026-06-11', 'well')],
      attacks: [attack('2026-06-10T18:00:00.000Z', null)],
      day: '2026-06-11',
    })).toMatchObject({ suppressed: null, state: 'well' });
  });

  it('treats a start exactly at now as active', () => {
    expect(assess({
      dayStates: [dayState(DAY, 'well')],
      attacks: [attack('2026-06-10T20:00:00.000Z', null)],
    })).toMatchObject({ suppressed: 'attack', state: 'well' });
  });

  it('keeps ended-attack recovery for well/off records, even with goals met', () => {
    const ended = attack('2026-06-10T10:00:00.000Z', '2026-06-10T15:00:00.000Z');
    expect(assess({
      dayStates: [dayState(DAY, 'well')],
      attacks: [ended],
    })).toMatchObject({ suppressed: null, state: 'well' });
    expect(assess({
      dayStates: [dayState(DAY, 'off')],
      attacks: [ended],
    })).toMatchObject({ suppressed: null, state: 'off' });
    expect(assess({
      workouts: goalsMet,
      dayStates: [dayState(DAY, 'well')],
      attacks: [ended],
    })).toMatchObject({ suppressed: 'goals-met', state: 'well' });
  });

  it('infers an active attack from an ongoing attack when no day state exists', () => {
    expect(assess({
      attacks: [attack('2026-06-10T18:00:00.000Z', null)],
    })).toMatchObject({ suppressed: 'attack', state: 'attack' });
  });

  it('never throws on unparseable timestamps and never suppresses via them', () => {
    expect(assess({
      dayStates: [dayState(DAY, 'well')],
      attacks: [attack('garbage', null)],
    })).toMatchObject({ suppressed: null, state: 'well' });

    expect(assess({
      dayStates: [dayState(DAY, 'well')],
      attacks: [attack('2026-06-10T18:00:00.000Z', 'garbage')],
    })).toMatchObject({ suppressed: null, state: 'well' });

    expect(assess({
      attacks: [attack('garbage', null)],
    })).toMatchObject({ suppressed: null, state: 'unknown' });
  });

  it('treats an empty-string end as still ongoing', () => {
    expect(assess({
      dayStates: [dayState(DAY, 'well')],
      attacks: [attack('2026-06-10T18:00:00.000Z', '')],
    })).toMatchObject({ suppressed: 'attack', state: 'well' });
  });

  it('lets an active attack win over met goals while an ended one does not', () => {
    expect(assess({
      workouts: goalsMet,
      dayStates: [dayState(DAY, 'well')],
      attacks: [attack('2026-06-10T18:00:00.000Z', null)],
    })).toMatchObject({ suppressed: 'attack', state: 'well' });

    expect(assess({
      workouts: goalsMet,
      dayStates: [dayState(DAY, 'well')],
      attacks: [attack('2026-06-10T10:00:00.000Z', '2026-06-10T15:00:00.000Z')],
    })).toMatchObject({ suppressed: 'goals-met', state: 'well' });
  });

  it('leaves an empty week behind with no suppression', () => {
    expect(assess({})).toMatchObject({
      suppressed: null,
      state: 'unknown',
      counts: { strength: 0, cardio: 0, mobility: 0 },
      strengthMet: false,
      cardioMet: false,
    });
  });
});

describe('assessLowStock', () => {
  const NOW = Date.parse('2026-06-10T20:00:00.000Z');
  const past = '2026-01-01T12:00:00.000Z';
  const future = '2026-12-01T12:00:00.000Z';

  function assess(input: {
    baselines?: ReturnType<typeof baseline>[];
    doses?: { id: string; ts: string; quantity?: number | null }[];
    refills?: { id: string; date: string; quantity?: number | null }[];
    threshold?: number;
  }) {
    return assessLowStock({
      baselines: input.baselines ?? [],
      doses: input.doses ?? [],
      refills: input.refills ?? [],
      now: NOW,
      timeZone: NY,
      threshold: input.threshold ?? 2,
    });
  }

  it('reports unknown before any applicable baseline and never low', () => {
    expect(assess({})).toEqual({
      status: 'unknown',
      quantity: null,
      threshold: 2,
      low: false,
    });
    expect(assess({ baselines: [baseline('future', future, 0)] })).toEqual({
      status: 'unknown',
      quantity: null,
      threshold: 2,
      low: false,
    });
  });

  it('is ok above the threshold', () => {
    expect(assess({ baselines: [baseline('b', past, 5)] })).toEqual({
      status: 'known',
      quantity: 5,
      threshold: 2,
      low: false,
    });
  });

  it('is low at and below the threshold, including negative stock', () => {
    expect(assess({ baselines: [baseline('b', past, 2)] }).low).toBe(true);
    expect(assess({ baselines: [baseline('b', past, 1)] }).low).toBe(true);
    expect(assess({
      baselines: [baseline('b', past, 0)],
      doses: [{ id: 'd', ts: '2026-02-01T12:00:00.000Z', quantity: 3 }],
    })).toMatchObject({ status: 'known', quantity: -3, low: true });
  });

  it('ignores unknown quantities and future baselines', () => {
    expect(assess({
      baselines: [baseline('b', past, 5), baseline('f', future, 0)],
      doses: [
        { id: 'd1', ts: '2026-02-01T12:00:00.000Z', quantity: null },
        { id: 'd2', ts: '2026-02-02T12:00:00.000Z' },
      ],
      refills: [
        { id: 'r1', date: '2026-03-01', quantity: null },
        { id: 'r2', date: '2026-03-02' },
      ],
    })).toEqual({
      status: 'known',
      quantity: 5,
      threshold: 2,
      low: false,
    });
  });

  it('treats threshold 0 with zero tablets as low', () => {
    expect(assess({
      baselines: [baseline('b', past, 0)],
      threshold: 0,
    })).toEqual({
      status: 'known',
      quantity: 0,
      threshold: 0,
      low: true,
    });
  });
});

describe('occurrence keys', () => {
  it('uses the documented deterministic formats', () => {
    expect(checkInOccurrenceKey('2026-06-10')).toBe('checkin:2026-06-10');
    expect(exerciseOccurrenceKey('2026-06-10')).toBe('exercise:2026-06-10');
    expect(preventiveOccurrenceKey('emgality', '2026-07-01'))
      .toBe('preventive:emgality:2026-07-01');
    expect(stockOccurrenceKey('2026-06-10T12:00:00.000Z'))
      .toBe('stock:nurtec:2026-06-10T12:00:00.000Z');
  });

  it('is deterministic across repeated calls', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(checkInOccurrenceKey('2026-06-10')).toBe('checkin:2026-06-10');
      expect(exerciseOccurrenceKey('2026-06-10')).toBe('exercise:2026-06-10');
      expect(preventiveOccurrenceKey('botox', '2026-08-01'))
        .toBe('preventive:botox:2026-08-01');
      expect(stockOccurrenceKey('2026-06-10T12:00:00.000Z'))
        .toBe('stock:nurtec:2026-06-10T12:00:00.000Z');
    }
  });
});

describe('reminder settings validation and normalization', () => {
  it('merges a valid partial object over the documented defaults', () => {
    const input = {
      enabled: false,
      preventive: false,
      lowStock: false,
      checkIn: false,
      exercise: false,
      wakingStart: '10:00',
      wakingEnd: '12:00',
      checkInTime: '10:30',
      exerciseTime: '11:30',
      graceMinutes: 45,
    };
    const normalized = normalizeReminderSettings(input);
    expect(normalized).toEqual({ ...DEFAULT_REMINDER_SETTINGS, ...input });
    expect(reminderSettingsErrors(normalized)).toEqual([]);

    // A truly partial object fills every omitted field from the defaults.
    expect(normalizeReminderSettings({ lowStock: false }))
      .toEqual({ ...DEFAULT_REMINDER_SETTINGS, lowStock: false });
  });

  it('falls back independently for invalid booleans, times, and grace', () => {
    const normalized = normalizeReminderSettings({
      enabled: 'yes',
      preventive: 0,
      lowStock: null,
      checkIn: 'true',
      exercise: false,
      wakingStart: '9:00',
      wakingEnd: '25:00',
      checkInTime: 'nope',
      exerciseTime: '25:00',
      graceMinutes: 10,
    });

    expect(normalized).toEqual({ ...DEFAULT_REMINDER_SETTINGS, exercise: false });
    expect(reminderSettingsErrors(normalized)).toEqual([]);
    expect(normalizeReminderSettings({ graceMinutes: 361 }).graceMinutes).toBe(120);
    expect(normalizeReminderSettings({ graceMinutes: 30.5 }).graceMinutes).toBe(120);
    expect(normalizeReminderSettings({ graceMinutes: 15 }).graceMinutes).toBe(15);
    expect(normalizeReminderSettings({ graceMinutes: 360 }).graceMinutes).toBe(360);
  });

  it('resets both waking times when end is not after start', () => {
    const reversed = normalizeReminderSettings({
      wakingStart: '20:00',
      wakingEnd: '10:00',
      checkInTime: '10:00',
      exerciseTime: '20:00',
    });
    expect(reversed.wakingStart).toBe('09:00');
    expect(reversed.wakingEnd).toBe('21:00');
    expect(reversed.checkInTime).toBe('10:00');
    expect(reversed.exerciseTime).toBe('20:00');
    expect(reminderSettingsErrors(reversed)).toEqual([]);

    const equal = normalizeReminderSettings({ wakingStart: '10:00', wakingEnd: '10:00' });
    expect(equal.wakingStart).toBe('09:00');
    expect(equal.wakingEnd).toBe('21:00');
  });

  it('moves out-of-window check-in/exercise times back inside waking hours', () => {
    const normalized = normalizeReminderSettings({
      wakingStart: '10:00',
      wakingEnd: '12:00',
      checkInTime: '18:00',
      exerciseTime: '09:00',
    });
    expect(normalized.checkInTime).toBe('10:00');
    expect(normalized.exerciseTime).toBe('10:00');
    expect(reminderSettingsErrors(normalized)).toEqual([]);
  });

  it('always normalizes narrow waking windows to valid settings', () => {
    const windows = [
      ['10:00', '12:00'],
      ['12:00', '13:00'],
      ['06:00', '06:30'],
      ['20:00', '21:00'],
    ] as const;

    for (const [wakingStart, wakingEnd] of windows) {
      const inputs = [
        { wakingStart, wakingEnd },
        { wakingStart, wakingEnd, checkInTime: '18:00', exerciseTime: '18:30' },
        { wakingStart, wakingEnd, checkInTime: '00:00', exerciseTime: '23:59' },
      ];
      for (const input of inputs) {
        const normalized = normalizeReminderSettings(input);
        expect(reminderSettingsErrors(normalized), `${wakingStart}-${wakingEnd}`).toEqual([]);
        expect(normalized.wakingStart).toBe(wakingStart);
        expect(normalized.wakingEnd).toBe(wakingEnd);
      }
    }
  });

  it('reports reserved delivery/secret keys and never copies them', () => {
    const reserved = {
      ntfyUrl: 'https://ntfy.example.test/topic',
      NTFY_TOKEN: 'secret-token',
      public_app_url: 'https://migraine.example.test',
      authToken: 'auth-secret',
    };
    const value = { ...DEFAULT_REMINDER_SETTINGS, ...reserved };

    expect(reservedReminderSettingKeys(value)).toEqual([
      'ntfyUrl',
      'NTFY_TOKEN',
      'public_app_url',
      'authToken',
    ]);

    const errors = reminderSettingsErrors(value);
    expect(errors).toContain('reminder settings must not contain ntfyUrl');
    expect(errors).toContain('reminder settings must not contain NTFY_TOKEN');
    expect(errors).toContain('reminder settings must not contain public_app_url');
    expect(errors).toContain('reminder settings must not contain authToken');

    const normalized = normalizeReminderSettings(value);
    expect(normalized).toStrictEqual(DEFAULT_REMINDER_SETTINGS);
    expect(Object.keys(normalized).sort()).toEqual(Object.keys(DEFAULT_REMINDER_SETTINGS).sort());
    const serialized = JSON.stringify(normalized);
    for (const secret of Object.values(reserved)) {
      expect(serialized).not.toContain(secret);
    }
  });
});
