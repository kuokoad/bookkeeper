import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

import { writeTransaction } from '@/db/transaction';
import type { Db, Tx } from '@/db/types';
import { customers, products, quotationItems, quotations } from '@/db/schema';
import { calculateSale } from '@/domain/sales/calculate';
import { toBusinessDate } from '@/lib/format';
import { minor, type Minor } from '@/domain/money';
import type { Qty } from '@/domain/quantity';
import { NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import type { Actor } from './journal.service';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';
import { getTaxProfile } from './tax.service';
import { createSale } from './sale.service';

/**
 * Quotations: offering a price, and later honouring it.
 *
 * Nothing in this file posts to the journal or moves stock. A quote is a
 * proposal, so creating, editing, printing and cancelling one leave the books
 * exactly as they were — `tests/services/quotation-moves-nothing.test.ts` holds
 * that true rather than trusting it.
 *
 * The books are touched in exactly one place, `convertQuotation`, and even there
 * this file does not touch them itself: it calls `createSale`, so a converted
 * quote produces an ordinary sale that every report, every balance and every
 * stock movement already understands. There is no second way to sell something.
 *
 * Every figure comes from `calculateSale`, the same pure function the till uses.
 * That is what makes a quote's total equal the total of the sale it becomes, by
 * construction rather than by coincidence.
 */

export interface QuotationLineRequest {
  productId: number;
  qty: Qty;
  /** What is being offered. Defaults to the product's list price. */
  unitPrice?: Minor;
  discount?: Minor;
}

export interface CreateQuotationInput {
  businessDate?: string;
  /** The day the price stops being promised. Required; see the schema. */
  validUntil: string;
  customerName: string;
  customerId?: number | null;
  customerPhone?: string | null;
  /** The job: "Adenta site", "Block C roofing". */
  reference?: string | null;
  lines: QuotationLineRequest[];
  quoteDiscount?: Minor;
  notes?: string | null;
}

export interface CreatedQuotation {
  quotationId: number;
  quoteNo: string;
  total: Minor;
}

export interface QuotationItemRow {
  id: number;
  lineNo: number;
  productId: number;
  productName: string;
  unit: string;
  qtyMilli: number;
  unitPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
}

export type QuotationDetail = typeof quotations.$inferSelect & {
  items: QuotationItemRow[];
};

// --- shared helpers --------------------------------------------------------

/**
 * Resolve the lines and compute every figure, exactly as the till does.
 *
 * Shared by create and update so an edited quote cannot be totalled by a
 * different route from the one that first priced it.
 */
function priceLines(tx: Tx, input: CreateQuotationInput) {
  if (input.lines.length === 0) {
    throw new ValidationError('Add at least one item to the quote.');
  }

  const resolved = input.lines.map((line) => {
    const product = tx.select().from(products).where(eq(products.id, line.productId)).get();
    if (!product) throw new NotFoundError('Product', line.productId);
    if (!product.isActive) {
      throw new ValidationError(`"${product.name}" is archived and cannot be quoted.`);
    }
    return { request: line, product, unitPrice: line.unitPrice ?? minor(product.sellingPriceMinor) };
  });

  // Read once, inside the transaction, so a rate changed mid-edit cannot apply
  // to half the quote. Same reasoning as `createSale`.
  const taxProfile = getTaxProfile(tx);

  const totals = calculateSale({
    lines: resolved.map((entry) => ({
      productId: entry.product.id,
      qty: entry.request.qty,
      unitPrice: entry.unitPrice,
      ...(entry.request.discount !== undefined ? { discount: entry.request.discount } : {}),
    })),
    ...(input.quoteDiscount !== undefined ? { invoiceDiscount: input.quoteDiscount } : {}),
    taxComponents: taxProfile.components,
    taxInclusive: taxProfile.inclusive,
  });

  return { resolved, totals, taxInclusive: taxProfile.inclusive };
}

function assertDates(businessDate: string, validUntil: string): void {
  if (validUntil < businessDate) {
    throw new ValidationError(
      'A quote cannot expire before the day it is issued.',
      { businessDate, validUntil },
    );
  }
}

function writeItems(
  tx: Tx,
  quotationId: number,
  priced: ReturnType<typeof priceLines>,
  now: Date,
): void {
  priced.resolved.forEach((entry, index) => {
    const line = priced.totals.lines[index]!;
    tx.insert(quotationItems)
      .values({
        quotationId,
        lineNo: index + 1,
        productId: entry.product.id,
        // Snapshotted, so a reprint shows what was offered even after a rename.
        productName: entry.product.name,
        unit: entry.product.unit,
        qtyMilli: entry.request.qty,
        unitPriceMinor: entry.unitPrice,
        discountMinor: entry.request.discount ?? 0,
        lineTotalMinor: line.lineTotal,
        createdAt: now,
      })
      .run();
  });
}

// --- create ----------------------------------------------------------------

export function createQuotation(
  db: Db,
  input: CreateQuotationInput,
  actor: Actor,
): CreatedQuotation {
  const name = input.customerName.trim();
  if (name === '') throw new ValidationError('Say who the quote is for.');

  return writeTransaction(db, (tx) => {
    const businessDate = input.businessDate ?? toBusinessDate();
    assertDates(businessDate, input.validUntil);

    const priced = priceLines(tx, input);
    const now = new Date();
    const quoteNo = nextDocumentNumber(tx, DOC_TYPES.QUOTE);

    const inserted = tx
      .insert(quotations)
      .values({
        quoteNo,
        businessDate,
        validUntil: input.validUntil,
        customerName: name,
        customerId: input.customerId ?? null,
        customerPhone: input.customerPhone ?? null,
        reference: input.reference ?? null,
        subtotalMinor: priced.totals.subtotalExTax,
        discountMinor: priced.totals.invoiceDiscountExTax,
        quoteDiscountMinor: input.quoteDiscount ?? 0,
        taxMinor: priced.totals.tax,
        totalMinor: priced.totals.total,
        taxInclusive: priced.taxInclusive,
        status: 'OPEN',
        notes: input.notes ?? null,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: quotations.id })
      .get();

    writeItems(tx, inserted.id, priced, now);

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'quotations',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: `Quote ${quoteNo} for ${name}, valid to ${input.validUntil}`,
      at: now,
    });

    return { quotationId: inserted.id, quoteNo, total: priced.totals.total };
  });
}

