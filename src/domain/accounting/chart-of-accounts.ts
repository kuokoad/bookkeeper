import type { AccountType, NormalBalance } from '@/db/schema/accounting';

/**
 * Stable account codes.
 *
 * Domain code refers to accounts by these constants, never by a database id and
 * never by a display name — names are editable by the owner, ids differ between
 * a test database and a real one, but codes are permanent.
 */
export const ACCOUNT_CODES = {
  // Assets
  CASH: '1000',
  MOBILE_MONEY: '1010',
  BANK: '1020',
  ACCOUNTS_RECEIVABLE: '1100',
  INVENTORY: '1200',

  // Liabilities
  ACCOUNTS_PAYABLE: '2000',
  /**
   * VAT collected on sales, less VAT reclaimable on purchases. Kept as the
   * general "tax payable" code it has always been, so existing reports and
   * balances carry on meaning what they meant.
   */
  TAX_PAYABLE: '2100',
  /**
   * The Ghanaian levies, held separately from VAT because they are separate
   * obligations remitted on one return. Netting them into a single figure would
   * leave the shop unable to say what it owes under each, and unable to file.
   *
   * Keeping them apart also survived the law changing: until Act 1151 nothing
   * paid on a purchase could be reclaimed against either levy, and from
   * 1 January 2026 it can. A single blended tax account would have made that
   * change impossible to represent, let alone to report on either side of.
   */
  NHIL_PAYABLE: '2110',
  GETFUND_PAYABLE: '2120',

  // Equity
  OWNERS_CAPITAL: '3000',
  OWNERS_DRAWINGS: '3100',
  RETAINED_EARNINGS: '3200',
  OPENING_BALANCE_EQUITY: '3900',

  // Revenue
  SALES_REVENUE: '4000',
  SALES_DISCOUNTS: '4100',
  SALES_RETURNS: '4150',
  OTHER_INCOME: '4200',

  // Cost and expenses
  COST_OF_GOODS_SOLD: '5000',
  INVENTORY_SHRINKAGE: '5900',
  CASH_OVER_SHORT: '5910',
  OPERATING_EXPENSES: '6000',
} as const;

export type AccountCode = (typeof ACCOUNT_CODES)[keyof typeof ACCOUNT_CODES];

export interface AccountDefinition {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  description: string;
  sortOrder: number;
  /** Parent account code, for report grouping. */
  parentCode?: string;
  /**
   * A heading that groups children and is never posted to directly.
   *
   * Rather than adding a column, postability follows the standard accounting
   * rule: an account with children is a heading. This flag records the intent
   * for the seed and for readers of this file.
   */
  isHeader?: boolean;
}

/** Which side increases an account of this type. */
export function normalBalanceFor(type: AccountType): NormalBalance {
  switch (type) {
    case 'ASSET':
    case 'EXPENSE':
    case 'COGS':
    case 'CONTRA_EQUITY':
    case 'CONTRA_REVENUE':
      return 'DEBIT';
    case 'LIABILITY':
    case 'EQUITY':
    case 'REVENUE':
      return 'CREDIT';
  }
}

/** Accounts that appear on the Balance Sheet rather than the P&L. */
export function isBalanceSheetAccount(type: AccountType): boolean {
  return type === 'ASSET' || type === 'LIABILITY' || type === 'EQUITY' || type === 'CONTRA_EQUITY';
}

export function isProfitAndLossAccount(type: AccountType): boolean {
  return !isBalanceSheetAccount(type);
}

/**
 * The system chart of accounts, created by the seed and never deletable.
 *
 * Individual payment accounts (each MoMo wallet, each bank account) get their
 * own child asset account created at runtime under the relevant parent, so the
 * owner can add "Telecel Cash" without a code change.
 */
