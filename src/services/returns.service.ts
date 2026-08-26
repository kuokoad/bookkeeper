import { asc, eq, sql } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db, Tx } from '@/db/types';
import {
  accounts,
  businessSettings,
  paymentAccounts,
  products,
  purchaseItems,
  purchasePayments,
  purchases,
  saleItems,
  salePayments,
  sales,
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { credit, debit, type DraftLine } from '@/domain/accounting/journal';
import { add, allocate, isZero, minor, mulDiv, subtract, sum, ZERO, type Minor } from '@/domain/money';
import { qty as makeQty, QTY_SCALE, type Qty } from '@/domain/quantity';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import { postJournalEntry, type Actor } from './journal.service';
import { recordStockMovement } from './inventory.service';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';
import { batchSplitBySaleItem, getSaleOutstanding } from './sale.service';
import { batchSplitByPurchaseItem } from './purchase.service';
import {
  readPurchaseTaxes,
  readSaleTaxes,
  taxAccountFor,
  writePurchaseTaxes,
  writeSaleTaxes,
} from './tax.service';
import { taxShareOf } from '@/domain/tax/components';

/**
 * Returns — goods coming back, in either direction.
 *
 * A return is a NEW document linked to the original, never an edit of it. The
 * original sale or purchase keeps saying exactly what happened on the day, and
 * the return says what happened afterwards.
 *
 * Partial returns are supported, and each line tracks how much has already come
 * back so the same goods cannot be returned twice.
 */

export interface ReturnLineRequest {
  /** The ORIGINAL sale_item / purchase_item being returned against. */
  itemId: number;
  qty: Qty;
}

export interface CreateReturnInput {
  businessDate: string;
  items: ReturnLineRequest[];
  /** Money handed back now. Left empty, the debt is reduced instead. */
  refunds?: { paymentAccountId: number; amount: Minor }[];
  reason?: string | undefined;
  occurredAt?: Date;
  isDemo?: boolean;
}

function accountIdByCode(tx: Tx, code: string): number {
  const account = tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code)).get();
  if (!account) throw new NotFoundError('Account', code);
  return account.id;
}

// ==========================================================================
// CUSTOMER RETURN — a customer brings goods back
// ==========================================================================

/**
 * Stock comes back in at the cost it left at (prorated from the original sale
 * line), so a return neither creates nor destroys profit. Revenue is reduced
 * through the Sales Returns contra account rather than by editing the sale.
 */
