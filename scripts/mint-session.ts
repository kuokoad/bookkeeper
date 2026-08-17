/**
 * Prints a valid session token for the demo owner. Development only.
 *
 * Opens its own database connection rather than importing `@/db/client`, which
 * is marked `server-only` and refuses to load outside a React Server Component.
 * Used by scripts/smoke-test.mjs.
 */
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from '@/db/schema';
import { configureConnection } from '@/db/pragmas';
import type { Db } from '@/db/types';
import { login, loginWithPin } from '@/services/auth.service';
import { env, isProduction } from '@/lib/env';

if (isProduction) {
  console.error('Refusing to mint a session token with NODE_ENV=production.');
  process.exit(1);
}

const username = process.argv[2] ?? 'owner';
const secret = process.argv[3] ?? 'demo-owner-2026';
// `--pin` signs in the till way instead, so the smoke test can prove that path
// end to end rather than only in unit tests.
const usePin = process.argv.includes('--pin');

const connection = new Database(resolve(process.cwd(), env.DATABASE_PATH));
configureConnection(connection);

try {
  const db = drizzle(connection, { schema }) as Db;
  const result = usePin
    ? await loginWithPin(db, { username, pin: secret })
    : await login(db, { username, password: secret });

  if (!result.ok) {
    console.error(`LOGIN_FAILED:${result.reason}`);
    process.exit(1);
  }

  process.stdout.write(result.token);
} finally {
  connection.close();
}
