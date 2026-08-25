/**
 * The checks to pass before a real shop trusts this with its money.
 *
 * Every item here is something that is easy to get wrong once, silently, and
 * then only discover after weeks of trading — a placeholder secret, demo sales
 * mixed into the real books, migrations not applied, a database that no longer
 * balances. Each is stated as a plain question with a yes or no answer.
 *
 * Usage: npm run preflight
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

import { configureConnection } from '@/db/pragmas';
import { isDirectRun } from '@/db/_cli';
import { env } from '@/lib/env';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** `fail` blocks going live. `warn` is a judgement call the owner should make. */
export function runPreflight(databasePath: string = env.DATABASE_PATH): Check[] {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) =>
    checks.push({ name, status, detail });

  // --- configuration -------------------------------------------------------

  if (env.NODE_ENV === 'production') {
    add('Running in production mode', 'pass', 'NODE_ENV=production');
  } else {
    add(
      'Running in production mode',
      'warn',
      `NODE_ENV is "${env.NODE_ENV}". Set NODE_ENV=production before real trading, or error details meant for a developer may reach the screen.`,
    );
  }

  const secret = env.SESSION_SECRET;
  if (secret.startsWith('replace-me') || secret.includes('test-only')) {
    add('Session secret is real', 'fail', 'SESSION_SECRET is still a placeholder. Run `npm run env:init`.');
  } else if (secret.length < 48) {
    add(
      'Session secret is real',
      'warn',
      `SESSION_SECRET is ${secret.length} characters. 64 hex characters is the intended strength.`,
    );
  } else {
    add('Session secret is real', 'pass', `${secret.length} characters, not a placeholder`);
  }

  if (env.SEED_DEMO_DATA) {
    add(
      'Demo seeding is off',
      'fail',
      'SEED_DEMO_DATA is true. Set it to false so demo records can never be written to the real books.',
    );
  } else {
    add('Demo seeding is off', 'pass', 'SEED_DEMO_DATA=false');
  }

  add(
    'Cookies match how it is served',
    env.COOKIE_SECURE ? 'pass' : 'warn',
    env.COOKIE_SECURE
      ? 'COOKIE_SECURE=true — the session cookie is only sent over HTTPS.'
      : 'COOKIE_SECURE=false. Correct for plain HTTP on the shop\'s own network; set it to true if you put the app behind HTTPS.',
  );

  add(
    'Forwarded headers are not blindly trusted',
    env.TRUST_PROXY_HEADERS ? 'warn' : 'pass',
    env.TRUST_PROXY_HEADERS
      ? 'TRUST_PROXY_HEADERS=true. Only correct if a reverse proxy in front of this app OVERWRITES X-Forwarded-For. If callers can set it themselves, the sign-in rate limit can be sidestepped.'
      : 'TRUST_PROXY_HEADERS=false — sign-in attempts are counted against one shared bucket rather than a header the caller controls.',
  );

  // --- the database itself -------------------------------------------------

  const file = resolve(process.cwd(), databasePath);
  if (!existsSync(file)) {
    add('Database exists', 'fail', `No database at ${file}. Run \`npm run db:migrate\`.`);
    return checks;
  }
  add('Database exists', 'pass', file);

  const connection = new Database(file, { readonly: true });
  try {
    configureConnection(connection);

    const integrity = connection.pragma('integrity_check') as { integrity_check: string }[];
    add(
      'Database is not corrupt',
      integrity[0]?.integrity_check === 'ok' ? 'pass' : 'fail',
      integrity[0]?.integrity_check ?? 'unknown',
    );

    const violations = connection.pragma('foreign_key_check') as unknown[];
    add(
      'No broken references',
      violations.length === 0 ? 'pass' : 'fail',
      violations.length === 0 ? 'foreign_key_check clean' : `${violations.length} violation(s)`,
    );

    // Migrations: drizzle records what it has applied. An empty table means the
    // schema was made some other way, which is not something to trade on.
    const applied = connection
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get() as { count: number };
    if (applied.count === 0) {
      add('Migrations applied', 'fail', 'No migration history. Run `npm run db:migrate`.');
    } else {
      const rows = connection
        .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
        .get() as { count: number };
      add('Migrations applied', rows.count > 0 ? 'pass' : 'fail', `${rows.count} migration(s) recorded`);
    }

    // The check that matters most: do the books balance?
    const totals = connection
      .prepare('SELECT COALESCE(SUM(debit_minor),0) AS debits, COALESCE(SUM(credit_minor),0) AS credits FROM journal_lines')
      .get() as { debits: number; credits: number };
    add(
      'The books balance',
      totals.debits === totals.credits ? 'pass' : 'fail',
      totals.debits === totals.credits
        ? `debits and credits both ${(totals.debits / 100).toFixed(2)}`
        : `debits ${totals.debits} vs credits ${totals.credits} — do NOT trade on these books`,
    );

    // Stock: replay EVERY movement and compare with the cached figures.
    //
    // The inventory page shows a cheaper version of this check — cache against
    // the last balance the ledger recorded — because it renders on every visit
    // and a full replay grows with the shop's whole history. The replay lives
    // here, where somebody has asked for a thorough answer and can wait for it,
    // and it catches something the cheap check cannot: a ledger that is
    // internally inconsistent, where a row has gone from the middle of a chain
    // and the running balances now describe a history that never happened.
    const stockTable = connection
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='stock_ledger'")
      .get() as { count: number };

    if (stockTable.count > 0) {
      const movements = connection
        .prepare(
          'SELECT product_id, qty_in_milli, qty_out_milli, total_cost_minor FROM stock_ledger ORDER BY product_id, id',
        )
        .all() as {
        product_id: number;
        qty_in_milli: number;
        qty_out_milli: number;
        total_cost_minor: number;
      }[];

      // Same arithmetic as `replayChain`, including the rule that matters most:
      // an empty shelf is worth nothing, so value is cleared whenever the
      // quantity reaches zero rather than being carried forward.
      const replayed = new Map<number, { qty: number; value: number }>();
      for (const row of movements) {
        const state = replayed.get(row.product_id) ?? { qty: 0, value: 0 };
        if (row.qty_in_milli > 0) {
          state.qty += row.qty_in_milli;
          state.value += row.total_cost_minor;
        } else if (row.qty_out_milli > 0) {
          state.qty -= row.qty_out_milli;
          state.value -= row.total_cost_minor;
        }
        if (state.qty === 0) state.value = 0;
        replayed.set(row.product_id, state);
      }

      const tracked = connection
        .prepare(
          'SELECT id, name, qty_on_hand_milli, stock_value_minor FROM products WHERE track_inventory = 1',
        )
        .all() as {
        id: number;
        name: string;
        qty_on_hand_milli: number;
        stock_value_minor: number;
      }[];

      const drifted = tracked.filter((product) => {
        const state = replayed.get(product.id) ?? { qty: 0, value: 0 };
        return (
          state.qty !== product.qty_on_hand_milli || state.value !== product.stock_value_minor
        );
      });

      add(
        'Stock matches its movement history',
        drifted.length === 0 ? 'pass' : 'fail',
        drifted.length === 0
          ? `${tracked.length} product(s) replayed from ${movements.length} movement(s)`
          : `${drifted.length} product(s) disagree with their own ledger: ` +
            `${drifted.map((product) => product.name).join(', ')}. Do NOT trust the stock valuation.`,
      );
    }

    // Every unit on the shelf must belong to some batch.
    //
    // This is the invariant expiry tracking rests on. If stock exists that no
    // batch owns, first-expiry-first-out is choosing from an incomplete set:
    // a sale can be refused while the shelf is full, and an expiry warning can
    // be missing for goods that are about to turn. Neither announces itself.
    //
    // One grouped sum against a cached column — cheap enough to sit beside the
    // replay above rather than waiting for somebody to go looking.
    const batchTable = connection
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='product_batches'")
      .get() as { count: number };

    if (batchTable.count > 0) {
      const uncovered = connection
        .prepare(
          `SELECT p.name, p.qty_on_hand_milli AS productQty,
                  COALESCE(SUM(b.qty_milli), 0) AS batchedQty
           FROM products p
           LEFT JOIN product_batches b ON b.product_id = p.id
           WHERE p.track_inventory = 1
           GROUP BY p.id
           HAVING productQty <> batchedQty`,
        )
        .all() as { name: string; productQty: number; batchedQty: number }[];

      const trackedCount = (
        connection
          .prepare('SELECT COUNT(*) AS count FROM products WHERE track_inventory = 1')
          .get() as { count: number }
      ).count;

      add(
        'Every unit of stock belongs to a batch',
        uncovered.length === 0 ? 'pass' : 'fail',
        uncovered.length === 0
          ? `${trackedCount} product(s) fully covered by their batches`
          : `${uncovered.length} product(s) hold stock no batch owns: ` +
            `${uncovered.map((row) => row.name).join(', ')}. Expiry warnings may be missing.`,
      );
    }

    // Demo data must not be sitting in a real shop's records.
    const demoTables = ['products', 'sales', 'purchases', 'customers', 'suppliers'];
    let demoRows = 0;
    for (const table of demoTables) {
      const exists = connection
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { count: number };
      if (exists.count === 0) continue;

      const hasColumn = (connection.pragma(`table_info(${table})`) as { name: string }[]).some(
        (column) => column.name === 'is_demo',
      );
      if (!hasColumn) continue;

      const row = connection
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE is_demo = 1`)
        .get() as { count: number };
      demoRows += row.count;
    }
    add(
      'No demo records in the books',
      demoRows === 0 ? 'pass' : 'fail',
      demoRows === 0
        ? 'nothing tagged as demo'
        : `${demoRows} demo record(s) present. Start from a clean database for a real shop.`,
    );

    // An owner must exist, or nobody can sign in.
    const owners = connection
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'OWNER' AND is_active = 1")
      .get() as { count: number };
    add(
      'An owner can sign in',
      owners.count > 0 ? 'pass' : 'fail',
      owners.count > 0 ? `${owners.count} active owner(s)` : 'No active owner. Nobody could manage the shop.',
    );

    // Demo credentials must not survive into production.
    //
    // The username alone does not prove anything: a real shop may perfectly
    // well have a person whose account is called "owner", and failing that
    // shop's preflight would be crying wolf — which is how a check stops being
    // read. What settles it is `has_demo_data`, set by the demo seeder itself.
    const seededDemo =
      (
        connection.prepare('SELECT has_demo_data AS flag FROM business_settings WHERE id = 1').get() as
          | { flag: number }
          | undefined
      )?.flag === 1;

    const demoUsers = connection
      .prepare("SELECT COUNT(*) AS count FROM users WHERE username IN ('owner', 'ama')")
      .get() as { count: number };

    if (seededDemo && demoUsers.count > 0) {
      add(
        'No demo accounts',
        'fail',
        `${demoUsers.count} seeded demo account(s) can still sign in, and their passwords are published in the README.`,
      );
    } else if (demoUsers.count > 0) {
      add(
        'No demo accounts',
        'warn',
        `${demoUsers.count} account(s) are named "owner" or "ama". This database was not demo-seeded, so these look like your own — but those names appear with passwords in the README, so make sure the passwords differ.`,
      );
    } else if (seededDemo) {
      add(
        'No demo accounts',
        'warn',
        'This database was seeded with demo data at some point. The demo sign-ins are gone, but check the records too.',
      );
    } else {
      add('No demo accounts', 'pass', 'never demo-seeded, and no published demo usernames');
    }
  } finally {
    connection.close();
  }

  return checks;
}

if (isDirectRun(import.meta.url)) {
  const checks = runPreflight();
  const symbol = { pass: '  ok  ', warn: ' warn ', fail: ' FAIL ' } as const;

  console.log('\nProduction readiness\n');
  for (const check of checks) {
    console.log(`[${symbol[check.status]}] ${check.name}`);
    console.log(`           ${check.detail}`);
  }

  const failures = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');

  console.log('');
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) FAILED. Do not use this for real trading yet.`);
    process.exit(1);
  }
  console.log(
    warnings.length > 0
      ? `Ready, with ${warnings.length} thing(s) to decide on above.`
      : 'Ready for production.',
  );
}
