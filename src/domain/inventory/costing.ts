import { add, isZero, mulDiv, subtract, ZERO, type Minor } from '../money';
import {
  addQty,
  extendPrice,
  QTY_SCALE,
  subtractQty,
  type Qty,
} from '../quantity';
import { InsufficientStockError, ValidationError } from '../errors';

/**
 * Weighted-average inventory costing.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL IDEA: no per-unit average cost is ever stored.
 *
 * A product's cost basis is a PAIR — total quantity on hand (Q) and total
 * inventory value (V). Storing a rounded per-unit average and multiplying it
 * back out is what makes stock valuations drift away from the general ledger
 * over months of trading.
 *
 *   Stock in  q units for total cost c:   Q' = Q + q      V' = V + c
 *   Stock out q units:                    cogs = round(V x q / Q)
 *                                         Q'   = Q - q    V' = V - cogs
 *
 * Value is ALLOCATED out of the running total, never recomputed, so V is
 * conserved to the exact pesewa and the remainder stays in inventory instead of
 * evaporating into rounding.
 * ---------------------------------------------------------------------------
 *
 * Pure functions. No database, no clock, no ids. Every branch is unit-tested.
 */

export interface StockState {
  /** Quantity on hand, in milli-units. May be negative only when the shop allows it. */
  qty: Qty;
  /** Total value of that quantity, in pesewas. */
  value: Minor;
}

export const EMPTY_STOCK: StockState = { qty: 0 as Qty, value: ZERO };

export interface MovementResult {
  /** The running pair after the movement — written to the ledger row. */
  state: StockState;
  /** Exact value that moved. Positive for in, positive for out (as COGS). */
  totalCost: Minor;
  /** Rounded per-unit figure, for DISPLAY only. Never use it to recompute cost. */
  unitCost: Minor;
}

/** Invariant: zero quantity must mean zero value. */
function assertCoherent(state: StockState): void {
  if (state.qty === 0 && !isZero(state.value)) {
    throw new ValidationError(
      `Inventory state is incoherent: zero quantity but value ${state.value}.`,
      { state },
    );
  }
}

/** Per-unit average, for display. Returns zero when there is nothing on hand. */
export function averageUnitCost(state: StockState): Minor {
  if (state.qty === 0) return ZERO;
  return mulDiv(state.value, QTY_SCALE, state.qty);
}

/**
 * Add stock at a known total cost. Re-averages automatically because both the
 * quantity and the value move together.
 */
export function applyStockIn(
  current: StockState,
  qty: Qty,
  totalCost: Minor,
): MovementResult {
  if (qty <= 0) {
    throw new ValidationError('Stock in requires a quantity greater than zero.', { qty });
  }
  if (totalCost < 0) {
    throw new ValidationError('Stock cannot be received at a negative cost.', { totalCost });
  }

  const nextQty = addQty(current.qty, qty);
  let nextValue = add(current.value, totalCost);

  // Receiving stock can bring a negative position back to exactly zero. If it
  // does, any residual value must go with it rather than being stranded.
  if (nextQty === 0 && !isZero(nextValue)) {
    nextValue = ZERO;
  }

  const state: StockState = { qty: nextQty, value: nextValue };
  assertCoherent(state);

  return {
    state,
    totalCost,
    unitCost: qty === 0 ? ZERO : mulDiv(totalCost, QTY_SCALE, qty),
  };
}

export interface StockOutOptions {
  /**
   * Unit cost used for any quantity NOT covered by stock actually on hand.
   * Only consulted when the shop has enabled negative stock; typically the
   * product's reference cost price.
   */
  fallbackUnitCost?: Minor;
  /** When false (the default), selling more than is on hand is refused. */
  allowNegative?: boolean;
  /** Used only to make the error message useful. */
  productName?: string;
}

/**
 * Remove stock, allocating cost of goods sold out of the running value.
 *
 * The quantity available and the value available are consumed in proportion, so
 * selling everything releases exactly the remaining value — no more, no less.
 */
export function applyStockOut(
  current: StockState,
  qty: Qty,
  options: StockOutOptions = {},
): MovementResult {
  if (qty <= 0) {
    throw new ValidationError('Stock out requires a quantity greater than zero.', { qty });
  }

  const allowNegative = options.allowNegative ?? false;
  const fallbackUnitCost = options.fallbackUnitCost ?? ZERO;

  if (!allowNegative && qty > current.qty) {
    throw new InsufficientStockError(
      options.productName ?? 'this product',
      formatMilli(current.qty),
      formatMilli(qty),
    );
  }

  // --- the ordinary case: enough stock on hand -----------------------------
  if (current.qty > 0 && qty <= current.qty) {
    // Allocate proportionally out of the running value.
    let cogs = mulDiv(current.value, qty, current.qty);

    const nextQty = subtractQty(current.qty, qty);
    let nextValue = subtract(current.value, cogs);

    // Selling the last unit must empty the value exactly. Any residual pesewa
    // left by rounding goes out with it, so inventory can never hold value
    // with nothing on hand.
    if (nextQty === 0 && !isZero(nextValue)) {
      cogs = add(cogs, nextValue);
      nextValue = ZERO;
    }

    const state: StockState = { qty: nextQty, value: nextValue };
    assertCoherent(state);

    return {
      state,
      totalCost: cogs,
      unitCost: mulDiv(cogs, QTY_SCALE, qty),
    };
  }

  // --- negative stock territory (only reachable when explicitly allowed) ----
  //
  // Whatever IS on hand is consumed at its real average; the uncovered excess
  // is costed at the fallback rate so the position stays explainable and
  // self-corrects when stock is next received.
  const onHand = current.qty > 0 ? current.qty : (0 as Qty);
  const covered = onHand;
  const excess = subtractQty(qty, covered);

  const coveredCost = current.qty > 0 ? current.value : ZERO;
  const excessCost = extendPrice(fallbackUnitCost, excess);
  const cogs = add(coveredCost, excessCost);

  const nextQty = subtractQty(current.qty, qty);
  // current.value is fully released for the covered part; the excess drives the
  // balance negative by exactly what it was costed at.
  const nextValue = subtract(current.qty > 0 ? ZERO : current.value, excessCost);

  const state: StockState = {
    qty: nextQty,
    value: nextQty === 0 ? ZERO : nextValue,
  };
  assertCoherent(state);

  return {
    state,
    totalCost: cogs,
    unitCost: mulDiv(cogs, QTY_SCALE, qty),
  };
}