export const SYSTEM_ACCOUNTS: readonly AccountDefinition[] = [
  {
    code: ACCOUNT_CODES.CASH,
    name: 'Cash',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    description: 'Heading for physical cash. Each till is a child account.',
    sortOrder: 100,
    isHeader: true,
  },
  {
    code: ACCOUNT_CODES.MOBILE_MONEY,
    name: 'Mobile Money',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    description: 'Heading for mobile money wallets. Each wallet is a child account.',
    sortOrder: 110,
    isHeader: true,
  },
  {
    code: ACCOUNT_CODES.BANK,
    name: 'Bank',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    description: 'Heading for bank accounts. Each account is a child account.',
    sortOrder: 120,
    isHeader: true,
  },
  {
    code: ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
    name: 'Accounts Receivable',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    description: 'Money customers owe the shop for credit sales.',
    sortOrder: 130,
  },
  {
    code: ACCOUNT_CODES.INVENTORY,
    name: 'Inventory',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    description: 'Value of goods held for sale, at weighted average cost.',
    sortOrder: 140,
  },

  {
    code: ACCOUNT_CODES.ACCOUNTS_PAYABLE,
    name: 'Accounts Payable',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    description: 'Money the shop owes suppliers.',
    sortOrder: 200,
  },
  {
    code: ACCOUNT_CODES.TAX_PAYABLE,
    name: 'VAT Payable',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    description:
      'VAT charged on sales, less VAT paid on purchases, not yet remitted. A debit balance means the authority owes the shop.',
    sortOrder: 210,
  },
  {
    code: ACCOUNT_CODES.NHIL_PAYABLE,
    name: 'NHIL Payable',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    description:
      'National Health Insurance Levy collected on sales. Not reclaimable on purchases, so nothing is ever set against it.',
    sortOrder: 211,
  },
  {
    code: ACCOUNT_CODES.GETFUND_PAYABLE,
    name: 'GETFund Levy Payable',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    description:
      'Ghana Education Trust Fund levy collected on sales. Not reclaimable on purchases.',
    sortOrder: 212,
  },

  {
    code: ACCOUNT_CODES.OWNERS_CAPITAL,
    name: "Owner's Capital",
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    description: 'Money and goods the owner has put into the business.',
    sortOrder: 300,
  },
  {
    code: ACCOUNT_CODES.OWNERS_DRAWINGS,
    name: "Owner's Drawings",
    type: 'CONTRA_EQUITY',
    normalBalance: 'DEBIT',
    description: 'Money or goods the owner has taken out for personal use.',
    sortOrder: 310,
  },
  {
    code: ACCOUNT_CODES.RETAINED_EARNINGS,
    name: 'Retained Earnings',
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    description: 'Accumulated profit kept in the business from prior periods.',
    sortOrder: 320,
  },
  {
    code: ACCOUNT_CODES.OPENING_BALANCE_EQUITY,
    name: 'Opening Balance Equity',
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    description:
      'Balancing account used only when entering opening balances at setup. Should return to zero once setup is complete.',
    sortOrder: 390,
  },

  {
    code: ACCOUNT_CODES.SALES_REVENUE,
    name: 'Sales Revenue',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    description: 'Income from selling goods.',
    sortOrder: 400,
  },
  {
    code: ACCOUNT_CODES.SALES_DISCOUNTS,
    name: 'Sales Discounts',
    type: 'CONTRA_REVENUE',
    normalBalance: 'DEBIT',
    description: 'Discounts given to customers, shown as a reduction of revenue.',
    sortOrder: 410,
  },
  {
    code: ACCOUNT_CODES.SALES_RETURNS,
    name: 'Sales Returns',
    type: 'CONTRA_REVENUE',
    normalBalance: 'DEBIT',
    description:
      'Value of goods customers brought back, shown as a reduction of revenue rather than hidden by editing the original sale.',
    sortOrder: 415,
  },
  {
    code: ACCOUNT_CODES.OTHER_INCOME,
    name: 'Other Income',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    description: 'Income that is not from selling stock, such as commission or services.',
    sortOrder: 420,
  },

  {
    code: ACCOUNT_CODES.COST_OF_GOODS_SOLD,
    name: 'Cost of Goods Sold',
    type: 'COGS',
    normalBalance: 'DEBIT',
    description: 'What the goods sold actually cost the shop.',
    sortOrder: 500,
  },
  {
    code: ACCOUNT_CODES.INVENTORY_SHRINKAGE,
    name: 'Inventory Shrinkage',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    description: 'Value of stock lost, damaged, expired or written off.',
    sortOrder: 590,
  },
  {
    code: ACCOUNT_CODES.CASH_OVER_SHORT,
    name: 'Cash Over / Short',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    description:
      'Unexplained differences found during cash or MoMo reconciliation. Kept visible rather than hidden by editing history.',
    sortOrder: 591,
  },
  {
    code: ACCOUNT_CODES.OPERATING_EXPENSES,
    name: 'Operating Expenses',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    description: 'Parent account for day-to-day running costs.',
    sortOrder: 600,
  },
];

/**
 * Default expense categories, each becoming a child of Operating Expenses.
 * The owner can add, rename or deactivate these — nothing here is hard-coded
 * into business logic.
 */
export const DEFAULT_EXPENSE_CATEGORIES: readonly { code: string; name: string }[] = [
  { code: '6010', name: 'Rent' },
  { code: '6020', name: 'Electricity' },
  { code: '6030', name: 'Water' },
  { code: '6040', name: 'Internet & Airtime' },
  { code: '6050', name: 'Transport' },
  { code: '6060', name: 'Staff Wages' },
  { code: '6070', name: 'Repairs & Maintenance' },
  { code: '6080', name: 'Packaging' },
  { code: '6090', name: 'Bank Charges' },
  { code: '6100', name: 'MoMo Charges' },
  { code: '6110', name: 'Licences & Permits' },
  { code: '6900', name: 'Miscellaneous' },
];

/**
 * Payment accounts created at setup.
 *
 * Each owns its own child GL account so its balance is a plain ledger query.
 * `provider` is free text — adding "Telecel Cash" is data entry, not a code
 * change, which is the whole point of not hard-coding a mobile network.
 */
export const DEFAULT_PAYMENT_ACCOUNTS: readonly {
  name: string;
  kind: 'CASH' | 'MOBILE_MONEY' | 'BANK' | 'OTHER';
  provider: string | null;
  glCode: string;
  glName: string;
  parentCode: string;
  isDefault: boolean;
  sortOrder: number;
}[] = [
  {
    name: 'Cash',
    kind: 'CASH',
    provider: null,
    glCode: '1001',
    glName: 'Cash on Hand',
    parentCode: ACCOUNT_CODES.CASH,
    isDefault: true,
    sortOrder: 10,
  },
  {
    name: 'MTN MoMo',
    kind: 'MOBILE_MONEY',
    provider: 'MTN',
    glCode: '1011',
    glName: 'MTN Mobile Money',
    parentCode: ACCOUNT_CODES.MOBILE_MONEY,
    isDefault: false,
    sortOrder: 20,
  },
  {
    name: 'Bank Account',
    kind: 'BANK',
    provider: null,
    glCode: '1021',
    glName: 'Bank Account',
    parentCode: ACCOUNT_CODES.BANK,
    isDefault: false,
    sortOrder: 30,
  },
];

/** Default non-sales income categories. */
export const DEFAULT_INCOME_CATEGORIES: readonly { code: string; name: string }[] = [
  { code: '4210', name: 'Commission' },
  { code: '4220', name: 'Service Income' },
  { code: '4290', name: 'Miscellaneous Income' },
];
