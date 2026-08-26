import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db, Tx } from '@/db/types';
import {
  accounts,
  businessSettings,
  customerPaymentAllocations,
  customerPayments,
  customers,
  paymentAccounts,
  products,
  saleItems,
  salePayments,
  sales,
  users,
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { dueDateFor } from '@/domain/business-date';
import { credit, debit, type DraftLine } from '@/domain/accounting/journal';
import { calculateSale, calculateTender, exceedsCreditLimit } from '@/domain/sales/calculate';
import { formatMoney, isZero, minor, subtract, sum, ZERO, type Minor } from '@/domain/money';
import { qty as makeQty, type Qty } from '@/domain/quantity';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import { postJournalEntry, reverseJournalEntry, type Actor } from './journal.service';
import { readBatchSplits, recordStockMovement } from './inventory.service';
import type { Allocation } from '@/domain/inventory/batches';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';
import { getCustomerBalance } from './customer.service';
import {
  getTaxProfile,
  readSaleTaxes,
  taxAccountFor,
  writeSaleTaxes,
} from './tax.service';

/**
 * Completing a sale — the most important transaction in the application.
 *
 * ONE database transaction does all of this, or none of it:
 *   1. validate items, stock and credit limit
 *   2. write the sale and its lines, snapshotting price AND cost basis
 *   3. remove stock, capturing exact COGS from the weighted-average engine
 *   4. record the tender (split payments supported)
 *   5. post ONE balanced journal entry
 *   6. write the audit record
 *
 * If step 5 fails to balance, the stock movement in step 3 disappears with it.
 * There is no state in which stock left the shelf without the books recording it.
 */

export interface SaleLineRequest {
  productId: number;
  qty: Qty;
  /**
   * Departs from the product's list price when the shop negotiates. Permitted
   * only when the caller sets `allowPriceOverride` — see below.
   */
  unitPrice?: Minor;
  /** Money off this line. Also gated by `allowPriceOverride`. */
  discount?: Minor;
}

export interface TenderRequest {
  paymentAccountId: number;
  amount: Minor;
  reference?: string | undefined;
}

export interface CreateSaleInput {
  businessDate: string;
  customerId?: number | null;
  /** Days to pay. Defaults to the shop setting. Only used for a credit sale. */
  termsDays?: number;
  items: SaleLineRequest[];
  invoiceDiscount?: Minor;
  tenders: TenderRequest[];
  note?: string | undefined;
  occurredAt?: Date;
  isDemo?: boolean;
  /**
   * The till's own name for this cart, making the sale safe to submit twice.
   *
   * Send the SAME value if a request is retried and exactly one sale results:
   * the second call returns the first one's figures rather than ringing the
   * goods up again. Omit it and every call creates a new sale, which is what
   * seeds, imports and tests want.
   *
   * See `sales.clientRef` for why nothing else can catch this duplicate.
   */
  clientRef?: string | undefined;
  /**
   * Whether this sale may depart from the shop's own prices.
   *
   * DEFAULTS TO FALSE, and deliberately so. Selling below list is how stock
   * leaves a shop cheaply, and it leaves the books in perfect order — the sale
   * genuinely happened at the price charged, so no balance check anywhere will
   * ever notice. Nothing else in this file can catch it either, which is why
   * the decision is made here rather than trusted to each caller.
   *
   * A price and a discount are the same lever: list price with the line
   * discounted in full comes to the same nothing. Both are gated together, or
   * gating either is theatre.
   *
   * Set from the caller's `sales:edit` permission. Owners always hold it.
   */
  allowPriceOverride?: boolean;
  /**
   * Whether this sale may reach into stock that has passed its date.
   *
   * DEFAULTS TO FALSE, for the same reason as the price gate above: the
   * decision is made here, once, rather than trusted to each caller. Selling
   * expired goods leaves the books in perfect order — the sale happened, the
   * money came in, and no balance check anywhere will ever notice.
   *
   * Note what this flag is NOT. It is not "prefer expired stock", and it does
   * not change which batch an ordinary sale draws from. Expired stock is
   * skipped in silence whenever good stock covers the quantity, whoever is at
   * the till. This only decides what happens when there is nothing else left:
   * refuse the sale, or let this person take it and record that they did.
   *
   * Set from the caller's `inventory:void` permission — the right to write
   * stock off. Selling goods that are past their date and writing them off are
   * the same level of trust over the same goods. Owners always hold it.
   */
  allowExpiredStock?: boolean;
  /** What the person approving it said, if anything. Recorded in the audit. */
  overrideReason?: string | undefined;
}

export interface CreatedSale {
  saleId: number;
  receiptNo: string;
  total: Minor;
  cogs: Minor;
  change: Minor;
  outstanding: Minor;
  journalEntryId: number;
}

/**
 * The answer to a sale that was already recorded.
 *
 * Everything comes from the stored document rather than being recomputed, with
 * one exception: change. It is not a fact of the sale — the shop kept nothing
 * and owes nothing for it — so it is not a column, and the honest way to report
 * it on a replay is from the same tender the caller has just sent us.
 */
function replayOf(
  tx: Tx,
  existing: typeof sales.$inferSelect,
  input: CreateSaleInput,
): CreatedSale {
  const total = minor(existing.totalMinor);
  const tendered = tx
    .select({ total: sql<number>`COALESCE(SUM(${salePayments.amountMinor}), 0)` })
    .from(salePayments)
    .where(eq(salePayments.saleId, existing.id))
    .get();

  const outstanding =
    existing.status === 'VOIDED' ? ZERO : subtract(total, minor(tendered?.total ?? 0));

  return {
    saleId: existing.id,
    receiptNo: existing.receiptNo,
    total,
    cogs: minor(existing.cogsMinor),
    change: calculateTender(total, input.tenders).change,
    outstanding,
    journalEntryId: existing.journalEntryId ?? 0,
  };
}

function accountIdByCode(tx: Tx, code: string): number {
  const account = tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code)).get();
  if (!account) throw new NotFoundError('Account', code);
  return account.id;
}

