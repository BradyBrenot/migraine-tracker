// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MedEvent } from '@/types';

const store = vi.hoisted(() => ({
  logMed: vi.fn(),
  updateMed: vi.fn(),
  state: {
    meds: [] as unknown[],
    doses: { nurtec: '75 mg' } as Record<string, string>,
  },
}));

vi.mock('@/lib/store', () => ({ useStore: () => store }));

import MedFormDialog from './MedFormDialog';

function makeMed(overrides: Partial<MedEvent> = {}): MedEvent {
  return {
    id: 'med-1',
    medId: 'nurtec',
    dose: '75 mg',
    quantity: null,
    ts: '2026-03-02T10:00:00.000Z',
    attackId: null,
    notes: '',
    source: 'manual',
    ...overrides,
  };
}

function openDialog(med: MedEvent | null = null) {
  const onClose = vi.fn();
  render(<MedFormDialog med={med} open onClose={onClose} />);
  return { onClose };
}

function tabletsInput(): HTMLInputElement {
  return screen.getByLabelText('Tablets') as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^(Add|Save)$/ }) as HTMLButtonElement;
}

beforeEach(() => {
  store.logMed.mockReset();
  store.updateMed.mockReset();
  store.state.meds = [];
  store.state.doses = { nurtec: '75 mg' };
});

afterEach(() => {
  cleanup();
});

describe('MedFormDialog Nurtec tablet quantities', () => {
  it('prefills 1 tablet for a new Nurtec entry and passes it through logMed', () => {
    openDialog();

    expect(tabletsInput().value).toBe('1');
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    expect(store.logMed).toHaveBeenCalledTimes(1);
    expect(store.logMed).toHaveBeenCalledWith(
      'nurtec',
      expect.any(Date),
      null,
      '75 mg',
      '',
      1,
    );
  });

  it('keeps a legacy null quantity blank in edit mode and saves null', () => {
    openDialog(makeMed({ quantity: null }));

    expect(tabletsInput().value).toBe('');
    fireEvent.click(saveButton());

    expect(store.updateMed).toHaveBeenCalledTimes(1);
    expect(store.updateMed).toHaveBeenCalledWith(
      'med-1',
      expect.objectContaining({ quantity: null }),
    );
  });

  it('prefills and saves an edited Nurtec quantity', () => {
    openDialog(makeMed({ quantity: 2 }));

    expect(tabletsInput().value).toBe('2');
    fireEvent.change(tabletsInput(), { target: { value: '3' } });
    fireEvent.click(saveButton());

    expect(store.updateMed).toHaveBeenCalledWith(
      'med-1',
      expect.objectContaining({ quantity: 3 }),
    );
  });

  it('blocks saving a non-numeric or negative quantity', () => {
    openDialog();

    fireEvent.change(tabletsInput(), { target: { value: '-1' } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('whole number');

    fireEvent.change(tabletsInput(), { target: { value: '1.5' } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(store.logMed).not.toHaveBeenCalled();
  });

  it('hides the Tablets field for non-Nurtec meds and sends null', () => {
    openDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Tylenol' }));
    expect(screen.queryByLabelText('Tablets')).toBeNull();

    fireEvent.click(saveButton());
    expect(store.logMed).toHaveBeenCalledWith(
      'tylenol',
      expect.any(Date),
      null,
      '',
      '',
      null,
    );
  });

  it('resets the tablet default when switching medications in new mode', () => {
    openDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Tylenol' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nurtec' }));

    expect(tabletsInput().value).toBe('1');
  });
});
