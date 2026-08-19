import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { boolean, businessDate, createdAt, isDemo, moneyMinor, timestampMs, updatedAt } from './_shared';
import { oneOf } from './_check';
import { customers } from './parties';
import { suppliers } from './suppliers';
import { users } from './users';

/**
 * Account classification.
 *
 * CONTRA_REVENUE (sales discounts) and CONTRA_EQUITY (owner drawings) are
 * separate types rather than negative-balance hacks, so the P&L and Balance
 * Sheet can present them correctly without special-casing account codes.
 */
export const ACCOUNT_TYPES = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'CONTRA_EQUITY',
  'REVENUE',
  'CONTRA_REVENUE',
  'COGS',
  'EXPENSE',
] as const;

export const NORMAL_BALANCES = ['DEBIT', 'CREDIT'] as const;

/** Chart of accounts. */
export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** Stable numeric code, e.g. '1000' cash. Referenced by code in domain logic. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: ACCOUNT_TYPES }).notNull(),
    normalBalance: text('normal_balance', { enum: NORMAL_BALANCES }).notNull(),

    parentId: integer('parent_id'),

    /**
     * System accounts are created by migration/seed and are required for posting.
     * They cannot be deleted or have their code or type changed.
     */
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_accounts_code').on(t.code),
    index('idx_accounts_type').on(t.type),
    index('idx_accounts_parent').on(t.parentId),
    check('ck_accounts_code_len', sql`length(${t.code}) BETWEEN 1 AND 20`),
    // An account cannot be its own parent.
    check('ck_accounts_parent_not_self', sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
    check('ck_accounts_type', oneOf(t.type, ACCOUNT_TYPES)),
    check('ck_accounts_normal_balance', oneOf(t.normalBalance, NORMAL_BALANCES)),
    // The normal balance must match the account type, or every report that
    // sign-adjusts a balance would silently present it backwards.
    check(
      'ck_accounts_normal_balance_matches_type',
      sql`(${t.type} IN ('ASSET','EXPENSE','COGS','CONTRA_EQUITY','CONTRA_REVENUE') AND ${t.normalBalance} = 'DEBIT')
          OR (${t.type} IN ('LIABILITY','EQUITY','REVENUE') AND ${t.normalBalance} = 'CREDIT')`,
    ),
  ],
);

/**
 * Payment accounts — the money containers the owner actually thinks in:
 * "Cash box", "MTN MoMo", "Telecel Cash", "GCB current account".
 *
 * `provider` is free text, NOT an enum: no mobile network is hard-coded, and the
 * owner can add a new one without a code change.
 *
 * Each payment account owns exactly one GL asset account, so its balance is a
 * plain ledger query and can never disagree with the books.
 */
export const PAYMENT_ACCOUNT_KINDS = ['CASH', 'MOBILE_MONEY', 'BANK', 'OTHER'] as const;

export const paymentAccounts = sqliteTable(
  'payment_accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    name: text('name').notNull(),
    kind: text('kind', { enum: PAYMENT_ACCOUNT_KINDS }).notNull(),
    /** e.g. 'MTN', 'Telecel', 'AirtelTigo', 'GCB'. Free text by design. */
    provider: text('provider'),
    accountNumber: text('account_number'),

    glAccountId: integer('gl_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),

    isActive: boolean('is_active').notNull().default(true),
    /** Pre-selected in the POS payment step. At most one may be true. */
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),

    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_payment_accounts_name').on(sql`lower(${t.name})`),
    uniqueIndex('uq_payment_accounts_gl').on(t.glAccountId),
    index('idx_payment_accounts_active').on(t.isActive),
    check('ck_payment_accounts_kind', oneOf(t.kind, PAYMENT_ACCOUNT_KINDS)),
    check('ck_payment_accounts_name', sql`length(${t.name}) > 0`),
  ],
);

/**
 * What business event produced a journal entry. Every entry must name one —
 * there is no free-form journal in v1, which is what guarantees that any figure
 * on any report can be traced back to a real transaction.
 */