export function createSale(db: Db, input: CreateSaleInput, actor: Actor): CreatedSale {
  if (input.items.length === 0) {
    throw new ValidationError('Add at least one item to the sale.');
  }

  return writeTransaction(db, (tx) => {
    const occurredAt = input.occurredAt ?? new Date();

    // --- has this cart already been rung up? ------------------------------
    //
    // Checked before anything is read or written, so a retry costs one indexed
    // lookup and changes nothing. The unique index on the column is the actual
    // guarantee; this is what turns the second submission into a helpful answer
    // instead of a constraint error the cashier cannot act on.
    if (input.clientRef !== undefined) {
      const existing = tx.select().from(sales).where(eq(sales.clientRef, input.clientRef)).get();
      if (existing) {
        return replayOf(tx, existing, input);
      }
    }

    const settings = tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
    if (!settings) throw new NotFoundError('Business settings', 1);

    // --- resolve products and prices -------------------------------------
    const resolved = input.items.map((item) => {
      const product = tx.select().from(products).where(eq(products.id, item.productId)).get();
      if (!product) throw new NotFoundError('Product', item.productId);
      if (!product.isActive) {
        throw new ValidationError(`"${product.name}" is archived and cannot be sold.`);
      }
      return {
        request: item,
        product,
        unitPrice: item.unitPrice ?? minor(product.sellingPriceMinor),
      };
    });

    // --- may this sale depart from the shop's prices? --------------------
    //
    // Checked against the price read from the database a moment ago, not
    // against anything the caller sent alongside it: the till posts a price
    // for every line, so "did they change it?" can only be answered here.
    if (input.allowPriceOverride !== true) {
      for (const [index, entry] of resolved.entries()) {
        const listPrice = minor(entry.product.sellingPriceMinor);

        if (entry.unitPrice !== listPrice) {
          throw new ForbiddenError(
            `change the price of "${entry.product.name}"`,
            `Only a supervisor can change a price. "${entry.product.name}" sells for ` +
              `${formatMoney(listPrice, settings.currencyCode)}. Sell it at that, or ask someone who can approve the change.`,
          );
        }

        const lineDiscount = entry.request.discount;
        if (lineDiscount !== undefined && !isZero(lineDiscount)) {
          throw new ForbiddenError(
            `discount line ${index + 1}`,
            'Only a supervisor can give a discount. Remove it, or ask someone who can approve it.',
          );
        }
      }

      if (input.invoiceDiscount !== undefined && !isZero(input.invoiceDiscount)) {
        throw new ForbiddenError(
          'discount the whole sale',
          'Only a supervisor can give a discount. Remove it, or ask someone who can approve it.',
        );
      }
    }

    // What the shop charges, and how. Read once inside the transaction so a
    // rate changed mid-sale cannot apply to half of it.
    const taxProfile = getTaxProfile(tx);

    // --- compute every figure in the pure domain -------------------------
    const totals = calculateSale({
      lines: resolved.map((entry) => ({
        productId: entry.product.id,
        qty: entry.request.qty,
        unitPrice: entry.unitPrice,
        ...(entry.request.discount !== undefined ? { discount: entry.request.discount } : {}),
      })),
      ...(input.invoiceDiscount !== undefined ? { invoiceDiscount: input.invoiceDiscount } : {}),
      taxComponents: taxProfile.components,
      taxInclusive: taxProfile.inclusive,
    });

    const tender = calculateTender(totals.total, input.tenders);

    // --- credit rules ----------------------------------------------------
    const customerId = input.customerId ?? null;

    if (!isZero(tender.outstanding) && customerId === null) {
      throw new ValidationError(
        'This sale is not fully paid. Choose a customer so the balance can be recorded against them.',
      );
    }

    if (customerId !== null) {
      const customer = tx.select().from(customers).where(eq(customers.id, customerId)).get();
      if (!customer) throw new NotFoundError('Customer', customerId);
      if (!customer.isActive) {
        throw new ValidationError(`"${customer.name}" is archived and cannot be given credit.`);
      }

      if (!isZero(tender.outstanding)) {
        const currentBalance = getCustomerBalance(tx, customerId);
        const limit = customer.creditLimitMinor === null ? null : minor(customer.creditLimitMinor);

        if (exceedsCreditLimit(limit, currentBalance, tender.outstanding)) {
          throw new ValidationError(
            `This would take ${customer.name} over their credit limit.`,
            { currentBalance, limit, additional: tender.outstanding },
          );
        }
      }
    }

    // --- write the sale --------------------------------------------------
    const receiptNo = nextDocumentNumber(tx, DOC_TYPES.RECEIPT);

    // A sale left unpaid becomes an invoice: something the customer takes away
    // and pays against, so it needs its own number and a date it falls due.
    // A sale settled at the counter gets neither — issuing invoice numbers for
    // those would leave gaps in the sequence that read as missing documents.
    const isCredit = !isZero(tender.outstanding) && customerId !== null;

    const termsDays = isCredit
      ? (input.termsDays ??
        tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get()
          ?.defaultTermsDays ??
        30)
      : null;

    // Snapshotted onto the sale, so changing the shop default later cannot move
    // the due date of an invoice already in a customer's hands.
    const dueDate = termsDays === null ? null : dueDateFor(input.businessDate, termsDays);
    const invoiceNo = isCredit ? nextDocumentNumber(tx, DOC_TYPES.INVOICE) : null;

    const sale = tx
      .insert(sales)
      .values({
        receiptNo,
        invoiceNo,
        termsDays,
        dueDate,
        businessDate: input.businessDate,
        occurredAt,
        customerId,
        // Stored net of tax, whichever way the shop prices its shelves, so that
        // `subtotal - discount + tax = total` always holds. Under inclusive
        // pricing the line items above still carry the prices the customer saw.
        subtotalMinor: totals.subtotalExTax,
        discountMinor: totals.invoiceDiscountExTax,
        taxMinor: totals.tax,
        totalMinor: totals.total,
        // Snapshotted so a receipt reprinted after the shop changes its pricing
        // setting still describes the sale that actually happened.
        taxInclusive: settings.taxInclusive,
        cogsMinor: 0,
        status: 'POSTED',
        clientRef: input.clientRef ?? null,
        note: input.note ?? null,
        createdBy: actor.id,
        isDemo: input.isDemo ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: sales.id })
      .get();

    if (!sale) throw new ConflictError('Could not create the sale.');

    // What each tax charged, snapshotted onto the document. `sales.taxMinor`
    // stays the total of these, so every report that asks for "the tax" keeps
    // working without knowing about the breakdown.
    writeSaleTaxes(tx, sale.id, totals.taxLines, taxProfile.componentIdByCode, occurredAt);

    // --- lines, stock and COGS -------------------------------------------
    const allowNegative = settings.allowNegativeStock;
    const cogsParts: Minor[] = [];
    /** Batch refs of expired stock this sale was approved to take. */
    const expiredSold: string[] = [];

    resolved.forEach((entry, index) => {
      const line = totals.lines[index];
      if (!line) throw new ValidationError('Sale line mismatch.');

      let unitCost = ZERO;
      let totalCost = ZERO;

      if (entry.product.trackInventory) {
        const movement = recordStockMovement(tx, {
          productId: entry.product.id,
          direction: 'OUT',
          qty: entry.request.qty,
          movementType: 'SALE',
          sourceType: 'SALE',
          sourceId: sale.id,
          sourceRef: receiptNo,
          businessDate: input.businessDate,
          occurredAt,
          userId: actor.id,
          allowNegative,
          isDemo: input.isDemo ?? false,
          // First-expiry-first-out. Without the flag this throws
          // `ExpiredStockError` rather than quietly selling stock that has
          // passed its date — and only when there is no good stock left.
          batch: { kind: 'PICK', allowExpired: input.allowExpiredStock === true },
        });
        unitCost = movement.unitCost;
        totalCost = movement.totalCost;
        expiredSold.push(...movement.expiredTaken);
      }

      cogsParts.push(totalCost);

      tx.insert(saleItems)
        .values({
          saleId: sale.id,
          lineNo: index + 1,
          productId: entry.product.id,
          // Snapshot: a receipt reprinted later shows what was actually sold.
          productName: entry.product.name,
          unit: entry.product.unit,
          qtyMilli: entry.request.qty,
          unitPriceMinor: entry.unitPrice,
          discountMinor: line.discount,
          lineTotalMinor: line.lineTotal,
          unitCostMinor: unitCost,
          totalCostMinor: totalCost,
          createdAt: occurredAt,
        })
        .run();
    });

    const cogs = sum(cogsParts);

    tx.update(sales).set({ cogsMinor: cogs }).where(eq(sales.id, sale.id)).run();

    // --- tender ----------------------------------------------------------
    //
    // Payments are applied in order up to the sale total. Any excess is change
    // handed back, never recorded as revenue or as a credit balance.
    let remainingToApply = tender.applied;
    const appliedByAccount: { paymentAccountId: number; amount: Minor }[] = [];

    for (const request of input.tenders) {
      if (remainingToApply <= 0) break;
      if (request.amount <= 0) continue;

      const account = tx
        .select()
        .from(paymentAccounts)
        .where(eq(paymentAccounts.id, request.paymentAccountId))
        .get();
      if (!account) throw new NotFoundError('Payment account', request.paymentAccountId);
      if (!account.isActive) {
        throw new ValidationError(`Payment account "${account.name}" is not active.`);
      }

      const applied = request.amount > remainingToApply ? remainingToApply : request.amount;

      tx.insert(salePayments)
        .values({
          saleId: sale.id,
          paymentAccountId: request.paymentAccountId,
          amountMinor: applied,
          reference: request.reference ?? null,
          createdAt: occurredAt,
        })
        .run();

      appliedByAccount.push({ paymentAccountId: request.paymentAccountId, amount: applied });
      remainingToApply = subtract(remainingToApply, applied);
    }

    // --- the journal entry ------------------------------------------------
    const lines: DraftLine[] = [];

    for (const applied of appliedByAccount) {
      const account = tx
        .select({ glAccountId: paymentAccounts.glAccountId, name: paymentAccounts.name })
        .from(paymentAccounts)
        .where(eq(paymentAccounts.id, applied.paymentAccountId))
        .get();
      if (!account) throw new NotFoundError('Payment account', applied.paymentAccountId);

      lines.push(
        debit(account.glAccountId, applied.amount, {
          paymentAccountId: applied.paymentAccountId,
          description: `${receiptNo} received (${account.name})`,
        }),
      );
    }

    if (!isZero(tender.outstanding)) {
      lines.push(
        debit(accountIdByCode(tx, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE), tender.outstanding, {
          description: `${receiptNo} on credit`,
          ...(customerId !== null ? { customerId } : {}),
        }),
      );
    }

    // Discounts are shown as contra-revenue, so gross sales stay visible.
    // Net of tax: a discount on a tax-inclusive price gives back some tax too,
    // and that part was never the shop's revenue to give away.
    if (!isZero(totals.totalDiscountExTax)) {
      lines.push(
        debit(accountIdByCode(tx, ACCOUNT_CODES.SALES_DISCOUNTS), totals.totalDiscountExTax, {
          description: `${receiptNo} discount`,
        }),
      );
    }

    // What the shop earned, before discounts and excluding tax. Under exclusive
    // pricing `total - tax` is the net; under inclusive pricing it is the same
    // subtraction, because the tax was inside the total all along.
    const grossRevenue = sum([subtract(totals.total, totals.tax), totals.totalDiscountExTax]);
    lines.push(
      credit(accountIdByCode(tx, ACCOUNT_CODES.SALES_REVENUE), grossRevenue, {
        description: `${receiptNo} sale`,
      }),
    );

    // Each tax to its OWN account. NHIL, GETFund and VAT are three separate
    // obligations remitted on the same return but accounted for separately,
    // and only VAT can be set against what was paid on purchases. Netted into
    // one figure that distinction disappears, and with it any way to file.
    for (const taxLine of totals.taxLines) {
      if (isZero(taxLine.amount)) continue;
      lines.push(
        credit(taxAccountFor(tx, taxLine), taxLine.amount, {
          description: `${receiptNo} ${taxLine.name}`,
        }),
      );
    }

    // Cost of goods sold moves value out of inventory.
    if (!isZero(cogs)) {
      lines.push(
        debit(accountIdByCode(tx, ACCOUNT_CODES.COST_OF_GOODS_SOLD), cogs, {
          description: `${receiptNo} cost of goods`,
        }),
        credit(accountIdByCode(tx, ACCOUNT_CODES.INVENTORY), cogs, {
          description: `${receiptNo} stock released`,
        }),
      );
    }

    const posted = postJournalEntry(
      tx,
      {
        entryDate: input.businessDate,
        sourceType: 'SALE',
        sourceId: sale.id,
        memo: `${receiptNo} sale`,
        lines,
        occurredAt,
        isDemo: input.isDemo ?? false,
      },
      actor,
    );

    tx.update(sales)
      .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
      .where(eq(sales.id, sale.id))
      .run();

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'sale',
      entityId: sale.id,
      userId: actor.id,
      username: actor.username,
      summary: `${receiptNo}: ${input.items.length} item(s), total ${totals.total}`,
      metadata: {
        totalMinor: totals.total,
        cogsMinor: cogs,
        outstandingMinor: tender.outstanding,
        customerId,
        entryNo: posted.entryNo,
      },
      at: occurredAt,
    });

    /**
     * A separate row when somebody sold stock that had passed its date.
     *
     * Its own record rather than a field on the sale's, because this is the
     * question an owner comes back to ask months later — who let that go out,
     * and which crate was it — and it should be findable by looking for the
     * action rather than by reading every sale.
     */
    if (expiredSold.length > 0) {
      writeAudit(tx, {
        // 'CREATE' of an `expiry_override`, rather than a new audit action.
        // `AUDIT_ACTIONS` is a CHECK constraint on an append-only table, so a
        // sixteenth value would cost a rebuild of the whole audit log for one
        // word — and `entityType` is already how this codebase distinguishes a
        // record that is not about a row somewhere, as `backup` does.
        action: 'CREATE',
        entityType: 'expiry_override',
        entityId: sale.id,
        userId: actor.id,
        username: actor.username,
        summary: `${receiptNo}: sold expired stock from ${expiredSold.join(', ')}`,
        metadata: {
          batchRefs: expiredSold,
          businessDate: input.businessDate,
          ...(input.overrideReason === undefined ? {} : { reason: input.overrideReason }),
        },
        at: occurredAt,
      });
    }

    return {
      saleId: sale.id,
      receiptNo,
      total: totals.total,
      cogs,
      change: tender.change,
      outstanding: tender.outstanding,
      journalEntryId: posted.entryId,
    };
  });
}

