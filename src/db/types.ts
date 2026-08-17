import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './schema';

/**
 * The database handle type.
 *
 * Declared here rather than in `client.ts` because `client.ts` is marked
 * `server-only` and would refuse to load inside a Vitest process. Services take
 * a `Db` as a parameter instead of importing the singleton, which keeps them
 * injectable: production passes the real connection, tests pass a throwaway one.
 */
export type Db = BetterSQLite3Database<typeof schema>;

/**
 * A handle inside an open transaction. Structurally identical to `Db`, but the
 * alias documents intent at call sites: a function taking `Tx` MUST be called
 * within `transaction(...)` and must not open its own.
 */
export type Tx = Db;