export function createCustomerReturn(
  db: Db,
  originalSaleId: number,
  input: CreateReturnInput,
  actor: Actor,
): { returnSaleId: number; receiptNo: string; refunded: Minor; creditApplied: Minor } {
  if (input.items.length === 0) {
    throw new ValidationError('Choose at least one item to return.');
  }

  return writeTransaction(db, (tx) => {
    const occurredAt = input.occurredAt ?? new Date();

    const original = tx.select().from(sales).where(eq(sales.id, originalSaleId)).get();
    if (!original) throw new NotFoundError('Sale', originalSaleId);
    if (original.status === 'VOIDED') {
      throw new ConflictError('That sale was voided, so there is nothing to return.');
    }
    if (original.kind !== 'SALE') {
      throw new ConflictError('Returns can only be made against an original sale.');
    }

    const receiptNo = nextDocumentNumber(tx, DOC_TYPES.SALE_RETURN);

    /**
     * Reproduce the invoice-level discount allocation from the original sale.
     *
     * `sale_items.lineTotalMinor` is recorded BEFORE any invoice-wide discount,
     * so refunding straight from it would hand back more than the customer
     * actually paid. `allocate` is deterministic, so running it again over the
     * same line totals reproduces exactly the split made at the time of sale.
     */
    const originalLines = tx
      .select()
      .from(saleItems)
      .where(eq(saleItems.saleId, originalSaleId))
      .orderBy(asc(saleItems.lineNo))
      .all();

    const invoiceDiscount = minor(original.discountMinor);
    const discountShares = isZero(invoiceDiscount)
      ? originalLines.map(() => ZERO)
      : allocate(
          invoiceDiscount,
          originalLines.map((line) => line.lineTotalMinor),
        );

    const netByItemId = new Map<number, Minor>(
      originalLines.map((line, index) => [
        line.id,
        subtract(minor(line.lineTotalMinor), discountShares[index] ?? ZERO),
      ]),
    );

    // --- validate each line against what is still returnable -------------
    const resolved = input.items.map((request) => {
      const item = tx.select().from(saleItems).where(eq(saleItems.id, request.itemId)).get();
      if (!item) throw new NotFoundError('Sale item', request.itemId);
      if (item.saleId !== originalSaleId) {
        throw new ValidationError('That item is not part of this sale.');
      }
      if (request.qty <= 0) {
        throw new ValidationError('Return quantity must be greater than zero.');
      }

      const alreadyReturned = makeQty(item.returnedQtyMilli);
      const returnable = makeQty(item.qtyMilli - alreadyReturned);
      if (request.qty > returnable) {
        throw new ValidationError(
          `Only ${formatQtyLabel(returnable)} of ${item.productName} can still be returned.`,
          { returnable, requested: request.qty },
        );
      }

      // Prorate revenue from the line's NET value (after its share of any
      // invoice-wide discount), and cost from the snapshot, so a partial
      // return takes back exactly what was paid and exactly what it cost.
      const netLineTotal = netByItemId.get(item.id) ?? minor(item.lineTotalMinor);
      const revenueShare = mulDiv(netLineTotal, request.qty, item.qtyMilli);
      const costShare = mulDiv(minor(item.totalCostMinor), request.qty, item.qtyMilli);

      return { request, item, revenueShare, costShare };
    });

    const totalRevenue = sum(resolved.map((line) => line.revenueShare));
    const totalCost = sum(resolved.map((line) => line.costShare));

    if (isZero(totalRevenue) && isZero(totalCost)) {
      throw new ValidationError('This return has no value to record.');
    }

    /**
     * The tax goes back with the goods.
     *
     * A shop collects tax on the authority's behalf. When the goods come back
     * the sale did not happen, so neither did the tax on it: the shop stops
     * owing it, and a credit customer stops being charged it. Left unreversed
     * — which it was — a fully returned sale left the shop with a liability to
     * the taxman for a sale it never made, and the customer still owing the tax
     * on goods sitting back on the shelf.
     *
     * Taken from the tax the ORIGINAL sale actually charged, apportioned by how
     * much of it is coming back. Re-applying today's rate would be wrong twice:
     * the rate may have changed since, and the sale may have been priced the
     * other way round.
     */
    const saleNetRevenue = sum([...netByItemId.values()]);

    /**
     * Component by component, not as one figure.
     *
     * NHIL, the GETFund levy and VAT are three separate obligations sitting in
     * three separate accounts, and only VAT can be set against what was paid on
     * purchases. Handing back a single lump would leave the levy accounts
     * holding tax on goods that came back, and the VAT account short.
     */
    const chargedLines = readSaleTaxes(tx, originalSaleId).map((row) => ({
      code: row.code,
      name: row.name,
      rateBp: row.rateBp,
      basis: row.basis,
      isRecoverable: false,
      componentId: row.componentId,
      amount: minor(row.amountMinor),
    }));

    // `taxShareOf` returns the domain's own line shape, so the component ids
    // are zipped back on by position — the shares come out in the order they
    // went in, one for one.
    const returnedLines =
      chargedLines.length === 0 || saleNetRevenue === 0
        ? []
        : taxShareOf(chargedLines, totalRevenue, minor(saleNetRevenue)).map((line, index) => ({
            ...line,
            componentId: chargedLines[index]?.componentId ?? null,
          }));

    const taxShare = isZero(minor(original.taxMinor))
      ? ZERO
      : sum(returnedLines.map((line) => line.amount));

    /**
     * Where prices INCLUDED tax, `totalRevenue` already contains it, so the tax
     * is split back out of that figure rather than added to it. Where prices
     * excluded it, the tax sat on top and comes off on top.
     */
    const returnedValue = original.taxInclusive ? totalRevenue : add(totalRevenue, taxShare);
    const revenueReversed = original.taxInclusive
      ? subtract(totalRevenue, taxShare)
      : totalRevenue;

    // --- the return document ---------------------------------------------
    const returnSale = tx
      .insert(sales)
      .values({
        receiptNo,
        kind: 'RETURN',
        returnsSaleId: originalSaleId,
        customerId: original.customerId,
        businessDate: input.businessDate,
        occurredAt,
        // Mirror figures, net of tax like every other sale document, so
        // subtotal - discount + tax = total holds here too.
        subtotalMinor: -revenueReversed,
        discountMinor: 0,
        taxMinor: -taxShare,
        totalMinor: -returnedValue,
        taxInclusive: original.taxInclusive,
        cogsMinor: -totalCost,
        status: 'POSTED',
        note: input.reason ?? `Return against ${original.receiptNo}`,
        createdBy: actor.id,
        isDemo: input.isDemo ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: sales.id })
      .get();

    if (!returnSale) throw new ConflictError('Could not create the return.');

    // Negative, mirroring the document, and snapshotted like the sale's own.
    writeSaleTaxes(
      tx,
      returnSale.id,
      returnedLines.map((line) => ({ ...line, amount: minor(-line.amount) })),
      new Map(
        returnedLines
          .filter((line) => line.componentId !== null)
          .map((line) => [line.code, line.componentId as number]),
      ),
      occurredAt,
    );

    // --- stock back in, at the original cost -----------------------------
    /** Which crates each line of the original receipt was picked from. */
    const soldFrom = batchSplitBySaleItem(tx, originalSaleId);

    resolved.forEach((line, index) => {
      const product = tx
        .select()
        .from(products)
        .where(eq(products.id, line.item.productId))
        .get();

      if (product?.trackInventory && !isZero(line.costShare)) {
        // Goods go back into the crates they were picked from. A partial return
        // is split across them in proportion — see `allocateProportional` —
        // because there is no other defensible answer: put four tins of a line
        // that drew from two crates back into whichever one is handy and the
        // dates on that shelf stop describing the stock.
        const cameFrom = soldFrom.get(line.item.id);

        recordStockMovement(tx, {
          productId: line.item.productId,
          direction: 'IN',
          qty: line.request.qty,
          totalCost: line.costShare,
          ...(cameFrom === undefined
            ? {}
            : { batch: { kind: 'SOURCE' as const, allocations: cameFrom } }),
          movementType: 'SALE_RETURN',
          sourceType: 'SALE_RETURN',
          sourceId: returnSale.id,
          sourceRef: receiptNo,
          businessDate: input.businessDate,
          occurredAt,
          userId: actor.id,
          note: `Return against ${original.receiptNo}`,
          isDemo: input.isDemo ?? false,
        });
      }

      tx.insert(saleItems)
        .values({
          saleId: returnSale.id,
          lineNo: index + 1,
          productId: line.item.productId,
          productName: line.item.productName,
          unit: line.item.unit,
          qtyMilli: -line.request.qty,
          unitPriceMinor: line.item.unitPriceMinor,
          discountMinor: 0,
          lineTotalMinor: -line.revenueShare,
          unitCostMinor: line.item.unitCostMinor,
          totalCostMinor: -line.costShare,
          createdAt: occurredAt,
        })
        .run();

      // Mark the original line so the same goods cannot come back twice.
      tx.update(saleItems)
        .set({ returnedQtyMilli: line.item.returnedQtyMilli + line.request.qty })
        .where(eq(saleItems.id, line.item.id))
        .run();
    });

    // --- how the customer is made whole ----------------------------------
    //
    // Refund cash if asked; otherwise reduce what they owe. Never more of
    // either than the return is worth.
    const refunds = input.refunds ?? [];
    const refundTotal = sum(refunds.map((refund) => refund.amount));
    // Measured against what the customer actually paid, tax included — that is
    // what they are owed back.
    if (refundTotal > returnedValue) {
      throw new ValidationError('You cannot refund more than the value of the goods returned.', {
        returnedValue,
        refundTotal,
      });
    }

    const outstandingOnOriginal = getSaleOutstanding(tx, originalSaleId);
    const creditApplied = subtract(returnedValue, refundTotal);

    if (creditApplied > outstandingOnOriginal && original.customerId === null) {
      throw new ValidationError(
        'This sale was paid in full, so the return must be refunded rather than credited.',
        { creditApplied },
      );
    }

    const lines: DraftLine[] = [];

    // Revenue comes back out through the contra account, net of tax.
    if (!isZero(revenueReversed)) {
      lines.push(
        debit(accountIdByCode(tx, ACCOUNT_CODES.SALES_RETURNS), revenueReversed, {
          description: `${receiptNo} goods returned`,
        }),
      );
    }

    // The shop stops owing tax it collected on a sale that did not stand —
    // each component out of the account it went into. A levy handed back
    // through the VAT account would leave both wrong and the return unfileable.
    for (const line of returnedLines) {
      if (isZero(line.amount)) continue;
      lines.push(
        debit(taxAccountFor(tx, line), line.amount, {
          description: `${receiptNo} ${line.name} on goods returned`,
        }),
      );
    }

    for (const refund of refunds) {
      if (refund.amount <= 0) continue;
      const account = tx
        .select()
        .from(paymentAccounts)
        .where(eq(paymentAccounts.id, refund.paymentAccountId))
        .get();
      if (!account) throw new NotFoundError('Payment account', refund.paymentAccountId);

      tx.insert(salePayments)
        .values({
          saleId: returnSale.id,
          paymentAccountId: refund.paymentAccountId,
          amountMinor: -refund.amount,
          reference: `Refund for ${original.receiptNo}`,
          createdAt: occurredAt,
        })
        .run();

      lines.push(
        credit(account.glAccountId, refund.amount, {
          paymentAccountId: refund.paymentAccountId,
          description: `${receiptNo} refunded (${account.name})`,
        }),
      );
    }

    if (!isZero(creditApplied)) {
      lines.push(
        credit(accountIdByCode(tx, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE), creditApplied, {
          ...(original.customerId !== null ? { customerId: original.customerId } : {}),
          description: `${receiptNo} credited to account`,
        }),
      );
    }

    // Stock going back reverses the cost of goods sold.
    if (!isZero(totalCost)) {
      lines.push(
        debit(accountIdByCode(tx, ACCOUNT_CODES.INVENTORY), totalCost, {
          description: `${receiptNo} stock returned`,
        }),
        credit(accountIdByCode(tx, ACCOUNT_CODES.COST_OF_GOODS_SOLD), totalCost, {
          description: `${receiptNo} cost reversed`,
        }),
      );
    }

    const posted = postJournalEntry(
      tx,
      {
        entryDate: input.businessDate,
        sourceType: 'SALE_RETURN',
        sourceId: returnSale.id,
        memo: `${receiptNo} — return against ${original.receiptNo}`,
        lines,
        occurredAt,
        isDemo: input.isDemo ?? false,
      },
      actor,
    );

    tx.update(sales)
      .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
      .where(eq(sales.id, returnSale.id))
      .run();

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'sale_return',
      entityId: returnSale.id,
      userId: actor.id,
      username: actor.username,
      summary: `${receiptNo}: return against ${original.receiptNo}`,
      metadata: {
        revenueMinor: totalRevenue,
        costMinor: totalCost,
        refundedMinor: refundTotal,
        creditedMinor: creditApplied,
        entryNo: posted.entryNo,
      },
      at: occurredAt,
    });

    return {
      returnSaleId: returnSale.id,
      receiptNo,
      refunded: refundTotal,
      creditApplied,
    };
  });
}

