// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Attack } from '@/types';

const store = vi.hoisted(() => ({
  updateAttack: vi.fn(),
  startAttack: vi.fn(),
  endAttack: vi.fn(),
  logPain: vi.fn(),
}));

vi.mock('@/lib/store', () => ({ useStore: () => store }));

import AttackFormDialog from './AttackFormDialog';

function makeAttack(overrides: Partial<Attack> = {}): Attack {
  return {
    id: 'attack-1',
    start: '2026-10-20T08:00:00.000Z',
    end: null,
    painLog: [],
    peakPain: -1,
    symptoms: [],
    triggers: [],
    aura: null,
    notes: '',
    source: 'manual',
    ...overrides,
  };
}

const OLDER_LOG = [
  { ts: '2026-10-20T09:00:00.000Z', level: 5 },
  { ts: '2026-10-20T10:00:00.000Z', level: 8 },
];

function openDialog(attack: Attack | null) {
  const onClose = vi.fn();
  render(<AttackFormDialog attack={attack} open onClose={onClose} />);
  return { onClose };
}

function painButton(level: number): HTMLButtonElement {
  return screen.getByRole('button', { name: String(level) }) as HTMLButtonElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^(Add attack|Save changes)$/ }) as HTMLButtonElement;
}

beforeEach(() => {
  store.updateAttack.mockReset();
  store.startAttack.mockReset();
  store.endAttack.mockReset();
  store.logPain.mockReset();
  store.startAttack.mockReturnValue(makeAttack({ id: 'new-attack' }));
});

afterEach(() => {
  cleanup();
});

describe('AttackFormDialog peak-pain edits', () => {
  it('saves a raised peak on an existing attack without logging pain', () => {
    openDialog(makeAttack({ peakPain: 5, painLog: OLDER_LOG }));

    fireEvent.click(painButton(9));
    fireEvent.click(saveButton());

    expect(store.updateAttack).toHaveBeenCalledTimes(1);
    expect(store.updateAttack).toHaveBeenCalledWith(
      'attack-1',
      expect.objectContaining({ peakPain: 9 }),
    );
    expect(store.logPain).not.toHaveBeenCalled();
  });

  it.each([2, 0])(
    'saves a lowered peak of %i without touching the pain log',
    (level) => {
      openDialog(makeAttack({ peakPain: 5, painLog: OLDER_LOG }));

      fireEvent.click(painButton(level));
      fireEvent.click(saveButton());

      expect(store.updateAttack).toHaveBeenCalledTimes(1);
      const patch = store.updateAttack.mock.calls[0][1] as Partial<Attack>;
      expect(patch.peakPain).toBe(level);
      expect(patch).not.toHaveProperty('painLog');
      expect(store.logPain).not.toHaveBeenCalled();
    },
  );

  it('keeps an existing peak explicit when pain is not touched', () => {
    openDialog(makeAttack({ peakPain: 5, painLog: OLDER_LOG }));

    fireEvent.click(saveButton());

    expect(store.updateAttack).toHaveBeenCalledTimes(1);
    expect(store.updateAttack).toHaveBeenCalledWith(
      'attack-1',
      expect.objectContaining({ peakPain: 5 }),
    );
    expect(store.logPain).not.toHaveBeenCalled();
  });

  it('creates a past attack with the chosen pain via logPain', () => {
    const { onClose } = openDialog(null);

    fireEvent.click(painButton(7));
    fireEvent.click(saveButton());

    expect(store.startAttack).toHaveBeenCalledTimes(1);
    expect(store.startAttack).toHaveBeenCalledWith(expect.any(Date));
    expect(store.logPain).toHaveBeenCalledTimes(1);
    expect(store.logPain).toHaveBeenCalledWith('new-attack', 7, expect.any(Date));
    expect(store.updateAttack).toHaveBeenCalledTimes(1);
    const patch = store.updateAttack.mock.calls[0][1] as Partial<Attack>;
    expect(patch).not.toHaveProperty('peakPain');
    expect(patch).toMatchObject({ symptoms: [], triggers: [], aura: null, notes: '' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('creates a 0-pain past attack via logPain', () => {
    openDialog(null);

    fireEvent.click(painButton(0));
    fireEvent.click(saveButton());

    expect(store.logPain).toHaveBeenCalledTimes(1);
    expect(store.logPain).toHaveBeenCalledWith('new-attack', 0, expect.any(Date));
  });
});

describe('AttackFormDialog time validation', () => {
  function startInput(): HTMLInputElement {
    return screen.getByLabelText('Started') as HTMLInputElement;
  }

  function endInput(): HTMLInputElement {
    return screen.getByLabelText('Ended') as HTMLInputElement;
  }

  it('blocks saving an empty start and reports it with role=alert', () => {
    openDialog(makeAttack());

    fireEvent.change(startInput(), { target: { value: '' } });

    expect(saveButton().disabled).toBe(true);
    expect(startInput().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('valid start');
    fireEvent.click(saveButton());
    expect(store.updateAttack).not.toHaveBeenCalled();
  });

  it('requires a usable end when ongoing is unchecked', () => {
    openDialog(null);

    // New attacks start ongoing, so the end field is disabled and optional.
    expect(endInput().disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'ongoing' }));
    expect(endInput().disabled).toBe(false);

    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('valid end');

    fireEvent.change(startInput(), { target: { value: '2026-05-01T09:00' } });
    fireEvent.change(endInput(), { target: { value: '2026-05-01T10:00' } });
    expect(saveButton().disabled).toBe(false);
  });

  it('keeps an end-before-start attack editable and saves it without rejecting', () => {
    // End-before-start is intentional legacy/edit behavior: repair is possible,
    // but the form must never force end >= start on save.
    openDialog(makeAttack({ start: '2026-05-02T10:00:00.000Z', end: '2026-05-02T12:00:00.000Z' }));

    const start = '2026-05-01T09:00';
    const end = '2026-05-01T08:00';
    fireEvent.change(startInput(), { target: { value: start } });
    fireEvent.change(endInput(), { target: { value: end } });

    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    expect(store.updateAttack).toHaveBeenCalledWith(
      'attack-1',
      expect.objectContaining({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      }),
    );
  });

  it('opens a corrupt legacy start blank and can repair and save it', () => {
    openDialog(makeAttack({ start: 'not-a-date' }));

    expect(startInput().value).toBe('');
    expect(document.body.textContent).not.toContain('NaN');
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('valid start');

    const repaired = '2026-05-01T09:00';
    fireEvent.change(startInput(), { target: { value: repaired } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    expect(store.updateAttack).toHaveBeenCalledWith(
      'attack-1',
      expect.objectContaining({ start: new Date(repaired).toISOString() }),
    );
  });
});