/**
 * Return stock to inventory at the ORIGINAL cost it left at.
 *
 * A customer return must restore exactly the value the sale removed, otherwise
 * returning goods would silently create or destroy profit. The caller supplies
 * the cost snapshot taken from the original sale line.
 */
export function applyReturnIn(
  current: StockState,
  qty: Qty,
  originalTotalCost: Minor,
): MovementResult {
  return applyStockIn(current, qty, originalTotalCost);
}

/**
 * Remove stock at a KNOWN cost rather than at the running average.
 *
 * Used when goods go back to a supplier: they leave at the price that supplier
 * actually charged, not at a blended average that includes other deliveries.
 * Returning cheap stock therefore correctly leaves the remaining average higher.
 *
 * The value can legitimately exceed what is on hand if other stock has since
 * been sold; the running pair simply follows, and the zero-quantity rule still
 * holds.
 */
export function applyStockOutAtCost(
  current: StockState,
  qty: Qty,
  totalCost: Minor,
  options: { allowNegative?: boolean; productName?: string } = {},
): MovementResult {
  if (qty <= 0) {
    throw new ValidationError('Stock out requires a quantity greater than zero.', { qty });
  }
  if (totalCost < 0) {
    throw new ValidationError('Stock cannot be returned at a negative cost.', { totalCost });
  }
  if (!(options.allowNegative ?? false) && qty > current.qty) {
    throw new InsufficientStockError(
      options.productName ?? 'this product',
      formatMilli(current.qty),
      formatMilli(qty),
    );
  }

  const nextQty = subtractQty(current.qty, qty);
  const nextValue = nextQty === 0 ? ZERO : subtract(current.value, totalCost);

  const state: StockState = { qty: nextQty, value: nextValue };
  assertCoherent(state);

  return { state, totalCost, unitCost: mulDiv(totalCost, QTY_SCALE, qty) };
}

/**
 * Cost basis for removing stock that is NOT a sale — damage, loss, expiry,
 * internal use. Identical arithmetic to a sale; the difference is which
 * expense account the value is posted to, which is the caller's concern.
 */
export function applyWriteOff(
  current: StockState,
  qty: Qty,
  options: StockOutOptions = {},
): MovementResult {
  return applyStockOut(current, qty, options);
}

/**
 * Replay a whole movement chain from empty.
 *
 * This is what makes the cached quantity/value on `products` provable: recompute
 * from the first movement and compare. Used by the integrity report and by
 * tests, never in a hot path.
 */
export interface ReplayMovement {
  qtyIn: Qty;
  qtyOut: Qty;
  totalCost: Minor;
}

export function replayChain(movements: readonly ReplayMovement[]): StockState {
  let state = EMPTY_STOCK;

  for (const movement of movements) {
    if (movement.qtyIn > 0) {
      state = { qty: addQty(state.qty, movement.qtyIn), value: add(state.value, movement.totalCost) };
    } else if (movement.qtyOut > 0) {
      state = {
        qty: subtractQty(state.qty, movement.qtyOut),
        value: subtract(state.value, movement.totalCost),
      };
    }
    if (state.qty === 0) state = { qty: state.qty, value: ZERO };
  }

  return state;
}

/** Below the reorder level (and the product is actually tracked). */
export function isLowStock(qtyOnHand: Qty, minStock: Qty | null, fallbackMin: Qty): boolean {
  const threshold = minStock ?? fallbackMin;
  return qtyOnHand <= threshold;
}

export function isOutOfStock(qtyOnHand: Qty): boolean {
  return qtyOnHand <= 0;
}

/** Local helper so error messages read in units, not milli-units. */
function formatMilli(value: number): string {
  const negative = value < 0;
  const digits = Math.abs(value).toString().padStart(4, '0');
  const whole = digits.slice(0, -3);
  const fraction = digits.slice(-3).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Guard for callers that must not silently accept a fractional milli-unit. */
export function assertWholeMilli(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${label} must be a whole number of milli-units.`, { value });
  }
}
