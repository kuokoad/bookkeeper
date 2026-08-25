import { describe, expect, it } from 'vitest';

import {
  allocateFefo,
  allocateProportional,
  isExpired,
  orderForPicking,
  type PickableBatch,
} from '@/domain/inventory/batches';
import { fromUnits, type Qty } from '@/domain/quantity';
import { ValidationError } from '@/domain/errors';

/**
 * Which units leave the shelf — and nothing about what they cost.
 *
 * Pure functions, no database. The rule they encode is first-expiry-first-out
 * with one deliberate exception: expired stock is never taken automatically,
 * and is not even mentioned while good stock covers the sale. A block that
 * fired while there was fresh stock on the shelf would be routed around within
 * a week, and a sale made off-system is worse than one made from an old batch.
 */

const TODAY = '2026-08-25';
const u = (n: number): Qty => fromUnits(n);

const batch = (
  id: number,
  qtyUnits: number,
  expiryDate: string | null = null,
): PickableBatch => ({
  id,
  batchRef: `BAT-${String(id).padStart(5, '0')}`,
  expiryDate,
  qtyMilli: qtyUnits * 1000,
});

const took = (plan: { allocations: { batchId: number; qtyMilli: number }[] }) =>
  plan.allocations.map((a) => [a.batchId, a.qtyMilli]);

const total = (plan: { allocations: { qtyMilli: number }[] }) =>
  plan.allocations.reduce((sum, a) => sum + a.qtyMilli, 0);

describe('what counts as expired', () => {
  it('is not expired on its own date — that is the last good day', () => {
    expect(isExpired(batch(1, 5, TODAY), TODAY)).toBe(false);
  });

  it('is expired the day after', () => {
    expect(isExpired(batch(1, 5, '2026-08-24'), TODAY)).toBe(true);
  });

  it('is never expired without a date', () => {
    expect(isExpired(batch(1, 5, null), TODAY)).toBe(false);
  });
});

describe('the picking order', () => {
  it('puts dated-and-good first, then undated, then expired', () => {
    const ordered = orderForPicking(
      [
        batch(1, 5, '2026-01-01'), // expired
        batch(2, 5, null), // undated
        batch(3, 5, '2026-09-01'), // good, later
        batch(4, 5, '2026-08-26'), // good, sooner
      ],
      TODAY,
    );

    expect(ordered.map((b) => b.id)).toEqual([4, 3, 2, 1]);
  });

  it('takes the tightest date first among good stock', () => {
    const ordered = orderForPicking(
      [batch(1, 5, '2026-12-31'), batch(2, 5, '2026-08-26'), batch(3, 5, '2026-10-01')],
      TODAY,
    );
    expect(ordered.map((b) => b.id)).toEqual([2, 3, 1]);
  });

  it('takes the oldest undated batch first', () => {
    const ordered = orderForPicking([batch(7, 5), batch(2, 5), batch(5, 5)], TODAY);
    expect(ordered.map((b) => b.id)).toEqual([2, 5, 7]);
  });

  it('is total, so the same shelf always gives the same answer', () => {
    const shelf = [batch(3, 5, '2026-09-01'), batch(1, 5, '2026-09-01'), batch(2, 5, '2026-09-01')];
    expect(orderForPicking(shelf, TODAY).map((b) => b.id)).toEqual([1, 2, 3]);
    expect(orderForPicking([...shelf].reverse(), TODAY).map((b) => b.id)).toEqual([1, 2, 3]);
  });
});