export const JOURNAL_SOURCE_TYPES = [
  'SALE',
  'SALE_RETURN',
  'PURCHASE',
  'PURCHASE_RETURN',
  'CUSTOMER_PAYMENT',
  'SUPPLIER_PAYMENT',
  'EXPENSE',
  'INCOME',
  'STOCK_ADJUSTMENT',
  'RECONCILIATION',
  'OPENING_BALANCE',
  'CAPITAL',
  'DRAWINGS',
  'REVERSAL',
  'YEAR_END_CLOSE',
] as const;

export const journalEntries = sqliteTable(
  'journal_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entryNo: text('entry_no').notNull(),

    /** The business day this entry belongs to ('YYYY-MM-DD', shop-local). */
    entryDate: businessDate('entry_date').notNull(),
    /** The instant it was recorded. Audit time, not reporting time. */
    occurredAt: timestampMs('occurred_at').notNull(),

    sourceType: text('source_type', { enum: JOURNAL_SOURCE_TYPES }).notNull(),
    /**
     * Primary key of the row in the source table. Null only where there is
     * genuinely no source document: OPENING_BALANCE (where the books started)
     * and YEAR_END_CLOSE (the books tidying themselves).
     */
    sourceId: integer('source_id'),

    memo: text('memo'),

    /** Opening balances are flagged so reports never mix them with trading activity. */
    isOpening: boolean('is_opening').notNull().default(false),

    /**
     * A year-end closing entry, which sweeps the year's revenue and expenses
     * into Retained Earnings.
     *
     * Flagged rather than inferred from `sourceType` because the Profit & Loss
     * MUST exclude these. A closing entry dated 31 December falls inside that
     * year, and counting it would net the year's own profit to zero — the
     * report would show nothing earned in a year the shop traded well.
     */
    isClosing: boolean('is_closing').notNull().default(false),

    /** Reversal linkage — history is corrected by addition, never by deletion. */
    reversesEntryId: integer('reverses_entry_id'),
    reversedByEntryId: integer('reversed_by_entry_id'),

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_journal_entries_no').on(t.entryNo),
    index('idx_journal_entries_date').on(t.entryDate),
    index('idx_journal_entries_source').on(t.sourceType, t.sourceId),
    index('idx_journal_entries_occurred').on(t.occurredAt),
    index('idx_journal_entries_reverses').on(t.reversesEntryId),
    // 'YYYY-MM-DD' shape enforced at the database level.
    check(
      'ck_journal_entries_date_format',
      sql`${t.entryDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check(
      'ck_journal_entries_not_self_reversing',
      sql`${t.reversesEntryId} IS NULL OR ${t.reversesEntryId} <> ${t.id}`,
    ),
    check('ck_journal_entries_source_type', oneOf(t.sourceType, JOURNAL_SOURCE_TYPES)),
    // Every entry must name the business transaction it came from. Only an
    // opening balance is allowed to have no source row.
    check(
      'ck_journal_entries_traceable',
      sql`${t.sourceId} IS NOT NULL OR ${t.sourceType} IN ('OPENING_BALANCE', 'YEAR_END_CLOSE')`,
    ),
  ],
);

/**
 * The individual debit/credit lines.
 *
 * CHECK constraints make a malformed line impossible at the storage layer:
 * amounts are non-negative, and a line is exactly one of a debit or a credit —
 * never both, never neither. The "entry balances" rule spans rows, so it is
 * asserted by the posting service inside the same transaction before commit.
 */
export const journalLines = sqliteTable(
  'journal_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    entryId: integer('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),

    debitMinor: moneyMinor('debit_minor').notNull().default(0),
    creditMinor: moneyMinor('credit_minor').notNull().default(0),

    /** Which money container moved, when this line touches one. */
    paymentAccountId: integer('payment_account_id').references(() => paymentAccounts.id, {
      onDelete: 'restrict',
    }),

    /**
     * Subledger tag.
     *
     * Set on lines that hit Accounts Receivable, so what one customer owes is a
     * query over these lines rather than a separately maintained total. The
     * sum of every customer's balance therefore EQUALS the A/R control account
     * by construction — an invariant the test suite asserts.
     */
    customerId: integer('customer_id').references(() => customers.id, { onDelete: 'restrict' }),

    /** The same idea for Accounts Payable: what the shop owes one supplier. */
    supplierId: integer('supplier_id').references(() => suppliers.id, { onDelete: 'restrict' }),

    description: text('description'),

    createdAt: createdAt(),
  },
  (t) => [
    index('idx_journal_lines_entry').on(t.entryId),
    // The workhorse index for every balance and report query.
    index('idx_journal_lines_account').on(t.accountId, t.entryId),
    index('idx_journal_lines_payment_account').on(t.paymentAccountId),
    index('idx_journal_lines_customer').on(t.customerId),
    index('idx_journal_lines_supplier').on(t.supplierId),
    uniqueIndex('uq_journal_lines_entry_line').on(t.entryId, t.lineNo),

    check('ck_journal_lines_debit_nonneg', sql`${t.debitMinor} >= 0`),
    check('ck_journal_lines_credit_nonneg', sql`${t.creditMinor} >= 0`),
    // Exactly one side carries the amount.
    check(
      'ck_journal_lines_one_sided',
      sql`(${t.debitMinor} = 0 AND ${t.creditMinor} > 0) OR (${t.debitMinor} > 0 AND ${t.creditMinor} = 0)`,
    ),
  ],
);

/**
 * One row per financial year that has been closed.
 *
 * The closing journal entry alone would say what happened but not that a close
 * was *declared*, nor let a second close be refused. This does both, and keeps
 * the reversal linked to the close it undoes rather than floating free.
 */
export const yearEndClosings = sqliteTable(
  'year_end_closings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** The calendar year the financial year STARTS in — how a year is named. */
    startYear: integer('start_year').notNull(),
    periodStart: businessDate('period_start').notNull(),
    periodEnd: businessDate('period_end').notNull(),

    /** The closing entry itself. */
    journalEntryId: integer('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),

    /** Snapshotted at the moment of closing, so the figures cannot drift. */
    profitMinor: moneyMinor('profit_minor').notNull(),
    drawingsMinor: moneyMinor('drawings_minor').notNull(),

    closedBy: integer('closed_by').references(() => users.id, { onDelete: 'set null' }),
    closedAt: timestampMs('closed_at').notNull(),

    /** Reopening does not delete this row — it records the undoing. */
    reversedAt: timestampMs('reversed_at'),
    reversedBy: integer('reversed_by').references(() => users.id, { onDelete: 'set null' }),
    reversalEntryId: integer('reversal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    createdAt: createdAt(),
  },
  (t) => [
    // A year can only be open once and closed once at a time. Partial unique
    // index: a reopened year may be closed again, and both rows remain.
    uniqueIndex('uq_year_end_closings_open')
      .on(t.startYear)
      .where(sql`${t.reversedAt} IS NULL`),
    index('idx_year_end_closings_year').on(t.startYear),
    check('ck_year_end_closings_period', sql`${t.periodEnd} > ${t.periodStart}`),
    // Reversal details arrive together or not at all.
    check(
      'ck_year_end_closings_reversal',
      sql`(${t.reversedAt} IS NULL AND ${t.reversalEntryId} IS NULL)
          OR (${t.reversedAt} IS NOT NULL AND ${t.reversalEntryId} IS NOT NULL)`,
    ),
  ],
);

export type YearEndClosing = typeof yearEndClosings.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type PaymentAccount = typeof paymentAccounts.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalLine = typeof journalLines.$inferSelect;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type NormalBalance = (typeof NORMAL_BALANCES)[number];
export type JournalSourceType = (typeof JOURNAL_SOURCE_TYPES)[number];
export type PaymentAccountKind = (typeof PAYMENT_ACCOUNT_KINDS)[number];
