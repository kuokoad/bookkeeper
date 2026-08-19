import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

import type { Db, Tx } from '@/db/types';
import {
  accounts,
  businessSettings,
  paymentAccounts,
  products,
  purchaseItems,
  purchasePayments,
  purchases,
  stockLedger,
  supplierPaymentAllocations,
  supplierPayments,
  suppliers,
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { credit, debit, type DraftLine } from '@/domain/accounting/journal';
import {
  add,
  allocate,
  isZero,
  minor,
  percentOf,
  subtract,
  sum,
  ZERO,
  type Minor,
} from '@/domain/money';
import { extendPrice, qty as makeQty, type Qty } from '@/domain/quantity';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import { postJournalEntry, reverseJournalEntry, type Actor } from './journal.service';
import { recordStockMovement } from './inventory.service';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';

/**
 * Recording a purchase — the mirror of a sale.
 *
 * ONE database transaction does all of this, or none of it:
 *   1. validate the supplier and the lines
 *   2. write the purchase and its lines
 *   3. add stock at the price ACTUALLY PAID, re-averaging the cost
 *   4. record what was paid at the time
 *   5. post ONE balanced journal entry (Inventory / Cash / Accounts Payable)
 *   6. write the audit record
 */

export interface PurchaseLineRequest {
  productId: number;
  qty: Qty;
  /** What this supplier charged per unit on this delivery. */
  unitCost: Minor;
  discount?: Minor;
}

export interface PurchaseTenderRequest {
  paymentAccountId: number;
  amount: Minor;
  reference?: string | undefined;
}

export interface CreatePurchaseInput {
  supplierId: number;
  businessDate: string;
  invoiceNo?: string | undefined;
  items: PurchaseLineRequest[];
  invoiceDiscount?: Minor;
  tenders: PurchaseTenderRequest[];
  note?: string | undefined;
  occurredAt?: Date;
  isDemo?: boolean;
}

export interface CreatedPurchase {
  purchaseId: number;
  purchaseNo: string;
  total: Minor;
  paid: Minor;
  outstanding: Minor;
  journalEntryId: number;
}

function accountIdByCode(tx: Tx, code: string): number {
  const account = tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code)).get();
  if (!account) throw new NotFoundError('Account', code);
  return account.id;
}