// ==========================================================================
// SUPPLIER RETURN — the shop sends goods back
// ==========================================================================

/**
 * Goods leave at the price the SUPPLIER charged, not at the blended weighted
 * average. Returning a cheap delivery therefore correctly leaves the remaining
 * average cost higher, which is what actually happened.
 */
export function createSupplierReturn(
  db: Db,
  originalPurchaseId: number,
  input: CreateReturnInput,
  actor: Actor,
): { returnPurchaseId: number; purchaseNo: string; refunded: Minor; creditApplied: Minor } {
  if (input.items.length === 0) {
    throw new ValidationError('Choose at least one item to return.');
  }

  return writeTransaction(db, (tx) => {
    const occurredAt = input.occurredAt ?? new Date();

    const original = tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, originalPurchaseId))
      .get();
    if (!original) throw new NotFoundError('Purchase', originalPurchaseId);
    if (original.status === 'VOIDED') {
      throw new ConflictError('That purchase was voided, so there is nothing to return.');
    }
    if (original.kind !== 'PURCHASE') {
      throw new ConflictError('Returns can only be made against an original purchase.');
    }

    const settings = tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
    const allowNegative = settings?.allowNegativeStock ?? false;
    const purchaseNo = nextDocumentNumber(tx, DOC_TYPES.PURCHASE_RETURN);

    const resolved = input.items.map((request) => {
      const item = tx
        .select()
        .from(purchaseItems)
        .where(eq(purchaseItems.id, request.itemId))
        .get();
      if (!item) throw new NotFoundError('Purchase item', request.itemId);
      if (item.purchaseId !== originalPurchaseId) {
        throw new ValidationError('That item is not part of this purchase.');
      }
      if (request.qty <= 0) {
        throw new ValidationError('Return quantity must be greater than zero.');
      }

      const returnable = makeQty(item.qtyMilli - item.returnedQtyMilli);
      if (request.qty > returnable) {
        throw new ValidationError(
          `Only ${formatQtyLabel(returnable)} of ${item.productName} can still be returned.`,
        );
      }

      const costShare = mulDiv(minor(item.lineTotalMinor), request.qty, item.qtyMilli);
      return { request, item, costShare };
    });

    const totalCost = sum(resolved.map((line) => line.costShare));
    if (isZero(totalCost)) {
      throw new ValidationError('This return has no value to record.');
    }

    /** Which crate each line of the original delivery filled. */
    const sourceBatches = batchSplitByPurchaseItem(tx, originalPurchaseId);

    /**
     * The tax reclaim goes back with the goods.
     *
     * Tax paid to a supplier is reclaimable, so it was debited to the tax
     * account when the delivery arrived. Send the goods back and there is
     * nothing to reclaim — left behind, it overstates what the tax authority
     * owes the shop, on an invoice the shop did not keep. The mirror of the
     * customer side, and it was missing for the same reason.
     *
     * Apportioned from the tax the original purchase ACTUALLY carried, on the
     * same basis the line costs were prorated from.
     */
    const purchaseNet = subtract(minor(original.subtotalMinor), minor(original.discountMinor));

    /**
     * Apportioned COMPONENT BY COMPONENT, not as one figure.
     *
     * The total was already being mirrored onto the return document, but the
     * per-component rows were not — so `purchase_taxes` still said the shop had
     * paid, and could reclaim, tax on goods it had sent back. Nothing noticed,
     * because the trial balance and every existing report read the total. Only
     * a tax return reads these rows, and it did not exist until now.
     *
     * `isRecoverable` is carried across from the original row rather than read
     * from settings: what the shop could reclaim is a fact about the day the
     * goods were bought.
     */
    const paidLines = readPurchaseTaxes(tx, originalPurchaseId);
    const returnedLines =
      paidLines.length === 0 || purchaseNet === 0
        ? []
        : paidLines.map((row) => ({
            code: row.code,
            name: row.name,
            rateBp: row.rateBp,
            basis: row.basis,
            componentId: row.componentId,
            isRecoverable: row.isRecoverable,
            amount: mulDiv(minor(row.amountMinor), totalCost, purchaseNet),
          }));

    const taxShare =
      returnedLines.length > 0
        ? sum(returnedLines.map((line) => line.amount))
        : isZero(minor(original.taxMinor)) || purchaseNet === 0
          ? ZERO
          : mulDiv(minor(original.taxMinor), totalCost, purchaseNet);

    /** What the supplier owes back: the goods and the tax charged on them. */
    const returnedValue = add(totalCost, taxShare);

    const returnPurchase = tx
      .insert(purchases)
      .values({
        purchaseNo,
        kind: 'RETURN',
        returnsPurchaseId: originalPurchaseId,
        supplierId: original.supplierId,
        businessDate: input.businessDate,
        occurredAt,
        invoiceNo: original.invoiceNo,
        subtotalMinor: -totalCost,
        discountMinor: 0,
        taxMinor: -taxShare,
        totalMinor: -returnedValue,
        status: 'POSTED',
        note: input.reason ?? `Return against ${original.purchaseNo}`,
        createdBy: actor.id,
        isDemo: input.isDemo ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: purchases.id })
      .get();

    if (!returnPurchase) throw new ConflictError('Could not create the return.');

    // Negative, mirroring the document, exactly as the customer side does.
    writePurchaseTaxes(
      tx,
      returnPurchase.id,
      returnedLines.map((line) => ({ ...line, amount: minor(-line.amount) })),
      new Map(
        returnedLines
          .filter((line) => line.componentId !== null)
          .map((line) => [line.code, line.componentId as number]),
      ),
      occurredAt,
    );

    resolved.forEach((line, index) => {
      const product = tx
        .select()
        .from(products)
        .where(eq(products.id, line.item.productId))
        .get();

      if (product?.trackInventory) {
        // And leaves from the crate THIS supplier delivered. Sending back
        // goods means sending back theirs: pick by expiry instead and the shop
        // keeps their dated stock while an older crate goes out of the door.
        const cameFrom = sourceBatches.get(line.item.id);

        recordStockMovement(tx, {
          productId: line.item.productId,
          direction: 'OUT',
          qty: line.request.qty,
          // Leaves at the price THIS supplier charged, not the blended average.
          totalCost: line.costShare,
          ...(cameFrom === undefined
            ? {}
            : { batch: { kind: 'SOURCE' as const, allocations: cameFrom } }),
          movementType: 'PURCHASE_RETURN',
          sourceType: 'PURCHASE_RETURN',
          sourceId: returnPurchase.id,
          sourceRef: purchaseNo,
          businessDate: input.businessDate,
          occurredAt,
          userId: actor.id,
          allowNegative,
          note: `Return to supplier against ${original.purchaseNo}`,
          isDemo: input.isDemo ?? false,
        });
      }

      tx.insert(purchaseItems)
        .values({
          purchaseId: returnPurchase.id,
          lineNo: index + 1,
          productId: line.item.productId,
          productName: line.item.productName,
          unit: line.item.unit,
          qtyMilli: -line.request.qty,
          unitCostMinor: line.item.unitCostMinor,
          discountMinor: 0,
          lineTotalMinor: -line.costShare,
          createdAt: occurredAt,
        })
        .run();

      tx.update(purchaseItems)
        .set({ returnedQtyMilli: line.item.returnedQtyMilli + line.request.qty })
        .where(eq(purchaseItems.id, line.item.id))
        .run();
    });

    const refunds = input.refunds ?? [];
    const refundTotal = sum(refunds.map((refund) => refund.amount));
    // Against what the supplier actually charged, tax included.
    if (refundTotal > returnedValue) {
      throw new ValidationError('The refund cannot be more than the value returned.');
    }
    const creditApplied = subtract(returnedValue, refundTotal);

    const lines: DraftLine[] = [
      credit(accountIdByCode(tx, ACCOUNT_CODES.INVENTORY), totalCost, {
        description: `${purchaseNo} stock returned to supplier`,
      }),
    ];

    // Nothing left to reclaim on goods that went back.
    if (!isZero(taxShare)) {
      lines.push(
        credit(accountIdByCode(tx, ACCOUNT_CODES.TAX_PAYABLE), taxShare, {
          description: `${purchaseNo} tax on goods returned`,
        }),
      );
    }

    for (const refund of refunds) {
      if (refund.amount <= 0) continue;
      const account = tx
        .select()
        .from(paymentAccounts)
        .where(eq(paymentAccounts.id, refund.paymentAccountId))
        .get();
      if (!account) throw new NotFoundError('Payment account', refund.paymentAccountId);

      tx.insert(purchasePayments)
        .values({
          purchaseId: returnPurchase.id,
          paymentAccountId: refund.paymentAccountId,
          amountMinor: -refund.amount,
          reference: `Refund for ${original.purchaseNo}`,
          createdAt: occurredAt,
        })
        .run();

      lines.push(
        debit(account.glAccountId, refund.amount, {
          paymentAccountId: refund.paymentAccountId,
          description: `${purchaseNo} refunded by supplier (${account.name})`,
        }),
      );
    }

    if (!isZero(creditApplied)) {
      lines.push(
        debit(accountIdByCode(tx, ACCOUNT_CODES.ACCOUNTS_PAYABLE), creditApplied, {
          ...(original.supplierId !== null ? { supplierId: original.supplierId } : {}),
          description: `${purchaseNo} credited against what we owe`,
        }),
      );
    }

    const posted = postJournalEntry(
      tx,
      {
        entryDate: input.businessDate,
        sourceType: 'PURCHASE_RETURN',
        sourceId: returnPurchase.id,
        memo: `${purchaseNo} — return against ${original.purchaseNo}`,
        lines,
        occurredAt,
        isDemo: input.isDemo ?? false,
      },
      actor,
    );

    tx.update(purchases)
      .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
      .where(eq(purchases.id, returnPurchase.id))
      .run();

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'purchase_return',
      entityId: returnPurchase.id,
      userId: actor.id,
      username: actor.username,
      summary: `${purchaseNo}: return to supplier against ${original.purchaseNo}`,
      metadata: {
        valueMinor: totalCost,
        refundedMinor: refundTotal,
        creditedMinor: creditApplied,
        entryNo: posted.entryNo,
      },
      at: occurredAt,
    });

    return {
      returnPurchaseId: returnPurchase.id,
      purchaseNo,
      refunded: refundTotal,
      creditApplied,
    };
  });
}

