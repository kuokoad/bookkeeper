import { sql } from 'drizzle-orm';
import { blob, check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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

    /**
     * The line under the shop name in the menu.
     *
     * Defaulted to the wording it replaced, so an existing shop sees no change
     * until it decides otherwise. Cleared to NULL, the line disappears
     * altogether rather than falling back to something the owner deleted.
     */
    tagline: text('tagline').default('Bookkeeping & stock'),
    address: text('address'),
    phone: text('phone'),
    email: text('email'),
    /**
     * The shop's logo, stored IN the database rather than as a path to a file.
     *
     * Two reasons, both learned the hard way elsewhere in this project. A file
     * on disk is not copied by `npm run backup`, which copies the database and
     * nothing else — a restore would bring back every sale and every balance
     * but leave a broken image on every receipt, and a backup that is silently
     * incomplete is worse than one that fails loudly. And on a managed host the
     * application folder is rewritten on every deploy, so a file beside the app
     * would vanish without a word.
     *
     * A logo is tens of kilobytes against a database measured in megabytes.
     */
    logoData: blob('logo_data', { mode: 'buffer' }),
    /** Confirmed from the file's own bytes, never from what the browser said. */
    logoMime: text('logo_mime'),
    logoWidth: integer('logo_width'),
    logoHeight: integer('logo_height'),
    logoUpdatedAt: timestampMs('logo_updated_at'),

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

    /** How long before a batch's date the shop wants to hear about it. */
    expiryWarningDays: integer('expiry_warning_days').notNull().default(30),

    /**
     * Whether expired stock is refused at the till.
     *
     * On by default, because selling goods past their date is the thing this
     * feature exists to prevent. Off for a shop that stocks nothing perishable
     * and does not want a block it can only ever hit by accident — the warnings
     * still show either way.
     *
     * Expired stock is SKIPPED rather than blocking whenever good stock covers
     * the sale, so this only ever fires when there is genuinely nothing else to
     * sell. A block that fired more often than that would be routed around, and
     * a sale made off-system is worse than one made from an old batch.
     */
    expiryBlocksSales: boolean('expiry_blocks_sales').notNull().default(true),

    // Payment policy.
    allowOverpayment: boolean('allow_overpayment').notNull().default(false),

    /** Days a credit customer is given to pay, unless overridden on the sale. */
    defaultTermsDays: integer('default_terms_days').notNull().default(30),

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

/**
 * Fixed-window throttle counters, for sign-in attempts.
 *
 * Kept in the database rather than in process memory, because memory is emptied
 * by every restart and every redeploy — and a throttle that forgets is one an
 * attacker resets by waiting for a deploy, or by whatever made the app restart.
 * It is also invisible to a second process, so under any deployment that forks
 * workers each one would hand out its own fresh allowance.
 *
 * The per-account lockout in `users` is the primary defence and always was; this
 * is the layer that stops one machine working through many usernames, and it is
 * worth no less than the accounts it protects.
 *
 * Rows are disposable: losing them costs an attacker's counter, not a shop's
 * records, so nothing here is referenced by anything else.
 */
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    /** Opaque bucket name, e.g. `login:shared`. Built by `clientThrottleKey`. */
    key: text('key').primaryKey(),
    attempts: integer('attempts').notNull().default(0),
    /** Unix ms at which this window ends and the count starts again. */
    resetAt: timestampMs('reset_at').notNull(),
  },
  (t) => [
    index('idx_rate_limits_reset').on(t.resetAt),
    check('ck_rate_limits_attempts', sql`${t.attempts} >= 0`),
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