/**
 * Void a sale by writing its mirror image.
 *
 * Stock goes back at EXACTLY the cost it left at (taken from the line
 * snapshots), so voiding neither creates nor destroys profit. The original sale
 * and its ledger entry are untouched.
 */
export function voidSale(
  db: Db,
  saleId: number,
  reason: string,
  actor: Actor,
  now: Date = new Date(),
): { reversalSaleId: number; receiptNo: string } {
  if (reason.trim().length < 3) {
    throw new ValidationError('Give a reason for voiding this sale.');
  }

  return writeTransaction(db, (tx) => {
    const original = tx.select().from(sales).where(eq(sales.id, saleId)).get();
    if (!original) throw new NotFoundError('Sale', saleId);
    if (original.status === 'VOIDED') throw new ConflictError('That sale has already been voided.');
    if (original.voidsSaleId !== null) {
      throw new ConflictError('A voiding entry cannot itself be voided.');
    }

    // Money already collected against this sale must be undone first, or the
    // customer's balance would be left wrong.
    const settled = tx
      .select({ total: sql<number>`COALESCE(SUM(${customerPaymentAllocations.amountMinor}), 0)` })
      .from(customerPaymentAllocations)
      .innerJoin(
        customerPayments,
        eq(customerPayments.id, customerPaymentAllocations.paymentId),
      )
      .where(
        and(
          eq(customerPaymentAllocations.saleId, saleId),
          eq(customerPayments.status, 'POSTED'),
        ),
      )
      .get();

    if ((settled?.total ?? 0) > 0) {
      throw new ConflictError(
        'This sale has customer payments recorded against it. Void those payments first.',
      );
    }

    const items = tx.select().from(saleItems).where(eq(saleItems.saleId, saleId)).all();
    const businessDate = toBusinessDateString(now);
    const receiptNo = nextDocumentNumber(tx, DOC_TYPES.SALE_RETURN);

    const reversal = tx
      .insert(sales)
      .values({
        receiptNo,
        // A correction, not a customer bringing goods back and not a sale.
        // Reports separate the three, and cannot if this is left to default.
        kind: 'VOID',
        businessDate,
        occurredAt: now,
        customerId: original.customerId,
        // Mirrored figures so the pair nets to zero.
        subtotalMinor: -original.subtotalMinor,
        discountMinor: -original.discountMinor,
        taxMinor: -original.taxMinor,
        totalMinor: -original.totalMinor,
        cogsMinor: -original.cogsMinor,
        // Whichever way the original was priced, so the mirror describes the
        // same document rather than today's setting.
        taxInclusive: original.taxInclusive,
        status: 'POSTED',
        voidsSaleId: saleId,
        note: `Void of ${original.receiptNo}: ${reason.trim()}`,
        createdBy: actor.id,
        isDemo: original.isDemo,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: sales.id })
      .get();

    if (!reversal) throw new ConflictError('Could not create the reversing sale.');

    // Mirror each tax the original charged, line for line, from what it
    // actually charged rather than from today's rates. A void of a sale made
    // before the budget moved VAT has to give back the VAT that was collected.
    const originalTaxes = readSaleTaxes(tx, saleId);
    writeSaleTaxes(
      tx,
      reversal.id,
      originalTaxes.map((row) => ({
        code: row.code,
        name: row.name,
        rateBp: row.rateBp,
        basis: row.basis,
        amount: minor(-row.amountMinor),
        isRecoverable: false,
      })),
      new Map(
        originalTaxes
          .filter((row) => row.componentId !== null)
          .map((row) => [row.code, row.componentId as number]),
      ),
      now,
    );

    /**
     * Which crates the sale emptied, so the void can refill those and no others.
     *
     * Put the units back anywhere else and the dates on the shelf become
     * fiction: a tin sold from a batch that runs out in March comes back into
     * one that runs out next year, and nothing will ever notice. Consumed per
     * line, because the same product can appear on two lines of one receipt.
     *
     * Empty for a sale made before batches existed, which is not a failure —
     * that sale never named a crate, so its void does not either.
     */
    const soldFrom = new Map<number, Allocation[][]>();
    for (const item of items) {
      if (soldFrom.has(item.productId)) continue;
      soldFrom.set(
        item.productId,
        readBatchSplits(tx, { sourceType: 'SALE', sourceId: saleId }, item.productId),
      );
    }

    items.forEach((item, index) => {
      const product = tx.select().from(products).where(eq(products.id, item.productId)).get();

      if (product?.trackInventory) {
        const cameFrom = soldFrom.get(item.productId)?.shift();

        // Back at the ORIGINAL cost, from the line snapshot.
        recordStockMovement(tx, {
          productId: item.productId,
          direction: 'IN',
          qty: makeQty(item.qtyMilli),
          totalCost: minor(item.totalCostMinor),
          movementType: 'SALE_RETURN',
          sourceType: 'SALE_VOID',
          sourceId: reversal.id,
          sourceRef: receiptNo,
          businessDate,
          occurredAt: now,
          userId: actor.id,
          note: `Void of ${original.receiptNo}`,
          isDemo: original.isDemo,
          ...(cameFrom === undefined || cameFrom.length === 0
            ? {}
            : { batch: { kind: 'SOURCE' as const, allocations: cameFrom } }),
        });
      }

      tx.insert(saleItems)
        .values({
          saleId: reversal.id,
          lineNo: index + 1,
          productId: item.productId,
          productName: item.productName,
          unit: item.unit,
          qtyMilli: -item.qtyMilli,
          unitPriceMinor: item.unitPriceMinor,
          discountMinor: item.discountMinor,
          lineTotalMinor: -item.lineTotalMinor,
          unitCostMinor: item.unitCostMinor,
          totalCostMinor: -item.totalCostMinor,
          createdAt: now,
        })
        .run();
    });

    // Mirror the tender so the cash/MoMo accounts are put back too.
    const tenders = tx.select().from(salePayments).where(eq(salePayments.saleId, saleId)).all();
    for (const tenderRow of tenders) {
      tx.insert(salePayments)
        .values({
          saleId: reversal.id,
          paymentAccountId: tenderRow.paymentAccountId,
          amountMinor: -tenderRow.amountMinor,
          reference: `Void of ${original.receiptNo}`,
          createdAt: now,
        })
        .run();
    }

    let reversalEntryId = 0;
    if (original.journalEntryId !== null) {
      const reversed = reverseJournalEntry(
        tx,
        original.journalEntryId,
        {
          entryDate: businessDate,
          sourceType: 'SALE_RETURN',
          sourceId: reversal.id,
          memo: `Void of ${original.receiptNo}: ${reason.trim()}`,
          occurredAt: now,
        },
        actor,
      );
      reversalEntryId = reversed.entryId;
      tx.update(sales)
        .set({ journalEntryId: reversalEntryId, updatedAt: now })
        .where(eq(sales.id, reversal.id))
        .run();
    }

    tx.update(sales)
      .set({
        status: 'VOIDED',
        voidedAt: now,
        voidReason: reason.trim(),
        voidedBySaleId: reversal.id,
        updatedAt: now,
      })
      .where(eq(sales.id, saleId))
      .run();

    writeAudit(tx, {
      action: 'VOID',
      entityType: 'sale',
      entityId: saleId,
      userId: actor.id,
      username: actor.username,
      summary: `Voided ${original.receiptNo} with ${receiptNo}`,
      metadata: { reason: reason.trim(), reversalSaleId: reversal.id },
      at: now,
    });

    return { reversalSaleId: reversal.id, receiptNo };
  });
}

function toBusinessDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// --- reads ----------------------------------------------------------------

/** What is still owed on one sale: total less tender less later payments. */
export function getSaleOutstanding(db: Db, saleId: number): Minor {
  const sale = db.select().from(sales).where(eq(sales.id, saleId)).get();
  if (!sale) throw new NotFoundError('Sale', saleId);
  if (sale.status === 'VOIDED') return ZERO;

  const tendered = db
    .select({ total: sql<number>`COALESCE(SUM(${salePayments.amountMinor}), 0)` })
    .from(salePayments)
    .where(eq(salePayments.saleId, saleId))
    .get();

  const allocated = db
    .select({ total: sql<number>`COALESCE(SUM(${customerPaymentAllocations.amountMinor}), 0)` })
    .from(customerPaymentAllocations)
    .innerJoin(customerPayments, eq(customerPayments.id, customerPaymentAllocations.paymentId))
    .where(
      and(eq(customerPaymentAllocations.saleId, saleId), eq(customerPayments.status, 'POSTED')),
    )
    .get();

  return subtract(
    minor(sale.totalMinor),
    minor((tendered?.total ?? 0) + (allocated?.total ?? 0)),
  );
}

/**
 * Outstanding amount for EVERY posted sale, in one pass.
 *
 * `getSaleOutstanding` runs three queries per sale, which is fine for one sale
 * and ruinous for a report over a thousand of them. The ageing reports and the
 * open-invoice lists use this instead; the definition of "outstanding" is
 * identical, so the two can never disagree.
 */
