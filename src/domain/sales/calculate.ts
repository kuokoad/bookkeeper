import {
  add,
  allocate,
  atLeastZero,
  isZero,
  mulDiv,
  percentOf,
  subtract,
  sum,
  ZERO,
  type Minor,
} from '../money';
import { extendPrice, type Qty } from '../quantity';
import { ValidationError } from '../errors';

/**
 * Sale arithmetic — pure, and the only place a sale total is ever computed.
 *
 * The POS screen, the server action and the receipt all display figures that
 * came from here, so what the customer is quoted, what is charged and what is
 * posted to the ledger cannot disagree.
 */

export interface SaleLineInput {
  productId: number;
  qty: Qty;
  unitPrice: Minor;
  /** Discount on this line, in money (not a percentage). */
  discount?: Minor;
}

export interface CalculatedLine extends SaleLineInput {
  discount: Minor;
  /** qty x unitPrice, before the line discount. */
  gross: Minor;
  /** gross - discount. */
  lineTotal: Minor;
  /** This line's share of any invoice-level discount. */
  allocatedInvoiceDiscount: Minor;
  /** lineTotal - allocatedInvoiceDiscount. What this line actually earns. */
  netTotal: Minor;
}

export interface SaleTotalsInput {
  lines: readonly SaleLineInput[];
  /** Invoice-level discount applied after line discounts. */
  invoiceDiscount?: Minor;
  /** Tax rate in basis points (1250 = 12.5%). Zero when tax is off. */
  taxRateBp?: number;
  /** When true, the quoted prices already include tax. */
  taxInclusive?: boolean;
}

export interface SaleTotals {
  lines: CalculatedLine[];
  /** Sum of line totals after line discounts, before the invoice discount. */
  subtotal: Minor;
  invoiceDiscount: Minor;
  /** Total of line discounts plus the invoice discount. Shown on the receipt. */
  totalDiscount: Minor;
  /** Taxable base: subtotal - invoiceDiscount. */
  netBeforeTax: Minor;
  tax: Minor;
  /** What the customer must pay. */
  total: Minor;
}

/**
 * Compute every figure on a sale.
 *
 * The invoice-level discount is spread across lines with the largest-remainder
 * method, so the parts always add back to exactly the discount given — no
 * pesewa is created or lost — and each line's true margin stays knowable.
 */
export function calculateSale(input: SaleTotalsInput): SaleTotals {
  if (input.lines.length === 0) {
    throw new ValidationError('A sale must have at least one item.');
  }

  const withGross = input.lines.map((line) => {
    if (line.qty <= 0) {
      throw new ValidationError('Every item needs a quantity greater than zero.');
    }
    if (line.unitPrice < 0) {
      throw new ValidationError('A selling price cannot be negative.');
    }

    const gross = extendPrice(line.unitPrice, line.qty);
    const discount = line.discount ?? ZERO;

    if (discount < 0) {
      throw new ValidationError('A discount cannot be negative.');
    }
    if (discount > gross) {
      throw new ValidationError('A line discount cannot be more than the line total.', {
        gross,
        discount,
      });
    }

    return { ...line, discount, gross, lineTotal: subtract(gross, discount) };
  });

  const subtotal = sum(withGross.map((line) => line.lineTotal));
  const invoiceDiscount = input.invoiceDiscount ?? ZERO;

  if (invoiceDiscount < 0) {
    throw new ValidationError('A discount cannot be negative.');
  }
  if (invoiceDiscount > subtotal) {
    throw new ValidationError('The discount cannot be more than the sale total.', {
      subtotal,
      invoiceDiscount,
    });
  }

  // Spread the invoice discount across lines in proportion to their value.
  const allocated = isZero(invoiceDiscount)
    ? withGross.map(() => ZERO)
    : allocate(
        invoiceDiscount,
        withGross.map((line) => line.lineTotal),
      );

  const lines: CalculatedLine[] = withGross.map((line, index) => {
    const allocatedInvoiceDiscount = allocated[index] ?? ZERO;
    return {
      ...line,
      allocatedInvoiceDiscount,
      netTotal: subtract(line.lineTotal, allocatedInvoiceDiscount),
    };
  });

  const netBeforeTax = subtract(subtotal, invoiceDiscount);
  const taxRateBp = input.taxRateBp ?? 0;

  if (taxRateBp < 0) {
    throw new ValidationError('A tax rate cannot be negative.');
  }

  let tax: Minor;
  let total: Minor;

  if (taxRateBp === 0) {
    tax = ZERO;
    total = netBeforeTax;
  } else if (input.taxInclusive) {
    // Prices already include tax: extract the tax portion out of the total.
    // tax = net x rate / (10000 + rate)
    tax = percentOfInclusive(netBeforeTax, taxRateBp);
    total = netBeforeTax;
  } else {
    tax = percentOf(netBeforeTax, taxRateBp);
    total = add(netBeforeTax, tax);
  }

  return {
    lines,
    subtotal,
    invoiceDiscount,
    totalDiscount: add(sum(lines.map((line) => line.discount)), invoiceDiscount),
    netBeforeTax,
    tax,
    total,
  };
}

