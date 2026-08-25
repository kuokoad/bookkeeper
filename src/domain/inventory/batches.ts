import { ValidationError } from '../errors';
import { QTY_SCALE, type Qty } from '../quantity';

/**
 * Which physical units leave the shelf, and which come back to it.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE KNOWS WHAT ANYTHING COST.
 *
 * Value is weighted-average and pooled per product — see `costing.ts`. These
 * functions decide only WHICH batch a quantity comes from. A unit picked from
 * the oldest batch and a unit picked from the newest cost exactly the same,
 * because cost is not a property of a batch and never becomes one.
 *
 * Keeping that separation is the whole reason expiry tracking was affordable.
 * If a cost ever appears in this file, the two systems have been allowed to
 * touch and the weighted average is no longer trustworthy.
 * ---------------------------------------------------------------------------
 *
 * Pure: no database, no clock, no ids generated. The caller passes the batches
 * and today's date; these return the split. Every branch is unit-tested.
 */

/** What the allocator needs to know about a batch. Deliberately not the row. */
export interface PickableBatch {
  id: number;
  batchRef: string;
  /** 'YYYY-MM-DD', or null for stock that does not expire. */
  expiryDate: string | null;
  qtyMilli: number;
}

export interface Allocation {
  batchId: number;
  batchRef: string;
  qtyMilli: number;
}

export interface FefoPlan {
  /** What to take, in the order it should be taken. */
  allocations: Allocation[];
  /**
   * Quantity that could not be covered at all, even counting expired stock.
   * Non-zero here means the shop is genuinely short, not merely out of date.
   */
  shortfall: number;
  /**
   * Quantity that could only be covered by reaching into expired batches.
   *
   * Zero on the ordinary path, INCLUDING when expired stock exists but good
   * stock covered the sale — which is the common case and must never interrupt
   * anybody. Non-zero only when there was nothing else left.
   */
  expiredNeeded: number;
  /** The batches that quantity would come from, for the person deciding. */
  expiredRefs: string[];
}

/**
 * Whether a batch has passed its date, as at `today`.
 *
 * An expiry date is the last day the goods are good, so a batch dated today is
 * still sellable — it expires at the end of it. Both are 'YYYY-MM-DD', which
 * compares correctly as text.
 */
export function isExpired(batch: PickableBatch, today: string): boolean {
  return batch.expiryDate !== null && batch.expiryDate < today;
}

/**
 * The order stock is taken in: first-expiry-first-out.
 *
 *   1. Dated and still good — earliest date first, so the tightest goes first.
 *   2. Undated — oldest batch first. The opening batch lives here, so migrated
 *      stock drains after anything with a deadline but before anything expired.
 *   3. Expired — last, and never reached automatically.
 *
 * Ties break on id, so the order is total and a shop gets the same answer twice.
 */
export function orderForPicking(
  batches: readonly PickableBatch[],
  today: string,
): PickableBatch[] {
  const rank = (batch: PickableBatch): number => {
    if (isExpired(batch, today)) return 2;
    return batch.expiryDate === null ? 1 : 0;
  };

  return [...batches].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;

    // Within the dated groups, the earliest date leads.
    if (a.expiryDate !== null && b.expiryDate !== null && a.expiryDate !== b.expiryDate) {
      return a.expiryDate < b.expiryDate ? -1 : 1;
    }
    return a.id - b.id;
  });
}

/**
 * Take `qty` out of the batches, earliest expiry first.
 *
 * Expired batches are SKIPPED whenever the good stock covers the quantity. They
 * are only reported — and only taken with `allowExpired` — when there is
 * nothing else left. That distinction is what keeps this from becoming a block
 * staff route around: a shop with one old crate at the back of the shelf never
 * sees an interruption while it still has fresh stock.
 *
 * Batches holding nothing, or holding a negative position, are not picked from.
 */