export function createPurchase(
  db: Db,
  input: CreatePurchaseInput,
  actor: Actor,
): CreatedPurchase {
  if (input.items.length === 0) {
    throw new ValidationError('Add at least one product to the purchase.');
  }

  return db.transaction((tx) => {
    const occurredAt = input.occurredAt ?? new Date();

    const settings = tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
    if (!settings) throw new NotFoundError('Business settings', 1);

    const supplier = tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).get();
    if (!supplier) throw new NotFoundError('Supplier', input.supplierId);
    if (!supplier.isActive) {
      throw new ValidationError(`"${supplier.name}" is archived and cannot be purchased from.`);
    }

    // --- line arithmetic --------------------------------------------------
    const lines = input.items.map((item) => {
      const product = tx.select().from(products).where(eq(products.id, item.productId)).get();
      if (!product) throw new NotFoundError('Product', item.productId);
      if (item.qty <= 0) {
        throw new ValidationError('Every line needs a quantity greater than zero.');
      }
      if (item.unitCost < 0) {
        throw new ValidationError('A unit cost cannot be negative.');
      }

      const gross = extendPrice(item.unitCost, item.qty);
      const discount = item.discount ?? ZERO;
      if (discount < 0) throw new ValidationError('A discount cannot be negative.');
      if (discount > gross) {
        throw new ValidationError('A line discount cannot be more than the line total.');
      }

      return { item, product, gross, discount, lineTotal: subtract(gross, discount) };
    });

    const subtotal = sum(lines.map((line) => line.lineTotal));
    const invoiceDiscount = input.invoiceDiscount ?? ZERO;
    if (invoiceDiscount < 0) throw new ValidationError('A discount cannot be negative.');
    if (invoiceDiscount > subtotal) {
      throw new ValidationError('The discount cannot be more than the purchase total.');
    }

    const netBeforeTax = subtract(subtotal, invoiceDiscount);
    const taxRateBp = settings.taxEnabled ? settings.taxRateBp : 0;
    const tax = taxRateBp === 0 ? ZERO : percentOf(netBeforeTax, taxRateBp);
    const total = sum([netBeforeTax, tax]);

    const tendered = sum(input.tenders.map((tender) => tender.amount));
    if (tendered < 0) throw new ValidationError('A payment cannot be negative.');
    if (tendered > total) {
      throw new ValidationError(
        'You cannot pay more than the purchase total. Reduce the amount paid.',
        { total, tendered },
      );
    }
    const outstanding = subtract(total, tendered);

    // --- write the purchase ----------------------------------------------
    const purchaseNo = nextDocumentNumber(tx, DOC_TYPES.PURCHASE);

    const purchase = tx
      .insert(purchases)
      .values({
        purchaseNo,
        kind: 'PURCHASE',
        supplierId: input.supplierId,
        businessDate: input.businessDate,
        occurredAt,
        invoiceNo: input.invoiceNo ?? null,
        subtotalMinor: subtotal,
        discountMinor: invoiceDiscount,
        taxMinor: tax,
        totalMinor: total,
        status: 'POSTED',
        note: input.note ?? null,
        createdBy: actor.id,
        isDemo: input.isDemo ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: purchases.id })
      .get();

    if (!purchase) throw new ConflictError('Could not create the purchase.');

    // --- stock in ---------------------------------------------------------
    //
    // Only the goods value goes into inventory. Any invoice-level discount is
    // spread proportionally so the value added equals what was actually paid
    // for the goods.
    let inventoryValue = ZERO;

    // Spread the invoice discount with the largest-remainder method so the
    // shares add back to EXACTLY the discount given. Rounding each line
    // independently leaks a pesewa, which then surfaces as a phantom expense.
    const discountShares = isZero(invoiceDiscount)
      ? lines.map(() => ZERO)
      : allocate(
          invoiceDiscount,
          lines.map((line) => line.lineTotal),
        );

    lines.forEach((line, index) => {
      const lineShare = discountShares[index] ?? ZERO;
      const lineCost = subtract(line.lineTotal, lineShare);

      if (line.product.trackInventory) {
        recordStockMovement(tx, {
          productId: line.product.id,
          direction: 'IN',
          qty: line.item.qty,
          totalCost: lineCost,
          movementType: 'PURCHASE',
          sourceType: 'PURCHASE',
          sourceId: purchase.id,
          sourceRef: purchaseNo,
          businessDate: input.businessDate,
          occurredAt,
          userId: actor.id,
          isDemo: input.isDemo ?? false,
        });
        inventoryValue = sum([inventoryValue, lineCost]);
      }

      tx.insert(purchaseItems)
        .values({
          purchaseId: purchase.id,
          lineNo: index + 1,
          productId: line.product.id,
          productName: line.product.name,
          unit: line.product.unit,
          qtyMilli: line.item.qty,
          unitCostMinor: line.item.unitCost,
          discountMinor: line.discount,
          lineTotalMinor: line.lineTotal,
          createdAt: occurredAt,
        })
        .run();
    });

    // Goods that are not stock-tracked are an immediate expense, not inventory.
    const nonInventoryValue = subtract(netBeforeTax, inventoryValue);

    // --- tender -----------------------------------------------------------
    const journalLines: DraftLine[] = [];

    for (const tender of input.tenders) {
      if (tender.amount <= 0) continue;

      const account = tx
        .select()
        .from(paymentAccounts)
        .where(eq(paymentAccounts.id, tender.paymentAccountId))
        .get();
      if (!account) throw new NotFoundError('Payment account', tender.paymentAccountId);
      if (!account.isActive) {
        throw new ValidationError(`Payment account "${account.name}" is not active.`);
      }

      tx.insert(purchasePayments)
        .values({
          purchaseId: purchase.id,
          paymentAccountId: tender.paymentAccountId,
          amountMinor: tender.amount,
          reference: tender.reference ?? null,
          createdAt: occurredAt,
        })
        .run();

      journalLines.push(
        credit(account.glAccountId, tender.amount, {
          paymentAccountId: tender.paymentAccountId,
          description: `${purchaseNo} paid (${account.name})`,
        }),
      );
    }

    // --- the journal entry -------------------------------------------------
    if (!isZero(inventoryValue)) {
      journalLines.push(
        debit(accountIdByCode(tx, ACCOUNT_CODES.INVENTORY), inventoryValue, {
          description: `${purchaseNo} stock received`,
        }),
      );
    }
    if (!isZero(nonInventoryValue)) {
      journalLines.push(
        debit(accountIdByCode(tx, '6900'), nonInventoryValue, {
          description: `${purchaseNo} non-stock items`,
        }),
      );
    }
    if (!isZero(tax)) {
      journalLines.push(
        debit(accountIdByCode(tx, ACCOUNT_CODES.TAX_PAYABLE), tax, {
          description: `${purchaseNo} ${settings.taxLabel}`,
        }),
      );
    }
    if (!isZero(outstanding)) {
      journalLines.push(
        credit(accountIdByCode(tx, ACCOUNT_CODES.ACCOUNTS_PAYABLE), outstanding, {
          supplierId: input.supplierId,
          description: `${purchaseNo} on credit`,
        }),
      );
    }

    const posted = postJournalEntry(
      tx,
      {
        entryDate: input.businessDate,
        sourceType: 'PURCHASE',
        sourceId: purchase.id,
        memo: `${purchaseNo} — purchase from ${supplier.name}`,
        lines: journalLines,
        occurredAt,
        isDemo: input.isDemo ?? false,
      },
      actor,
    );

    tx.update(purchases)
      .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
      .where(eq(purchases.id, purchase.id))
      .run();

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'purchase',
      entityId: purchase.id,
      userId: actor.id,
      username: actor.username,
      summary: `${purchaseNo}: ${input.items.length} line(s) from ${supplier.name}, total ${total}`,
      metadata: {
        totalMinor: total,
        paidMinor: tendered,
        outstandingMinor: outstanding,
        supplierId: input.supplierId,
        entryNo: posted.entryNo,
      },
      at: occurredAt,
    });

    return {
      purchaseId: purchase.id,
      purchaseNo,
      total,
      paid: tendered,
      outstanding,
      journalEntryId: posted.entryId,
    };
  });
}

