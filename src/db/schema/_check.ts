import { sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Build a real `col IN ('a','b',...)` CHECK constraint from a const tuple.
 *
 * Drizzle's `text('x', { enum: [...] })` is a TYPE-level constraint only — it
 * generates no SQL and the database will happily accept any string. For a
 * financial schema that is not good enough: an audit action, a journal source
 * type or a permission module written by a future code path, a raw SQL fix, or
 * a direct edit of the database file must be rejected by the database itself.
 *
 * Deriving the list from the same tuple the TypeScript type uses means the two
 * cannot drift apart.
 *
 * The values MUST be emitted as SQL literals via `sql.raw`. Interpolating them
 * as `sql`${value}`` produces bound parameters (`IN (?, ?, ?)`), which is
 * meaningless inside a CHECK constraint written to a migration file.
 */

// These come from const tuples in the schema, never from user input. The guard
// exists so a future contributor cannot introduce an injection point by
// widening the source of these values.
const SAFE_ENUM_VALUE = /^[A-Za-z0-9_]+$/;

export function oneOf(column: AnySQLiteColumn, values: readonly string[]): SQL {
  if (values.length === 0) {
    throw new Error('oneOf() requires at least one permitted value.');
  }

  for (const value of values) {
    if (!SAFE_ENUM_VALUE.test(value)) {
      throw new Error(
        `Unsafe enum value ${JSON.stringify(value)} in a CHECK constraint. ` +
          'Permitted values must be simple identifiers defined as compile-time constants.',
      );
    }
  }

  return sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(', '))})`;
}