export function getOutstandingBySale(
  db: Db,
  options: {
    customerId?: number;
    /**
     * Answer as at this business date rather than as at today.
     *
     * Sales after it are left out, and so are payments after it. Both halves
     * matter: keeping the old sales but counting every payment ever made
     * reports a debt as settled months before the money arrived, which makes a
     * historical ageing report disagree with the receivables balance on the
     * very date it claims to describe.
     */
    asAt?: string;
  } = {},
): Map<number, Minor> {
  const { customerId, asAt } = options;

  const conditions: SQL[] = [eq(sales.status, 'POSTED')];
  if (customerId !== undefined) conditions.push(eq(sales.customerId, customerId));
  if (asAt !== undefined) conditions.push(lte(sales.businessDate, asAt));

  // Tender is handed over with the sale itself, so it is dated by the sale and
  // needs no separate cut-off: a sale inside the window brought its tender with
  // it, and one outside is excluded whole.
  const tendered = db
    .select({
      saleId: salePayments.saleId,
      total: sql<number>`COALESCE(SUM(${salePayments.amountMinor}), 0)`,
    })
    .from(salePayments)
    .groupBy(salePayments.saleId)
    .all();
  const tenderedBySale = new Map(tendered.map((row) => [row.saleId, row.total]));

  const settledConditions: SQL[] = [eq(customerPayments.status, 'POSTED')];
  if (asAt !== undefined) settledConditions.push(lte(customerPayments.businessDate, asAt));

  const settled = db
    .select({
      saleId: customerPaymentAllocations.saleId,
      total: sql<number>`COALESCE(SUM(${customerPaymentAllocations.amountMinor}), 0)`,
    })
    .from(customerPaymentAllocations)
    .innerJoin(customerPayments, eq(customerPayments.id, customerPaymentAllocations.paymentId))
    .where(and(...settledConditions))
    .groupBy(customerPaymentAllocations.saleId)
    .all();
  const settledBySale = new Map(settled.map((row) => [row.saleId, row.total]));

  const outstanding = new Map<number, Minor>();
  for (const row of db
    .select({ id: sales.id, totalMinor: sales.totalMinor })
    .from(sales)
    .where(and(...conditions))
    .all()) {
    outstanding.set(
      row.id,
      minor(row.totalMinor - (tenderedBySale.get(row.id) ?? 0) - (settledBySale.get(row.id) ?? 0)),
    );
  }
  return outstanding;
}

