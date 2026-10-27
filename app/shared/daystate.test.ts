import { describe, it, expect } from 'vitest';
import { effectiveDayState } from './daystate.ts';

describe('effectiveDayState', () => {
  it('lets an explicit record win over attack records', () => {
    expect(effectiveDayState({ status: 'well' }, true)).toBe('well');
    expect(effectiveDayState({ status: 'off' }, true)).toBe('off');
    // 'attack' stays readable as an explicit legacy status.
    expect(effectiveDayState({ status: 'attack' }, false)).toBe('attack');
    expect(effectiveDayState({ status: 'attack' }, true)).toBe('attack');
  });

  it('infers off when only attack records exist', () => {
    expect(effectiveDayState(null, true)).toBe('off');
    expect(effectiveDayState(undefined, true)).toBe('off');
  });

  it('returns null with neither a record nor an attack', () => {
    expect(effectiveDayState(null, false)).toBeNull();
    expect(effectiveDayState(undefined, false)).toBeNull();
  });
});
