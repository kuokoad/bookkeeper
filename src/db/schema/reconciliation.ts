import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  boolean,
  businessDate,
  createdAt,
  isDemo,
  moneyMinor,
  timestampMs,
  updatedAt,
} from './_shared';
import { oneOf } from './_check';
import { journalEntries, paymentAccounts } from './accounting';
import { users } from './users';

export const RECONCILIATION_STATUSES = ['POSTED', 'VOIDED'] as const;

/**
 * A cash / MoMo / bank count.
 *
 * Records three facts and keeps them forever: what the books said, what was
 * actually there, and the difference between them. The books are NEVER edited
 * to make the two agree — if the owner accepts the difference, it posts its own
 * visible adjusting entry to Cash Over / Short, so the discrepancy shows up in
 * the accounts instead of disappearing.
 *
 * `expectedMinor` is a snapshot taken at the moment of counting. Keeping it
 * (rather than recomputing later) is the whole point: it is the evidence of
 * what the system claimed at the time.
 */
export const reconciliations = sqliteTable(
  'reconciliations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reconciliationNo: text('reconciliation_no').notNull(),

    paymentAccountId: integer('payment_account_id')
      .notNull()
      .references(() => paymentAccounts.id, { onDelete: 'restrict' }),

    /** The day being counted. */
    businessDate: businessDate('business_date').notNull(),
    occurredAt: timestampMs('occurred_at').notNull(),

    /** What the ledger said the balance was, as at businessDate. */
    expectedMinor: moneyMinor('expected_minor').notNull(),
    /** What was actually counted. */
    actualMinor: moneyMinor('actual_minor').notNull(),
    /** actual - expected. Positive = more than expected. */
    differenceMinor: moneyMinor('difference_minor').notNull(),

    /** Required whenever there is a difference. */
    explanation: text('explanation'),

    /**
     * True when an adjusting entry was posted to bring the books in line.
     * False means the difference was recorded and left open for investigation.
     */
    adjusted: boolean('adjusted').notNull().default(false),

    status: text('status', { enum: RECONCILIATION_STATUSES }).notNull().default('POSTED'),
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
    uniqueIndex('uq_reconciliations_no').on(t.reconciliationNo),
    index('idx_reconciliations_account').on(t.paymentAccountId, t.businessDate),
    index('idx_reconciliations_date').on(t.businessDate),
    index('idx_reconciliations_status').on(t.status),

    check('ck_reconciliations_status', oneOf(t.status, RECONCILIATION_STATUSES)),
    check(
      'ck_reconciliations_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    // The arithmetic must hold at the storage layer, so a tampered row is
    // rejected rather than believed.
    check(
      'ck_reconciliations_difference',
      sql`${t.differenceMinor} = ${t.actualMinor} - ${t.expectedMinor}`,
    ),
    // A difference always needs a reason; a clean count does not.
    check(
      'ck_reconciliations_explained',
      sql`${t.differenceMinor} = 0 OR (${t.explanation} IS NOT NULL AND length(trim(${t.explanation})) > 0)`,
    ),
  ],
);

export type Reconciliation = typeof reconciliations.$inferSelect;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];