export function allocateFefo(
  batches: readonly PickableBatch[],
  qty: Qty,
  options: { today: string; allowExpired?: boolean },
): FefoPlan {
  if (qty <= 0) {
    throw new ValidationError('Picking requires a quantity greater than zero.', { qty });
  }

  const ordered = orderForPicking(batches, options.today).filter((batch) => batch.qtyMilli > 0);
  const good = ordered.filter((batch) => !isExpired(batch, options.today));
  const expired = ordered.filter((batch) => isExpired(batch, options.today));

  const allocations: Allocation[] = [];
  let remaining = qty as number;

  const drawFrom = (from: readonly PickableBatch[]): void => {
    for (const batch of from) {
      if (remaining <= 0) break;
      const take = Math.min(batch.qtyMilli, remaining);
      allocations.push({ batchId: batch.id, batchRef: batch.batchRef, qtyMilli: take });
      remaining -= take;
    }
  };

  drawFrom(good);

  if (remaining <= 0) {
    return { allocations, shortfall: 0, expiredNeeded: 0, expiredRefs: [] };
  }

  // Good stock ran out. What would expired stock cover?
  const expiredAvailable = expired.reduce((total, batch) => total + batch.qtyMilli, 0);
  const fromExpired = Math.min(expiredAvailable, remaining);

  if (options.allowExpired !== true) {
    return {
      allocations,
      shortfall: remaining - fromExpired,
      expiredNeeded: fromExpired,
      expiredRefs: expired.map((batch) => batch.batchRef),
    };
  }

  drawFrom(expired);

  return {
    allocations,
    shortfall: Math.max(0, remaining),
    expiredNeeded: fromExpired,
    expiredRefs: expired.map((batch) => batch.batchRef),
  };
}

/**
 * Split `qty` across the batches a document originally drew from, in proportion
 * to what each contributed.
 *
 * A partial return has to go back somewhere, and the only defensible somewhere
 * is where it came from — otherwise the expiry dates on a shelf become fiction
 * after the first return. Largest remainder, exactly as `allocate()` does for
 * money, so the parts add back to the whole with nothing invented or lost.
 *
 * `source` is the ORIGINAL split, not what the batches hold now: a batch that
 * has since emptied still gets its share back, and reopens.
 */
export function allocateProportional(
  source: readonly Allocation[],
  qty: Qty,
): Allocation[] {
  if (source.length === 0) {
    throw new ValidationError('Cannot put stock back across zero batches.');
  }
  if (qty <= 0) {
    throw new ValidationError('Returning requires a quantity greater than zero.', { qty });
  }

  const total = source.reduce((sum, item) => sum + item.qtyMilli, 0);
  if (total <= 0) {
    throw new ValidationError('The original movement took nothing to put back.', { total });
  }
  if ((qty as number) > total) {
    throw new ValidationError(
      `Cannot put back more than went out: ${qty} against ${total}.`,
      { qty, total },
    );
  }

  // BigInt for the same reason `allocate()` uses it: the intermediate product
  // of two milli-unit quantities can leave the safe integer range long before
  // either operand looks large.
  const qtyBig = BigInt(qty as number);
  const totalBig = BigInt(total);

  const shares: number[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let distributed = 0;

  source.forEach((item, index) => {
    const product = qtyBig * BigInt(item.qtyMilli);
    const share = product / totalBig;
    remainders.push({ index, remainder: product - share * totalBig });
    shares.push(Number(share));
    distributed += Number(share);
  });

  // Hand the leftover units to the largest remainders, ties to the earlier
  // batch so the result is deterministic rather than merely correct.
  let leftover = (qty as number) - distributed;
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );

  for (const { index } of remainders) {
    if (leftover <= 0) break;
    shares[index] = (shares[index] ?? 0) + 1;
    leftover -= 1;
  }

  return source
    .map((item, index) => ({
      batchId: item.batchId,
      batchRef: item.batchRef,
      qtyMilli: shares[index] ?? 0,
    }))
    .filter((item) => item.qtyMilli > 0);
}

/** Whole units, for an error message a shop owner reads. */
export function formatQty(milli: number): string {
  const negative = milli < 0;
  const digits = Math.abs(milli).toString().padStart(4, '0');
  const whole = digits.slice(0, -3);
  const fraction = digits.slice(-3).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Guard for a caller that must not hand in a fractional milli-unit. */
export function assertWholeMilli(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${label} must be a whole number of milli-units.`, { value });
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER / QTY_SCALE) {
    throw new ValidationError(`${label} is too large to be a quantity.`, { value });
  }
}