export const SALE_PAYMENT_KINDS = ['CASH', 'MOBILE_MONEY', 'BANK', 'OTHER'] as const;
export type SalePaymentKind = (typeof SALE_PAYMENT_KINDS)[number];

export const SALE_SORTS = ['date', 'amount', 'profit', 'customer', 'receipt'] as const;
export type SaleSort = (typeof SALE_SORTS)[number];

export interface SaleListQuery {
  from?: string;
  to?: string;
  customerId?: number;
  productId?: number;
  categoryId?: number;
  /** One specific till account: "Cash", "MTN MoMo". */
  paymentAccountId?: number;
  /** A whole class of account, for the "MoMo sales" quick filter. */
  paymentKind?: SalePaymentKind;
  /** Who rang it up. */
  staffId?: number;
  status?: 'POSTED' | 'VOIDED';
  /** SALE, RETURN or VOID — separates real trade from corrections. */
  kind?: 'SALE' | 'RETURN' | 'VOID';
  /** Settled or still owing, from tender plus any later allocations. */
  paymentState?: 'paid' | 'unpaid';
  /** Receipt or invoice number, customer name or phone, product name or SKU. */
  search?: string;
  minAmount?: Minor;
  maxAmount?: Minor;
  sort?: SaleSort;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** @deprecated Use `paymentState: 'unpaid'`. Kept for existing callers. */
  unpaidOnly?: boolean;
}

/**
 * The outer sale's own columns, written out with their table name.
 *
 * Drizzle omits the table qualifier for a query's primary table when the query
 * has no joins, so `${sales.id}` can render as a bare `"id"`. Inside a
 * correlated subquery SQLite then binds that to the SUBQUERY's table — turning
 * "lines belonging to this sale" into "lines whose id happens to equal their own
 * sale_id", which is not an error, returns the same plausible number for every
 * row, and is invisible until somebody counts.
 *
 * It bit exactly that way: `itemCount` was correct on the list (which joins
 * customers, so drizzle qualified everything) and wrong the moment the same
 * fragment was reused in a count with no joins. Writing the qualifier out means
 * the fragment cannot depend on the shape of the query it lands in.
 */
const SALE_ID = sql`sales.id`;
const SALE_CUSTOMER_ID = sql`sales.customer_id`;

/**
 * What a sale still owes, as SQL.
 *
 * This has to be an expression rather than a number computed afterwards,
 * because "show me the credit sales" must narrow the rows BEFORE the limit is
 * applied. Filtering a page of results in JavaScript answers a different
 * question — "which of the most recent hundred sales are unpaid" — and gets
 * quietly wronger the more sales the shop makes.
 *
 * A voided sale owes nothing: its mirror document already took the money back
 * out, so counting it again would show every correction as a debt.
 */
const outstandingSql = sql<number>`(CASE WHEN ${sales.status} = 'VOIDED' THEN 0 ELSE
  ${sales.totalMinor}
  - (SELECT COALESCE(SUM(sp.amount_minor), 0) FROM sale_payments sp WHERE sp.sale_id = ${SALE_ID})
  - (
      SELECT COALESCE(SUM(a.amount_minor), 0)
      FROM customer_payment_allocations a
      JOIN customer_payments p ON p.id = a.payment_id AND p.status = 'POSTED'
      WHERE a.sale_id = ${SALE_ID}
    )
END)`;

/**
 * Every filter, as one set of conditions.
 *
 * The list, the row count and the totals all build from this, which is what
 * makes the figures above a filtered table describe THAT table. A summary
 * assembled from its own separate WHERE clause is how a page ends up showing
 * twenty-seven cash sales under a revenue figure that includes the MoMo ones.
 */