/**
 * Tax already contained within a tax-inclusive amount.
 * tax = gross x rate / (10000 + rate)
 */
function percentOfInclusive(amountIncludingTax: Minor, taxRateBp: number): Minor {
  return mulDiv(amountIncludingTax, taxRateBp, 10_000 + taxRateBp);
}

// --- tender ---------------------------------------------------------------

export interface TenderLine {
  paymentAccountId: number;
  amount: Minor;
}

export interface TenderResult {
  /** Total tendered across all methods. */
  tendered: Minor;
  /** Amount actually applied to the sale (never more than the total). */
  applied: Minor;
  /** Cash to hand back. Only ever non-zero when cash was over-tendered. */
  change: Minor;
  /** Still owed after this tender. Becomes a receivable. */
  outstanding: Minor;
}

/**
 * Work out change and the outstanding balance.
 *
 * Over-tendering is normal at a till — a customer hands over GHS 50 for a
 * GHS 47 basket. The excess becomes change, NOT extra revenue and NOT a credit
 * balance, so the ledger only ever records what was actually earned.
 */
export function calculateTender(
  total: Minor,
  tenders: readonly TenderLine[],
  options: { allowChange?: boolean } = {},
): TenderResult {
  for (const tender of tenders) {
    if (tender.amount < 0) {
      throw new ValidationError('A payment amount cannot be negative.');
    }
  }

  const tendered = sum(tenders.map((tender) => tender.amount));

  if (tendered <= total) {
    return {
      tendered,
      applied: tendered,
      change: ZERO,
      outstanding: subtract(total, tendered),
    };
  }

  const change = subtract(tendered, total);
  if (options.allowChange === false) {
    throw new ValidationError(
      'The amount paid is more than the sale total. Reduce it, or allow change to be given.',
      { total, tendered },
    );
  }

  return { tendered, applied: total, change, outstanding: ZERO };
}

/** Gross profit on a sale: what it earned less what the goods cost. */
export function grossProfit(netRevenue: Minor, cogs: Minor): Minor {
  return subtract(netRevenue, cogs);
}

/**
 * Margin in basis points, for display. Returns null when there is no revenue to
 * divide by, rather than a misleading zero.
 */
export function marginBp(netRevenue: Minor, cogs: Minor): number | null {
  if (netRevenue === 0) return null;
  const profit = grossProfit(netRevenue, cogs);
  return Math.round((profit / netRevenue) * 10_000);
}

/** Remaining credit headroom, or null when no limit is set. */
export function creditHeadroom(
  creditLimit: Minor | null,
  currentBalance: Minor,
): Minor | null {
  if (creditLimit === null) return null;
  return atLeastZero(subtract(creditLimit, currentBalance));
}

export function exceedsCreditLimit(
  creditLimit: Minor | null,
  currentBalance: Minor,
  additionalCredit: Minor,
): boolean {
  if (creditLimit === null) return false;
  return add(currentBalance, additionalCredit) > creditLimit;
}
