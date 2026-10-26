// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Workout } from '@/types';

const store = vi.hoisted(() => ({
  state: { workouts: [] as Workout[], timezone: 'UTC' },
  addWorkout: vi.fn(),
  updateWorkout: vi.fn(),
}));

vi.mock('@/lib/store', () => ({ useStore: () => store }));

import WorkoutFormDialog from './WorkoutFormDialog';

function makeWorkout(overrides: Partial<Workout> = {}): Workout {
  return {
    id: 'workout-1',
    performedAt: '2026-03-02T10:00:00.000Z',
    kind: 'strength',
    effort: 'medium',
    durationMinutes: 60,
    notes: '',
    source: 'manual',
    ...overrides,
  };
}

function openDialog(workout: Workout | null = null) {
  const onClose = vi.fn();
  render(<WorkoutFormDialog workout={workout} open onClose={onClose} />);
  return { onClose };
}

function performedInput(): HTMLInputElement {
  const input = document.querySelector('input[type="datetime-local"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('performed-at input missing');
  return input;
}

/**
 * The instant the dialog derives from a datetime-local value (`Date.parse`
 * reads it in the host zone). Seeding the store from the same conversion keeps
 * these assertions independent of the machine's time zone.
 */
function seededInstant(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

function fillRequired(kind = 'Strength', effort = 'Medium'): void {
  fireEvent.click(screen.getByRole('button', { name: kind }));
  fireEvent.click(screen.getByRole('button', { name: effort }));
}

function durationInput(): HTMLInputElement {
  return screen.getByLabelText('Duration in minutes') as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  const button = screen.getByRole('button', { name: /^(Add workout|Save changes)$/ });
  return button as HTMLButtonElement;
}

beforeEach(() => {
  store.state.workouts = [];
  store.state.timezone = 'UTC';
  store.addWorkout.mockReset();
  store.updateWorkout.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('WorkoutFormDialog duration validation', () => {
  it('creates a workout with a blank duration as null', () => {
    openDialog();
    fillRequired();

    expect(durationInput().value).toBe('');
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    expect(store.addWorkout).toHaveBeenCalledTimes(1);
    expect(store.addWorkout).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'strength', effort: 'medium', durationMinutes: null }),
    );
  });

  it('creates a workout with a positive whole-number duration', () => {
    openDialog();
    fillRequired();
    fireEvent.change(durationInput(), { target: { value: '45' } });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    expect(store.addWorkout).toHaveBeenCalledWith(
      expect.objectContaining({ durationMinutes: 45 }),
    );
  });

  it.each(['0', '-5', '45.5'])(
    'blocks saving and shows an inline error for invalid duration %s',
    (value) => {
      openDialog();
      fillRequired();
      fireEvent.change(durationInput(), { target: { value } });

      expect(saveButton().disabled).toBe(true);
      expect(
        screen.getByText(
          'Duration must be a positive whole number of minutes, or leave blank.',
        ),
      ).toBeTruthy();

      fireEvent.click(saveButton());
      expect(store.addWorkout).not.toHaveBeenCalled();
      expect(store.updateWorkout).not.toHaveBeenCalled();
    },
  );

  it('shows an existing duration in edit mode and saves an explicit blank as null', () => {
    openDialog(makeWorkout());
    expect(durationInput().value).toBe('60');

    fireEvent.change(durationInput(), { target: { value: '' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    expect(store.updateWorkout).toHaveBeenCalledTimes(1);
    expect(store.updateWorkout).toHaveBeenCalledWith(
      'workout-1',
      expect.objectContaining({ durationMinutes: null }),
    );
  });

  it('blocks an edit save when the duration is zero', () => {
    openDialog(makeWorkout());
    fireEvent.change(durationInput(), { target: { value: '0' } });

    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(saveButton());
    expect(store.updateWorkout).not.toHaveBeenCalled();
  });
});

describe('WorkoutFormDialog duplicate-day warning', () => {
  // Explicit configured zone; timestamps are always derived from the entered
  // datetime-local value so the host zone cannot change the expected day.
  const DAY_INPUT = '2026-03-02T10:00';

  /** The dialog's single persistent polite status region. */
  function statusRegion(): HTMLElement {
    return screen.getByRole('status');
  }

  function warningText(): string {
    return statusRegion().textContent ?? '';
  }

  it('warns before saving when the same kind already exists that day, but still saves', () => {
    store.state.workouts = [
      makeWorkout({ id: 'existing-strength', kind: 'strength', performedAt: seededInstant(DAY_INPUT) }),
    ];

    openDialog();
    fireEvent.change(performedInput(), { target: { value: DAY_INPUT } });
    fillRequired('Strength', 'Medium');

    expect(statusRegion().getAttribute('aria-live')).toBe('polite');
    const warning = warningText();
    expect(warning).toContain('This day already has a Strength workout.');
    expect(warning).toContain('count each day once');
    expect(warning).toContain('still save it');

    // Visible while editing, not only after pressing save — and never blocking.
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(store.addWorkout).toHaveBeenCalledTimes(1);
    expect(store.addWorkout).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'strength', performedAt: seededInstant(DAY_INPUT) }),
    );
  });

  it('does not warn about the record being edited', () => {
    const edited = makeWorkout({
      id: 'workout-1',
      kind: 'strength',
      performedAt: seededInstant(DAY_INPUT),
    });
    store.state.workouts = [edited];

    openDialog(edited);

    expect(warningText()).toBe('');
  });

  it('warns in edit mode for another same-day record and still calls updateWorkout', () => {
    const edited = makeWorkout({
      id: 'workout-1',
      kind: 'strength',
      performedAt: seededInstant(DAY_INPUT),
    });
    const other = makeWorkout({
      id: 'workout-2',
      kind: 'strength',
      performedAt: seededInstant('2026-03-02T16:00'),
    });
    store.state.workouts = [edited, other];

    openDialog(edited);

    expect(warningText()).toContain('This day already has a Strength workout.');
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(store.updateWorkout).toHaveBeenCalledTimes(1);
    expect(store.updateWorkout).toHaveBeenCalledWith(
      'workout-1',
      expect.objectContaining({ kind: 'strength' }),
    );
  });

  it('clears the warning when the kind or the day no longer has another record', () => {
    store.state.workouts = [
      makeWorkout({ id: 'existing-strength', kind: 'strength', performedAt: seededInstant(DAY_INPUT) }),
    ];

    openDialog();
    fireEvent.change(performedInput(), { target: { value: DAY_INPUT } });
    fillRequired('Strength', 'Medium');
    expect(warningText()).not.toBe('');

    // Cardio has no record that day.
    fireEvent.click(screen.getByRole('button', { name: 'Cardio' }));
    expect(warningText()).toBe('');

    // Back to the duplicated strength day...
    fireEvent.click(screen.getByRole('button', { name: 'Strength' }));
    expect(warningText()).not.toBe('');

    // ...and a different day has no strength record.
    fireEvent.change(performedInput(), { target: { value: '2026-03-05T10:00' } });
    expect(warningText()).toBe('');
  });

  it('shows no warning and keeps save disabled for a cleared date', () => {
    store.state.workouts = [
      makeWorkout({ id: 'existing-strength', kind: 'strength', performedAt: seededInstant(DAY_INPUT) }),
    ];

    openDialog();
    fireEvent.change(performedInput(), { target: { value: DAY_INPUT } });
    fillRequired('Strength', 'Medium');
    expect(warningText()).not.toBe('');

    fireEvent.change(performedInput(), { target: { value: '' } });
    expect(warningText()).toBe('');
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(store.addWorkout).not.toHaveBeenCalled();
    expect(store.updateWorkout).not.toHaveBeenCalled();
  });

  it('never warns for mobility duplicates', () => {
    store.state.workouts = [
      makeWorkout({ id: 'existing-mobility', kind: 'mobility', performedAt: seededInstant(DAY_INPUT) }),
    ];

    openDialog();
    fireEvent.change(performedInput(), { target: { value: DAY_INPUT } });
    fillRequired('Mobility', 'Low');

    expect(warningText()).toBe('');
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(store.addWorkout).toHaveBeenCalledTimes(1);
    expect(store.addWorkout).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mobility' }),
    );
  });

  it('keeps one persistent polite live region that toggles from empty to a warning', () => {
    store.state.workouts = [
      makeWorkout({ id: 'existing-strength', kind: 'strength', performedAt: seededInstant(DAY_INPUT) }),
    ];

    openDialog();
    const region = statusRegion();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');

    fireEvent.change(performedInput(), { target: { value: DAY_INPUT } });
    fillRequired('Strength', 'Medium');

    // Same DOM node, now with text: no remount between the empty and warning states.
    expect(statusRegion()).toBe(region);
    expect(region.textContent).toContain('This day already has a Strength workout.');
  });

  it('shows no warning and throws nothing for invalid stored timestamps', () => {
    store.state.workouts = [
      makeWorkout({ id: 'bad-1', kind: 'strength', performedAt: 'not-a-date' }),
      makeWorkout({ id: 'bad-2', kind: 'strength', performedAt: '2026-13-45' }),
    ];

    openDialog();
    fireEvent.change(performedInput(), { target: { value: DAY_INPUT } });
    fillRequired('Strength', 'Medium');

    expect(warningText()).toBe('');
    expect(saveButton().disabled).toBe(false);
  });

  it('buckets the day in the configured zone, not UTC, in edit mode', () => {
    store.state.timezone = 'America/New_York';
    const edited = makeWorkout({
      id: 'workout-ny',
      kind: 'strength',
      performedAt: '2026-03-02T05:00:00.000Z', // NY Mon Mar 2 00:00
    });
    // NY Mon Mar 2 23:00 but UTC Tue Mar 3: only the configured zone makes it
    // the same goal day as the edited record.
    const sameNyDay = makeWorkout({
      id: 'workout-ny-late',
      kind: 'strength',
      performedAt: '2026-03-03T04:00:00.000Z',
    });
    store.state.workouts = [edited, sameNyDay];

    // The edit round-trip (toLocalInput -> Date.parse) preserves the instant,
    // so this does not depend on the host time zone.
    openDialog(edited);

    expect(warningText()).toContain('This day already has a Strength workout.');
    expect(saveButton().disabled).toBe(false);
  });

  it('does not scan workouts once the dialog is closed', () => {
    const originalState = store.state;
    const view = render(<WorkoutFormDialog workout={null} open onClose={vi.fn()} />);
    // Give the retained form a valid instant so a missing open guard would scan.
    fireEvent.change(performedInput(), { target: { value: DAY_INPUT } });
    fillRequired('Strength', 'Medium');

    let workoutReads = 0;
    store.state = {
      get workouts() {
        workoutReads += 1;
        return [];
      },
      timezone: 'UTC',
    };
    try {
      view.rerender(<WorkoutFormDialog workout={null} open={false} onClose={vi.fn()} />);
      expect(workoutReads).toBe(0);
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      store.state = originalState;
    }
  });
});
