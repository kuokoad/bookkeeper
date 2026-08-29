import 'server-only';

import type { CashbookQuery } from '@/services/cashbook.service';
import { CASHBOOK_SORTS } from '@/services/cashbook.service';
import type { ProductQuery } from '@/services/catalog.service';
import { PRODUCT_SORTS, STOCK_STATUSES } from '@/services/catalog.service';
import type { CustomerQuery } from '@/services/customer.service';
import { CUSTOMER_SORTS } from '@/services/customer.service';
import type { LedgerQuery } from '@/services/inventory.service';
import { MOVEMENT_TYPES } from '@/db/schema/inventory';
import { JOURNAL_SOURCE_TYPES } from '@/db/schema/accounting';
import type { AccountMovementQuery } from '@/services/payment-account.service';
import type { PurchaseListQuery } from '@/services/purchase.service';
import { PURCHASE_SORTS } from '@/services/purchase.service';
import type {
  PurchaseReportQuery,
  SalesReportQuery,
  StockValuationQuery,
} from '@/services/reporting/operations.service';
import type { SaleListQuery } from '@/services/sale.service';
import { SALE_SORTS } from '@/services/sale.service';
import type { SupplierQuery } from '@/services/supplier.service';
import { SUPPLIER_SORTS } from '@/services/supplier.service';
import { toBusinessDate } from '@/lib/format';
import {
  DEFAULT_PAGE_SIZE,
  parseAmountRange,
  parseEnum,
  parseId,
  parsePage,
  parseSearch,
  parseSort,
  resolveDateRange,
  type DatePreset,
  type DateRange,
  type FilterValues,
} from '@/lib/filters';