// --- edit ------------------------------------------------------------------

/**
 * Replace an open quote's contents.
 *
 * Editing in place, which nothing else in this application permits. A sale is
 * corrected by posting its reversal because it is history; a quote is an offer
 * that has not been accepted, so there is no history to protect. Once it
 * converts it stops being an offer, and this refuses.
 */
export function updateQuotation(
  db: Db,
  quotationId: number,
  input: CreateQuotationInput,
  actor: Actor,
): void {
  const name = input.customerName.trim();
  if (name === '') throw new ValidationError('Say who the quote is for.');

  writeTransaction(db, (tx) => {
    const existing = tx.select().from(quotations).where(eq(quotations.id, quotationId)).get();
    if (!existing) throw new NotFoundError('Quotation', quotationId);
    if (existing.status !== 'OPEN') {
      throw new ValidationError(
        existing.status === 'CONVERTED'
          ? `Quote ${existing.quoteNo} has already become a sale and can no longer be changed.`
          : `Quote ${existing.quoteNo} was cancelled and can no longer be changed.`,
      );
    }

    const businessDate = input.businessDate ?? existing.businessDate;
    assertDates(businessDate, input.validUntil);

    const priced = priceLines(tx, input);
    const now = new Date();

    tx.delete(quotationItems).where(eq(quotationItems.quotationId, quotationId)).run();

    tx.update(quotations)
      .set({
        businessDate,
        validUntil: input.validUntil,
        customerName: name,
        customerId: input.customerId ?? null,
        customerPhone: input.customerPhone ?? null,
        reference: input.reference ?? null,
        subtotalMinor: priced.totals.subtotalExTax,
        discountMinor: priced.totals.invoiceDiscountExTax,
        quoteDiscountMinor: input.quoteDiscount ?? 0,
        taxMinor: priced.totals.tax,
        totalMinor: priced.totals.total,
        taxInclusive: priced.taxInclusive,
        notes: input.notes ?? null,
        updatedAt: now,
      })
      .where(eq(quotations.id, quotationId))
      .run();

    writeItems(tx, quotationId, priced, now);

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'quotations',
      entityId: quotationId,
      userId: actor.id,
      username: actor.username,
      summary: `Quote ${existing.quoteNo} changed`,
      at: now,
    });
  });
}

// --- cancel ----------------------------------------------------------------

