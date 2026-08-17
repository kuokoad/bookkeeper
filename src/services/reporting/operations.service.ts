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

export interface Period {
  from: string;
  to: string;
}

/** Only real trading counts — voided documents and reversals are excluded. */
const postedSales = () => and(eq(sales.status, 'POSTED'), eq(sales.kind, 'SALE'));

// --- sales ----------------------------------------------------------------

export interface SalesByDay {
  businessDate: string;
  saleCount: number;
  total: Minor;
  cogs: Minor;
  profit: Minor;
}

export function getSalesByDay(db: Db, period: Period): SalesByDay[] {
  return db
    .select({
      businessDate: sales.businessDate,
      saleCount: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${sales.totalMinor}), 0)`,
      cogs: sql<number>`COALESCE(SUM(${sales.cogsMinor}), 0)`,
    })
    .from(sales)
    .where(and(postedSales(), gte(sales.businessDate, period.from), lte(sales.businessDate, period.to)))
    .groupBy(sales.businessDate)
    .orderBy(asc(sales.businessDate))
    .all()
    .map((row) => ({
      businessDate: row.businessDate,
      saleCount: row.saleCount,
      total: minor(row.total),
      cogs: minor(row.cogs),
      profit: subtract(minor(row.total), minor(row.cogs)),
    }));
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

export function getSalesByProduct(db: Db, period: Period): SalesByProduct[] {
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
    .where(and(postedSales(), gte(sales.businessDate, period.from), lte(sales.businessDate, period.to)))
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

export function getSalesByCategory(db: Db, period: Period): SalesByCategory[] {
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
    .where(and(postedSales(), gte(sales.businessDate, period.from), lte(sales.businessDate, period.to)))
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

export function getSalesByCustomer(db: Db, period: Period): SalesByCustomer[] {
  return db
    .select({
      customerId: sales.customerId,
      customerName: customers.name,
      saleCount: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${sales.totalMinor}), 0)`,
      cogs: sql<number>`COALESCE(SUM(${sales.cogsMinor}), 0)`,
    })
    .from(sales)
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(and(postedSales(), gte(sales.businessDate, period.from), lte(sales.businessDate, period.to)))
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
export function getSalesByPaymentMethod(db: Db, period: Period): SalesByPaymentMethod[] {
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
    .where(
      and(
        eq(sales.status, 'POSTED'),
        gte(sales.businessDate, period.from),
        lte(sales.businessDate, period.to),
      ),
    )
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

const postedPurchases = () =>
  and(eq(purchases.status, 'POSTED'), eq(purchases.kind, 'PURCHASE'));

export interface PurchasesBySupplier {
  supplierId: number | null;
  supplierName: string;
  purchaseCount: number;
  total: Minor;
}

export function getPurchasesBySupplier(db: Db, period: Period): PurchasesBySupplier[] {
  return db
    .select({
      supplierId: purchases.supplierId,
      supplierName: suppliers.name,
      purchaseCount: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${purchases.totalMinor}), 0)`,
    })
    .from(purchases)
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(
      and(
        postedPurchases(),
        gte(purchases.businessDate, period.from),
        lte(purchases.businessDate, period.to),
      ),
    )
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

export function getPurchasesByProduct(db: Db, period: Period): PurchasesByProduct[] {
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
    .where(
      and(
        postedPurchases(),
        gte(purchases.businessDate, period.from),
        lte(purchases.businessDate, period.to),
      ),
    )
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

export function getPurchasesByDay(db: Db, period: Period): PurchasesByDay[] {
  return db
    .select({
      businessDate: purchases.businessDate,
      purchaseCount: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${purchases.totalMinor}), 0)`,
    })
    .from(purchases)
    .where(
      and(
        postedPurchases(),
        gte(purchases.businessDate, period.from),
        lte(purchases.businessDate, period.to),
      ),
    )
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

export function getStockValuation(db: Db): StockValuation {
  const fallbackMin = getLowStockThreshold(db);

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
    .where(and(eq(products.isActive, true), eq(products.trackInventory, true)))
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
