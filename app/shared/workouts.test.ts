import { describe, it, expect } from 'vitest';
import type { WorkoutKind } from '../src/types/index.ts';
import {
  WEEKLY_CARDIO_GOAL,
  WEEKLY_STRENGTH_GOAL,
  countWorkoutsInWeek,
  weekGoalStatus,
  workoutInstantMs,
} from './workouts.ts';

function entry(performedAt: string, kind: WorkoutKind = 'strength') {
  return { performedAt, kind };
}

describe('workoutInstantMs', () => {
  it('parses ISO timestamps', () => {
    expect(workoutInstantMs('2026-06-08T12:00:00.000Z')).toBe(Date.UTC(2026, 5, 8, 12));
  });

  it('returns null for unparseable values without throwing', () => {
    expect(workoutInstantMs('not-a-date')).toBeNull();
    expect(workoutInstantMs('')).toBeNull();
    expect(() => workoutInstantMs('2026-13-45')).not.toThrow();
    expect(workoutInstantMs('2026-13-45')).toBeNull();
  });
});

describe('countWorkoutsInWeek', () => {
  it('reports zeros for an empty week', () => {
    expect(countWorkoutsInWeek([], '2026-06-10', 'America/New_York')).toEqual({
      strength: 0,
      cardio: 0,
      mobility: 0,
    });
  });

  it('counts each kind and never treats mobility as strength or cardio', () => {
    const workouts = [
      entry('2026-06-08T12:00:00.000Z', 'strength'),
      entry('2026-06-09T12:00:00.000Z', 'cardio'),
      entry('2026-06-10T12:00:00.000Z', 'mobility'),
      entry('2026-06-11T12:00:00.000Z', 'mobility'),
      entry('2026-06-12T12:00:00.000Z', 'mobility'),
    ];
    expect(countWorkoutsInWeek(workouts, '2026-06-10', 'America/New_York')).toEqual({
      strength: 1,
      cardio: 1,
      mobility: 3,
    });
    // Lots of mobility alone never satisfies either goal.
    const mobilityOnly = [
      entry('2026-06-08T12:00:00.000Z', 'mobility'),
      entry('2026-06-09T12:00:00.000Z', 'mobility'),
      entry('2026-06-10T12:00:00.000Z', 'mobility'),
    ];
    expect(weekGoalStatus(countWorkoutsInWeek(mobilityOnly, '2026-06-10', 'America/New_York')))
      .toEqual({ strengthMet: false, cardioMet: false });
  });

  it('counts backdated entries in their own week, not the current one', () => {
    const workouts = [
      entry('2026-05-18T12:00:00.000Z', 'strength'), // May 17 week
      entry('2026-06-09T12:00:00.000Z', 'cardio'), // June 7 week
    ];
    expect(countWorkoutsInWeek(workouts, '2026-06-10', 'America/New_York')).toEqual({
      strength: 0,
      cardio: 1,
      mobility: 0,
    });
    expect(countWorkoutsInWeek(workouts, '2026-05-20', 'America/New_York')).toEqual({
      strength: 1,
      cardio: 0,
      mobility: 0,
    });
  });

  it('uses half-open bounds aligned to local midnight', () => {
    // Sunday 2026-06-07 00:00 EDT = 04:00Z; next Sunday start = 2026-06-14 04:00Z.
    const atWeekStart = entry('2026-06-07T04:00:00.000Z', 'strength');
    const atNextWeekStart = entry('2026-06-14T04:00:00.000Z', 'cardio');
    expect(countWorkoutsInWeek([atWeekStart, atNextWeekStart], '2026-06-10', 'America/New_York'))
      .toEqual({ strength: 1, cardio: 0, mobility: 0 });
    expect(countWorkoutsInWeek([atNextWeekStart], '2026-06-16', 'America/New_York'))
      .toEqual({ strength: 0, cardio: 1, mobility: 0 });
  });

  it('keeps the DST-shortened spring-forward week on local midnights', () => {
    // Week of Sunday 2026-03-08 is 167h: [Mar 8 05:00Z, Mar 15 04:00Z).
    const springSunday = entry('2026-03-08T14:00:00.000Z', 'strength'); // 10:00 EDT
    const followingMonday = entry('2026-03-16T14:00:00.000Z', 'cardio'); // 10:00 EDT

    expect(countWorkoutsInWeek([springSunday], '2026-03-10', 'America/New_York')).toEqual({
      strength: 1,
      cardio: 0,
      mobility: 0,
    });
    // The following Monday is its own week, not the spring-forward one.
    expect(countWorkoutsInWeek([followingMonday], '2026-03-10', 'America/New_York')).toEqual({
      strength: 0,
      cardio: 0,
      mobility: 0,
    });
    expect(countWorkoutsInWeek([followingMonday], '2026-03-16', 'America/New_York')).toEqual({
      strength: 0,
      cardio: 1,
      mobility: 0,
    });

    // 23:30 Saturday local still belongs to the DST week; 00:00 Sunday does not.
    const lateSaturday = entry('2026-03-15T03:30:00.000Z', 'mobility');
    const nextSundayMidnight = entry('2026-03-15T04:00:00.000Z', 'mobility');
    expect(countWorkoutsInWeek([lateSaturday], '2026-03-10', 'America/New_York').mobility).toBe(1);
    expect(countWorkoutsInWeek([nextSundayMidnight], '2026-03-10', 'America/New_York').mobility).toBe(0);
  });

  it('buckets the same instant into different weeks per time zone', () => {
    // 2026-06-06 15:20Z = Sunday 00:20 in Tokyo, Saturday 11:20 in New York.
    const instant = entry('2026-06-06T15:20:00.000Z', 'strength');

    // Tokyo: first day of the June 7 week.
    expect(countWorkoutsInWeek([instant], '2026-06-10', 'Asia/Tokyo').strength).toBe(1);
    // New York: still Saturday, so it belongs to the May 31 week.
    expect(countWorkoutsInWeek([instant], '2026-06-10', 'America/New_York').strength).toBe(0);
    expect(countWorkoutsInWeek([instant], '2026-06-06', 'America/New_York').strength).toBe(1);
    expect(countWorkoutsInWeek([instant], '2026-05-31', 'America/New_York').strength).toBe(1);
  });

  it('skips workouts with unparseable timestamps', () => {
    const workouts = [
      entry('not-a-date', 'strength'),
      entry('', 'cardio'),
      entry('2026-06-09T12:00:00.000Z', 'cardio'),
    ];
    expect(countWorkoutsInWeek(workouts, '2026-06-10', 'America/New_York')).toEqual({
      strength: 0,
      cardio: 1,
      mobility: 0,
    });
  });
});