function saleConditions(query: SaleListQuery): SQL[] {
  const conditions: SQL[] = [];

  if (query.from) conditions.push(gte(sales.businessDate, query.from));
  if (query.to) conditions.push(lte(sales.businessDate, query.to));
  if (query.customerId !== undefined) conditions.push(eq(sales.customerId, query.customerId));
  if (query.staffId !== undefined) conditions.push(eq(sales.createdBy, query.staffId));
  if (query.status !== undefined) conditions.push(eq(sales.status, query.status));
  if (query.kind !== undefined) conditions.push(eq(sales.kind, query.kind));

  if (query.productId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${saleItems} WHERE ${saleItems.saleId} = ${SALE_ID}
                  AND ${saleItems.productId} = ${query.productId})`,
    );
  }

  if (query.categoryId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${saleItems}
                  JOIN ${products} ON ${products.id} = ${saleItems.productId}
                  WHERE ${saleItems.saleId} = ${SALE_ID}
                    AND ${products.categoryId} = ${query.categoryId})`,
    );
  }

  if (query.paymentAccountId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM sale_payments sp
                  WHERE sp.sale_id = ${SALE_ID}
                    AND sp.payment_account_id = ${query.paymentAccountId})`,
    );
  }

  if (query.paymentKind !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM sale_payments sp
                  JOIN payment_accounts pa ON pa.id = sp.payment_account_id
                  WHERE sp.sale_id = ${SALE_ID} AND pa.kind = ${query.paymentKind})`,
    );
  }

  const paymentState = query.paymentState ?? (query.unpaidOnly ? 'unpaid' : undefined);
  if (paymentState === 'unpaid') conditions.push(sql`${outstandingSql} > 0`);
  if (paymentState === 'paid') conditions.push(sql`${outstandingSql} <= 0`);

  /*
    Amount bounds compare the ABSOLUTE total so a mirror document sits in the
    same bracket as the sale it reverses. "Sales over 500" that hid the void of
    a 600-cedi sale would make the correction impossible to find.
  */
  if (query.minAmount !== undefined) {
    conditions.push(sql`ABS(${sales.totalMinor}) >= ${query.minAmount}`);
  }
  if (query.maxAmount !== undefined) {
    conditions.push(sql`ABS(${sales.totalMinor}) <= ${query.maxAmount}`);
  }

  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    conditions.push(
      sql`(
        lower(${sales.receiptNo}) LIKE ${term}
        OR lower(COALESCE(${sales.invoiceNo}, '')) LIKE ${term}
        OR EXISTS (SELECT 1 FROM ${customers}
                   WHERE ${customers.id} = ${SALE_CUSTOMER_ID}
                     AND (lower(${customers.name}) LIKE ${term}
                          OR lower(COALESCE(${customers.phone}, '')) LIKE ${term}))
        OR EXISTS (SELECT 1 FROM ${saleItems}
                   LEFT JOIN ${products} ON ${products.id} = ${saleItems.productId}
                   WHERE ${saleItems.saleId} = ${SALE_ID}
                     AND (lower(${saleItems.productName}) LIKE ${term}
                          OR lower(COALESCE(${products.sku}, '')) LIKE ${term}
                          OR lower(COALESCE(${products.barcode}, '')) LIKE ${term}))
      )`,
    );
  }

  return conditions;
}

function saleOrderBy(query: SaleListQuery): SQL[] {
  const ascending = (query.direction ?? 'desc') === 'asc';
  const dir = (column: SQL): SQL => (ascending ? sql`${column} ASC` : sql`${column} DESC`);

  switch (query.sort) {
    case 'amount':
      return [dir(sql`${sales.totalMinor}`), sql`${sales.id} DESC`];
    case 'profit':
      return [dir(sql`(${sales.totalMinor} - ${sales.cogsMinor})`), sql`${sales.id} DESC`];
    case 'customer':
      return [dir(sql`lower(COALESCE(${customers.name}, 'zzzz'))`), sql`${sales.id} DESC`];
    case 'receipt':
      return [dir(sql`${sales.receiptNo}`), sql`${sales.id} DESC`];
    default:
      return [dir(sql`${sales.occurredAt}`), dir(sql`${sales.id}`)];
  }
}

