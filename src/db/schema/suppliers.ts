import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { boolean, createdAt, isDemo, updatedAt } from './_shared';
import { users } from './users';

/**
 * Suppliers.
 *
 * As with customers, no balance is stored. What the shop owes a supplier is
 * derived from the Accounts Payable journal lines tagged with their id, so the
 * figure on their profile and the figure on the balance sheet are the same
 * number read two ways.
 */
export const suppliers = sqliteTable(
  'suppliers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    name: text('name').notNull(),
    contactPerson: text('contact_person'),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    notes: text('notes'),

    isActive: boolean('is_active').notNull().default(true),

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_suppliers_name').on(t.name),
    index('idx_suppliers_phone').on(t.phone),
    index('idx_suppliers_active').on(t.isActive),
    check('ck_suppliers_name', sql`length(trim(${t.name})) > 0`),
  ],
);

export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