export function cancelQuotation(
  db: Db,
  quotationId: number,
  reason: string,
  actor: Actor,
): void {
  const trimmed = reason.trim();
  if (trimmed === '') throw new ValidationError('Say why the quote is being cancelled.');

  writeTransaction(db, (tx) => {
    const existing = tx.select().from(quotations).where(eq(quotations.id, quotationId)).get();
    if (!existing) throw new NotFoundError('Quotation', quotationId);
    if (existing.status !== 'OPEN') {
      throw new ValidationError(`Quote ${existing.quoteNo} is not open.`);
    }

    const now = new Date();
    tx.update(quotations)
      .set({ status: 'CANCELLED', cancelledAt: now, cancelReason: trimmed, updatedAt: now })
      .where(eq(quotations.id, quotationId))
      .run();

    writeAudit(tx, {
      action: 'ARCHIVE',
      entityType: 'quotations',
      entityId: quotationId,
      userId: actor.id,
      username: actor.username,
      summary: `Quote ${existing.quoteNo} cancelled: ${trimmed}`,
      at: now,
    });
  });
}

// --- read ------------------------------------------------------------------

export function getQuotation(db: Db | Tx, quotationId: number): QuotationDetail {
  const quote = db.select().from(quotations).where(eq(quotations.id, quotationId)).get();
  if (!quote) throw new NotFoundError('Quotation', quotationId);

  const items = db
    .select()
    .from(quotationItems)
    .where(eq(quotationItems.quotationId, quotationId))
    .orderBy(asc(quotationItems.lineNo))
    .all();

  return { ...quote, items };
}