describe('taking stock out', () => {
  it('draws from one batch when it covers the lot', () => {
    const plan = allocateFefo([batch(1, 10, '2026-09-01')], u(4), { today: TODAY });

    expect(took(plan)).toEqual([[1, 4_000]]);
    expect(plan.shortfall).toBe(0);
    expect(plan.expiredNeeded).toBe(0);
  });

  it('spans three batches and still sums to what was asked', () => {
    const plan = allocateFefo(
      [batch(1, 2, '2026-08-26'), batch(2, 3, '2026-09-01'), batch(3, 10, null)],
      u(9),
      { today: TODAY },
    );

    expect(took(plan)).toEqual([
      [1, 2_000],
      [2, 3_000],
      [3, 4_000],
    ]);
    expect(total(plan)).toBe(9_000);
    expect(plan.shortfall).toBe(0);
  });

  it('SKIPS expired stock entirely while good stock covers the sale', () => {
    // The common case, and the one that must never interrupt anybody: an old
    // crate at the back of the shelf is not the cashier's problem today.
    const plan = allocateFefo([batch(1, 20, '2026-01-01'), batch(2, 30, '2026-09-01')], u(5), {
      today: TODAY,
    });

    expect(took(plan)).toEqual([[2, 5_000]]);
    expect(plan.expiredNeeded).toBe(0);
    expect(plan.expiredRefs).toEqual([]);
    expect(plan.shortfall).toBe(0);
  });

  it('reports what expired stock would be needed, without taking it', () => {
    const plan = allocateFefo([batch(1, 20, '2026-01-01'), batch(2, 3, '2026-09-01')], u(5), {
      today: TODAY,
    });

    // The good stock went out; the rest is reported, not taken.
    expect(took(plan)).toEqual([[2, 3_000]]);
    expect(plan.expiredNeeded).toBe(2_000);
    expect(plan.expiredRefs).toEqual(['BAT-00001']);
    expect(plan.shortfall).toBe(0);
  });

  it('reaches into expired stock only when told to, earliest date first', () => {
    const plan = allocateFefo(
      [batch(1, 2, '2026-02-01'), batch(2, 5, '2026-01-01'), batch(3, 1, '2026-09-01')],
      u(6),
      { today: TODAY, allowExpired: true },
    );

    // Good stock first, then the OLDEST expired batch before the newer one.
    expect(took(plan)).toEqual([
      [3, 1_000],
      [2, 5_000],
    ]);
    expect(plan.expiredNeeded).toBe(5_000);
    expect(plan.shortfall).toBe(0);
  });

  it('reports a genuine shortage separately from an expiry problem', () => {
    // Nothing on the shelf at all: this is InsufficientStock territory, not a
    // decision for a supervisor.
    const plan = allocateFefo([batch(1, 2, '2026-09-01')], u(5), { today: TODAY });

    expect(plan.shortfall).toBe(3_000);
    expect(plan.expiredNeeded).toBe(0);
  });

  it('reports both when expired stock still would not be enough', () => {
    const plan = allocateFefo([batch(1, 1, '2026-01-01'), batch(2, 1, '2026-09-01')], u(5), {
      today: TODAY,
    });

    expect(plan.expiredNeeded).toBe(1_000);
    expect(plan.shortfall).toBe(3_000);
  });

  it('does not pick from an empty or negative batch', () => {
    const plan = allocateFefo(
      [batch(1, 0, '2026-08-26'), { ...batch(2, 0), qtyMilli: -4_000 }, batch(3, 5, '2026-09-01')],
      u(2),
      { today: TODAY },
    );

    expect(took(plan)).toEqual([[3, 2_000]]);
  });

  it('refuses a quantity of nothing', () => {
    expect(() => allocateFefo([batch(1, 5)], 0 as Qty, { today: TODAY })).toThrow(ValidationError);
  });
});