describe('weekGoalStatus', () => {
  it('requires the strength goal and at least the cardio minimum', () => {
    expect(WEEKLY_STRENGTH_GOAL).toBe(2);
    expect(WEEKLY_CARDIO_GOAL).toBe(3);

    expect(weekGoalStatus({ strength: 2, cardio: 3, mobility: 0 }))
      .toEqual({ strengthMet: true, cardioMet: true });
    // Cardio is a minimum: more than 3 still meets it.
    expect(weekGoalStatus({ strength: 2, cardio: 4, mobility: 0 }))
      .toEqual({ strengthMet: true, cardioMet: true });
    expect(weekGoalStatus({ strength: 1, cardio: 3, mobility: 5 }))
      .toEqual({ strengthMet: false, cardioMet: true });
    expect(weekGoalStatus({ strength: 2, cardio: 2, mobility: 5 }))
      .toEqual({ strengthMet: true, cardioMet: false });
    expect(weekGoalStatus({ strength: 0, cardio: 0, mobility: 10 }))
      .toEqual({ strengthMet: false, cardioMet: false });
  });

  it('reflects counted workouts', () => {
    const workouts = [
      entry('2026-06-08T12:00:00.000Z', 'strength'),
      entry('2026-06-09T12:00:00.000Z', 'strength'),
      entry('2026-06-10T12:00:00.000Z', 'cardio'),
      entry('2026-06-11T12:00:00.000Z', 'cardio'),
      entry('2026-06-12T12:00:00.000Z', 'cardio'),
    ];
    const counts = countWorkoutsInWeek(workouts, '2026-06-10', 'America/New_York');
    expect(weekGoalStatus(counts)).toEqual({ strengthMet: true, cardioMet: true });
  });
});
