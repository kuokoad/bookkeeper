import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { boolean, createdAt, isDemo, moneyMinor, updatedAt } from './_shared';
import { users } from './users';

/**
 * Customers.
 *
 * Note what is NOT stored here: a balance. What a customer owes is derived from
 * the accounts-receivable journal lines tagged with their id, so the figure on
 * their profile and the figure on the balance sheet are the same number read
 * two ways, and cannot drift apart.
 */
export const customers = sqliteTable(
  'customers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    notes: text('notes'),

    /**
     * Maximum credit allowed. NULL means no limit set — deliberately distinct
     * from 0, which means "this customer may not buy on credit at all".
     */
    creditLimitMinor: moneyMinor('credit_limit_minor'),

    isActive: boolean('is_active').notNull().default(true),

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_customers_name').on(t.name),
    index('idx_customers_phone').on(t.phone),
    index('idx_customers_active').on(t.isActive),
    check('ck_customers_name', sql`length(trim(${t.name})) > 0`),
    check(
      'ck_customers_credit_limit',
      sql`${t.creditLimitMinor} IS NULL OR ${t.creditLimitMinor} >= 0`,
    ),
  ],
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