describe('putting stock back where it came from', () => {
  it('returns the whole movement batch for batch', () => {
    const source = [
      { batchId: 1, batchRef: 'BAT-00001', qtyMilli: 2_000 },
      { batchId: 2, batchRef: 'BAT-00002', qtyMilli: 3_000 },
    ];
    const back = allocateProportional(source, u(5));

    expect(back.map((a) => [a.batchId, a.qtyMilli])).toEqual([
      [1, 2_000],
      [2, 3_000],
    ]);
  });

  it('splits a partial return in proportion, summing exactly', () => {
    const source = [
      { batchId: 1, batchRef: 'BAT-00001', qtyMilli: 2_000 },
      { batchId: 2, batchRef: 'BAT-00002', qtyMilli: 6_000 },
    ];
    const back = allocateProportional(source, u(4));

    // 4 of 8 came back: one quarter from the first, three quarters from the second.
    expect(back.map((a) => a.qtyMilli)).toEqual([1_000, 3_000]);
    expect(back.reduce((s, a) => s + a.qtyMilli, 0)).toBe(4_000);
  });

  it('gives the odd unit to the largest remainder rather than losing it', () => {
    const source = [
      { batchId: 1, batchRef: 'BAT-00001', qtyMilli: 1 },
      { batchId: 2, batchRef: 'BAT-00002', qtyMilli: 1 },
      { batchId: 3, batchRef: 'BAT-00003', qtyMilli: 1 },
    ];
    const back = allocateProportional(source, 2 as Qty);

    expect(back.reduce((s, a) => s + a.qtyMilli, 0)).toBe(2);
  });

  it('is deterministic when remainders tie', () => {
    const source = [
      { batchId: 1, batchRef: 'BAT-00001', qtyMilli: 1_000 },
      { batchId: 2, batchRef: 'BAT-00002', qtyMilli: 1_000 },
      { batchId: 3, batchRef: 'BAT-00003', qtyMilli: 1_000 },
    ];
    const first = allocateProportional(source, 1_001 as Qty);
    const again = allocateProportional(source, 1_001 as Qty);
    expect(first).toEqual(again);
    expect(first.reduce((s, a) => s + a.qtyMilli, 0)).toBe(1_001);
  });

  it('refuses to put back more than went out', () => {
    const source = [{ batchId: 1, batchRef: 'BAT-00001', qtyMilli: 2_000 }];
    expect(() => allocateProportional(source, u(3))).toThrow(ValidationError);
  });

  it('refuses when the original took nothing', () => {
    expect(() => allocateProportional([], u(1))).toThrow(ValidationError);
  });
});

describe('the property that has to hold whatever the shop does', () => {
  /**
   * Sum of batch quantities === product quantity, across any sequence of
   * movements. This is `verifyBatchCoverage` stated as arithmetic, and it is
   * the invariant every later phase leans on: break it and picking runs against
   * an incomplete shelf, silently.
   *
   * Deterministic pseudo-random, so a failure can be reproduced. Alongside
   * `costing-properties.test.ts`, which does the same for value.
   */
  it('keeps batch quantities summing to the shelf across 500 movements', () => {
    let seed = 20260825;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };

    const batches: PickableBatch[] = [];
    let nextId = 1;
    let shelf = 0;

    for (let step = 0; step < 500; step++) {
      const takingOut = shelf > 0 && next(2) === 0;

      if (!takingOut) {
        const qty = (next(20) + 1) * 1000;
        const dated = next(3) !== 0;
        batches.push({
          id: nextId,
          batchRef: `BAT-${String(nextId).padStart(5, '0')}`,
          // A spread of dates around today, so some are expired and some are not.
          expiryDate: dated ? `2026-0${1 + next(9)}-15` : null,
          qtyMilli: qty,
        });
        nextId += 1;
        shelf += qty;
        continue;
      }

      const want = Math.min(shelf, (next(15) + 1) * 1000);
      const plan = allocateFefo(batches, want as Qty, { today: TODAY, allowExpired: true });

      // Whatever it planned to take must come out of the shelf exactly.
      const taken = total(plan);
      expect(taken + plan.shortfall).toBe(want);

      for (const allocation of plan.allocations) {
        const target = batches.find((b) => b.id === allocation.batchId)!;
        target.qtyMilli -= allocation.qtyMilli;
        expect(target.qtyMilli).toBeGreaterThanOrEqual(0);
      }
      shelf -= taken;

      expect(batches.reduce((sum, b) => sum + b.qtyMilli, 0), `step ${step}`).toBe(shelf);
    }

    expect(batches.reduce((sum, b) => sum + b.qtyMilli, 0)).toBe(shelf);
  });
});
