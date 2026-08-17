import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  businessDate,
  createdAt,
  isDemo,
  moneyMinor,
  timestampMs,
  updatedAt,
} from './_shared';
import { oneOf } from './_check';
import { accounts, journalEntries, paymentAccounts } from './accounting';
import { users } from './users';

export const CASHBOOK_STATUSES = ['POSTED', 'VOIDED'] as const;

/**
 * Expenses — money spent running the shop that is not buying stock.
 *
 * `categoryAccountId` points at a real expense account in the chart of
 * accounts. There is deliberately no separate "expense categories" table: a
 * category IS an account, so the Profit & Loss groups spending correctly with
 * no mapping layer that could drift out of step.
 */
export const expenses = sqliteTable(
  'expenses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    expenseNo: text('expense_no').notNull(),

    businessDate: businessDate('business_date').notNull(),
    occurredAt: timestampMs('occurred_at').notNull(),

    /** An EXPENSE-type account. Enforced by the service, not just the FK. */
    categoryAccountId: integer('category_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),

    description: text('description').notNull(),
    amountMinor: moneyMinor('amount_minor').notNull(),

    /** Which pot the money came out of. */
    paymentAccountId: integer('payment_account_id')
      .notNull()
      .references(() => paymentAccounts.id, { onDelete: 'restrict' }),

    reference: text('reference'),
    note: text('note'),

    status: text('status', { enum: CASHBOOK_STATUSES }).notNull().default('POSTED'),
    journalEntryId: integer('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    voidedAt: timestampMs('voided_at'),
    voidReason: text('void_reason'),

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_expenses_no').on(t.expenseNo),
    index('idx_expenses_date').on(t.businessDate),
    index('idx_expenses_category').on(t.categoryAccountId),
    index('idx_expenses_payment_account').on(t.paymentAccountId),
    index('idx_expenses_status').on(t.status),

    check('ck_expenses_status', oneOf(t.status, CASHBOOK_STATUSES)),
    check('ck_expenses_amount_positive', sql`${t.amountMinor} > 0`),
    check('ck_expenses_description', sql`length(trim(${t.description})) > 0`),
    check(
      'ck_expenses_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
  ],
);

/**
 * Other income — money in that is not a product sale: commission, a service
 * charge, rent from a sublet corner of the shop.
 */
export const incomes = sqliteTable(
  'incomes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    incomeNo: text('income_no').notNull(),

    businessDate: businessDate('business_date').notNull(),
    occurredAt: timestampMs('occurred_at').notNull(),

    /** A REVENUE-type account under Other Income. */
    categoryAccountId: integer('category_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),

    description: text('description').notNull(),
    amountMinor: moneyMinor('amount_minor').notNull(),

    paymentAccountId: integer('payment_account_id')
      .notNull()
      .references(() => paymentAccounts.id, { onDelete: 'restrict' }),

    reference: text('reference'),
    note: text('note'),

    status: text('status', { enum: CASHBOOK_STATUSES }).notNull().default('POSTED'),
    journalEntryId: integer('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    voidedAt: timestampMs('voided_at'),
    voidReason: text('void_reason'),

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_incomes_no').on(t.incomeNo),
    index('idx_incomes_date').on(t.businessDate),
    index('idx_incomes_category').on(t.categoryAccountId),
    index('idx_incomes_payment_account').on(t.paymentAccountId),
    index('idx_incomes_status').on(t.status),

    check('ck_incomes_status', oneOf(t.status, CASHBOOK_STATUSES)),
    check('ck_incomes_amount_positive', sql`${t.amountMinor} > 0`),
    check('ck_incomes_description', sql`length(trim(${t.description})) > 0`),
    check(
      'ck_incomes_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
  ],
);

export const OWNER_MOVEMENT_KINDS = ['CAPITAL', 'DRAWINGS'] as const;

/**
 * The owner putting money into the business, or taking it out.
 *
 * This table exists so those entries have a real source row to point at. The
 * database requires every journal entry to name its source document, and that
 * rule is worth more than the convenience of skipping a table — an entry that
 * traces to nothing is exactly what makes a set of books unauditable.
 */
export const ownerMovements = sqliteTable(
  'owner_movements',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    movementNo: text('movement_no').notNull(),

    kind: text('kind', { enum: OWNER_MOVEMENT_KINDS }).notNull(),

    businessDate: businessDate('business_date').notNull(),
    occurredAt: timestampMs('occurred_at').notNull(),

    paymentAccountId: integer('payment_account_id')
      .notNull()
      .references(() => paymentAccounts.id, { onDelete: 'restrict' }),

    amountMinor: moneyMinor('amount_minor').notNull(),
    description: text('description').notNull(),

    status: text('status', { enum: CASHBOOK_STATUSES }).notNull().default('POSTED'),
    journalEntryId: integer('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    voidedAt: timestampMs('voided_at'),
    voidReason: text('void_reason'),

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_owner_movements_no').on(t.movementNo),
    index('idx_owner_movements_date').on(t.businessDate),
    index('idx_owner_movements_kind').on(t.kind),
    check('ck_owner_movements_kind', oneOf(t.kind, OWNER_MOVEMENT_KINDS)),
    check('ck_owner_movements_status', oneOf(t.status, CASHBOOK_STATUSES)),
    check('ck_owner_movements_amount_positive', sql`${t.amountMinor} > 0`),
    check(
      'ck_owner_movements_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
  ],
);

export type Expense = typeof expenses.$inferSelect;
export type Income = typeof incomes.$inferSelect;
export type OwnerMovement = typeof ownerMovements.$inferSelect;
export type OwnerMovementKind = (typeof OWNER_MOVEMENT_KINDS)[number];
export type CashbookStatus = (typeof CASHBOOK_STATUSES)[number];