/**
 * Void a purchase by writing its mirror image.
 *
 * Stock leaves at the cost it arrived at, and the payable or payment is
 * reversed. The original purchase is kept exactly as recorded.
 */
export function voidPurchase(
  db: Db,
  purchaseId: number,
  reason: string,
  actor: Actor,
  now: Date = new Date(),
): { reversalPurchaseId: number; purchaseNo: string } {
  if (reason.trim().length < 3) {
    throw new ValidationError('Give a reason for voiding this purchase.');
  }

  return db.transaction((tx) => {
    const original = tx.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
    if (!original) throw new NotFoundError('Purchase', purchaseId);
    if (original.status === 'VOIDED') {
      throw new ConflictError('That purchase has already been voided.');
    }
    if (original.kind !== 'PURCHASE') {
      throw new ConflictError('Only a purchase can be voided this way.');
    }

    const settled = tx
      .select({ total: sql<number>`COALESCE(SUM(${supplierPaymentAllocations.amountMinor}), 0)` })
      .from(supplierPaymentAllocations)
      .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentAllocations.paymentId))
      .where(
        and(
          eq(supplierPaymentAllocations.purchaseId, purchaseId),
          eq(supplierPayments.status, 'POSTED'),
        ),
      )
      .get();

    if ((settled?.total ?? 0) > 0) {
      throw new ConflictError(
        'This purchase has payments recorded against it. Void those payments first.',
      );
    }

    const items = tx
      .select()
      .from(purchaseItems)
      .where(eq(purchaseItems.purchaseId, purchaseId))
      .all();

    const businessDate = toBusinessDateString(now);
    const purchaseNo = nextDocumentNumber(tx, DOC_TYPES.PURCHASE_RETURN);
    const settings = tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
    const allowNegative = settings?.allowNegativeStock ?? false;

    /** Value the shelf could not keep. Posted below if it is not zero. */
    let costingResidual: Minor = ZERO;

    const reversal = tx
      .insert(purchases)
      .values({
        purchaseNo,
        kind: 'VOID',
        supplierId: original.supplierId,
        businessDate,
        occurredAt: now,
        invoiceNo: original.invoiceNo,
        subtotalMinor: -original.subtotalMinor,
        discountMinor: -original.discountMinor,
        taxMinor: -original.taxMinor,
        totalMinor: -original.totalMinor,
        status: 'POSTED',
        voidsPurchaseId: purchaseId,
        note: `Void of ${original.purchaseNo}: ${reason.trim()}`,
        createdBy: actor.id,
        isDemo: original.isDemo,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: purchases.id })
      .get();

    if (!reversal) throw new ConflictError('Could not create the reversing purchase.');

    /**
     * The goods leave at the cost they arrived at, not at today's average.
     *
     * The general ledger side of this void is an exact reversal of the original
     * entry, so it credits Inventory with what the delivery cost. Taking the
     * stock out at the running average instead — which is what happens when no
     * cost is supplied — removes a different number, and the two counts of
     * inventory stop agreeing: buy ten at GHS 10 and ten at GHS 20, void the
     * first, and the shelf says GHS 150 while the accounts say GHS 200.
     *
     * The original movements are read back rather than recomputed, because the
     * value that went in had an invoice-level discount spread across it and the
     * ledger row is the record of what that came to.
     */
    const originalCosts = new Map<number, Minor[]>();
    for (const row of tx
      .select({ productId: stockLedger.productId, totalCost: stockLedger.totalCostMinor })
      .from(stockLedger)
      .where(
        and(eq(stockLedger.sourceType, 'PURCHASE'), eq(stockLedger.sourceId, purchaseId)),
      )
      .orderBy(asc(stockLedger.id))
      .all()) {
      const queue = originalCosts.get(row.productId) ?? [];
      queue.push(minor(row.totalCost));
      originalCosts.set(row.productId, queue);
    }

    items.forEach((item, index) => {
      const product = tx.select().from(products).where(eq(products.id, item.productId)).get();

      if (product?.trackInventory) {
        // Same product can appear on more than one line, so costs are consumed
        // in the order they were recorded.
        const wentInAt = originalCosts.get(item.productId)?.shift();

        const movement = recordStockMovement(tx, {
          productId: item.productId,
          direction: 'OUT',
          qty: makeQty(item.qtyMilli),
          ...(wentInAt === undefined ? {} : { totalCost: wentInAt }),
          movementType: 'PURCHASE_RETURN',
          sourceType: 'PURCHASE_VOID',
          sourceId: reversal.id,
          sourceRef: purchaseNo,
          businessDate,
          occurredAt: now,
          userId: actor.id,
          allowNegative,
          note: `Void of ${original.purchaseNo}`,
          isDemo: original.isDemo,
        });

        costingResidual = add(costingResidual, movement.residual);
      }

      tx.insert(purchaseItems)
        .values({
          purchaseId: reversal.id,
          lineNo: index + 1,
          productId: item.productId,
          productName: item.productName,
          unit: item.unit,
          qtyMilli: -item.qtyMilli,
          unitCostMinor: item.unitCostMinor,
          discountMinor: item.discountMinor,
          lineTotalMinor: -item.lineTotalMinor,
          createdAt: now,
        })
        .run();
    });

    const tenders = tx
      .select()
      .from(purchasePayments)
      .where(eq(purchasePayments.purchaseId, purchaseId))
      .all();
    for (const tender of tenders) {
      tx.insert(purchasePayments)
        .values({
          purchaseId: reversal.id,
          paymentAccountId: tender.paymentAccountId,
          amountMinor: -tender.amountMinor,
          reference: `Void of ${original.purchaseNo}`,
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
          sourceType: 'PURCHASE_RETURN',
          sourceId: reversal.id,
          memo: `Void of ${original.purchaseNo}: ${reason.trim()}`,
          occurredAt: now,
        },
        actor,
      );
      reversalEntryId = reversed.entryId;
      tx.update(purchases)
        .set({ journalEntryId: reversalEntryId, updatedAt: now })
        .where(eq(purchases.id, reversal.id))
        .run();
    }

    /**
     * Value the shelf could not keep, posted as its own entry.
     *
     * Taking the last of a product back out at what it cost can leave the
     * running value short of, or over, zero — the average moved on while other
     * stock arrived and sold. Zero quantity has to mean zero value, so that
     * difference leaves inventory, and it has to leave the general ledger too
     * or the two counts of inventory part company.
     *
     * Recorded separately from the reversal rather than folded into it: the
     * reversal says exactly what the original said, backwards, and this says
     * what the averaging cost the shop. Merging them would hide a real figure
     * inside a mechanical one.
     */
    if (!isZero(costingResidual)) {
      postJournalEntry(
        tx,
        {
          entryDate: businessDate,
          sourceType: 'PURCHASE_RETURN',
          sourceId: reversal.id,
          memo: `Stock costing difference on voiding ${original.purchaseNo}`,
          occurredAt: now,
          lines:
            costingResidual > 0
              ? [
                  debit(accountIdByCode(tx, ACCOUNT_CODES.COST_OF_GOODS_SOLD), costingResidual, {
                    description: `${purchaseNo} costing difference`,
                  }),
                  credit(accountIdByCode(tx, ACCOUNT_CODES.INVENTORY), costingResidual, {
                    description: `${purchaseNo} stock value released`,
                  }),
                ]
              : [
                  debit(accountIdByCode(tx, ACCOUNT_CODES.INVENTORY), minor(-costingResidual), {
                    description: `${purchaseNo} stock value restored`,
                  }),
                  credit(
                    accountIdByCode(tx, ACCOUNT_CODES.COST_OF_GOODS_SOLD),
                    minor(-costingResidual),
                    { description: `${purchaseNo} costing difference` },
                  ),
                ],
        },
        actor,
      );
    }

    tx.update(purchases)
      .set({
        status: 'VOIDED',
        voidedAt: now,
        voidReason: reason.trim(),
        voidedByPurchaseId: reversal.id,
        updatedAt: now,
      })
      .where(eq(purchases.id, purchaseId))
      .run();

    writeAudit(tx, {
      action: 'VOID',
      entityType: 'purchase',
      entityId: purchaseId,
      userId: actor.id,
      username: actor.username,
      summary: `Voided ${original.purchaseNo} with ${purchaseNo}`,
      metadata: { reason: reason.trim() },
      at: now,
    });

    return { reversalPurchaseId: reversal.id, purchaseNo };
  });
}

function toBusinessDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// --- reads ----------------------------------------------------------------

export function getPurchaseOutstanding(db: Db, purchaseId: number): Minor {
  const purchase = db.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
  if (!purchase) throw new NotFoundError('Purchase', purchaseId);
  if (purchase.status === 'VOIDED') return ZERO;

  const paid = db
    .select({ total: sql<number>`COALESCE(SUM(${purchasePayments.amountMinor}), 0)` })
    .from(purchasePayments)
    .where(eq(purchasePayments.purchaseId, purchaseId))
    .get();

  const settled = db
    .select({ total: sql<number>`COALESCE(SUM(${supplierPaymentAllocations.amountMinor}), 0)` })
    .from(supplierPaymentAllocations)
    .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentAllocations.paymentId))
    .where(
      and(
        eq(supplierPaymentAllocations.purchaseId, purchaseId),
        eq(supplierPayments.status, 'POSTED'),
      ),
    )
    .get();

  return subtract(minor(purchase.totalMinor), minor((paid?.total ?? 0) + (settled?.total ?? 0)));
}

/**
 * Outstanding amount for EVERY posted purchase, in one pass.
 * Mirror of `getOutstandingBySale` — see the note there.
 */
export function getOutstandingByPurchase(
  db: Db,
  options: { supplierId?: number; asAt?: string } = {},
): Map<number, Minor> {
  const { supplierId, asAt } = options;

  const conditions: SQL[] = [eq(purchases.status, 'POSTED')];
  if (supplierId !== undefined) conditions.push(eq(purchases.supplierId, supplierId));
  if (asAt !== undefined) conditions.push(lte(purchases.businessDate, asAt));

  const paid = db
    .select({
      purchaseId: purchasePayments.purchaseId,
      total: sql<number>`COALESCE(SUM(${purchasePayments.amountMinor}), 0)`,
    })
    .from(purchasePayments)
    .groupBy(purchasePayments.purchaseId)
    .all();
  const paidByPurchase = new Map(paid.map((row) => [row.purchaseId, row.total]));

  const settledConditions: SQL[] = [eq(supplierPayments.status, 'POSTED')];
  if (asAt !== undefined) settledConditions.push(lte(supplierPayments.businessDate, asAt));

  const settled = db
    .select({
      purchaseId: supplierPaymentAllocations.purchaseId,
      total: sql<number>`COALESCE(SUM(${supplierPaymentAllocations.amountMinor}), 0)`,
    })
    .from(supplierPaymentAllocations)
    .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentAllocations.paymentId))
    .where(and(...settledConditions))
    .groupBy(supplierPaymentAllocations.purchaseId)
    .all();
  const settledByPurchase = new Map(settled.map((row) => [row.purchaseId, row.total]));

  const outstanding = new Map<number, Minor>();
  for (const row of db
    .select({ id: purchases.id, totalMinor: purchases.totalMinor })
    .from(purchases)
    .where(and(...conditions))
    .all()) {
    outstanding.set(
      row.id,
      minor(
        row.totalMinor - (paidByPurchase.get(row.id) ?? 0) - (settledByPurchase.get(row.id) ?? 0),
      ),
    );
  }
  return outstanding;
}

