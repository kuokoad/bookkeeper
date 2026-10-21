import { isDomainError } from '@/domain/errors';
import { parseMoney, subtract, sum, toDecimalString, ZERO, type Minor } from '@/domain/money';
import {
  assertUnitDecimals,
  extendPrice,
  parsePositiveQty,
  QTY_DECIMALS,
  toBaseQty,
  type Qty,
} from '@/domain/quantity';
import { taxOnNet, type TaxComponent, type TaxLine } from '@/domain/tax/components';

/**
 * What the new-purchase form would save, read the way the server reads it.
 *
 * ONE pass over what was typed decides every figure on the screen and whether
 * Save is allowed. Before this, the line figures, the totals and the Save
 * button each made their own reading with a hand-rolled parser, and they
 * disagreed with each other and with the server: a cleared cost box saved
 * stock at zero cost, a row with no product showed a line total Save then
 * dropped, an unreadable line left the totals at a confident 0.00, and "2,50"
 * read as 250.00 here while the server refused it.
 *
 * So the parsing is the server's own (`parseMoney`, `parsePositiveQty`, the
 * unit checks `resolveLineUnit` makes, the tax `createPurchase` adds), every
 * refusal the server would make is named against the field it belongs to, and
 * a figure is shown only when Save would store exactly that figure. Anything
 * else is a dash.
 *
 * Only what the screen can know is checked here. An archived supplier or a
 * product deleted since the page loaded is still the server's to refuse.
 */

export interface LineEntry {
  productId: string;
  qty: string;
  alt: boolean;
  unitCost: string;
  discount: string;
}

/** What a purchase line needs to know about its product to be checked. */
export interface LineProduct {
  id: number;
  unit: string;
  altUnit: string | null;
  altFactorMilli: number | null;
  /** Decimal places the base unit allows: Pcs 0, kg 3. */
  unitDecimals: number;
  /** Decimal places the alternate unit allows. Null when there is no alternate. */
  altUnitDecimals: number | null;
}

export type LineField = 'product' | 'qty' | 'cost' | 'discount';

export interface LineReading {
  /** Nothing typed on the line, so it is left out without complaint. */
  blank: boolean;
  /** Why the server would refuse each field, in words a shop owner can act on. */
  errors: Partial<Record<LineField, string>>;
  /** What Save stores as this line's total, or null when it would store no such line. */
  total: Minor | null;
  /** A cost of zero, typed on purpose: goods that came in free. */
  free: boolean;
}

export interface PurchaseReading {
  lines: LineReading[];
  /** Lines Save would send. */
  filled: number;
  /** Null while any line cannot be saved: the readable lines alone are not this purchase. */
  subtotal: Minor | null;
  invoiceDiscountError: string | undefined;
  taxLines: TaxLine[];
  total: Minor | null;
  /** Why there is no total when no box is to blame: an overflow, an unusable tax rate. */
  totalError: string | undefined;
  paid: Minor | null;
  paidError: string | undefined;
  outstanding: Minor | null;
  /** True when every figure typed is one the server accepts. */
  acceptable: boolean;
}

/** The message a domain refusal carries, or a plain one for anything else. */
function refusal(error: unknown, fallback: string): string {
  return isDomainError(error) ? error.userMessage : fallback;
}

/** The checks `resolveLineUnit` makes on the server, in the same order. */
function readQty(entry: LineEntry, product: LineProduct | undefined): { qty?: Qty; error?: string } {
  if (entry.qty.trim() === '') return { error: 'Enter a quantity.' };
  try {
    const qty = parsePositiveQty(entry.qty, 'Quantity');
    if (!product) return { qty };
    if (!entry.alt) {
      assertUnitDecimals(qty, product.unitDecimals, product.unit);
      return { qty };
    }
    if (product.altUnit === null || product.altFactorMilli === null) {
      return { error: 'This product has no alternate unit.' };
    }
    assertUnitDecimals(qty, product.altUnitDecimals ?? QTY_DECIMALS, product.altUnit);
    assertUnitDecimals(toBaseQty(qty, product.altFactorMilli), product.unitDecimals, product.unit);
    return { qty };
  } catch (error) {
    return { error: refusal(error, 'That quantity cannot be read.') };
  }
}

/** A required amount: what each one cost. Zero is a real cost; empty is not. */
function readCost(text: string): { cost?: Minor; error?: string } {
  if (text.trim() === '') return { error: 'Enter what each one cost.' };
  try {
    const cost = parseMoney(text);
    return cost < 0 ? { error: 'A unit cost cannot be negative.' } : { cost };
  } catch (error) {
    return { error: refusal(error, 'That cost cannot be read.') };
  }
}

