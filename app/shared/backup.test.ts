/**
 * Parser tests for shared/backup.ts (Vitest, node environment).
 *
 * These cover the two accepted on-disk shapes (server envelope + flattened
 * browser TrackerState), legacy tolerance, strict record validation, the
 * keep-first duplicate accounting, and the non-secret settings whitelist.
 * The server route's transaction behavior is covered separately in
 * app/server/test/restore.test.js.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_BACKUP_SCHEMA_VERSION,
  isReservedBackupSettingsKey,
  parseBackup,
} from './backup.ts';
import { DEFAULT_REMINDER_SETTINGS } from './reminders.ts';

// ── fixtures ──────────────────────────────────────────────────────────
const attack = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  start: '2026-03-01T10:00:00.000Z',
  end: null,
  painLog: [],
  peakPain: -1,
  symptoms: [],
  triggers: [],
  aura: null,
  notes: '',
  source: 'import',
  ...overrides,
});

const med = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1',
  medId: 'nurtec',
  ts: '2026-03-01T11:00:00.000Z',
  dose: '75mg',
  quantity: 8,
  attackId: null,
  notes: '',
  source: 'import',
  ...overrides,
});

const refill = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  medId: 'nurtec',
  date: '2026-03-02',
  quantity: 8,
  notes: '',
  source: 'import',
  ...overrides,
});

const workout = (overrides: Record<string, unknown> = {}) => ({
  id: 'w1',
  performedAt: '2026-03-01T12:00:00.000Z',
  kind: 'strength',
  effort: 'medium',
  durationMinutes: 45,
  notes: '',
  source: 'import',
  ...overrides,
});

const dayState = (overrides: Record<string, unknown> = {}) => ({
  day: '2026-03-01',
  status: 'well',
  notes: '',
  updatedAt: '2026-03-02T00:00:00.000Z',
  ...overrides,
});

const baseline = (overrides: Record<string, unknown> = {}) => ({
  id: 'b1',
  medId: 'nurtec',
  effectiveAt: '2026-03-01T00:00:00.000Z',
  quantity: 8,
  notes: '',
  source: 'import',
  createdAt: '2026-03-01T00:00:01.000Z',
  ...overrides,
});

const FULL_SETTINGS = {
  rules: { nurtec: { limit: 15, windowDays: 30 } },
  doses: { nurtec: '75mg' },
  planned: { botox: '2026-05-01' },
  timezone: 'America/New_York',
  lowStockThreshold: 3,
  lowStockAlert: { latchedAt: '2026-04-09T12:00:00.000Z' },
  reminders: { ...DEFAULT_REMINDER_SETTINGS },
};

const fullEnvelope = () => ({
  schemaVersion: MAX_BACKUP_SCHEMA_VERSION,
  exportedAt: '2026-04-10T09:30:00.000Z',
  attacks: [attack()],
  meds: [med()],
  refills: [refill()],
  workouts: [workout()],
  dayStates: [dayState()],
  stockBaselines: [baseline()],
  settings: { ...FULL_SETTINGS },
});

function expectOk(json: unknown) {
  const result = parseBackup(json);
  if (!result.ok) throw new Error(`expected a successful parse, got: ${result.error}`);
  return result.backup;
}

function expectError(json: unknown): string {
  const result = parseBackup(json);
  if (result.ok) throw new Error('expected the parse to fail');
  return result.error;
}

const zeroDuplicates = {
  attacks: 0, meds: 0, refills: 0, workouts: 0, dayStates: 0, stockBaselines: 0,
};

// ── accepted shapes ───────────────────────────────────────────────────
describe('envelope format', () => {
  it('parses the current server envelope with all six record types and settings', () => {
    const backup = expectOk(fullEnvelope());

    expect(backup.format).toBe('envelope');
    expect(backup.schemaVersion).toBe(MAX_BACKUP_SCHEMA_VERSION);
    expect(backup.exportedAt).toBe('2026-04-10T09:30:00.000Z');
    expect(backup.attacks).toEqual([attack()]);
    expect(backup.meds).toEqual([med()]);
    expect(backup.refills).toEqual([refill()]);
    expect(backup.workouts).toEqual([workout()]);
    expect(backup.dayStates).toEqual([dayState()]);
    expect(backup.stockBaselines).toEqual([baseline()]);
    expect(backup.settings).toEqual(FULL_SETTINGS);
    expect(backup.skippedSettingKeys).toEqual([]);
    expect(backup.duplicateCounts).toEqual(zeroDuplicates);
    expect(backup.seeded).toBeNull();
  });

  it('accepts a legacy envelope without schemaVersion and defaults missing arrays', () => {
    const backup = expectOk({
      exportedAt: '2025-12-01T00:00:00.000Z',
      attacks: [attack()],
      meds: [med({ medId: '' })], // legacy CSV custom med ids stay valid
      refills: [refill()],
      settings: { rules: { nurtec: { limit: 15, windowDays: 30 } } },
    });

    expect(backup.format).toBe('envelope');
    expect(backup.schemaVersion).toBeNull();
    expect(backup.attacks).toHaveLength(1);
    expect(backup.meds[0].medId).toBe('');
    expect(backup.workouts).toEqual([]);
    expect(backup.dayStates).toEqual([]);
    expect(backup.stockBaselines).toEqual([]);
    expect(backup.settings).toEqual({ rules: { nurtec: { limit: 15, windowDays: 30 } } });
    expect(backup.duplicateCounts).toEqual(zeroDuplicates);
  });

  it('accepts an envelope with settings null (legacy) as "no settings"', () => {
    const backup = expectOk({ schemaVersion: 4, attacks: [], settings: null });
    expect(backup.settings).toEqual({});
    expect(backup.skippedSettingKeys).toEqual([]);
  });

  it('parses a records-only payload as a browser-format payload with no settings', () => {
    // Detection is key-driven: only schemaVersion/exportedAt/settings make an
    // envelope, so a bare record array is classified as flattened/browser.
    // Either way the settings are empty, which is the behavioral contract.
    const backup = expectOk({ attacks: [attack()] });
    expect(backup.format).toBe('browser');
    expect(backup.schemaVersion).toBeNull();
    expect(backup.exportedAt).toBeNull();
    expect(backup.attacks).toHaveLength(1);
    expect(backup.settings).toEqual({});
    expect(backup.skippedSettingKeys).toEqual([]);
  });

  it('accepts every known schema version and rejects everything else', () => {
    for (let version = 1; version <= MAX_BACKUP_SCHEMA_VERSION; version += 1) {
      const backup = expectOk({ schemaVersion: version, attacks: [] });
      expect(backup.schemaVersion).toBe(version);
    }
    for (const bad of [MAX_BACKUP_SCHEMA_VERSION + 1, 0, -1, 1.5, '1']) {
      const error = expectError({ schemaVersion: bad, attacks: [] });
      expect(error).toMatch(/schemaVersion/);
      expect(error).toMatch(/between 1 and/);
    }
    // explicit null = legacy pre-versioning backup
    expect(expectOk({ schemaVersion: null, attacks: [] }).schemaVersion).toBeNull();
  });
});

describe('browser format', () => {
  it('parses a flattened TrackerState export and maps lowStockAlertedAt', () => {
    const backup = expectOk({
      attacks: [attack()],
      meds: [med()],
      refills: [refill()],
      workouts: [workout()],
      dayStates: [dayState()],
      stockBaselines: [baseline()],
      rules: { nurtec: { limit: 15, windowDays: 30 } },
      doses: { nurtec: '75mg' },
      planned: { botox: '2026-05-01' },
      timezone: 'Europe/Berlin',
      lowStockThreshold: 0,
      lowStockAlertedAt: '2026-01-02T03:04:05.000Z',
      reminders: { ...DEFAULT_REMINDER_SETTINGS, enabled: false },
      seeded: true,
    });

    expect(backup.format).toBe('browser');
    expect(backup.schemaVersion).toBeNull();
    expect(backup.exportedAt).toBeNull();
    expect(backup.seeded).toBe(true);
    expect(backup.attacks).toHaveLength(1);
    expect(backup.meds).toHaveLength(1);
    expect(backup.refills).toHaveLength(1);
    expect(backup.workouts).toHaveLength(1);
    expect(backup.dayStates).toHaveLength(1);
    expect(backup.stockBaselines).toHaveLength(1);
    expect(backup.settings).toEqual({
      rules: { nurtec: { limit: 15, windowDays: 30 } },
      doses: { nurtec: '75mg' },
      planned: { botox: '2026-05-01' },
      timezone: 'Europe/Berlin',
      lowStockThreshold: 0,
      lowStockAlert: { latchedAt: '2026-01-02T03:04:05.000Z' },
      reminders: { ...DEFAULT_REMINDER_SETTINGS, enabled: false },
    });
    expect(backup.skippedSettingKeys).toEqual([]);
    expect(backup.duplicateCounts).toEqual(zeroDuplicates);
  });

  it('captures a null lowStockAlertedAt and a non-boolean seeded as null', () => {
    const backup = expectOk({
      attacks: [], lowStockAlertedAt: null, seeded: 'yes',
    });
    expect(backup.settings.lowStockAlert).toEqual({ latchedAt: null });
    expect(backup.seeded).toBeNull();
  });
});

// ── rejection of unusable payloads ────────────────────────────────────
describe('format rejection', () => {
  it('rejects non-objects', () => {
    for (const value of [undefined, null, 'backup', 42, [], [{}], true]) {
      expect(expectError(value)).toBe('backup must be a JSON object');
    }
  });

  it('rejects an empty or unrecognized object so a missing body can never wipe data', () => {
    expect(expectError({})).toBe('unrecognized backup format');
    expect(expectError({ unrelated: true })).toBe('unrecognized backup format');
  });

  it('rejects a present non-array record key', () => {
    expect(expectError({ attacks: 'nope' })).toBe('attacks must be an array');
    expect(expectError({ settings: {}, dayStates: {} })).toBe('dayStates must be an array');
  });
});

describe('record validation', () => {
  it('reports indexed errors per record type', () => {
    expect(expectError({ attacks: [attack(), attack({ start: 5 })] }))
      .toMatch(/^attacks\[1\]: .*start must be a non-empty string/);
    expect(expectError({ attacks: [attack({ painLog: [{ ts: 5, level: 'high' }] })] }))
      .toMatch(/^attacks\[0\]: .*painLog\[0\]\.ts must be a string.*painLog\[0\]\.level must be a number/);
    expect(expectError({ meds: [med({ medId: 7 })] })).toMatch(/^meds\[0\]: .*medId/);
    expect(expectError({ refills: [refill({ date: '' })] })).toMatch(/^refills\[0\]: .*date/);
    expect(expectError({ workouts: [workout({ performedAt: '2026-03-01' })] }))
      .toMatch(/^workouts\[0\]: .*performedAt must be a full ISO 8601 instant/);
    expect(expectError({ dayStates: [dayState({ day: '2026-02-30' })] }))
      .toMatch(/^dayStates\[0\]: .*day must be a real calendar date/);
    expect(expectError({ stockBaselines: [baseline({ quantity: -1 })] }))
      .toMatch(/^stockBaselines\[0\]: .*quantity must be an integer >= 0/);
  });

  it('rejects non-object records and non-ISO instants without explicit timezones', () => {
    expect(expectError({ attacks: [{ nope: true }] })).toMatch(/^attacks\[0\]: .*start/);
    expect(expectError({ attacks: ['not-an-object'] })).toBe('attacks[0] must be an object');
    expect(expectError({ workouts: [workout({ performedAt: '2026-03-01T07:00:00' })] }))
      .toMatch(/^workouts\[0\]: .*performedAt/);
    expect(expectError({ stockBaselines: [baseline({ quantity: null })] }))
      .toMatch(/quantity must be an integer >= 0/);
    expect(expectError({ dayStates: [dayState({ status: 'great' })] }))
      .toMatch(/^dayStates\[0\]: .*status/);
  });
});

// ── duplicate accounting ─────────────────────────────────────────────
describe('duplicate ids', () => {
  it('keeps the first attack and counts the later duplicate without failing', () => {
    const backup = expectOk({
      attacks: [
        attack({ start: '2026-03-01T10:00:00.000Z' }),
        attack({ start: '2030-12-31T23:00:00.000Z' }),
      ],
    });
    expect(backup.duplicateCounts.attacks).toBe(1);
    expect(backup.attacks).toHaveLength(1);
    expect(backup.attacks[0].start).toBe('2026-03-01T10:00:00.000Z');
  });

  it('counts duplicate day states by day and keeps the first', () => {
    const backup = expectOk({
      dayStates: [dayState({ status: 'off' }), dayState({ status: 'attack' })],
    });
    expect(backup.duplicateCounts.dayStates).toBe(1);
    expect(backup.dayStates).toHaveLength(1);
    expect(backup.dayStates[0].status).toBe('off');
  });

  it('never collides absent or empty ids (the server generates them)', () => {
    const backup = expectOk({
      attacks: [attack({ id: '' }), attack({ id: '' }), attack({ id: undefined })],
      meds: [med({ id: '' }), med({ id: '' })],
    });
    expect(backup.attacks).toHaveLength(3);
    expect(backup.meds).toHaveLength(2);
    expect(backup.duplicateCounts).toEqual(zeroDuplicates);
  });
});

// ── settings whitelist ───────────────────────────────────────────────
describe('settings', () => {
  it('skips unknown non-secret keys instead of restoring them', () => {
    const backup = expectOk({
      schemaVersion: 4,
      attacks: [],
      settings: { rules: { nurtec: { limit: 15, windowDays: 30 } }, futureFlag: true },
    });
    expect(backup.settings).toEqual({ rules: { nurtec: { limit: 15, windowDays: 30 } } });
    expect(backup.skippedSettingKeys).toEqual(['futureFlag']);
  });

  it('hard-fails on secret-like settings keys (fail closed)', () => {
    for (const key of ['ntfyUrl', 'NTFY_TOKEN', 'publicAppUrl', 'apikey', 'my-secret']) {
      const error = expectError({ schemaVersion: 4, attacks: [], settings: { [key]: 'x' } });
      expect(error).toBe(`backup settings must not contain '${key}'`);
      expect(error).not.toContain('x');
    }
    // flattened browser payloads are checked the same way
    expect(expectError({ attacks: [], ntfyToken: 'secret-value' }))
      .toBe("backup settings must not contain 'ntfyToken'");
  });

  it('validates whitelisted setting values and names the key', () => {
    expect(expectError({ schemaVersion: 4, settings: { timezone: 'Mars/Phobos' } }))
      .toMatch(/timezone must be a valid IANA time zone/);
    expect(expectError({ schemaVersion: 4, settings: { lowStockThreshold: -1 } }))
      .toMatch(/lowStockThreshold must be an integer >= 0/);
    expect(expectError({ schemaVersion: 4, settings: { lowStockThreshold: 1.5 } }))
      .toMatch(/lowStockThreshold/);
    expect(expectError({ schemaVersion: 4, settings: { rules: [] } }))
      .toMatch(/rules must be an object/);
    expect(expectError({ schemaVersion: 4, settings: { reminders: { enabled: true } } }))
      .toMatch(/reminders:/);
    expect(expectError({ schemaVersion: 4, settings: { lowStockAlert: { latchedAt: 5 } } }))
      .toBe('lowStockAlert.latchedAt must be a full ISO 8601 instant or null');
    expect(expectError({ schemaVersion: 4, settings: { lowStockAlert: { latchedAt: 'yesterday' } } }))
      .toBe('lowStockAlert.latchedAt must be a full ISO 8601 instant or null');
    expect(expectError({ schemaVersion: 4, settings: 'nope' }))
      .toBe('settings must be an object');
    expect(expectError({ attacks: [], lowStockAlertedAt: 5 }))
      .toBe('lowStockAlertedAt must be a full ISO 8601 instant or null');
    expect(expectError({ attacks: [], lowStockAlertedAt: 'yesterday' }))
      .toBe('lowStockAlertedAt must be a full ISO 8601 instant or null');
  });

  it('validates rules/doses/planned entries strictly and names the path', () => {
    const envelope = (settings: unknown) => ({ schemaVersion: 4, attacks: [], settings });

    // rules: every entry is an object with a whole, non-negative limit and a
    // whole, positive windowDays (limit 0 means "no allowed days").
    expect(expectError(envelope({ rules: { nurtec: 5 } })))
      .toBe('rules[nurtec] must be an object');
    expect(expectError(envelope({ rules: { nurtec: { limit: '10', windowDays: 30 } } })))
      .toBe('rules[nurtec].limit must be an integer >= 0');
    expect(expectError(envelope({ rules: { nurtec: { limit: -1, windowDays: 30 } } })))
      .toBe('rules[nurtec].limit must be an integer >= 0');
    expect(expectError(envelope({ rules: { nurtec: { limit: 0.5, windowDays: 30 } } })))
      .toBe('rules[nurtec].limit must be an integer >= 0');
    expect(expectError(envelope({ rules: { nurtec: { limit: 1.5, windowDays: 30 } } })))
      .toBe('rules[nurtec].limit must be an integer >= 0');
    expect(expectError(envelope({ rules: { nurtec: { limit: 10 } } })))
      .toBe('rules[nurtec].windowDays must be an integer >= 1');
    expect(expectError(envelope({ rules: { nurtec: { limit: 10, windowDays: 0 } } })))
      .toBe('rules[nurtec].windowDays must be an integer >= 1');
    expect(expectError(envelope({ rules: { nurtec: { limit: 10, windowDays: '30' } } })))
      .toBe('rules[nurtec].windowDays must be an integer >= 1');

    // doses: default dose text only.
    expect(expectError(envelope({ doses: { nurtec: 42 } }))).toBe('doses[nurtec] must be a string');

    // planned: a REAL calendar day, not merely a date-shaped string.
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-01', 'next tuesday', 20260101]) {
      expect(expectError(envelope({ planned: { botox: bad } })))
        .toBe('planned[botox] must be a YYYY-MM-DD date');
    }
  });

  it('accepts rules.limit 0 ("no allowed days") and round-trips it verbatim', () => {
    // PUT /api/settings/rules stores raw JSON and only the UI clamps input, so
    // a real stored limit of 0 must survive a backup restore untouched.
    const backup = expectOk({
      schemaVersion: MAX_BACKUP_SCHEMA_VERSION,
      attacks: [],
      settings: { rules: { nurtec: { limit: 0, windowDays: 30 } } },
    });
    expect(backup.settings.rules).toEqual({ nurtec: { limit: 0, windowDays: 30 } });
  });

  it('fails closed on reserved names inside lookup objects and the latch', () => {
    // entry names of every lookup object
    for (const key of ['rules', 'doses', 'planned']) {
      expect(expectError({ schemaVersion: 4, settings: { [key]: { ntfyToken: 'x' } } }))
        .toBe(`${key} entry 'ntfyToken' must not be a reserved secret name`);
    }
    // a secret-looking key nested INSIDE a rules entry fails the whole parse
    expect(expectError({
      schemaVersion: 4,
      settings: { rules: { nurtec: { limit: 10, windowDays: 30, ntfyToken: 'x' } } },
    })).toBe("rules entry 'nurtec' must not contain 'ntfyToken'");
    // ... and inside lowStockAlert
    expect(expectError({
      schemaVersion: 4,
      settings: { lowStockAlert: { latchedAt: null, ntfyToken: 'x' } },
    })).toBe("lowStockAlert must not contain 'ntfyToken'");
  });

  it('applies the same lookup-object/latch rules to flattened browser fields', () => {
    expect(expectError({ attacks: [], rules: { nurtec: { limit: '10', windowDays: 30 } } }))
      .toBe('rules[nurtec].limit must be an integer >= 0');
    expect(expectError({ attacks: [], rules: { nurtec: { limit: 10, windowDays: 30, ntfyToken: 'x' } } }))
      .toBe("rules entry 'nurtec' must not contain 'ntfyToken'");
    expect(expectError({ attacks: [], doses: { nurtec: 42 } }))
      .toBe('doses[nurtec] must be a string');
    expect(expectError({ attacks: [], planned: { botox: '2026-02-30' } }))
      .toBe('planned[botox] must be a YYYY-MM-DD date');
    expect(expectError({ attacks: [], planned: { ntfyToken: '2026-02-01' } }))
      .toBe("planned entry 'ntfyToken' must not be a reserved secret name");
  });

  it('keeps non-reserved extra keys inside a rules entry (mirrors record tolerance)', () => {
    const backup = expectOk({
      schemaVersion: 4,
      attacks: [],
      settings: { rules: { nurtec: { limit: 15, windowDays: 30, label: 'Nurtec ODT' } } },
    });
    expect(backup.settings.rules).toEqual({
      nurtec: { limit: 15, windowDays: 30, label: 'Nurtec ODT' },
    });
  });

  it('normalizes valid reminders and drops unknown nested latch fields', () => {
    const backup = expectOk({
      schemaVersion: 4,
      attacks: [],
      settings: {
        reminders: {
          ...DEFAULT_REMINDER_SETTINGS,
          wakingStart: '08:00',
          wakingEnd: '20:00',
          checkInTime: '17:00',
        },
        lowStockAlert: { latchedAt: '2026-01-02T03:04:05.000Z', ledger: 'dropped' },
      },
    });
    expect(backup.settings.reminders).toEqual({
      ...DEFAULT_REMINDER_SETTINGS,
      wakingStart: '08:00',
      wakingEnd: '20:00',
      checkInTime: '17:00',
    });
    expect(backup.settings.lowStockAlert).toEqual({ latchedAt: '2026-01-02T03:04:05.000Z' });
  });

  it('reserves delivery/credential-like names case- and separator-insensitively', () => {
    for (const key of ['ntfyUrl', 'NTFY_URL', 'ntfy-token', 'public-app-url', 'apikey', 'mysecret', 'tokenX']) {
      expect(isReservedBackupSettingsKey(key)).toBe(true);
    }
    expect(isReservedBackupSettingsKey('rules')).toBe(false);
    expect(isReservedBackupSettingsKey('timezone')).toBe(false);
    expect(isReservedBackupSettingsKey(7)).toBe(false);
  });
});