function formatQtyLabel(value: number): string {
  const whole = Math.trunc(value / QTY_SCALE);
  const fraction = Math.abs(value % QTY_SCALE)
    .toString()
    .padStart(3, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

// --- reads ----------------------------------------------------------------

/** Lines from a sale that still have quantity available to return. */
export function getReturnableSaleItems(db: Db, saleId: number) {
  return db
    .select()
    .from(saleItems)
    .where(eq(saleItems.saleId, saleId))
    .all()
    .map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      unit: item.unit,
      qtyMilli: item.qtyMilli,
      returnedQtyMilli: item.returnedQtyMilli,
      returnableMilli: item.qtyMilli - item.returnedQtyMilli,
      unitPriceMinor: item.unitPriceMinor,
    }))
    .filter((item) => item.returnableMilli > 0);
}

export function getReturnablePurchaseItems(db: Db, purchaseId: number) {
  return db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, purchaseId))
    .all()
    .map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      unit: item.unit,
      qtyMilli: item.qtyMilli,
      returnedQtyMilli: item.returnedQtyMilli,
      returnableMilli: item.qtyMilli - item.returnedQtyMilli,
      unitCostMinor: item.unitCostMinor,
    }))
    .filter((item) => item.returnableMilli > 0);
}

/** Total value of goods returned by customers in a period. */
export function getSalesReturnsTotal(db: Db, from: string, to: string): Minor {
  const row = db
    .select({ total: sql<number>`COALESCE(SUM(-${sales.totalMinor}), 0)` })
    .from(sales)
    .where(
      sql`${sales.kind} = 'RETURN' AND ${sales.businessDate} >= ${from} AND ${sales.businessDate} <= ${to} AND ${sales.status} = 'POSTED'`,
    )
    .get();
  return minor(row?.total ?? 0);
}
