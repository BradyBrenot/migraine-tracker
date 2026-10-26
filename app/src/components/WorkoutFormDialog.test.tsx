// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Workout } from '@/types';

const store = vi.hoisted(() => ({
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
