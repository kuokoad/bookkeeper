import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';

import type { Db } from '@/db/types';
import {
  categories,
  customers,
  paymentAccounts,
  products,
  purchaseItems,
  purchases,
  saleItems,
  salePayments,
  sales,
  stockLedger,
  suppliers,
} from '@/db/schema';
import { averageUnitCost, isLowStock, isOutOfStock } from '@/domain/inventory/costing';
import { minor, subtract, sum, type Minor } from '@/domain/money';
import { qty as makeQty, type Qty } from '@/domain/quantity';
import { getLowStockThreshold } from '../catalog.service';

/**
 * Operational reports — what sold, what was bought, what is on the shelf.
 *
 * These read the sale/purchase documents and the stock ledger rather than the
 * general ledger, because the questions are about goods and quantities, not
 * about accounts. The money figures still tie back: total sales here equals
 * revenue on the Profit & Loss for the same period.
 */

/**
 * The outer report row's own columns, written out with their table name.
 *
 * Drizzle omits the table qualifier for a query's primary table when the query
 * has no joins, so a bare interpolation can render as an unqualified column
 * name — which SQLite then binds to the SUBQUERY's table, quietly turning a
 * correlated subquery into an uncorrelated one that returns the same plausible
 * number for every row. See the note on listCategories in catalog.service.ts,
 * which hit the same thing. Writing the qualifier out means these fragments
 * cannot depend on the shape of the query they land in.
 */
const SALE_ID = sql`sales.id`;
const PURCHASE_ID = sql`purchases.id`;
const VALUATION_PRODUCT_ID = sql`products.id`;

export interface Period {
  from: string;
  to: string;
}

/**
 * What a sales report can be narrowed to, on top of its dates.
 *
 * Two of these behave differently depending on the table, and the difference is
 * worth stating plainly because a reader will otherwise assume the tables add
 * up to each other:
 *
 *   - `customerId` and `paymentAccountId` are properties of the SALE, so they
 *     mean the same thing everywhere.
 *   - `productId` and `categoryId` are properties of a LINE. On the by-product
 *     and by-category tables they narrow to the matching lines, which is what
 *     "sales of Coca-Cola" means there. On the sale-level tables — by day, by
 *     customer, by payment method — they narrow to sales that CONTAIN that
 *     product, and the figures remain whole-sale figures, because half a
 *     receipt has no tax, no invoice discount and no tender of its own to
 *     report. The report page says so above the tables.
 */
export interface SalesReportQuery extends Period {
  customerId?: number;
  productId?: number;
  categoryId?: number;
  paymentAccountId?: number;
}

/**
 * Every sale document dated in the period, whatever became of it.
 *
 * Corrections and returns carry negative figures, so including them is what
 * makes the totals net out; and a sale that was later voided still stands in
 * the period it happened in, because voiding writes a mirror document on the
 * day of the correction rather than reaching back into a finished day.
 *
 * An earlier version excluded both the voided original AND the mirror. That
 * removed the sale from the day it was made and the refund from the day it was
 * refunded, so each day's takings disagreed with the Profit & Loss by the whole
 * sale — while a range spanning both days still looked right, because the two
 * errors cancelled. The docblock above promises these figures tie back to the
 * accounts; this is what keeps that promise true.
 */
const salesDatedIn = (query: SalesReportQuery) => {
  const conditions = [gte(sales.businessDate, query.from), lte(sales.businessDate, query.to)];

  if (query.customerId !== undefined) conditions.push(eq(sales.customerId, query.customerId));

  if (query.paymentAccountId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = ${SALE_ID}
                  AND sp.payment_account_id = ${query.paymentAccountId})`,
    );
  }

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

  return and(...conditions);
};

/**
 * The same window, narrowed to the LINES that match rather than the sales that
 * contain them. Used by the by-product and by-category tables.
 */
const linesMatching = (query: SalesReportQuery) => {
  const conditions = [
    gte(sales.businessDate, query.from),
    lte(sales.businessDate, query.to),
  ];

  if (query.customerId !== undefined) conditions.push(eq(sales.customerId, query.customerId));

  if (query.paymentAccountId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = ${SALE_ID}
                  AND sp.payment_account_id = ${query.paymentAccountId})`,
    );
  }

  if (query.productId !== undefined) conditions.push(eq(saleItems.productId, query.productId));
  if (query.categoryId !== undefined) conditions.push(eq(products.categoryId, query.categoryId));

  return and(...conditions);
};

/**
 * How many sales were rung up — corrections and returns are not sales made.
 * Counted separately from the money for that reason.
 */