/**
 * The URL, turned into a service query — once per module, for everyone.
 *
 * The page and its CSV export both come through here. That is the point: an
 * export that parses the query string its own way is how a shop owner ends up
 * with a spreadsheet that does not match the screen they were looking at when
 * they pressed Download. Same parser, same query, same rows.
 *
 * Everything is validated on the way in. A hand-edited `?customer=abc` or
 * `?page=-4` narrows nothing rather than reaching the database or throwing a
 * 500 at somebody who only mistyped a URL.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

/** Query strings can repeat a key. The first value wins; the rest are noise. */
function one(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

export interface ParsedList<Q> {
  filters: Q;
  range: DateRange;
  preset: DatePreset;
  /** The page asked for. Clamp it against the real total before using it. */
  page: number;
  pageSize: number;
  /** Every filter key, for links that must not drop the current view. */
  carried: FilterValues;
}

const PAYMENT_KINDS = ['CASH', 'MOBILE_MONEY', 'BANK', 'OTHER'] as const;

/** Only the keys that are set, so `exactOptionalPropertyTypes` stays happy. */
function put<T extends object>(target: T, key: keyof T, value: unknown): void {
  if (value !== undefined) (target as Record<string, unknown>)[key as string] = value;
}

// --- sales -----------------------------------------------------------------

export function parseSalesFilters(
  params: SearchParams,
  today: string = toBusinessDate(),
  pageSize: number = DEFAULT_PAGE_SIZE,
): ParsedList<SaleListQuery> {
  const { range, preset } = resolveDateRange(
    one(params, 'period'),
    one(params, 'from'),
    one(params, 'to'),
    today,
  );
  const { minAmount, maxAmount } = parseAmountRange(one(params, 'min'), one(params, 'max'));
  const { sort, direction } = parseSort(
    one(params, 'sort'),
    one(params, 'direction'),
    SALE_SORTS,
    'date',
  );

  const filters: SaleListQuery = { from: range.from, to: range.to, sort, direction };
  put(filters, 'customerId', parseId(one(params, 'customer')));
  put(filters, 'productId', parseId(one(params, 'product')));
  put(filters, 'categoryId', parseId(one(params, 'category')));
  put(filters, 'paymentAccountId', parseId(one(params, 'account')));
  put(filters, 'staffId', parseId(one(params, 'staff')));
  put(filters, 'paymentKind', parseEnum(one(params, 'method'), PAYMENT_KINDS));
  put(filters, 'status', parseEnum(one(params, 'status'), ['POSTED', 'VOIDED'] as const));
  put(filters, 'paymentState', parseEnum(one(params, 'paid'), ['paid', 'unpaid'] as const));
  put(filters, 'search', parseSearch(one(params, 'q')));
  put(filters, 'minAmount', minAmount);
  put(filters, 'maxAmount', maxAmount);

  const paged = parsePage(one(params, 'page'), pageSize);

  return {
    filters,
    range,
    preset,
    page: paged.page,
    pageSize: paged.pageSize,
    carried: carry(params, [
      'period',
      'from',
      'to',
      'q',
      'customer',
      'product',
      'category',
      'account',
      'method',
      'staff',
      'status',
      'paid',
      'min',
      'max',
      'sort',
      'direction',
    ]),
  };
}

// --- quotations ------------------------------------------------------------

export const QUOTATION_SORTS = ['date', 'total', 'validUntil'] as const;

export interface QuotationListQuery {
  from: string;
  to: string;
  status?: 'OPEN' | 'CONVERTED' | 'CANCELLED';
  /** Open quotes past their date. A view of the data, never a stored status. */
  expired?: boolean;
  customerId?: number;
  search?: string;
  sort: (typeof QUOTATION_SORTS)[number];
  direction: 'asc' | 'desc';
}

/**
 * ONE parser, used by the quotations page AND its CSV route.
 *
 * An export that read the query string its own way is how a downloaded file
 * stops matching the screen it came from.
 */
export function parseQuotationFilters(
  params: SearchParams,
  today: string = toBusinessDate(),
  pageSize: number = DEFAULT_PAGE_SIZE,
): ParsedList<QuotationListQuery> {
  const { range, preset } = resolveDateRange(
    one(params, 'period'),
    one(params, 'from'),
    one(params, 'to'),
    today,
  );
  const { sort, direction } = parseSort(
    one(params, 'sort'),
    one(params, 'direction'),
    QUOTATION_SORTS,
    'date',
  );

  const filters: QuotationListQuery = { from: range.from, to: range.to, sort, direction };
  put(
    filters,
    'status',
    parseEnum(one(params, 'status'), ['OPEN', 'CONVERTED', 'CANCELLED'] as const),
  );
  // Only ever true or absent. "expired=0" is not a request to see unexpired
  // quotes, it is a hand-edited query string, and it narrows nothing.
  put(filters, 'expired', one(params, 'expired') === '1' ? true : undefined);
  put(filters, 'customerId', parseId(one(params, 'customer')));
  put(filters, 'search', parseSearch(one(params, 'q')));

  const paged = parsePage(one(params, 'page'), pageSize);

  return {
    filters,
    range,
    preset,
    page: paged.page,
    pageSize: paged.pageSize,
    carried: carry(params, [
      'period',
      'from',
      'to',
      'q',
      'status',
      'expired',
      'customer',
      'sort',
      'direction',
    ]),
  };
}

// --- purchases -------------------------------------------------------------

export function parsePurchaseFilters(
  params: SearchParams,
  today: string = toBusinessDate(),
  pageSize: number = DEFAULT_PAGE_SIZE,
): ParsedList<PurchaseListQuery> {
  const { range, preset } = resolveDateRange(
    one(params, 'period'),
    one(params, 'from'),
    one(params, 'to'),
    today,
  );
  const { minAmount, maxAmount } = parseAmountRange(one(params, 'min'), one(params, 'max'));
  const { sort, direction } = parseSort(
    one(params, 'sort'),
    one(params, 'direction'),
    PURCHASE_SORTS,
    'date',
  );

  const filters: PurchaseListQuery = { from: range.from, to: range.to, sort, direction };
  put(filters, 'supplierId', parseId(one(params, 'supplier')));
  put(filters, 'productId', parseId(one(params, 'product')));
  put(filters, 'categoryId', parseId(one(params, 'category')));
  put(filters, 'paymentAccountId', parseId(one(params, 'account')));
  put(filters, 'paymentKind', parseEnum(one(params, 'method'), PAYMENT_KINDS));
  put(filters, 'status', parseEnum(one(params, 'status'), ['POSTED', 'VOIDED'] as const));
  put(
    filters,
    'paymentState',
    parseEnum(one(params, 'paid'), ['paid', 'partial', 'outstanding'] as const),
  );
  put(filters, 'search', parseSearch(one(params, 'q')));
  put(filters, 'minAmount', minAmount);
  put(filters, 'maxAmount', maxAmount);

  const paged = parsePage(one(params, 'page'), pageSize);

  return {
    filters,
    range,
    preset,
    page: paged.page,
    pageSize: paged.pageSize,
    carried: carry(params, [
      'period',
      'from',
      'to',
      'q',
      'supplier',
      'product',
      'category',
      'account',
      'method',
      'status',
      'paid',
      'min',
      'max',
      'sort',
      'direction',
    ]),
  };
}

// --- expenses and income ---------------------------------------------------

export function parseCashbookFilters(
  params: SearchParams,
  today: string = toBusinessDate(),
  pageSize: number = DEFAULT_PAGE_SIZE,
): ParsedList<CashbookQuery> {
  const { range, preset } = resolveDateRange(
    one(params, 'period'),
    one(params, 'from'),
    one(params, 'to'),
    today,
  );
  const { minAmount, maxAmount } = parseAmountRange(one(params, 'min'), one(params, 'max'));
  const { sort, direction } = parseSort(
    one(params, 'sort'),
    one(params, 'direction'),
    CASHBOOK_SORTS,
    'date',
  );

  const filters: CashbookQuery = { from: range.from, to: range.to, sort, direction };
  put(filters, 'categoryAccountId', parseId(one(params, 'category')));
  put(filters, 'paymentAccountId', parseId(one(params, 'account')));
  put(filters, 'staffId', parseId(one(params, 'staff')));
  put(filters, 'status', parseEnum(one(params, 'status'), ['POSTED', 'VOIDED'] as const));
  put(filters, 'search', parseSearch(one(params, 'q')));
  put(filters, 'minAmount', minAmount);
  put(filters, 'maxAmount', maxAmount);

  const paged = parsePage(one(params, 'page'), pageSize);

  return {
    filters,
    range,
    preset,
    page: paged.page,
    pageSize: paged.pageSize,
    carried: carry(params, [
      'period',
      'from',
      'to',
      'q',
      'category',
      'account',
      'staff',
      'status',
      'min',
      'max',
      'sort',
      'direction',
    ]),
  };
}

// --- products --------------------------------------------------------------

export function parseProductFilters(
  params: SearchParams,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Omit<ParsedList<ProductQuery>, 'range' | 'preset'> {
  const { sort, direction } = parseSort(
    one(params, 'sort'),
    one(params, 'direction'),
    PRODUCT_SORTS,
    'name',
    'asc',
  );

  const filters: ProductQuery = { sort, direction };
  put(filters, 'search', parseSearch(one(params, 'q')));
  put(filters, 'categoryId', parseId(one(params, 'category')));
  put(filters, 'supplierId', parseId(one(params, 'supplier')));
  put(filters, 'stockStatus', parseEnum(one(params, 'stock'), STOCK_STATUSES));
  put(filters, 'expiring', parseEnum(one(params, 'expiring'), ['expired', 'soon'] as const));
  put(
    filters,
    'productStatus',
    parseEnum(one(params, 'archived'), ['active', 'archived'] as const),
  );

  const paged = parsePage(one(params, 'page'), pageSize);

  return {
    filters,
    page: paged.page,
    pageSize: paged.pageSize,
    carried: carry(params, [
      'q',
      'category',
      'supplier',
      'stock',
      'expiring',
      'archived',
      'sort',
      'direction',
    ]),
  };
}

// --- stock movements -------------------------------------------------------

export function parseStockMovementFilters(
  params: SearchParams,
  today: string = toBusinessDate(),
  pageSize: number = DEFAULT_PAGE_SIZE,
): ParsedList<LedgerQuery> {
  /*
    Stock movements default to everything rather than to this month. The
    question this page answers is "where did this stock go", and an answer that
    silently stops at the first of the month is the wrong answer.
  */
  const { range, preset } = resolveDateRange(
    one(params, 'period') ?? 'all',
    one(params, 'from'),
    one(params, 'to'),
    today,
  );

  const filters: LedgerQuery = { from: range.from, to: range.to };
  put(filters, 'productId', parseId(one(params, 'product')));
  put(filters, 'categoryId', parseId(one(params, 'category')));
  put(filters, 'movementType', parseEnum(one(params, 'movement'), MOVEMENT_TYPES));
  put(filters, 'userId', parseId(one(params, 'user')));
  put(filters, 'search', parseSearch(one(params, 'q')));

  const paged = parsePage(one(params, 'page'), pageSize);

  return {
    filters,
    range,
    preset,
    page: paged.page,
    pageSize: paged.pageSize,
    carried: carry(params, [
      'period',
      'from',
      'to',
      'q',
      'product',
      'category',
      'movement',
      'user',
    ]),
  };
}

// --- customers and suppliers ----------------------------------------------

export function parseCustomerFilters(
  params: SearchParams,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Omit<ParsedList<CustomerQuery>, 'range' | 'preset'> {
  const { sort, direction } = parseSort(
    one(params, 'sort'),
    one(params, 'direction'),
    CUSTOMER_SORTS,
    'name',
    'asc',
  );

  const filters: CustomerQuery = { sort, direction };
  put(filters, 'search', parseSearch(one(params, 'q')));
  put(filters, 'balanceState', parseEnum(one(params, 'balance'), ['owing', 'zero', 'credit'] as const));
  put(
    filters,
    'customerStatus',
    parseEnum(one(params, 'archived'), ['active', 'archived'] as const),
  );

  const paged = parsePage(one(params, 'page'), pageSize);

  return {
    filters,
    page: paged.page,
    pageSize: paged.pageSize,
    carried: carry(params, ['q', 'balance', 'archived', 'sort', 'direction']),
  };
}

export function parseSupplierFilters(
  params: SearchParams,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Omit<ParsedList<SupplierQuery>, 'range' | 'preset'> {
  const { sort, direction } = parseSort(
    one(params, 'sort'),
    one(params, 'direction'),
    SUPPLIER_SORTS,
    'name',
    'asc',
  );

  const filters: SupplierQuery = { sort, direction };
  put(filters, 'search', parseSearch(one(params, 'q')));
  put(filters, 'balanceState', parseEnum(one(params, 'balance'), ['owing', 'zero', 'credit'] as const));
  put(
    filters,
    'supplierStatus',
    parseEnum(one(params, 'archived'), ['active', 'archived'] as const),
  );

  const paged = parsePage(one(params, 'page'), pageSize);

  return {
    filters,
    page: paged.page,
    pageSize: paged.pageSize,
    carried: carry(params, ['q', 'balance', 'archived', 'sort', 'direction']),
  };
}

// --- one account's statement ----------------------------------------------

export function parseAccountFilters(
  params: SearchParams,
  today: string = toBusinessDate(),
  pageSize: number = DEFAULT_PAGE_SIZE,
): ParsedList<AccountMovementQuery> {
  const { range, preset } = resolveDateRange(
    one(params, 'period'),
    one(params, 'from'),
    one(params, 'to'),
    today,
  );
  const { minAmount, maxAmount } = parseAmountRange(one(params, 'min'), one(params, 'max'));

  const filters: AccountMovementQuery = { from: range.from, to: range.to };
  // Checked against the enum rather than passed through as free text: a
  // transaction type is a fixed set, and anything else should narrow nothing.
  put(filters, 'sourceType', parseEnum(one(params, 'type'), JOURNAL_SOURCE_TYPES));
  put(filters, 'flow', parseEnum(one(params, 'flow'), ['in', 'out'] as const));
  put(filters, 'search', parseSearch(one(params, 'q')));
  put(filters, 'minAmount', minAmount);
  put(filters, 'maxAmount', maxAmount);

  const paged = parsePage(one(params, 'page'), pageSize);

  return {
    filters,
    range,
    preset,
    page: paged.page,
    pageSize: paged.pageSize,
    carried: carry(params, ['period', 'from', 'to', 'q', 'type', 'flow', 'min', 'max']),
  };
}

// --- reports ---------------------------------------------------------------

export interface ParsedReport<Q> {
  filters: Q;
  range: DateRange;
  preset: DatePreset;
  carried: FilterValues;
}

/**
 * A report with nothing but a period — Profit & Loss, and the like.
 *
 * Reports do not paginate: they are a whole answer for a whole period, and half
 * a Profit & Loss is not a smaller Profit & Loss.
 */
export function parseReportPeriod(
  params: SearchParams,
  today: string = toBusinessDate(),
): ParsedReport<DateRange> {
  const { range, preset } = resolveDateRange(
    one(params, 'period'),
    one(params, 'from'),
    one(params, 'to'),
    today,
  );
  return { filters: range, range, preset, carried: carry(params, ['period', 'from', 'to']) };
}

export function parseSalesReportFilters(
  params: SearchParams,
  today: string = toBusinessDate(),
): ParsedReport<SalesReportQuery> {
  const { range, preset } = resolveDateRange(
    one(params, 'period'),
    one(params, 'from'),
    one(params, 'to'),
    today,
  );

  const filters: SalesReportQuery = { from: range.from, to: range.to };
  put(filters, 'customerId', parseId(one(params, 'customer')));
  put(filters, 'productId', parseId(one(params, 'product')));
  put(filters, 'categoryId', parseId(one(params, 'category')));
  put(filters, 'paymentAccountId', parseId(one(params, 'account')));

  return {
    filters,
    range,
    preset,
    carried: carry(params, ['period', 'from', 'to', 'customer', 'product', 'category', 'account']),
  };
}

export function parsePurchaseReportFilters(
  params: SearchParams,
  today: string = toBusinessDate(),
): ParsedReport<PurchaseReportQuery> {
  const { range, preset } = resolveDateRange(
    one(params, 'period'),
    one(params, 'from'),
    one(params, 'to'),
    today,
  );

  const filters: PurchaseReportQuery = { from: range.from, to: range.to };
  put(filters, 'supplierId', parseId(one(params, 'supplier')));
  put(filters, 'productId', parseId(one(params, 'product')));
  put(filters, 'categoryId', parseId(one(params, 'category')));
  put(filters, 'paymentAccountId', parseId(one(params, 'account')));

  return {
    filters,
    range,
    preset,
    carried: carry(params, ['period', 'from', 'to', 'supplier', 'product', 'category', 'account']),
  };
}

/** The inventory report is a position, not a period — no dates. */
export function parseInventoryReportFilters(params: SearchParams): {
  filters: StockValuationQuery;
  carried: FilterValues;
} {
  const filters: StockValuationQuery = {};
  put(filters, 'categoryId', parseId(one(params, 'category')));
  put(filters, 'supplierId', parseId(one(params, 'supplier')));
  put(filters, 'stockStatus', parseEnum(one(params, 'stock'), STOCK_STATUSES));

  return { filters, carried: carry(params, ['category', 'supplier', 'stock']) };
}

/** One account, for the cash-flow report. */
export function parseCashFlowFilters(
  params: SearchParams,
  today: string = toBusinessDate(),
): ParsedReport<DateRange> & { accountId: number | undefined } {
  const period = parseReportPeriod(params, today);
  return {
    ...period,
    accountId: parseId(one(params, 'account')),
    carried: carry(params, ['period', 'from', 'to', 'account']),
  };
}

// --- shared ----------------------------------------------------------------

/**
 * The filter keys that were actually set, ready to hang on a link.
 *
 * Deliberately built from a whitelist rather than by copying the whole query
 * string: a one-shot flash key like `created=1` must not ride along on the
 * pager and put a success banner back on the screen three pages later.
 */
function carry(params: SearchParams, keys: readonly string[]): FilterValues {
  const carried: FilterValues = {};
  for (const key of keys) {
    const value = one(params, key);
    if (value !== undefined && value !== '') carried[key] = value;
  }
  return carried;
}