export interface PurchaseListQuery {
  from?: string;
  to?: string;
  supplierId?: number;
  unpaidOnly?: boolean;
  limit?: number;
}

export function listPurchases(db: Db, query: PurchaseListQuery = {}) {
  const conditions: SQL[] = [];
  if (query.from) conditions.push(gte(purchases.businessDate, query.from));
  if (query.to) conditions.push(lte(purchases.businessDate, query.to));
  if (query.supplierId !== undefined) conditions.push(eq(purchases.supplierId, query.supplierId));

  const base = db
    .select({
      id: purchases.id,
      purchaseNo: purchases.purchaseNo,
      kind: purchases.kind,
      businessDate: purchases.businessDate,
      occurredAt: purchases.occurredAt,
      invoiceNo: purchases.invoiceNo,
      supplierId: purchases.supplierId,
      supplierName: suppliers.name,
      totalMinor: purchases.totalMinor,
      status: purchases.status,
      itemCount: sql<number>`(SELECT COUNT(*) FROM ${purchaseItems} WHERE ${purchaseItems.purchaseId} = ${purchases.id})`,
    })
    .from(purchases)
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId));

  const rows = (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(desc(purchases.occurredAt), desc(purchases.id))
    .limit(Math.min(query.limit ?? 100, 500))
    .all();

  const outstanding = getOutstandingByPurchase(db);
  const mapped = rows.map((row) => ({
    ...row,
    outstandingMinor: (outstanding.get(row.id) ?? 0) as number,
  }));

  return query.unpaidOnly ? mapped.filter((row) => row.outstandingMinor > 0) : mapped;
}