export function listSales(db: Db, query: SaleListQuery = {}) {
  const conditions = saleConditions(query);

  const base = db
    .select({
      id: sales.id,
      receiptNo: sales.receiptNo,
      invoiceNo: sales.invoiceNo,
      kind: sales.kind,
      businessDate: sales.businessDate,
      occurredAt: sales.occurredAt,
      customerId: sales.customerId,
      customerName: customers.name,
      totalMinor: sales.totalMinor,
      discountMinor: sales.discountMinor,
      cogsMinor: sales.cogsMinor,
      status: sales.status,
      voidsSaleId: sales.voidsSaleId,
      createdBy: sales.createdBy,
      staffName: users.displayName,
      itemCount: sql<number>`(SELECT COUNT(*) FROM ${saleItems} WHERE ${saleItems.saleId} = ${SALE_ID})`,
      outstandingMinor: outstandingSql,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .leftJoin(users, eq(users.id, sales.createdBy));

  const rows = (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(...saleOrderBy(query))
    .limit(Math.min(query.limit ?? 100, 500))
    .offset(query.offset ?? 0)
    .all();

  return rows.map((row) => ({
    ...row,
    profitMinor: row.totalMinor - row.cogsMinor,
  }));
}

/** How many sales match, ignoring the page. What the pager counts. */
export function countSales(db: Db, query: SaleListQuery = {}): number {
  const conditions = saleConditions(query);
  const base = db.select({ total: sql<number>`COUNT(*)` }).from(sales);
  const row = (conditions.length > 0 ? base.where(and(...conditions)) : base).get();
  return row?.total ?? 0;
}

export interface FilteredSalesSummary {
  /** Sale documents rung up. Corrections are not another customer served. */
  count: number;
  quantity: Qty;
  revenue: Minor;
  discount: Minor;
  cogs: Minor;
  grossProfit: Minor;
  outstanding: Minor;
}

/**
 * The totals for exactly the sales a filter selects.
 *
 * Built from `saleConditions`, the same clause the table is built from, so the
 * figures above the rows always describe the rows. The money figures include
 * every document in range, voided ones too, because that is what the ledger
 * says happened — a revenue figure that contradicts the Profit & Loss is worse
 * than no revenue figure at all.
 */
export function getFilteredSalesSummary(
  db: Db,
  query: SaleListQuery = {},
): FilteredSalesSummary {
  const conditions = saleConditions(query);

  const base = db
    .select({
      count: sql<number>`COALESCE(SUM(CASE WHEN ${sales.kind} = 'SALE' THEN 1 ELSE 0 END), 0)`,
      revenue: sql<number>`COALESCE(SUM(${sales.totalMinor}), 0)`,
      discount: sql<number>`COALESCE(SUM(${sales.discountMinor}), 0)`,
      cogs: sql<number>`COALESCE(SUM(${sales.cogsMinor}), 0)`,
      outstanding: sql<number>`COALESCE(SUM(${outstandingSql}), 0)`,
      /*
        Quantity is summed through a correlated subquery rather than a join to
        `sale_items`: joining would multiply every sale's total by its number of
        lines, and a revenue figure inflated by line count is exactly the kind
        of plausible-looking wrong number nobody catches.
      */
      quantity: sql<number>`COALESCE(SUM(
        (SELECT COALESCE(SUM(si.qty_milli), 0) FROM ${saleItems} si WHERE si.sale_id = ${SALE_ID})
      ), 0)`,
    })
    .from(sales);

  const row = (conditions.length > 0 ? base.where(and(...conditions)) : base).get();

  const revenue = minor(row?.revenue ?? 0);
  const cogs = minor(row?.cogs ?? 0);

  return {
    count: row?.count ?? 0,
    quantity: makeQty(row?.quantity ?? 0),
    revenue,
    discount: minor(row?.discount ?? 0),
    cogs,
    grossProfit: subtract(revenue, cogs),
    outstanding: minor(row?.outstanding ?? 0),
  };
}

export function getSale(db: Db, saleId: number) {
  const sale = db
    .select({
      sale: sales,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(eq(sales.id, saleId))
    .get();

  if (!sale) throw new NotFoundError('Sale', saleId);

  const items = db.select().from(saleItems).where(eq(saleItems.saleId, saleId)).all();

  const tenders = db
    .select({
      id: salePayments.id,
      amountMinor: salePayments.amountMinor,
      reference: salePayments.reference,
      accountName: paymentAccounts.name,
      accountKind: paymentAccounts.kind,
    })
    .from(salePayments)
    .innerJoin(paymentAccounts, eq(paymentAccounts.id, salePayments.paymentAccountId))
    .where(eq(salePayments.saleId, saleId))
    .all();

  return {
    ...sale.sale,
    customerName: sale.customerName,
    customerPhone: sale.customerPhone,
    items,
    tenders,
    // What each tax charged ON THE DAY, for the receipt and the invoice. A
    // reprint after the budget moves a rate must show what the customer paid,
    // which is why these are read back rather than recomputed.
    taxes: readSaleTaxes(db, saleId),
    outstandingMinor: getSaleOutstanding(db, saleId),
  };
}

/**
 * Totals for a period, used by the dashboard and the sales report.
 *
 * The money figures cover EVERY sale document dated in the period, including
 * ones since voided, because that is what the ledger says happened. Voiding
 * writes a mirror document dated on the day of the correction rather than
 * reaching back into a finished day — so the takings for the original day stand
 * and the money comes back out on the day it was actually handed back. Dropping
 * the voided original would leave this report disagreeing with the Profit &
 * Loss by the whole sale, in both periods, and a sales figure that contradicts
 * the accounts is worse than no sales figure at all.
 *
 * `count` is narrower on purpose: it answers "how many sales were rung up",
 * so a correction is not counted as another customer served.
 */
export function getSalesSummary(db: Db, from: string, to: string) {
  const row = db
    .select({
      count: sql<number>`COALESCE(SUM(CASE WHEN ${sales.kind} = 'SALE' THEN 1 ELSE 0 END), 0)`,
      total: sql<number>`COALESCE(SUM(${sales.totalMinor}), 0)`,
      cogs: sql<number>`COALESCE(SUM(${sales.cogsMinor}), 0)`,
    })
    .from(sales)
    .where(and(gte(sales.businessDate, from), lte(sales.businessDate, to)))
    .get();

  const total = minor(row?.total ?? 0);
  const cogs = minor(row?.cogs ?? 0);

  return {
    count: row?.count ?? 0,
    total,
    cogs,
    grossProfit: subtract(total, cogs),
  };
}

/**
 * Map each line of a receipt to the batch split it was picked from.
 *
 * The mirror of `batchSplitByPurchaseItem`, and it works the same way:
 * `readBatchSplits` returns one split per movement in the order the movements
 * were made, which is the order the lines were written, so the lines are walked
 * the same way and each takes the head of its product's queue.
 *
 * Lines whose product does not track stock moved nothing and take nothing, or
 * every line after them would be paired with the wrong crate.
 */
export function batchSplitBySaleItem(tx: Tx, saleId: number): Map<number, Allocation[]> {
  const lines = tx
    .select({
      id: saleItems.id,
      productId: saleItems.productId,
      trackInventory: products.trackInventory,
    })
    .from(saleItems)
    .innerJoin(products, eq(products.id, saleItems.productId))
    .where(eq(saleItems.saleId, saleId))
    .orderBy(asc(saleItems.lineNo))
    .all();

  const queues = new Map<number, Allocation[][]>();
  const byLine = new Map<number, Allocation[]>();

  for (const line of lines) {
    if (!line.trackInventory) continue;

    let queue = queues.get(line.productId);
    if (queue === undefined) {
      queue = readBatchSplits(tx, { sourceType: 'SALE', sourceId: saleId }, line.productId);
      queues.set(line.productId, queue);
    }

    const split = queue.shift();
    if (split !== undefined && split.length > 0) byLine.set(line.id, split);
  }

  return byLine;
}