export interface QuotationFilters {
  status?: 'OPEN' | 'CONVERTED' | 'CANCELLED';
  /** Open quotes whose validity has passed. A view, not a stored status. */
  expired?: boolean;
  from?: string;
  to?: string;
  customerId?: number;
  search?: string;
  sort?: 'date' | 'total' | 'validUntil';
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/**
 * ONE conditions builder, shared by the list and the count.
 *
 * Required by the filtering rules in CLAUDE.md: rows and totals that build their
 * clauses separately is how a screen ends up showing filtered rows under an
 * unfiltered count.
 */
function quotationConditions(filters: QuotationFilters, asAt: string): SQL[] {
  const conditions: SQL[] = [];

  if (filters.status !== undefined) conditions.push(eq(quotations.status, filters.status));
  if (filters.expired === true) {
    conditions.push(eq(quotations.status, 'OPEN'));
    conditions.push(lte(quotations.validUntil, asAt));
  }
  if (filters.from !== undefined) conditions.push(gte(quotations.businessDate, filters.from));
  if (filters.to !== undefined) conditions.push(lte(quotations.businessDate, filters.to));
  if (filters.customerId !== undefined) {
    conditions.push(eq(quotations.customerId, filters.customerId));
  }
  if (filters.search !== undefined && filters.search.trim() !== '') {
    const term = `%${filters.search.trim().toLowerCase()}%`;
    conditions.push(
      sql`(lower(${quotations.quoteNo}) LIKE ${term}
        OR lower(${quotations.customerName}) LIKE ${term}
        OR lower(COALESCE(${quotations.reference}, '')) LIKE ${term})`,
    );
  }

  return conditions;
}

const SORT_COLUMNS = {
  date: quotations.businessDate,
  total: quotations.totalMinor,
  validUntil: quotations.validUntil,
} as const;

export function listQuotations(
  db: Db,
  filters: QuotationFilters = {},
  asAt: string = toBusinessDate(),
) {
  const conditions = quotationConditions(filters, asAt);
  // A sort key reaches an ORDER BY, so it can never be a string off the wire.
  const column = SORT_COLUMNS[filters.sort ?? 'date'];
  const order = filters.direction === 'asc' ? asc(column) : desc(column);

  let query = db
    .select()
    .from(quotations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(order, desc(quotations.id))
    .$dynamic();

  if (filters.limit !== undefined) query = query.limit(filters.limit);
  if (filters.offset !== undefined) query = query.offset(filters.offset);

  return query.all();
}

export function countQuotations(
  db: Db,
  filters: QuotationFilters = {},
  asAt: string = toBusinessDate(),
): number {
  const conditions = quotationConditions(filters, asAt);
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(quotations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .get();
  return row?.count ?? 0;
}

// --- convert ---------------------------------------------------------------

export interface ConvertQuotationInput {
  businessDate?: string;
  /** Bill an existing customer. Ignored when `createCustomer` is set. */
  customerId?: number | null;
  /** Create a customer from the quote's typed name and bill them. */
  createCustomer?: boolean;
  tenders: { paymentAccountId: number; amount: Minor; reference?: string | undefined }[];
  termsDays?: number;
  /** Required when the quote has passed its validity date. */
  overrideReason?: string;
}

export interface ConvertedQuotation {
  saleId: number;
  receiptNo: string;
  total: Minor;
}

/**
 * Turn an accepted quote into a sale, at the prices that were quoted.
 *
 * The one dangerous function in this file, for a reason worth spelling out.
 * `createSale` gates a per-line price behind `allowPriceOverride`, and its own
 * comment explains why: selling below list leaves the books in perfect order, so
 * no balance check anywhere will ever notice. Honouring a quoted price IS such
 * an override by that definition, so this passes the flag deliberately. The
 * justification is that the owner already approved these prices when the quote
 * was issued, and holding `quotations:create` is what let them.
 *
 * Two things keep that from being a hole. Conversion needs the quotations
 * permission, so it is not a route for somebody without `sales:edit` to sell at
 * a price they chose. And an expired quote is refused unless it is overridden
 * with a reason, which is what stops a price from March being honoured in
 * August against stock that has since cost more to replace.
 *
 * One transaction throughout. If `createSale` throws for any reason — no stock,
 * over the credit limit, the books locked — nothing is written and the quote is
 * still open.
 */
export function convertQuotation(
  db: Db,
  quotationId: number,
  input: ConvertQuotationInput,
  actor: Actor,
): ConvertedQuotation {
  return writeTransaction(db, (tx) => {
    const quote = getQuotation(tx, quotationId);

    if (quote.status === 'CONVERTED') {
      throw new ValidationError(
        `Quote ${quote.quoteNo} has already become a sale. Open that sale rather than converting again.`,
      );
    }
    if (quote.status === 'CANCELLED') {
      throw new ValidationError(`Quote ${quote.quoteNo} was cancelled and cannot be converted.`);
    }

    const businessDate = input.businessDate ?? toBusinessDate();
    const override = input.overrideReason?.trim() ?? '';

    if (quote.validUntil < businessDate && override === '') {
      throw new ValidationError(
        `Quote ${quote.quoteNo} was only valid to ${quote.validUntil}. ` +
          'Prices may have moved since. Say why it is still being honoured, or issue a new quote.',
        { validUntil: quote.validUntil, asAt: businessDate },
      );
    }

    // --- who is being billed --------------------------------------------
    let customerId = input.customerId ?? quote.customerId ?? null;

    if (input.createCustomer === true && customerId === null) {
      const now = new Date();
      customerId = tx
        .insert(customers)
        .values({
          name: quote.customerName,
          phone: quote.customerPhone,
          createdBy: actor.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: customers.id })
        .get().id;
    }

    const sale = createSale(
      tx as unknown as Db,
      {
        businessDate,
        customerId,
        items: quote.items.map((item) => ({
          productId: item.productId,
          qty: item.qtyMilli as Qty,
          unitPrice: item.unitPriceMinor as Minor,
          discount: item.discountMinor as Minor,
        })),
        // The discount as it was typed, not the net figure stored beside it.
        // See `quotations.quoteDiscountMinor`.
        ...(quote.quoteDiscountMinor !== 0
          ? { invoiceDiscount: quote.quoteDiscountMinor as Minor }
          : {}),
        tenders: input.tenders,
        ...(input.termsDays !== undefined ? { termsDays: input.termsDays } : {}),
        note: `From quote ${quote.quoteNo}`,
        // See the note above. The prices came from a quote the owner issued.
        allowPriceOverride: true,
      },
      actor,
    );

    const now = new Date();
    tx.update(quotations)
      .set({
        status: 'CONVERTED',
        convertedSaleId: sale.saleId,
        convertedAt: now,
        ...(customerId !== null ? { customerId } : {}),
        ...(override !== '' ? { overrideReason: override } : {}),
        updatedAt: now,
      })
      .where(eq(quotations.id, quotationId))
      .run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'quotations',
      entityId: quotationId,
      userId: actor.id,
      username: actor.username,
      summary:
        `Quote ${quote.quoteNo} converted to sale ${sale.receiptNo}` +
        (override !== '' ? ` (expired ${quote.validUntil}, honoured: ${override})` : ''),
      at: now,
    });

    return { saleId: sale.saleId, receiptNo: sale.receiptNo, total: sale.total };
  });
}

/** Whether a quote's promise has run out, as at a given day. */
export function isExpired(quote: { status: string; validUntil: string }, asAt: string): boolean {
  return quote.status === 'OPEN' && quote.validUntil < asAt;
}

