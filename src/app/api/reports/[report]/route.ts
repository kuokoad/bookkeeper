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
import { listAllOpenBatches } from '@/services/inventory.service';
import { availableFinancialYears, getYearEndPack } from '@/services/reporting/year-end.service';
import type { Minor } from '@/domain/money';
import { qty as makeQty } from '@/domain/quantity';
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

    case 'expiry': {
      /**
       * Every crate still holding stock, with how long it has left.
       *
       * BATCHES, not buckets. The summary on screen answers "how bad is it";
       * a spreadsheet is opened to answer "which ones", and six summary rows
       * would not survive being printed and carried round a shelf.
       *
       * No money column, and there must never be one: a batch has never
       * carried a cost — value is weighted-average and pooled per product —
       * so any figure here would be invented.
       */
      const asAt = range.to;
      const rows: CsvValue[][] = listAllOpenBatches(db, asAt).map((row): CsvValue[] => [
        row.batchRef,
        row.productName,
        row.sku ?? '',
        row.unit,
        row.expiryDate ?? '',
        row.daysLeft === null ? '' : String(row.daysLeft),
        csvQty(makeQty(row.qtyMilli)),
        row.supplierName ?? '',
        row.receivedDate ?? '',
        row.expiryDate === null ? 'no date' : row.daysLeft! < 0 ? 'expired' : 'in date',
      ]);

      return {
        headers: [
          'Batch',
          'Product',
          'SKU',
          'Unit',
          'Expires',
          'Days left',
          'Remaining',
          'Supplier',
          'Received',
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

    case 'year-end': {
      // The whole pack as one file, laid out as labelled sections rather than
      // eight separate downloads. An accountant opens it in a spreadsheet and
      // reads it top to bottom, so the section headings carry the structure.
      const requested = Number(request.nextUrl.searchParams.get('year'));
      const years = availableFinancialYears(db);
      const chosen = years.find((year) => year.startYear === requested) ?? years[0];
      if (!chosen) return null;

      const pack = getYearEndPack(db, chosen.startYear);
      const pl = pack.profitAndLoss;
      const previousPl = pack.previousProfitAndLoss;
      const bs = pack.balanceSheet;
      const previousBs = pack.previousBalanceSheet;

      /** A blank row, so sections are readable when opened in a spreadsheet. */
      const gap = (): CsvValue[] => ['', '', ''];
      const heading = (title: string): CsvValue[] => [title, pack.year.label, pack.previous.label];
      // `number` rather than `Minor`: an expense absent from the prior year has
      // no branded zero to offer, and a plain 0 is the honest comparative.
      const line = (label: string, now: Minor, before?: number): CsvValue[] => [
        label,
        csvMoney(now),
        before === undefined ? '' : csvMoney(before as Minor),
      ];

      const rows: CsvValue[][] = [
        [pack.shop.name, '', ''],
        [`Financial statements for ${pack.year.label}`, '', ''],
        [`${pack.year.start} to ${pack.year.end}`, `All figures in ${pack.shop.currencyCode}`, ''],
        [
          pack.isProvisional ? 'PROVISIONAL — the year has not finished' : 'Final',
          `${pack.entryCount} journal entries`,
          '',
        ],
        gap(),

        heading('PROFIT AND LOSS'),
        line('Sales', pl.salesRevenue, previousPl.salesRevenue),
        line('Less discounts', pl.salesDiscounts, previousPl.salesDiscounts),
        line('Less returns', pl.salesReturns, previousPl.salesReturns),
        line('Net sales', pl.netSales, previousPl.netSales),
        line('Cost of goods sold', pl.costOfGoodsSold, previousPl.costOfGoodsSold),
        line('Gross profit', pl.grossProfit, previousPl.grossProfit),
        line('Other income', pl.totalOtherIncome, previousPl.totalOtherIncome),
        ...pl.expenses.map((expense): CsvValue[] =>
          line(
            `Expense: ${expense.name}`,
            expense.amount,
            previousPl.expenses.find((other) => other.accountId === expense.accountId)?.amount ?? 0,
          ),
        ),
        line('Total expenses', pl.totalExpenses, previousPl.totalExpenses),
        line('NET PROFIT', pl.netProfit, previousPl.netProfit),
        gap(),

        heading('BALANCE SHEET'),
        line('Cash, mobile money and bank', bs.totalCash, previousBs.totalCash),
        line('Owed by customers', bs.receivables, previousBs.receivables),
        line('Stock on hand', bs.inventory, previousBs.inventory),
        line('TOTAL ASSETS', bs.totalAssets, previousBs.totalAssets),
        line('Owed to suppliers', bs.payables, previousBs.payables),
        line('Tax payable', bs.taxPayable, previousBs.taxPayable),
        line('TOTAL LIABILITIES', bs.totalLiabilities, previousBs.totalLiabilities),
        line("OWNER'S STAKE", bs.totalEquity, previousBs.totalEquity),
        gap(),

        heading("MOVEMENT IN THE OWNER'S STAKE"),
        line(`Balance at ${pack.previous.end}`, pack.equity.openingEquity),
        line('Capital introduced', pack.equity.capitalIntroduced),
        line('Drawings', pack.equity.drawings),
        line('Opening balances brought in', pack.equity.openingBalancesRecognised),
        line('Profit for the year', pack.equity.profitForYear),
        line(`Balance at ${pack.year.end}`, pack.equity.closingEquity),
        gap(),

        ['CASH FLOW', 'In', 'Out'],
        [`Balance at ${pack.previous.end}`, csvMoney(pack.cashFlow.openingBalance), ''],
        ...pack.cashFlow.lines.map((flow): CsvValue[] => [
          flow.label,
          csvMoney(flow.inMinor),
          csvMoney(flow.outMinor),
        ]),
        ['Total', csvMoney(pack.cashFlow.totalIn), csvMoney(pack.cashFlow.totalOut)],
        [`Balance at ${pack.year.end}`, csvMoney(pack.cashFlow.closingBalance), ''],
        gap(),

        ['OWED BY CUSTOMERS', 'Over 90 days', 'Total'],
        ...pack.receivables.map((row): CsvValue[] => [
          row.partyName,
          csvMoney(row.over90),
          csvMoney(row.total),
        ]),
        ['Total owed to the shop', '', csvMoney(bs.receivables)],
        gap(),

        ['OWED TO SUPPLIERS', 'Over 90 days', 'Total'],
        ...pack.payables.map((row): CsvValue[] => [
          row.partyName,
          csvMoney(row.over90),
          csvMoney(row.total),
        ]),
        ['Total owed by the shop', '', csvMoney(bs.payables)],
        gap(),

        ['TRIAL BALANCE', 'Debit', 'Credit'],
        ...pack.trialBalance.lines.map((row): CsvValue[] => [
          `${row.code} ${row.name}`,
          csvMoney(row.debit),
          csvMoney(row.credit),
        ]),
        ['Total', csvMoney(pack.trialBalance.totalDebit), csvMoney(pack.trialBalance.totalCredit)],
        gap(),

        ['CHECKS PERFORMED', '', ''],
        ['Trial balance balances', pack.integrity.trialBalanced ? 'yes' : 'NO', ''],
        ['Balance sheet balances', bs.balances ? 'yes' : 'NO', ''],
        ['Owed by customers agrees', pack.integrity.receivablesMatch ? 'yes' : 'NO', ''],
        ['Owed to suppliers agrees', pack.integrity.payablesMatch ? 'yes' : 'NO', ''],
        ["Owner's stake reconciles", pack.equity.reconciles ? 'yes' : 'NO', ''],
        ['Cash flow reconciles', pack.cashFlow.reconciles ? 'yes' : 'NO', ''],
        ['Year closed to further entries', pack.isLocked ? 'yes' : 'no', ''],
      ];

      return { headers: ['Item', pack.year.label, pack.previous.label], rows };
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
