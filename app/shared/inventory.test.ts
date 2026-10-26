// Pure inventory-calculation edge cases (runs in Node via Vitest, like the
// other shared modules). The server-side authority test mirrors several of
// these scenarios through the real API in server/test/inventory.test.js.

import { describe, expect, it } from 'vitest';
import { classifyStock, currentStock } from './inventory.ts';

const TZ = 'America/New_York';

const baseline = (id: string, effectiveAt: string, quantity: number, createdAt = effectiveAt) => ({
  id,
  effectiveAt,
  quantity,
  createdAt,
});

// Refill instants are the START of the local day. EST (winter) is UTC-5.
const REFILL_DAY = '2026-02-10'; // starts 2026-02-10T05:00:00.000Z
// A correction on the evening of the same day:
const CORRECTION_INSTANT = '2026-02-10T21:30:00.000Z';

describe('currentStock', () => {
  it('is unknown before any applicable baseline — never zero', () => {
    const r = currentStock(
      {
        baselines: [],
        doses: [{ id: 'd1', ts: '2026-02-11T12:00:00.000Z', quantity: 1 }],
        refills: [{ id: 'r1', date: REFILL_DAY, quantity: 8 }],
      },
      { now: '2026-02-12T00:00:00.000Z', timeZone: TZ },
    );
    expect(r).toEqual({
      status: 'unknown',
      quantity: null,
      baselineId: null,
      baselineEffectiveAt: null,
    });
  });

  it('computes baseline + later refills − later doses', () => {
    const r = currentStock(
      {
        baselines: [baseline('b1', '2026-02-01T00:00:00.000Z', 10)],
        doses: [
          { id: 'd1', ts: '2026-02-11T12:00:00.000Z', quantity: 1 },
          { id: 'd2', ts: '2026-02-12T13:00:00.000Z', quantity: 1 },
        ],
        refills: [{ id: 'r1', date: REFILL_DAY, quantity: 8 }],
      },
      { now: '2026-02-15T00:00:00.000Z', timeZone: TZ },
    );
    expect(r.status).toBe('known');
    expect(r.quantity).toBe(10 + 8 - 2);
    expect(r.baselineId).toBe('b1');
  });

  it('ignores events before the baseline (backfills never decrement)', () => {
    const r = currentStock(
      {
        baselines: [baseline('b1', '2026-02-05T00:00:00.000Z', 10)],
        doses: [{ id: 'd-old', ts: '2026-02-02T12:00:00.000Z', quantity: 3 }],
        refills: [{ id: 'r-old', date: '2026-02-03', quantity: 8 }],
      },
      { now: '2026-02-15T00:00:00.000Z', timeZone: TZ },
    );
    expect(r.quantity).toBe(10);
  });

  it('subsumes an event at exactly the baseline instant (strictly-after rule)', () => {
    const at = '2026-02-05T00:00:00.000Z';
    const r = currentStock(
      {
        baselines: [baseline('b1', at, 10)],
        doses: [{ id: 'd-exact', ts: at, quantity: 1 }],
        // A refill whose day STARTS exactly at the baseline instant is also
        // not strictly after it:
        refills: [],
      },
      { now: '2026-02-15T00:00:00.000Z', timeZone: 'UTC' },
    );
    expect(r.quantity).toBe(10);
  });

  it('same-day correction is absolute and supersedes that day\u2019s earlier refill and dose', () => {
    // Refill effective at 05:00Z (start of local day); correction at 21:30Z.
    const r = currentStock(
      {
        baselines: [
          baseline('b1', '2026-01-01T00:00:00.000Z', 20),
          baseline('b2', CORRECTION_INSTANT, 6, '2026-02-10T21:35:00.000Z'),
        ],
        doses: [{ id: 'd1', ts: '2026-02-10T14:00:00.000Z', quantity: 1 }],
        refills: [{ id: 'r1', date: REFILL_DAY, quantity: 8 }],
      },
      { now: '2026-02-11T00:00:00.000Z', timeZone: TZ },
    );
    // The 05:00Z refill and the 14:00Z dose are both before the 21:30Z
    // correction, so the stock is exactly the correction's absolute count.
    expect(r.baselineId).toBe('b2');
    expect(r.quantity).toBe(6);
  });

  it('counts events strictly after a same-day correction normally', () => {
    const r = currentStock(
      {
        baselines: [baseline('b2', CORRECTION_INSTANT, 6)],
        doses: [{ id: 'd-late', ts: '2026-02-10T23:00:00.000Z', quantity: 1 }],
        refills: [{ id: 'r2', date: '2026-02-11', quantity: 8 }],
      },
      { now: '2026-02-12T00:00:00.000Z', timeZone: TZ },
    );
    // 2026-02-11 starts 05:00Z, after the correction → +8.
    expect(r.quantity).toBe(6 - 1 + 8);
  });

  it('breaks exact-instant baseline ties by createdAt, then id', () => {
    const at = '2026-02-05T00:00:00.000Z';
    const input = {
      doses: [],
      refills: [],
      baselines: [
        baseline('b-a', at, 5, '2026-02-05T10:00:00.000Z'),
        baseline('b-b', at, 9, '2026-02-05T10:00:00.000Z'), // same createdAt → id wins
        baseline('b-c', at, 7, '2026-02-05T09:00:00.000Z'),
      ],
    };
    expect(currentStock(input, { now: at, timeZone: TZ }).quantity).toBe(9);

    // A later createdAt (b-a) beats the higher id:
    const input2 = {
      ...input,
      baselines: [
        { ...input.baselines[0], createdAt: '2026-02-05T11:00:00.000Z' },
        input.baselines[1],
        input.baselines[2],
      ],
    };
    expect(currentStock(input2, { now: at, timeZone: TZ }).quantity).toBe(5);
  });

  it('ignores future baselines until their instant arrives, then applies them', () => {
    const future = '2026-03-01T12:00:00.000Z';
    const input = {
      baselines: [baseline('b-future', future, 12)],
      doses: [{ id: 'd1', ts: '2026-02-20T12:00:00.000Z', quantity: 2 }],
      refills: [],
    };
    expect(currentStock(input, { now: '2026-02-21T00:00:00.000Z', timeZone: TZ }).status)
      .toBe('unknown');
    const applied = currentStock(input, { now: '2026-03-01T12:00:00.000Z', timeZone: TZ });
    expect(applied).toMatchObject({ status: 'known', quantity: 12 });
  });

  it('resolves date-only refills through DST transitions', () => {
    // 2026-03-08 is the US spring-forward day: local midnight is 05:00Z
    // (EST, UTC-5), while 2026-03-09 starts at 04:00Z (EDT, UTC-4).
    const r = currentStock(
      {
        baselines: [baseline('b1', '2026-03-08T05:00:00.000Z', 10)],
        doses: [],
        refills: [{ id: 'r-dst', date: '2026-03-09', quantity: 8 }],
      },
      { now: '2026-03-09T03:59:59.999Z', timeZone: TZ },
    );
    // One millisecond before the refill's instant (04:00Z on the 9th) it is
    // still in the future; the same call at/after that instant includes it:
    expect(r.quantity).toBe(10);
    const r2 = currentStock(
      {
        baselines: [baseline('b1', '2026-03-08T05:00:00.000Z', 10)],
        doses: [],
        refills: [{ id: 'r-dst', date: '2026-03-09', quantity: 8 }],
      },
      { now: '2026-03-09T04:00:00.001Z', timeZone: TZ },
    );
    expect(r2.quantity).toBe(18);
  });

  it('skips unknown quantities instead of treating them as zero or guessing', () => {
    const r = currentStock(
      {
        baselines: [baseline('b1', '2026-02-01T00:00:00.000Z', 10)],
        doses: [
          { id: 'd-null', ts: '2026-02-05T12:00:00.000Z', quantity: null },
          { id: 'd-legacy', ts: '2026-02-06T12:00:00.000Z' }, // absent key
        ],
        refills: [{ id: 'r-null', date: '2026-02-07', quantity: null }],
      },
      { now: '2026-02-15T00:00:00.000Z', timeZone: TZ },
    );
    expect(r.quantity).toBe(10);
  });

  it('keeps negative stock and excludes events after now', () => {
    const r = currentStock(
      {
        baselines: [baseline('b1', '2026-02-01T00:00:00.000Z', 2)],
        doses: [
          { id: 'd1', ts: '2026-02-05T12:00:00.000Z', quantity: 5 },
          { id: 'd-future', ts: '2027-01-01T12:00:00.000Z', quantity: 100 },
        ],
        refills: [{ id: 'r-future', date: '2027-01-02', quantity: 8 }],
      },
      { now: '2026-02-15T00:00:00.000Z', timeZone: TZ },
    );
    expect(r.quantity).toBe(-3);
  });

  it('ignores malformed event timestamps/dates instead of failing the whole calculation', () => {
    const r = currentStock(
      {
        baselines: [baseline('b1', '2026-02-01T00:00:00.000Z', 10)],
        doses: [{ id: 'd-bad', ts: 'not-a-date', quantity: 3 }],
        refills: [{ id: 'r-bad', date: '2026-02-30', quantity: 8 }],
      },
      { now: '2026-02-15T00:00:00.000Z', timeZone: TZ },
    );
    expect(r.quantity).toBe(10);
  });
});

describe('classifyStock', () => {
  it('maps quantity + threshold to unknown/ok/low/negative', () => {
    expect(classifyStock(null, 2)).toBe('unknown');
    expect(classifyStock(3, 2)).toBe('ok');
    expect(classifyStock(2, 2)).toBe('low');
    expect(classifyStock(0, 2)).toBe('low');
    expect(classifyStock(-1, 2)).toBe('negative');
  });
});