/** An optional amount: empty is zero, anything typed must be a real one. */
function readOptional(text: string, negative: string): { amount?: Minor; error?: string } {
  if (text.trim() === '') return { amount: ZERO };
  try {
    const amount = parseMoney(text);
    return amount < 0 ? { error: negative } : { amount };
  } catch (error) {
    return { error: refusal(error, 'That amount cannot be read.') };
  }
}

export function readLine(entry: LineEntry, products: readonly LineProduct[]): LineReading {
  const blank =
    entry.productId === '' &&
    entry.qty.trim() === '' &&
    entry.unitCost.trim() === '' &&
    entry.discount.trim() === '';
  if (blank) return { blank, errors: {}, total: null, free: false };

  const errors: LineReading['errors'] = {};
  const product = products.find((item) => String(item.id) === entry.productId);
  if (!product) errors.product = 'Choose a product.';

  const qty = readQty(entry, product);
  if (qty.error) errors.qty = qty.error;
  const cost = readCost(entry.unitCost);
  if (cost.error) errors.cost = cost.error;
  const discount = readOptional(entry.discount, 'A discount cannot be negative.');
  if (discount.error) errors.discount = discount.error;

  let total: Minor | null = null;
  if (qty.qty !== undefined && cost.cost !== undefined && discount.amount !== undefined) {
    try {
      const gross = extendPrice(cost.cost, qty.qty);
      if (discount.amount > gross) {
        errors.discount = `The discount cannot be more than the line, ${toDecimalString(gross)}.`;
      } else {
        total = subtract(gross, discount.amount);
      }
    } catch (error) {
      errors.cost = refusal(error, 'That line is too large to work out.');
    }
  }

  const refused = Object.keys(errors).length > 0;
  return {
    blank,
    errors,
    total: refused ? null : total,
    free: !refused && cost.cost === 0,
  };
}

export function readPurchase(input: {
  rows: readonly LineEntry[];
  products: readonly LineProduct[];
  invoiceDiscount: string;
  payAmount: string;
  /** False when there is no account a payment could come out of. */
  canPay: boolean;
  taxComponents: readonly TaxComponent[];
}): PurchaseReading {
  const lines = input.rows.map((row) => readLine(row, input.products));
  const sent = lines.filter((line) => !line.blank);

  // A refusal that belongs to no one box, said under the total it stops.
  let totalError: string | undefined;

  let subtotal: Minor | null = null;
  if (sent.every((line) => line.total !== null)) {
    try {
      subtotal = sum(sent.map((line) => line.total as Minor));
    } catch (error) {
      totalError = refusal(error, 'These lines are too large to add up.');
    }
  }

  const discount = readOptional(input.invoiceDiscount, 'A discount cannot be negative.');
  let invoiceDiscountError = discount.error;
  if (subtotal !== null && discount.amount !== undefined && discount.amount > subtotal) {
    invoiceDiscountError = `The discount cannot be more than the subtotal, ${toDecimalString(subtotal)}.`;
  }

  /**
   * Tax goes on top of the net, whatever the shop does with its shelf prices,
   * by the same domain function the server charges it with. Left out, the form
   * quoted a total lower than the one stored, refused to let the full amount be
   * paid, and said nothing was owed while the tax still was.
   */
  let taxLines: TaxLine[] = [];
  let total: Minor | null = null;
  if (subtotal !== null && discount.amount !== undefined && invoiceDiscountError === undefined) {
    try {
      const breakdown = taxOnNet(subtract(subtotal, discount.amount), input.taxComponents);
      taxLines = breakdown.lines;
      total = breakdown.gross;
    } catch (error) {
      totalError = refusal(error, 'The tax on this purchase cannot be worked out.');
    }
  }

  const payment = readOptional(input.payAmount, 'A payment cannot be negative.');
  let paidError = payment.error;
  if (payment.amount !== undefined && payment.amount > 0 && !input.canPay) {
    paidError = 'Add a payment account before recording a payment.';
  } else if (payment.amount !== undefined && total !== null && payment.amount > total) {
    paidError = 'You cannot pay more than the purchase total.';
  }
  const paid = paidError === undefined ? (payment.amount ?? null) : null;

  return {
    lines,
    filled: sent.length,
    subtotal,
    invoiceDiscountError,
    taxLines,
    total,
    totalError,
    paid,
    paidError,
    outstanding: total !== null && paid !== null ? subtract(total, paid) : null,
    acceptable: total !== null && paidError === undefined,
  };
}
