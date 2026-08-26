import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { purchaseTaxes, purchases, saleTaxes, sales } from '@/db/schema';
import { add, minor, subtract, sum, ZERO, type Minor } from '@/domain/money';
import type { Period } from './operations.service';

/**
 * What the shop owes the tax authority for a period.
 *
 * Ghana charges several taxes on the same sale — NHIL, the GETFund levy and VAT
 * — and they are separate obligations, so this reports each one separately and
 * never as a single "tax" figure. What a shop hands to the GRA it must be able
 * to defend line by line.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES, and each of them is a decision somebody could get wrong.
 *
 * 1. EVERY tax row counts, whatever the document's status.
 *
 *    A void does not delete the sale it cancels. The original keeps its
 *    positive tax rows on its own date, and a mirror document carries the
 *    negatives on the day of the void. That is not an inconvenience to work
 *    around — it is how VAT works. Tax declared in a period that has been filed
 *    cannot be un-declared; it is adjusted in the period the cancellation
 *    happened. Filtering out `status = 'VOIDED'` would drop the original and
 *    keep the mirror, turning a cancelled sale into a negative liability.
 *
 * 2. Input tax is only reclaimable if it WAS reclaimable on the day.
 *
 *    `purchase_taxes.isRecoverable` is snapshotted per row. Ghana made NHIL and
 *    GETFund deductible on 1 January 2026 and did not make it retrospective, so
 *    reading today's setting would reclaim levies on deliveries that never
 *    carried the right.
 *
 * 3. Non-reclaimable input tax is REPORTED, not hidden.
 *
 *    It went into the cost of the goods and out through cost of sales. An owner
 *    who cannot see it will wonder why the return does not match the tax the
 *    shop actually paid.
 * ---------------------------------------------------------------------------
 *
 * Dated by BUSINESS DATE, like every other report here: the day the shop says
 * it traded, not the moment a row reached the database.
 */

export interface TaxReturnComponent {
  code: string;
  name: string;
  /** Tax charged to customers, net of returns and voids in this period. */
  outputMinor: Minor;
  /** Tax paid to suppliers that may be reclaimed, net of returns and voids. */
  recoverableInputMinor: Minor;
  /** Tax paid to suppliers that may NOT be — it is in the cost of the goods. */
  nonRecoverableInputMinor: Minor;
  /** Output less recoverable input. Positive is owed; negative is reclaimable. */
  netMinor: Minor;
}

export interface TaxReturn {
  period: Period;
  components: TaxReturnComponent[];
  totalOutput: Minor;
  totalRecoverableInput: Minor;
  totalNonRecoverableInput: Minor;
  /** What the shop owes. Negative means the authority owes the shop. */
  netPayable: Minor;
  /** Sales value the tax was charged on, for the box the return asks for. */
  taxableSalesMinor: Minor;
  /** Purchase value the input tax was paid on. */
  taxablePurchasesMinor: Minor;
  /** Documents behind the figures, so somebody can check one. */
  saleCount: number;
  purchaseCount: number;
}

export function getTaxReturn(db: Db, period: Period): TaxReturn {
  const inPeriod = <T extends typeof sales | typeof purchases>(table: T) =>
    and(gte(table.businessDate, period.from), lte(table.businessDate, period.to));

  const output = db
    .select({
      code: saleTaxes.code,
      name: saleTaxes.name,
      amount: sql<number>`COALESCE(SUM(${saleTaxes.amountMinor}), 0)`,
    })
    .from(saleTaxes)
    .innerJoin(sales, eq(sales.id, saleTaxes.saleId))
    .where(inPeriod(sales))
    .groupBy(saleTaxes.code)
    .orderBy(asc(saleTaxes.code))
    .all();

  const input = db
    .select({
      code: purchaseTaxes.code,
      name: purchaseTaxes.name,
      isRecoverable: purchaseTaxes.isRecoverable,
      amount: sql<number>`COALESCE(SUM(${purchaseTaxes.amountMinor}), 0)`,
    })
    .from(purchaseTaxes)
    .innerJoin(purchases, eq(purchases.id, purchaseTaxes.purchaseId))
    .where(inPeriod(purchases))
    .groupBy(purchaseTaxes.code, purchaseTaxes.isRecoverable)
    .orderBy(asc(purchaseTaxes.code))
    .all();

  const byCode = new Map<string, TaxReturnComponent>();
  const take = (code: string, name: string): TaxReturnComponent => {
    const existing = byCode.get(code);
    if (existing) return existing;
    const created: TaxReturnComponent = {
      code,
      name,
      outputMinor: ZERO,
      recoverableInputMinor: ZERO,
      nonRecoverableInputMinor: ZERO,
      netMinor: ZERO,
    };
    byCode.set(code, created);
    return created;
  };

  for (const row of output) {
    take(row.code, row.name).outputMinor = minor(row.amount);
  }

  for (const row of input) {
    const component = take(row.code, row.name);
    if (row.isRecoverable) {
      component.recoverableInputMinor = add(component.recoverableInputMinor, minor(row.amount));
    } else {
      component.nonRecoverableInputMinor = add(
        component.nonRecoverableInputMinor,
        minor(row.amount),
      );
    }
  }

  const components = [...byCode.values()]
    .map((component) => ({
      ...component,
      netMinor: subtract(component.outputMinor, component.recoverableInputMinor),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  // The value the tax sat on. Net of discounts, because that is what was
  // charged on, and net of returns for the same reason the tax figures are.
  const salesValue = db
    .select({
      value: sql<number>`COALESCE(SUM(${sales.subtotalMinor} - ${sales.discountMinor}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(sales)
    .where(inPeriod(sales))
    .get();

  const purchasesValue = db
    .select({
      value: sql<number>`COALESCE(SUM(${purchases.subtotalMinor} - ${purchases.discountMinor}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(purchases)
    .where(inPeriod(purchases))
    .get();

  const totalOutput = sum(components.map((component) => component.outputMinor));
  const totalRecoverableInput = sum(components.map((c) => c.recoverableInputMinor));

  return {
    period,
    components,
    totalOutput,
    totalRecoverableInput,
    totalNonRecoverableInput: sum(components.map((c) => c.nonRecoverableInputMinor)),
    netPayable: subtract(totalOutput, totalRecoverableInput),
    taxableSalesMinor: minor(salesValue?.value ?? 0),
    taxablePurchasesMinor: minor(purchasesValue?.value ?? 0),
    saleCount: salesValue?.count ?? 0,
    purchaseCount: purchasesValue?.count ?? 0,
  };
}
