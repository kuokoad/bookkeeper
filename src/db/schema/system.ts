import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { boolean, businessDate, createdAt, timestampMs, updatedAt } from './_shared';
import { oneOf } from './_check';

/**
 * Business settings — a strict singleton (id is pinned to 1 by a CHECK).
 * Currency, tax and stock policy live here so nothing is hard-coded in code.
 */
export const businessSettings = sqliteTable(
  'business_settings',
  {
    id: integer('id').primaryKey(),

    businessName: text('business_name').notNull().default('My Shop'),
    address: text('address'),
    phone: text('phone'),
    email: text('email'),
    logoPath: text('logo_path'),

    // Currency is configurable — GHS is the default, not an assumption.
    currencyCode: text('currency_code').notNull().default('GHS'),
    currencySymbol: text('currency_symbol').notNull().default('₵'),

    // Tax expressed in basis points (1250 = 12.5%) so it stays integer.
    taxEnabled: boolean('tax_enabled').notNull().default(false),
    taxRateBp: integer('tax_rate_bp').notNull().default(0),
    taxInclusive: boolean('tax_inclusive').notNull().default(false),
    taxLabel: text('tax_label').notNull().default('VAT'),

    // Inventory policy.
    lowStockThresholdMilli: integer('low_stock_threshold_milli').notNull().default(5000),
    allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),

    // Payment policy.
    allowOverpayment: boolean('allow_overpayment').notNull().default(false),

    /** Month the financial year starts, 1-12. Ghana commonly uses January. */
    financialYearStartMonth: integer('financial_year_start_month').notNull().default(1),

    /**
     * Books lock. Transactions dated ON OR BEFORE this day are refused.
     *
     * NULL means nothing is locked. This is a control, not an accounting
     * close: it stops a past period being quietly rewritten, while leaving
     * corrections possible through a current-dated reversal — which is what
     * proper practice requires anyway.
     */
    booksLockedBefore: businessDate('books_locked_before'),

    /** True while the database still contains seeded demo rows. */
    hasDemoData: boolean('has_demo_data').notNull().default(false),

    /** Bumped when the first owner account is created; gates the setup screen. */
    setupCompletedAt: timestampMs('setup_completed_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('ck_business_settings_singleton', sql`${t.id} = 1`),
    check('ck_business_settings_tax_rate', sql`${t.taxRateBp} >= 0 AND ${t.taxRateBp} <= 100000`),
    check(
      'ck_business_settings_fy_month',
      sql`${t.financialYearStartMonth} BETWEEN 1 AND 12`,
    ),
    check('ck_business_settings_currency', sql`length(${t.currencyCode}) BETWEEN 2 AND 4`),
    check(
      'ck_business_settings_lock_date_format',
      sql`${t.booksLockedBefore} IS NULL OR ${t.booksLockedBefore} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
  ],
);

/**
 * Atomic document numbering (receipts, invoices, journal entries, adjustments).
 * Incremented inside the same transaction as the document it numbers, so two
 * concurrent sales can never receive the same receipt number.
 */
export const sequences = sqliteTable(
  'sequences',
  {
    docType: text('doc_type').primaryKey(),
    prefix: text('prefix').notNull().default(''),
    nextNumber: integer('next_number').notNull().default(1),
    padding: integer('padding').notNull().default(5),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('ck_sequences_next_positive', sql`${t.nextNumber} >= 1`),
    check('ck_sequences_padding', sql`${t.padding} BETWEEN 0 AND 12`),
  ],
);

export const AUDIT_ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'CREATE',
  'UPDATE',
  'ARCHIVE',
  'RESTORE',
  'VOID',
  'REVERSE',
  'RECONCILE',
  'PERMISSION_CHANGE',
  'PASSWORD_CHANGE',
  'SETTINGS_CHANGE',
  'SEED_DEMO',
  'PURGE_DEMO',
] as const;

/**
 * Append-only audit trail. There is no UI path that deletes from this table,
 * and no service function that updates a row once written.
 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** Null only for system-generated events (migrations, seeding). */
    userId: integer('user_id'),
    username: text('username'),

    action: text('action', { enum: AUDIT_ACTIONS }).notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),

    /** Human-readable one-liner shown in the audit log UI. */
    summary: text('summary').notNull(),

    /** JSON blob of before/after or contextual detail. */
    metadata: text('metadata'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: createdAt(),
  },
  (t) => [
    index('idx_audit_logs_created_at').on(t.createdAt),
    index('idx_audit_logs_entity').on(t.entityType, t.entityId),
    index('idx_audit_logs_user').on(t.userId),
    index('idx_audit_logs_action').on(t.action),
    check('ck_audit_logs_action', oneOf(t.action, AUDIT_ACTIONS)),
    check('ck_audit_logs_summary', sql`length(${t.summary}) > 0`),
  ],
);

export type BusinessSettings = typeof businessSettings.$inferSelect;
export type Sequence = typeof sequences.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
