import { NextRequest } from 'next/server';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import { getBalanceSheet, getCashFlow, getProfitAndLoss } from '@/services/reporting/financial.service';
import {
  getPurchasesByDay,
  getPurchasesByProduct,
  getPurchasesBySupplier,
  getSalesByCategory,
  getSalesByCustomer,
  getSalesByDay,
  getSalesByPaymentMethod,
  getSalesByProduct,
  getStockMovementSummary,
  getStockValuation,
} from '@/services/reporting/operations.service';
import { getReceivablesAgeing, getPayablesAgeing } from '@/services/reporting/ledger.service';
import { csvFilename, csvMoney, csvQty, csvResponse, toCsv, type CsvValue } from '@/lib/csv';
import { toBusinessDate, isValidBusinessDate } from '@/lib/format';
import { isDomainError } from '@/domain/errors';

/**
 * CSV export.
 *
 * Runs the SAME service functions as the on-screen report, so a downloaded file
 * can never disagree with what the owner just looked at. Permission is checked
 * here too — an export route is a data-exfiltration path if it is not.
 */

export const dynamic = 'force-dynamic';

interface Table {
  headers: string[];
  rows: CsvValue[][];
}

function period(request: NextRequest): { from: string; to: string } {
  const today = toBusinessDate();
  const rawFrom = request.nextUrl.searchParams.get('from');
  const rawTo = request.nextUrl.searchParams.get('to');

  // Never trust a query string: fall back rather than pass junk into SQL.
  const from = rawFrom && isValidBusinessDate(rawFrom) ? rawFrom : `${today.slice(0, 7)}-01`;
  const to = rawTo && isValidBusinessDate(rawTo) ? rawTo : today;
  return { from, to };
}

