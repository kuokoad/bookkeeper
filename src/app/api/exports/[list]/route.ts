import { NextRequest } from 'next/server';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import type { PermissionModule } from '@/db/schema/users';
import { EXPORT_THROTTLE, throttleOrNull } from '@/lib/http-throttle';
import { listProducts } from '@/services/catalog.service';
import { listExpenses, listIncomes } from '@/services/cashbook.service';
import { listCustomers } from '@/services/customer.service';
import { getStockLedger } from '@/services/inventory.service';
import { getAccountStatement, getPaymentAccount } from '@/services/payment-account.service';
import { listPurchases } from '@/services/purchase.service';
import { listSales } from '@/services/sale.service';
import { listSuppliers } from '@/services/supplier.service';
import {
  parseAccountFilters,
  parseCashbookFilters,
  parseCustomerFilters,
  parseProductFilters,
  parsePurchaseFilters,
  parseSalesFilters,
  parseStockMovementFilters,
  parseSupplierFilters,
  type SearchParams,
} from '@/lib/list-filters';
import { csvFilename, csvMoney, csvQty, csvResponse, toCsv, type CsvValue } from '@/lib/csv';
import { minor } from '@/domain/money';
import { qty as makeQty } from '@/domain/quantity';
import { parseId } from '@/lib/filters';
import { toBusinessDate } from '@/lib/format';
import { isDomainError } from '@/domain/errors';

/**
 * CSV export of a FILTERED list.
 *
 * The one rule this route exists to keep: an export contains exactly the rows
 * the owner was looking at. It runs the same parser (`@/lib/list-filters`) and
 * the same service function as the page, so there is no second interpretation
 * of the query string that could drift. Filter to cash sales in the first
 * fortnight of August, press Download, and the file holds those sales — not the
 * whole month, and not the first hundred of them.
 *
 * Permission is checked per module rather than once for "reports": someone who
 * may see sales but not expenses must not be able to export expenses by
 * guessing a URL.
 *
 * Read-only throughout. Nothing here writes, and nothing here recalculates a
 * balance — the figures come from the same reads the screen used.
 */

export const dynamic = 'force-dynamic';

interface Table {
  headers: string[];
  rows: CsvValue[][];
}

/** How many rows one download may contain. Beyond this, narrow the filter. */
const EXPORT_LIMIT = 5000;

/**
 * Say so when a download was cut short.
 *
 * A spreadsheet that quietly stops at five thousand rows is worse than one that
 * refuses: the owner adds up a column, gets a number, and has no way of knowing
 * it is not the number they asked for. A last line saying what happened costs
 * nothing and makes the truncation impossible to miss.
 */
function withTruncationNotice(table: Table, rowCount: number): Table {
  if (rowCount < EXPORT_LIMIT) return table;

  const notice: CsvValue[] = [
    `NOT THE WHOLE SET — this file stops at ${EXPORT_LIMIT} rows. Narrow the filter and download again.`,
  ];
  while (notice.length < table.headers.length) notice.push('');

  return { headers: table.headers, rows: [...table.rows, notice] };
}

const MOVEMENT_LABELS: Record<string, string> = {
  OPENING_STOCK: 'Opening stock',
  PURCHASE: 'Purchase',
  PURCHASE_RETURN: 'Return to supplier',
  SALE: 'Sale',
  SALE_RETURN: 'Customer return',
  ADJUSTMENT_IN: 'Adjustment in',
  ADJUSTMENT_OUT: 'Adjustment out',
};

/** Which module a list belongs to, and therefore who may download it. */
const MODULES: Record<string, PermissionModule> = {
  sales: 'sales',
  purchases: 'purchases',
  expenses: 'expenses',
  income: 'income',
  products: 'products',
  'stock-movements': 'inventory',
  customers: 'customers',
  suppliers: 'suppliers',
  account: 'accounts',
};

function searchParamsOf(request: NextRequest): SearchParams {
  const params: SearchParams = {};
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    if (params[key] === undefined) params[key] = value;
  }
  return params;
}