export function getPurchase(db: Db, purchaseId: number) {
  const found = db
    .select({ purchase: purchases, supplierName: suppliers.name, supplierPhone: suppliers.phone })
    .from(purchases)
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(eq(purchases.id, purchaseId))
    .get();

  if (!found) throw new NotFoundError('Purchase', purchaseId);

  const items = db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, purchaseId))
    .all();

  const tenders = db
    .select({
      id: purchasePayments.id,
      amountMinor: purchasePayments.amountMinor,
      reference: purchasePayments.reference,
      accountName: paymentAccounts.name,
    })
    .from(purchasePayments)
    .innerJoin(paymentAccounts, eq(paymentAccounts.id, purchasePayments.paymentAccountId))
    .where(eq(purchasePayments.purchaseId, purchaseId))
    .all();

  return {
    ...found.purchase,
    supplierName: found.supplierName,
    supplierPhone: found.supplierPhone,
    items,
    tenders,
    outstandingMinor: getPurchaseOutstanding(db, purchaseId),
  };
}

export function getPurchasesSummary(db: Db, from: string, to: string) {
  const row = db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${purchases.totalMinor}), 0)`,
    })
    .from(purchases)
    .where(
      and(
        gte(purchases.businessDate, from),
        lte(purchases.businessDate, to),
        eq(purchases.status, 'POSTED'),
      ),
    )
    .get();

  return { count: row?.count ?? 0, total: minor(row?.total ?? 0) };
}

/** Unpaid purchases for a supplier, oldest first. */
export function getOpenPurchases(db: Db, supplierId: number) {
  const outstanding = getOutstandingByPurchase(db, { supplierId });

  return db
    .select({
      id: purchases.id,
      purchaseNo: purchases.purchaseNo,
      businessDate: purchases.businessDate,
      totalMinor: purchases.totalMinor,
    })
    .from(purchases)
    .where(and(eq(purchases.supplierId, supplierId), eq(purchases.status, 'POSTED')))
    .orderBy(purchases.businessDate, purchases.id)
    .all()
    .map((row) => ({ ...row, outstandingMinor: outstanding.get(row.id) ?? minor(0) }))
    .filter((row) => row.outstandingMinor > 0);
}