const saleCount = sql<number>`COALESCE(SUM(CASE WHEN ${sales.kind} = 'SALE' THEN 1 ELSE 0 END), 0)`;

// --- sales ----------------------------------------------------------------

export interface SalesByDay {
  businessDate: string;
  saleCount: number;
  /** Takings: what customers actually paid, tax included. */
  total: Minor;
  /** The part of the takings that is owed to the tax authority. */
  tax: Minor;
  /** total - tax. What the shop earned, and what the Profit & Loss reports. */
  net: Minor;
  cogs: Minor;
  /** net - cogs. Tax is money held for somebody else, never profit. */
  profit: Minor;
}

export function getSalesByDay(db: Db, query: SalesReportQuery): SalesByDay[] {
  return db
    .select({
      businessDate: sales.businessDate,
      saleCount,
      total: sql<number>`COALESCE(SUM(${sales.totalMinor}), 0)`,
      tax: sql<number>`COALESCE(SUM(${sales.taxMinor}), 0)`,
      cogs: sql<number>`COALESCE(SUM(${sales.cogsMinor}), 0)`,
    })
    .from(sales)
    .where(salesDatedIn(query))
    .groupBy(sales.businessDate)
    .orderBy(asc(sales.businessDate))
    .all()
    .map((row) => {
      // Tax is collected on the authority's behalf, so it is neither earnings
      // nor profit. Counted as either, a taxed shop reads its own margin as
      // the whole tax take better than it is.
      const net = subtract(minor(row.total), minor(row.tax));
      return {
        businessDate: row.businessDate,
        saleCount: row.saleCount,
        total: minor(row.total),
        tax: minor(row.tax),
        net,
        cogs: minor(row.cogs),
        profit: subtract(net, minor(row.cogs)),
      };
    });
}

export interface SalesByProduct {
  productId: number;
  productName: string;
  unit: string;
  categoryName: string | null;
  qtySold: Qty;
  revenue: Minor;
  cost: Minor;
  profit: Minor;
  marginBp: number | null;
}