function buildTable(list: string, request: NextRequest): Table | null {
  const params = searchParamsOf(request);
  const today = toBusinessDate();

  switch (list) {
    case 'sales': {
      const { filters } = parseSalesFilters(params, today);
      const rows = listSales(db, { ...filters, limit: EXPORT_LIMIT, offset: 0 });
      return {
        headers: [
          'Receipt',
          'Invoice',
          'Date',
          'Customer',
          'Served by',
          'Items',
          'Total',
          'Discount',
          'Cost of goods',
          'Profit',
          'Owing',
          'Status',
        ],
        rows: rows.map((row): CsvValue[] => [
          row.receiptNo,
          row.invoiceNo ?? '',
          row.businessDate,
          row.customerName ?? 'Walk-in',
          row.staffName ?? '',
          String(row.itemCount),
          csvMoney(minor(row.totalMinor)),
          csvMoney(minor(row.discountMinor)),
          csvMoney(minor(row.cogsMinor)),
          csvMoney(minor(row.profitMinor)),
          csvMoney(minor(row.outstandingMinor)),
          row.status === 'VOIDED' ? 'Voided' : row.outstandingMinor > 0 ? 'Credit' : 'Paid',
        ]),
      };
    }

    case 'purchases': {
      const { filters } = parsePurchaseFilters(params, today);
      const rows = listPurchases(db, { ...filters, limit: EXPORT_LIMIT, offset: 0 });
      return {
        headers: [
          'Purchase',
          'Invoice',
          'Date',
          'Supplier',
          'Items',
          'Total',
          'Paid',
          'Outstanding',
          'Status',
        ],
        rows: rows.map((row): CsvValue[] => [
          row.purchaseNo,
          row.invoiceNo ?? '',
          row.businessDate,
          row.supplierName ?? '',
          String(row.itemCount),
          csvMoney(minor(row.totalMinor)),
          csvMoney(minor(row.paidMinor)),
          csvMoney(minor(row.outstandingMinor)),
          row.status === 'VOIDED'
            ? 'Voided'
            : row.outstandingMinor <= 0
              ? 'Paid'
              : row.paidMinor > 0
                ? 'Partly paid'
                : 'Unpaid',
        ]),
      };
    }

    case 'expenses':
    case 'income': {
      const { filters } = parseCashbookFilters(params, today);
      const rows =
        list === 'expenses'
          ? listExpenses(db, { ...filters, limit: EXPORT_LIMIT, offset: 0 })
          : listIncomes(db, { ...filters, limit: EXPORT_LIMIT, offset: 0 });
      return {
        headers: ['Number', 'Date', 'Category', 'Description', 'Account', 'Reference', 'Amount', 'Status'],
        rows: rows.map((row): CsvValue[] => [
          row.documentNo,
          row.businessDate,
          row.categoryName,
          row.description,
          row.paymentAccountName,
          row.reference ?? '',
          csvMoney(minor(row.amountMinor)),
          row.status === 'VOIDED' ? 'Voided' : 'Posted',
        ]),
      };
    }

    case 'products': {
      const { filters } = parseProductFilters(params);
      const rows = listProducts(db, { ...filters, limit: EXPORT_LIMIT, offset: 0 });
      return {
        headers: [
          'Product',
          'SKU',
          'Barcode',
          'Category',
          'Unit',
          'In stock',
          'Average cost',
          'Selling price',
          'Stock value',
          'Stock status',
          'Product status',
        ],
        rows: rows.map((row): CsvValue[] => [
          row.name,
          row.sku ?? '',
          row.barcode ?? '',
          row.categoryName ?? '',
          row.unit,
          row.trackInventory ? csvQty(row.qtyOnHand) : '',
          row.trackInventory ? csvMoney(row.averageCost) : '',
          csvMoney(row.sellingPrice),
          csvMoney(row.stockValue),
          !row.trackInventory
            ? 'Not tracked'
            : row.qtyOnHand < 0
              ? 'Negative'
              : row.outOfStock
                ? 'Out of stock'
                : row.lowStock
                  ? 'Low'
                  : 'In stock',
          row.isActive ? 'Active' : 'Archived',
        ]),
      };
    }

    case 'stock-movements': {
      const { filters } = parseStockMovementFilters(params, today);
      const rows = getStockLedger(db, { ...filters, limit: EXPORT_LIMIT, offset: 0 });
      return {
        headers: [
          'Date',
          'Product',
          'Unit',
          'Movement',
          'Reference',
          'In',
          'Out',
          'Unit cost',
          'Total cost',
          'Balance qty',
          'Balance value',
          'Note',
        ],
        rows: rows.map((row): CsvValue[] => [
          row.businessDate,
          row.productName,
          row.productUnit,
          MOVEMENT_LABELS[row.movementType] ?? row.movementType,
          row.sourceRef ?? '',
          row.qtyIn === 0 ? '' : csvQty(makeQty(row.qtyIn)),
          row.qtyOut === 0 ? '' : csvQty(makeQty(row.qtyOut)),
          csvMoney(minor(row.unitCost)),
          csvMoney(minor(row.totalCost)),
          csvQty(makeQty(row.balanceQty)),
          csvMoney(minor(row.balanceValue)),
          row.note ?? '',
        ]),
      };
    }

    case 'customers': {
      const { filters } = parseCustomerFilters(params);
      const rows = listCustomers(db, { ...filters, limit: EXPORT_LIMIT, offset: 0 });
      return {
        headers: ['Customer', 'Phone', 'Email', 'Credit limit', 'Balance owing', 'Status'],
        rows: rows.map((row): CsvValue[] => [
          row.name,
          row.phone ?? '',
          row.email ?? '',
          row.creditLimit === null ? '' : csvMoney(row.creditLimit),
          csvMoney(row.balance),
          row.isActive ? 'Active' : 'Archived',
        ]),
      };
    }

    case 'suppliers': {
      const { filters } = parseSupplierFilters(params);
      const rows = listSuppliers(db, { ...filters, limit: EXPORT_LIMIT, offset: 0 });
      return {
        headers: ['Supplier', 'Contact', 'Phone', 'Email', 'Balance owed', 'Status'],
        rows: rows.map((row): CsvValue[] => [
          row.name,
          row.contactPerson ?? '',
          row.phone ?? '',
          row.email ?? '',
          csvMoney(row.balance),
          row.isActive ? 'Active' : 'Archived',
        ]),
      };
    }

    case 'account': {
      const accountId = parseId(request.nextUrl.searchParams.get('id') ?? undefined);
      if (accountId === undefined) return null;

      const { filters } = parseAccountFilters(params, today);
      const account = getPaymentAccount(db, accountId);
      const statement = getAccountStatement(db, accountId, {
        ...filters,
        limit: EXPORT_LIMIT,
        offset: 0,
      });

      /*
        Opening and closing bracket the movements, exactly as they do on screen.
        A statement that lists movements without them cannot be checked, and an
        unverifiable statement is not worth exporting.
      */
      return {
        headers: ['Date', 'What happened', 'Reference', 'Description', 'In', 'Out', 'Balance'],
        rows: [
          [
            `Opening balance — ${account.name}`,
            '',
            '',
            '',
            '',
            '',
            csvMoney(statement.opening),
          ],
          ...[...statement.movements].reverse().map((row): CsvValue[] => [
            row.entryDate,
            row.sourceType,
            row.entryNo,
            row.description ?? row.memo ?? '',
            row.inMinor === 0 ? '' : csvMoney(minor(row.inMinor)),
            row.outMinor === 0 ? '' : csvMoney(minor(row.outMinor)),
            csvMoney(minor(row.runningBalance)),
          ]),
          [
            'Total',
            '',
            '',
            '',
            csvMoney(statement.moneyIn),
            csvMoney(statement.moneyOut),
            '',
          ],
          ['Closing balance', '', '', '', '', '', csvMoney(statement.closing)],
        ],
      };
    }

    default:
      return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ list: string }> },
): Promise<Response> {
  const { list } = await params;

  const permissionModule = MODULES[list];
  if (permissionModule === undefined) {
    return new Response(`Unknown export "${list}".`, { status: 404 });
  }

  let actor;
  try {
    actor = await requirePermission(permissionModule, 'view');
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNAUTHENTICATED') {
      return new Response('Please sign in.', { status: 401 });
    }
    if (isDomainError(error) && error.code === 'FORBIDDEN') {
      return new Response('You do not have permission to export this.', { status: 403 });
    }
    throw error;
  }

  // Keyed on the person, not the address: they are already authenticated, and
  // a loop of exports scans the ledger repeatedly, which makes the till slow
  // for everyone else on a machine under a shop counter.
  const throttled = throttleOrNull(db, `export:${actor.id}`, EXPORT_THROTTLE);
  if (throttled) return throttled;

  let table: Table | null;
  try {
    table = buildTable(list, request);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') {
      return new Response('Not found.', { status: 404 });
    }
    throw error;
  }

  if (!table) return new Response(`Unknown export "${list}".`, { status: 404 });

  // The account statement adds an opening and a closing line of its own, so the
  // count that matters is the movements between them, not every row in the file.
  const dataRows = list === 'account' ? Math.max(0, table.rows.length - 3) : table.rows.length;
  table = withTruncationNotice(table, dataRows);

  const rawFrom = request.nextUrl.searchParams.get('from');
  const rawTo = request.nextUrl.searchParams.get('to');
  const today = toBusinessDate();

  return csvResponse(
    csvFilename(list, { from: rawFrom ?? today, to: rawTo ?? today }),
    toCsv(table.headers, table.rows),
  );
}
