import { minor, subtract, sum, type Minor } from '../money';

/**
 * The totals as a customer should read them.
 *
 * A sale is STORED net of tax, so that `subtotal − discount + tax = total`
 * holds for every sale however the shop prices its shelves. That is the right
 * shape for the ledger and the wrong shape for a receipt when prices include
 * tax: the stored subtotal would read GHS 100.00 directly underneath a line
 * saying "1 × 112.50", and a customer holding the paper would be right to think
 * the shop could not add up.
 *
 * So the document is presented the way the sale was actually transacted. Under
 * inclusive pricing the printed subtotal is the sum of the lines as printed,
 * the discount is the amount the customer was actually told, and the tax is
 * shown as contained within the total rather than added to it.
 *
 * Both figures are recovered by subtraction from amounts that are already
 * exact, never by re-applying a tax rate. Re-deriving would round a second time
 * and could leave the printed column out by a pesewa — which on a receipt is
 * indistinguishable from being cheated.
 */
export interface SaleDocumentTotals {
  /** Adds up the item lines exactly as they are printed. */
  subtotal: Minor;
  /** What was taken off, in the same money the customer was quoted. */
  discount: Minor;
  tax: Minor;
  total: Minor;
  /**
   * True when the tax sits inside the total. The document should then say
   * "includes VAT", not list it as another line to be added on.
   */
  taxWithinTotal: boolean;
}

export function saleDocumentTotals(
  sale: {
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    totalMinor: number;
    taxInclusive: boolean;
  },
  lineTotals: readonly number[],
): SaleDocumentTotals {
  const tax = minor(sale.taxMinor);
  const total = minor(sale.totalMinor);

  if (!sale.taxInclusive) {
    return {
      subtotal: minor(sale.subtotalMinor),
      discount: minor(sale.discountMinor),
      tax,
      total,
      taxWithinTotal: false,
    };
  }

  // Line totals already have their own line discounts taken off, and under
  // inclusive pricing they are the prices the customer saw. Whatever is left
  // between them and the total is the invoice-level discount, to the pesewa.
  const printedSubtotal = sum(lineTotals.map(minor));

  return {
    subtotal: printedSubtotal,
    discount: subtract(printedSubtotal, total),
    tax,
    total,
    taxWithinTotal: true,
  };
}