export function getSalesByProduct(db: Db, query: SalesReportQuery): SalesByProduct[] {
  return db
    .select({
      productId: saleItems.productId,
      productName: saleItems.productName,
      unit: saleItems.unit,
      categoryName: categories.name,
      qtySold: sql<number>`COALESCE(SUM(${saleItems.qtyMilli}), 0)`,
      revenue: sql<number>`COALESCE(SUM(${saleItems.lineTotalMinor}), 0)`,
      cost: sql<number>`COALESCE(SUM(${saleItems.totalCostMinor}), 0)`,
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .leftJoin(products, eq(products.id, saleItems.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(linesMatching(query))
    .groupBy(saleItems.productId)
    .orderBy(desc(sql`SUM(${saleItems.lineTotalMinor})`))
    .all()
    .map((row) => {
      const revenue = minor(row.revenue);
      const cost = minor(row.cost);
      const profit = subtract(revenue, cost);
      return {
        productId: row.productId,
        productName: row.productName,
        unit: row.unit,
        categoryName: row.categoryName,
        qtySold: makeQty(row.qtySold),
        revenue,
        cost,
        profit,
        marginBp: revenue === 0 ? null : Math.round((profit / revenue) * 10_000),
      };
    });
}

export interface SalesByCategory {
  categoryId: number | null;
  categoryName: string;
  revenue: Minor;
  cost: Minor;
  profit: Minor;
}

export function getSalesByCategory(db: Db, query: SalesReportQuery): SalesByCategory[] {
  return db
    .select({
      categoryId: products.categoryId,
      categoryName: categories.name,
      revenue: sql<number>`COALESCE(SUM(${saleItems.lineTotalMinor}), 0)`,
      cost: sql<number>`COALESCE(SUM(${saleItems.totalCostMinor}), 0)`,
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .leftJoin(products, eq(products.id, saleItems.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(linesMatching(query))
    .groupBy(products.categoryId)
    .orderBy(desc(sql`SUM(${saleItems.lineTotalMinor})`))
    .all()
    .map((row) => ({
      categoryId: row.categoryId,
      categoryName: row.categoryName ?? 'Uncategorised',
      revenue: minor(row.revenue),
      cost: minor(row.cost),
      profit: subtract(minor(row.revenue), minor(row.cost)),
    }));
}

export interface SalesByCustomer {
  customerId: number | null;
  customerName: string;
  saleCount: number;
  total: Minor;
  profit: Minor;
}

export function getSalesByCustomer(db: Db, query: SalesReportQuery): SalesByCustomer[] {
  return db
    .select({
      customerId: sales.customerId,
      customerName: customers.name,
      saleCount,
      total: sql<number>`COALESCE(SUM(${sales.totalMinor}), 0)`,
      cogs: sql<number>`COALESCE(SUM(${sales.cogsMinor}), 0)`,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(salesDatedIn(query))
    .groupBy(sales.customerId)
    .orderBy(desc(sql`SUM(${sales.totalMinor})`))
    .all()
    .map((row) => ({
      customerId: row.customerId,
      customerName: row.customerName ?? 'Walk-in customers',
      saleCount: row.saleCount,
      total: minor(row.total),
      profit: subtract(minor(row.total), minor(row.cogs)),
    }));
}

export interface SalesByPaymentMethod {
  paymentAccountId: number;
  accountName: string;
  kind: string;
  received: Minor;
}

/**
 * What was taken at the till, per method.
 *
 * This counts TENDER, not sale totals, so a credit sale contributes only what
 * was actually handed over. The figures therefore tie to the money accounts,
 * not to revenue.
 */
export function getSalesByPaymentMethod(db: Db, query: SalesReportQuery): SalesByPaymentMethod[] {
  return db
    .select({
      paymentAccountId: salePayments.paymentAccountId,
      accountName: paymentAccounts.name,
      kind: paymentAccounts.kind,
      received: sql<number>`COALESCE(SUM(${salePayments.amountMinor}), 0)`,
    })
    .from(salePayments)
    .innerJoin(sales, eq(sales.id, salePayments.saleId))
    .innerJoin(paymentAccounts, eq(paymentAccounts.id, salePayments.paymentAccountId))
    // Voiding mirrors the tender as a negative, putting the money back into the
    // account it came from. Excluding the voided original while keeping that
    // mirror showed a till that had paid out money it never took in.
    .where(salesDatedIn(query))
    .groupBy(salePayments.paymentAccountId)
    .orderBy(desc(sql`SUM(${salePayments.amountMinor})`))
    .all()
    .map((row) => ({
      paymentAccountId: row.paymentAccountId,
      accountName: row.accountName,
      kind: row.kind,
      received: minor(row.received),
    }));
}

// --- purchases ------------------------------------------------------------

/**
 * What a purchase report can be narrowed to, on top of its dates.
 *
 * `productId` and `categoryId` behave the same way they do on the sales side:
 * matching LINES on the by-product table, deliveries CONTAINING them on the
 * sale-level tables. See `SalesReportQuery` for why.
 */
export interface PurchaseReportQuery extends Period {
  supplierId?: number;
  productId?: number;
  categoryId?: number;
  paymentAccountId?: number;
}

const postedPurchases = () =>
  and(eq(purchases.status, 'POSTED'), eq(purchases.kind, 'PURCHASE'));

function purchasesDatedIn(query: PurchaseReportQuery) {
  const conditions = [
    postedPurchases(),
    gte(purchases.businessDate, query.from),
    lte(purchases.businessDate, query.to),
  ];

  if (query.supplierId !== undefined) conditions.push(eq(purchases.supplierId, query.supplierId));

  if (query.paymentAccountId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM purchase_payments pp WHERE pp.purchase_id = ${PURCHASE_ID}
                  AND pp.payment_account_id = ${query.paymentAccountId})`,
    );
  }

  if (query.productId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${purchaseItems}
                  WHERE ${purchaseItems.purchaseId} = ${PURCHASE_ID}
                    AND ${purchaseItems.productId} = ${query.productId})`,
    );
  }

  if (query.categoryId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${purchaseItems}
                  JOIN ${products} ON ${products.id} = ${purchaseItems.productId}
                  WHERE ${purchaseItems.purchaseId} = ${PURCHASE_ID}
                    AND ${products.categoryId} = ${query.categoryId})`,
    );
  }

  return and(...conditions);
}

/** The same window, narrowed to the matching purchase LINES. */
function purchaseLinesMatching(query: PurchaseReportQuery) {
  const conditions = [
    postedPurchases(),
    gte(purchases.businessDate, query.from),
    lte(purchases.businessDate, query.to),
  ];

  if (query.supplierId !== undefined) conditions.push(eq(purchases.supplierId, query.supplierId));

  if (query.paymentAccountId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM purchase_payments pp WHERE pp.purchase_id = ${PURCHASE_ID}
                  AND pp.payment_account_id = ${query.paymentAccountId})`,
    );
  }

  if (query.productId !== undefined) {
    conditions.push(eq(purchaseItems.productId, query.productId));
  }

  if (query.categoryId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${products}
                  WHERE ${products.id} = ${purchaseItems.productId}
                    AND ${products.categoryId} = ${query.categoryId})`,
    );
  }

  return and(...conditions);
}

export interface PurchasesBySupplier {
  supplierId: number | null;
  supplierName: string;
  purchaseCount: number;
  total: Minor;
}

export function getPurchasesBySupplier(db: Db, query: PurchaseReportQuery): PurchasesBySupplier[] {
  return db
    .select({
      supplierId: purchases.supplierId,
      supplierName: suppliers.name,
      purchaseCount: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${purchases.totalMinor}), 0)`,
    })
    .from(purchases)
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(purchasesDatedIn(query))
    .groupBy(purchases.supplierId)
    .orderBy(desc(sql`SUM(${purchases.totalMinor})`))
    .all()
    .map((row) => ({
      supplierId: row.supplierId,
      supplierName: row.supplierName ?? 'Unknown',
      purchaseCount: row.purchaseCount,
      total: minor(row.total),
    }));
}

export interface PurchasesByProduct {
  productId: number;
  productName: string;
  unit: string;
  qtyBought: Qty;
  total: Minor;
}

export function getPurchasesByProduct(db: Db, query: PurchaseReportQuery): PurchasesByProduct[] {
  return db
    .select({
      productId: purchaseItems.productId,
      productName: purchaseItems.productName,
      unit: purchaseItems.unit,
      qtyBought: sql<number>`COALESCE(SUM(${purchaseItems.qtyMilli}), 0)`,
      total: sql<number>`COALESCE(SUM(${purchaseItems.lineTotalMinor}), 0)`,
    })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
    .where(purchaseLinesMatching(query))
    .groupBy(purchaseItems.productId)
    .orderBy(desc(sql`SUM(${purchaseItems.lineTotalMinor})`))
    .all()
    .map((row) => ({
      productId: row.productId,
      productName: row.productName,
      unit: row.unit,
      qtyBought: makeQty(row.qtyBought),
      total: minor(row.total),
    }));
}

export interface PurchasesByDay {
  businessDate: string;
  purchaseCount: number;
  total: Minor;
}

export function getPurchasesByDay(db: Db, query: PurchaseReportQuery): PurchasesByDay[] {
  return db
    .select({
      businessDate: purchases.businessDate,
      purchaseCount: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${purchases.totalMinor}), 0)`,
    })
    .from(purchases)
    .where(purchasesDatedIn(query))
    .groupBy(purchases.businessDate)
    .orderBy(asc(purchases.businessDate))
    .all()
    .map((row) => ({
      businessDate: row.businessDate,
      purchaseCount: row.purchaseCount,
      total: minor(row.total),
    }));
}

// --- inventory ------------------------------------------------------------

export interface StockValuationRow {
  productId: number;
  productName: string;
  sku: string | null;
  unit: string;
  categoryName: string | null;
  qtyOnHand: Qty;
  averageCost: Minor;
  stockValue: Minor;
  sellingPrice: Minor;
  /** What it would fetch if it all sold at the current price. */
  retailValue: Minor;
  potentialProfit: Minor;
  minStock: Qty | null;
  lowStock: boolean;
  outOfStock: boolean;
}

export interface StockValuation {
  rows: StockValuationRow[];
  totalCostValue: Minor;
  totalRetailValue: Minor;
  totalPotentialProfit: Minor;
  lowStockCount: number;
  outOfStockCount: number;
}

export interface StockValuationQuery {
  categoryId?: number;
  /** Products this supplier has ever delivered. */
  supplierId?: number;
  stockStatus?: 'in-stock' | 'low' | 'out' | 'negative';
}

export function getStockValuation(db: Db, query: StockValuationQuery = {}): StockValuation {
  const fallbackMin = getLowStockThreshold(db);
  const threshold = sql`COALESCE(${products.minStockMilli}, ${fallbackMin})`;

  const conditions = [eq(products.isActive, true), eq(products.trackInventory, true)];

  if (query.categoryId !== undefined) conditions.push(eq(products.categoryId, query.categoryId));

  if (query.supplierId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${purchaseItems}
                  JOIN ${purchases} ON ${purchases.id} = ${purchaseItems.purchaseId}
                  WHERE ${purchaseItems.productId} = ${VALUATION_PRODUCT_ID}
                    AND ${purchases.supplierId} = ${query.supplierId})`,
    );
  }

  /*
    Filtered in SQL, so the totals under the table are the totals OF the table.
    Narrowing the rows in JavaScript afterwards would leave a stock valuation
    that says one thing in its rows and another in its footer.
  */
  switch (query.stockStatus) {
    case 'low':
      conditions.push(sql`${products.qtyOnHandMilli} <= ${threshold}`);
      break;
    case 'out':
      conditions.push(sql`${products.qtyOnHandMilli} <= 0`);
      break;
    case 'negative':
      conditions.push(sql`${products.qtyOnHandMilli} < 0`);
      break;
    case 'in-stock':
      conditions.push(sql`${products.qtyOnHandMilli} > ${threshold}`);
      break;
    default:
      break;
  }

  const rows = db
    .select({
      productId: products.id,
      productName: products.name,
      sku: products.sku,
      unit: products.unit,
      categoryName: categories.name,
      qtyOnHandMilli: products.qtyOnHandMilli,
      stockValueMinor: products.stockValueMinor,
      sellingPriceMinor: products.sellingPriceMinor,
      minStockMilli: products.minStockMilli,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(and(...conditions))
    .orderBy(asc(products.name))
    .all()
    .map((row): StockValuationRow => {
      const qtyOnHand = makeQty(row.qtyOnHandMilli);
      const stockValue = minor(row.stockValueMinor);
      const sellingPrice = minor(row.sellingPriceMinor);
      const minStock = row.minStockMilli === null ? null : makeQty(row.minStockMilli);
      // qty x price, in milli-units, rounded to the pesewa.
      const retailValue = minor(Math.round((sellingPrice * qtyOnHand) / 1000));

      return {
        productId: row.productId,
        productName: row.productName,
        sku: row.sku,
        unit: row.unit,
        categoryName: row.categoryName,
        qtyOnHand,
        averageCost: averageUnitCost({ qty: qtyOnHand, value: stockValue }),
        stockValue,
        sellingPrice,
        retailValue,
        potentialProfit: subtract(retailValue, stockValue),
        minStock,
        lowStock: isLowStock(qtyOnHand, minStock, fallbackMin),
        outOfStock: isOutOfStock(qtyOnHand),
      };
    });

  return {
    rows,
    totalCostValue: sum(rows.map((row) => row.stockValue)),
    totalRetailValue: sum(rows.map((row) => row.retailValue)),
    totalPotentialProfit: sum(rows.map((row) => row.potentialProfit)),
    lowStockCount: rows.filter((row) => row.lowStock && !row.outOfStock).length,
    outOfStockCount: rows.filter((row) => row.outOfStock).length,
  };
}

export interface StockMovementSummary {
  productId: number;
  productName: string;
  unit: string;
  qtyIn: Qty;
  qtyOut: Qty;
  netQty: Qty;
  valueIn: Minor;
  valueOut: Minor;
  closingQty: Qty;
  closingValue: Minor;
}

/** How much of each product moved in a period, and which way. */
export function getStockMovementSummary(db: Db, period: Period): StockMovementSummary[] {
  return db
    .select({
      productId: stockLedger.productId,
      productName: products.name,
      unit: products.unit,
      qtyIn: sql<number>`COALESCE(SUM(${stockLedger.qtyInMilli}), 0)`,
      qtyOut: sql<number>`COALESCE(SUM(${stockLedger.qtyOutMilli}), 0)`,
      valueIn: sql<number>`COALESCE(SUM(CASE WHEN ${stockLedger.qtyInMilli} > 0 THEN ${stockLedger.totalCostMinor} ELSE 0 END), 0)`,
      valueOut: sql<number>`COALESCE(SUM(CASE WHEN ${stockLedger.qtyOutMilli} > 0 THEN ${stockLedger.totalCostMinor} ELSE 0 END), 0)`,
      closingQty: products.qtyOnHandMilli,
      closingValue: products.stockValueMinor,
    })
    .from(stockLedger)
    .innerJoin(products, eq(products.id, stockLedger.productId))
    .where(
      and(
        gte(stockLedger.businessDate, period.from),
        lte(stockLedger.businessDate, period.to),
      ),
    )
    .groupBy(stockLedger.productId)
    .orderBy(asc(products.name))
    .all()
    .map((row) => ({
      productId: row.productId,
      productName: row.productName,
      unit: row.unit,
      qtyIn: makeQty(row.qtyIn),
      qtyOut: makeQty(row.qtyOut),
      netQty: makeQty(row.qtyIn - row.qtyOut),
      valueIn: minor(row.valueIn),
      valueOut: minor(row.valueOut),
      closingQty: makeQty(row.closingQty),
      closingValue: minor(row.closingValue),
    }));
}