function buildTable(report: string, request: NextRequest): Table | null {
  const range = period(request);

  switch (report) {
    case 'profit-and-loss': {
      const pl = getProfitAndLoss(db, range);
      const rows: CsvValue[][] = [
        ['Sales', csvMoney(pl.salesRevenue)],
        ['Less: discounts given', csvMoney(pl.salesDiscounts)],
        ['Less: goods returned', csvMoney(pl.salesReturns)],
        ['Net sales', csvMoney(pl.netSales)],
        ['Cost of goods sold', csvMoney(pl.costOfGoodsSold)],
        ['Gross profit', csvMoney(pl.grossProfit)],
        ...pl.otherIncome.map((line): CsvValue[] => [
          `Other income: ${line.name}`,
          csvMoney(line.amount),
        ]),
        ['Total other income', csvMoney(pl.totalOtherIncome)],
        ...pl.expenses.map((line): CsvValue[] => [`Cost: ${line.name}`, csvMoney(line.amount)]),
        ['Total running costs', csvMoney(pl.totalExpenses)],
        ['Net profit', csvMoney(pl.netProfit)],
      ];
      return { headers: ['Item', 'Amount'], rows };
    }

    case 'balance-sheet': {
      const rawAsAt = request.nextUrl.searchParams.get('asAt');
      const asAt = rawAsAt && isValidBusinessDate(rawAsAt) ? rawAsAt : toBusinessDate();
      const sheet = getBalanceSheet(db, asAt);

      const rows: CsvValue[][] = [
        ...sheet.cashAccounts.map((line): CsvValue[] => [
          `Asset: ${line.name}`,
          csvMoney(line.amount),
        ]),
        ['Asset: Money customers owe you', csvMoney(sheet.receivables)],
        ['Asset: Stock on the shelf', csvMoney(sheet.inventory)],
        ...sheet.otherAssets.map((line): CsvValue[] => [
          `Asset: ${line.name}`,
          csvMoney(line.amount),
        ]),
        ['Total assets', csvMoney(sheet.totalAssets)],
        ['Liability: Money you owe suppliers', csvMoney(sheet.payables)],
        ['Liability: Tax not yet paid', csvMoney(sheet.taxPayable)],
        ...sheet.otherLiabilities.map((line): CsvValue[] => [
          `Liability: ${line.name}`,
          csvMoney(line.amount),
        ]),
        ['Total liabilities', csvMoney(sheet.totalLiabilities)],
        ['Equity: Money you put in', csvMoney(sheet.ownersCapital)],
        ['Equity: Less money you took out', csvMoney(sheet.drawings)],
        ['Equity: Opening balances', csvMoney(sheet.openingBalanceEquity)],
        ['Equity: Profit kept in the business', csvMoney(sheet.retainedEarnings)],
        ['Total equity', csvMoney(sheet.totalEquity)],
        ['Total liabilities and equity', csvMoney(sheet.totalLiabilitiesAndEquity)],
        ['Balances?', sheet.balances ? 'yes' : 'NO'],
      ];
      return { headers: ['Item', 'Amount'], rows };
    }

    case 'cash-flow': {
      const flow = getCashFlow(db, range);
      const rows: CsvValue[][] = [
        ['Opening balance', '', '', csvMoney(flow.openingBalance)],
        ...flow.lines.map((line): CsvValue[] => [
          line.label,
          csvMoney(line.inMinor),
          csvMoney(line.outMinor),
          csvMoney(line.net),
        ]),
        ['Total', csvMoney(flow.totalIn), csvMoney(flow.totalOut), csvMoney(flow.netMovement)],
        ['Closing balance', '', '', csvMoney(flow.closingBalance)],
      ];
      return { headers: ['Item', 'In', 'Out', 'Net'], rows };
    }

    case 'sales': {
      const byProduct = getSalesByProduct(db, range);
      const byDay = getSalesByDay(db, range);
      const byCategory = getSalesByCategory(db, range);
      const byCustomer = getSalesByCustomer(db, range);
      const byMethod = getSalesByPaymentMethod(db, range);

      // One flat file with a "section" column, so a spreadsheet can filter it.
      const rows: CsvValue[][] = [
        ...byDay.map((row): CsvValue[] => [
          'By day',
          row.businessDate,
          '',
          String(row.saleCount),
          csvMoney(row.total),
          csvMoney(row.cogs),
          csvMoney(row.profit),
        ]),
        ...byProduct.map((row): CsvValue[] => [
          'By product',
          row.productName,
          row.categoryName ?? '',
          csvQty(row.qtySold),
          csvMoney(row.revenue),
          csvMoney(row.cost),
          csvMoney(row.profit),
        ]),
        ...byCategory.map((row): CsvValue[] => [
          'By category',
          row.categoryName,
          '',
          '',
          csvMoney(row.revenue),
          csvMoney(row.cost),
          csvMoney(row.profit),
        ]),
        ...byCustomer.map((row): CsvValue[] => [
          'By customer',
          row.customerName,
          '',
          String(row.saleCount),
          csvMoney(row.total),
          '',
          csvMoney(row.profit),
        ]),
        ...byMethod.map((row): CsvValue[] => [
          'By payment method',
          row.accountName,
          '',
          '',
          csvMoney(row.received),
          '',
          '',
        ]),
      ];

      return {
        headers: ['Section', 'Name', 'Category', 'Count/Qty', 'Revenue', 'Cost', 'Profit'],
        rows,
      };
    }

    case 'purchases': {
      const byDay = getPurchasesByDay(db, range);
      const bySupplier = getPurchasesBySupplier(db, range);
      const byProduct = getPurchasesByProduct(db, range);

      const rows: CsvValue[][] = [
        ...byDay.map((row): CsvValue[] => [
          'By day',
          row.businessDate,
          String(row.purchaseCount),
          csvMoney(row.total),
        ]),
        ...bySupplier.map((row): CsvValue[] => [
          'By supplier',
          row.supplierName,
          String(row.purchaseCount),
          csvMoney(row.total),
        ]),
        ...byProduct.map((row): CsvValue[] => [
          'By product',
          row.productName,
          csvQty(row.qtyBought),
          csvMoney(row.total),
        ]),
      ];

      return { headers: ['Section', 'Name', 'Count/Qty', 'Total'], rows };
    }

    case 'inventory': {
      const valuation = getStockValuation(db);
      const movement = getStockMovementSummary(db, range);
      const movementByProduct = new Map(movement.map((row) => [row.productId, row]));

      const rows: CsvValue[][] = valuation.rows.map((row): CsvValue[] => {
        const moved = movementByProduct.get(row.productId);
        return [
          row.productName,
          row.sku ?? '',
          row.categoryName ?? '',
          row.unit,
          csvQty(row.qtyOnHand),
          csvMoney(row.averageCost),
          csvMoney(row.stockValue),
          csvMoney(row.sellingPrice),
          csvMoney(row.retailValue),
          moved ? csvQty(moved.qtyIn) : '0',
          moved ? csvQty(moved.qtyOut) : '0',
          row.outOfStock ? 'out of stock' : row.lowStock ? 'low' : 'ok',
        ];
      });

      return {
        headers: [
          'Product',
          'SKU',
          'Category',
          'Unit',
          'On hand',
          'Average cost',
          'Value at cost',
          'Selling price',
          'Value at retail',
          'Qty in (period)',
          'Qty out (period)',
          'Status',
        ],
        rows,
      };
    }

    case 'receivables':
    case 'payables': {
      const asAt = range.to;
      const ageing =
        report === 'receivables' ? getReceivablesAgeing(db, asAt) : getPayablesAgeing(db, asAt);

      const rows: CsvValue[][] = ageing.map((row): CsvValue[] => [
        row.partyName,
        row.phone ?? '',
        row.oldestDate ?? '',
        csvMoney(row.current),
        csvMoney(row.days1to30),
        csvMoney(row.days31to60),
        csvMoney(row.days61to90),
        csvMoney(row.over90),
        csvMoney(row.total),
      ]);

      return {
        headers: [
          report === 'receivables' ? 'Customer' : 'Supplier',
          'Phone',
          'Oldest',
          'Not due',
          '1-30 days',
          '31-60 days',
          '61-90 days',
          'Over 90 days',
          'Total',
        ],
        rows,
      };
    }

    default:
      return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ report: string }> },
): Promise<Response> {
  try {
    await requirePermission('reports', 'view');
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNAUTHENTICATED') {
      return new Response('Please sign in.', { status: 401 });
    }
    if (isDomainError(error) && error.code === 'FORBIDDEN') {
      return new Response('You do not have permission to export reports.', { status: 403 });
    }
    throw error;
  }

  const { report } = await params;
  const table = buildTable(report, request);

  if (!table) {
    return new Response(`Unknown report "${report}".`, { status: 404 });
  }

  const range = period(request);
  return csvResponse(csvFilename(report, range), toCsv(table.headers, table.rows));
}
