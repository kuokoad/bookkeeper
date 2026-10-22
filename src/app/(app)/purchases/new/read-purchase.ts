import { assertPeriodOpen } from '@/domain/accounting/period-lock';
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
import { isValidBusinessDate } from '@/lib/format';
import { INVOICE_NO_MAX, PAYMENT_REFERENCE_MAX } from '@/lib/purchase-limits';

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
 * unit checks `resolveLineUnit` makes, the tax `createPurchase` adds, the books
 * lock `postJournalEntry` enforces), every refusal the server would make on
 * the figures and the date is named against the field it belongs to, and a
 * figure is shown only when Save would store exactly that figure. Anything
 * else is a dash. `tests/app/purchase-form-parity.test.ts` runs the same
 * entries through this and `createPurchase` to hold the two together.
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
  /** The line comes to 0.00: free goods, by a zero cost or a discount of the whole line. */
  free: boolean;
}

export interface PurchaseReading {
  lines: LineReading[];
  /** Lines Save would send. */
  filled: number;
  /** Why the delivery date would be refused: missing, or inside the books lock. */
  dateError: string | undefined;
  /** The free-text boxes the action limits in length. */
  invoiceNoError: string | undefined;
  referenceError: string | undefined;
  /**
   * Null while any line cannot be saved, since the readable lines alone are not
   * this purchase, and while there are no lines at all: an empty form is not a
   * purchase of 0.00.
   */
  subtotal: Minor | null;
  invoiceDiscountError: string | undefined;
  taxLines: TaxLine[];
  total: Minor | null;
  /** Why there is no total when no one box is to blame: 0.00, an overflow, an unusable rate. */
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

/**
 * An amount box. Empty is zero unless the box is `required`, in which case it
 * is refused with that message: zero is a real cost, an empty cost box is not.
 */
function readAmount(
  text: string,
  negative: string,
  required?: string,
): { amount?: Minor; error?: string } {
  if (text.trim() === '') return required ? { error: required } : { amount: ZERO };
  try {
    const amount = parseMoney(text);
    return amount < 0 ? { error: negative } : { amount };
  } catch (error) {
    return { error: refusal(error, 'That amount cannot be read.') };
  }
}

export function readLine(entry: LineEntry, product: LineProduct | undefined): LineReading {
  const blank =
    entry.productId === '' &&
    entry.qty.trim() === '' &&
    entry.unitCost.trim() === '' &&
    entry.discount.trim() === '';
  if (blank) return { blank, errors: {}, total: null, free: false };

  const errors: LineReading['errors'] = {};
  if (!product) errors.product = 'Choose a product.';

  const qty = readQty(entry, product);
  if (qty.error) errors.qty = qty.error;
  const cost = readAmount(entry.unitCost, 'A unit cost cannot be negative.', 'Enter what each one cost.');
  if (cost.error) errors.cost = cost.error;
  const discount = readAmount(entry.discount, 'A discount cannot be negative.');
  if (discount.error) errors.discount = discount.error;

  let total: Minor | null = null;
  if (qty.qty !== undefined && cost.amount !== undefined && discount.amount !== undefined) {
    try {
      const gross = extendPrice(cost.amount, qty.qty);
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
    free: !refused && total === 0,
  };
}

/**
 * A free-text box the action refuses past `max` characters, trimmed as it trims.
 *
 * Said rather than enforced with `maxLength`, which cuts a pasted invoice
 * number short without a word and stores something that no longer matches
 * the paper.
 */
function readLength(text: string, max: number): string | undefined {
  return text.trim().length > max ? `Keep this to ${max} characters.` : undefined;
}

/** The delivery date as `postJournalEntry` will judge it. */
function readDate(businessDate: string, lockedBefore: string | null): string | undefined {
  if (!isValidBusinessDate(businessDate)) return 'Enter the delivery date.';
  try {
    assertPeriodOpen(businessDate, lockedBefore);
    return undefined;
  } catch (error) {
    return refusal(error, 'The books are closed for that date.');
  }
}

export function readPurchase(input: {
  rows: readonly LineEntry[];
  products: readonly LineProduct[];
  invoiceDiscount: string;
  payAmount: string;
  /** False when there is no account a payment could come out of. */
  canPay: boolean;
  taxComponents: readonly TaxComponent[];
  businessDate: string;
  /** The books lock: nothing dated on or before it can be posted. */
  lockedBefore: string | null;
  invoiceNo: string;
  reference: string;
}): PurchaseReading {
  // One lookup table per reading, not a scan of the catalogue for every line.
  const byId = new Map(input.products.map((product) => [String(product.id), product]));
  const lines = input.rows.map((row) => readLine(row, byId.get(row.productId)));
  const sent = lines.filter((line) => !line.blank);

  // A refusal that belongs to no one box, said under the total it stops.
  let totalError: string | undefined;

  let subtotal: Minor | null = null;
  if (sent.length > 0 && sent.every((line) => line.total !== null)) {
    try {
      subtotal = sum(sent.map((line) => line.total as Minor));
    } catch (error) {
      totalError = refusal(error, 'These lines are too large to add up.');
    }
  }

  const discount = readAmount(input.invoiceDiscount, 'A discount cannot be negative.');
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

  /**
   * A purchase worth nothing posts no journal lines, and `postJournalEntry`
   * refuses an entry with none. Free goods are real, but they have to come in
   * on a purchase that is worth something; until the server can record a
   * delivery of nothing but free goods, the screen says so before Save does.
   */
  if (total === 0) {
    total = null;
    taxLines = [];
    totalError =
      'A purchase that comes to 0.00 cannot be saved: free goods can only come in on a purchase that is worth something.';
  }

  const payment = readAmount(input.payAmount, 'A payment cannot be negative.');
  let paidError = payment.error;
  if (payment.amount !== undefined && payment.amount > 0 && !input.canPay) {
    paidError = 'Add a payment account before recording a payment.';
  } else if (payment.amount !== undefined && total !== null && payment.amount > total) {
    paidError = 'You cannot pay more than the purchase total.';
  }
  const paid = paidError === undefined ? (payment.amount ?? null) : null;
  const dateError = readDate(input.businessDate, input.lockedBefore);
  const invoiceNoError = readLength(input.invoiceNo, INVOICE_NO_MAX);
  // An empty amount sends no payment, and with it no reference to refuse.
  const referenceError =
    input.payAmount.trim() === '' ? undefined : readLength(input.reference, PAYMENT_REFERENCE_MAX);

  return {
    lines,
    filled: sent.length,
    dateError,
    invoiceNoError,
    referenceError,
    subtotal,
    invoiceDiscountError,
    taxLines,
    total,
    totalError,
    paid,
    paidError,
    outstanding: total !== null && paid !== null ? subtract(total, paid) : null,
    acceptable:
      total !== null &&
      paidError === undefined &&
      dateError === undefined &&
      invoiceNoError === undefined &&
      referenceError === undefined,
  };
}
