import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

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
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { credit, debit, type DraftLine } from '@/domain/accounting/journal';
import { calculateSale, calculateTender, exceedsCreditLimit } from '@/domain/sales/calculate';
import { isZero, minor, subtract, sum, ZERO, type Minor } from '@/domain/money';
import { qty as makeQty, type Qty } from '@/domain/quantity';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import { postJournalEntry, reverseJournalEntry, type Actor } from './journal.service';
import { recordStockMovement } from './inventory.service';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';
import { getCustomerBalance } from './customer.service';

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
  /** Overrides the product's list price when the owner negotiates. */
  unitPrice?: Minor;
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
  items: SaleLineRequest[];
  invoiceDiscount?: Minor;
  tenders: TenderRequest[];
  note?: string | undefined;
  occurredAt?: Date;
  isDemo?: boolean;
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

function accountIdByCode(tx: Tx, code: string): number {
  const account = tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code)).get();
  if (!account) throw new NotFoundError('Account', code);
  return account.id;
}

export function createSale(db: Db, input: CreateSaleInput, actor: Actor): CreatedSale {
  if (input.items.length === 0) {
    throw new ValidationError('Add at least one item to the sale.');
  }

  return db.transaction((tx) => {
    const occurredAt = input.occurredAt ?? new Date();

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

    // --- compute every figure in the pure domain -------------------------
    const totals = calculateSale({
      lines: resolved.map((entry) => ({
        productId: entry.product.id,
        qty: entry.request.qty,
        unitPrice: entry.unitPrice,
        ...(entry.request.discount !== undefined ? { discount: entry.request.discount } : {}),
      })),
      ...(input.invoiceDiscount !== undefined ? { invoiceDiscount: input.invoiceDiscount } : {}),
      taxRateBp: settings.taxEnabled ? settings.taxRateBp : 0,
      taxInclusive: settings.taxInclusive,
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

    const sale = tx
      .insert(sales)
      .values({
        receiptNo,
        businessDate: input.businessDate,
        occurredAt,
        customerId,
        subtotalMinor: totals.subtotal,
        discountMinor: totals.invoiceDiscount,
        taxMinor: totals.tax,
        totalMinor: totals.total,
        cogsMinor: 0,
        status: 'POSTED',
        note: input.note ?? null,
        createdBy: actor.id,
        isDemo: input.isDemo ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: sales.id })
      .get();

    if (!sale) throw new ConflictError('Could not create the sale.');

    // --- lines, stock and COGS -------------------------------------------
    const allowNegative = settings.allowNegativeStock;
    const cogsParts: Minor[] = [];

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
        });
        unitCost = movement.unitCost;
        totalCost = movement.totalCost;
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
    if (!isZero(totals.totalDiscount)) {
      lines.push(
        debit(accountIdByCode(tx, ACCOUNT_CODES.SALES_DISCOUNTS), totals.totalDiscount, {
          description: `${receiptNo} discount`,
        }),
      );
    }

    const grossRevenue = sum([totals.netBeforeTax, totals.totalDiscount]);
    lines.push(
      credit(accountIdByCode(tx, ACCOUNT_CODES.SALES_REVENUE), grossRevenue, {
        description: `${receiptNo} sale`,
      }),
    );

    if (!isZero(totals.tax)) {
      lines.push(
        credit(accountIdByCode(tx, ACCOUNT_CODES.TAX_PAYABLE), totals.tax, {
          description: `${receiptNo} ${settings.taxLabel}`,
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

  return db.transaction((tx) => {
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
        businessDate,
        occurredAt: now,
        customerId: original.customerId,
        // Mirrored figures so the pair nets to zero.
        subtotalMinor: -original.subtotalMinor,
        discountMinor: -original.discountMinor,
        taxMinor: -original.taxMinor,
        totalMinor: -original.totalMinor,
        cogsMinor: -original.cogsMinor,
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

    items.forEach((item, index) => {
      const product = tx.select().from(products).where(eq(products.id, item.productId)).get();

      if (product?.trackInventory) {
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
export function getOutstandingBySale(db: Db, customerId?: number): Map<number, Minor> {
  const conditions: SQL[] = [eq(sales.status, 'POSTED')];
  if (customerId !== undefined) conditions.push(eq(sales.customerId, customerId));

  const tendered = db
    .select({
      saleId: salePayments.saleId,
      total: sql<number>`COALESCE(SUM(${salePayments.amountMinor}), 0)`,
    })
    .from(salePayments)
    .groupBy(salePayments.saleId)
    .all();
  const tenderedBySale = new Map(tendered.map((row) => [row.saleId, row.total]));

  const settled = db
    .select({
      saleId: customerPaymentAllocations.saleId,
      total: sql<number>`COALESCE(SUM(${customerPaymentAllocations.amountMinor}), 0)`,
    })
    .from(customerPaymentAllocations)
    .innerJoin(customerPayments, eq(customerPayments.id, customerPaymentAllocations.paymentId))
    .where(eq(customerPayments.status, 'POSTED'))
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

export interface SaleListQuery {
  from?: string;
  to?: string;
  customerId?: number;
  unpaidOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function listSales(db: Db, query: SaleListQuery = {}) {
  const conditions: SQL[] = [];
  if (query.from) conditions.push(gte(sales.businessDate, query.from));
  if (query.to) conditions.push(lte(sales.businessDate, query.to));
  if (query.customerId !== undefined) conditions.push(eq(sales.customerId, query.customerId));

  const base = db
    .select({
      id: sales.id,
      receiptNo: sales.receiptNo,
      businessDate: sales.businessDate,
      occurredAt: sales.occurredAt,
      customerId: sales.customerId,
      customerName: customers.name,
      totalMinor: sales.totalMinor,
      cogsMinor: sales.cogsMinor,
      status: sales.status,
      voidsSaleId: sales.voidsSaleId,
      itemCount: sql<number>`(SELECT COUNT(*) FROM ${saleItems} WHERE ${saleItems.saleId} = ${sales.id})`,
      tenderedMinor: sql<number>`(SELECT COALESCE(SUM(${salePayments.amountMinor}), 0) FROM ${salePayments} WHERE ${salePayments.saleId} = ${sales.id})`,
      settledMinor: sql<number>`(
        SELECT COALESCE(SUM(a.amount_minor), 0)
        FROM customer_payment_allocations a
        JOIN customer_payments p ON p.id = a.payment_id AND p.status = 'POSTED'
        WHERE a.sale_id = ${sales.id}
      )`,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId));

  const rows = (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(desc(sales.occurredAt), desc(sales.id))
    .limit(Math.min(query.limit ?? 100, 500))
    .offset(query.offset ?? 0)
    .all();

  const mapped = rows.map((row) => ({
    ...row,
    outstandingMinor:
      row.status === 'VOIDED'
        ? 0
        : row.totalMinor - row.tenderedMinor - row.settledMinor,
    profitMinor: row.totalMinor - row.cogsMinor,
  }));

  return query.unpaidOnly ? mapped.filter((row) => row.outstandingMinor > 0) : mapped;
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
    outstandingMinor: getSaleOutstanding(db, saleId),
  };
}

/** Totals for a period, used by the dashboard and the sales report. */
export function getSalesSummary(db: Db, from: string, to: string) {
  const row = db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${sales.totalMinor}), 0)`,
      cogs: sql<number>`COALESCE(SUM(${sales.cogsMinor}), 0)`,
    })
    .from(sales)
    .where(
      and(
        gte(sales.businessDate, from),
        lte(sales.businessDate, to),
        eq(sales.status, 'POSTED'),
      ),
    )
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
