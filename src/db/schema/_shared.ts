import { integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Shared column builders.
 *
 * Two distinct notions of time, deliberately kept apart:
 *
 *  - `*_at`      — an instant, stored as Unix milliseconds UTC. Machine time.
 *  - `*_date`    — a business day, stored as TEXT 'YYYY-MM-DD' in the shop's
 *                  local calendar. A sale rung up at 11:40 pm belongs to that
 *                  day's takings, and a P&L for "March" must use this, not UTC.
 *
 * Conflating the two is how reports quietly disagree with the owner's own
 * count of the day.
 */

export const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const createdAt = () =>
  timestampMs('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const updatedAt = () =>
  timestampMs('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

/** A business day in the shop's local calendar: 'YYYY-MM-DD'. */
export const businessDate = (name: string) => text(name);

/** SQLite has no boolean; 0/1 integer with a CHECK is the honest representation. */
export const boolean = (name: string) => integer(name, { mode: 'boolean' });

/**
 * Money column. ALWAYS an integer count of minor units (pesewas).
 * Naming every such column `*_minor` makes a float slipping in visible in review.
 */
export const moneyMinor = (name: string) => integer(name);

/** Quantity column. ALWAYS an integer count of milli-units (3 dp). */
export const qtyMilli = (name: string) => integer(name);

/**
 * Marks a row as demo/seed data so a real shop can purge it in one action and
 * never confuse it with genuine records.
 */
export const isDemo = () => boolean('is_demo').notNull().default(false);
