/**
 * How fast are the reports at a year of real trading?
 *
 * Demo data is a few dozen rows, which proves nothing about a shop doing 100 to
 * 300 sales a day. This builds a throwaway database at that volume and times
 * the queries every report depends on, so the answer is measured rather than
 * assumed. It also prints each query plan: a SCAN over a large table is the
 * thing that turns a fast report into a slow one as the years accumulate.
 *
 * Usage: npm run benchmark [-- --days=365 --sales=200]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from '@/db/schema';
import { configureConnection } from '@/db/pragmas';
import type { Db } from '@/db/types';
import { seedCore } from '@/db/seed/core';

const arg = (name: string, fallback: number): number => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  const parsed = found ? Number(found.split('=')[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const DAYS = arg('days', 365);
const SALES_PER_DAY = arg('sales', 200);

const directory = mkdtempSync(join(tmpdir(), 'bookkeeper-bench-'));
const file = join(directory, 'bench.db');
const connection = new Database(file);
configureConnection(connection);

const db = drizzle(connection, { schema }) as Db;
connection.pragma('foreign_keys = OFF');
try {
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
} finally {
  connection.pragma('foreign_keys = ON');
}
db.transaction((tx) => seedCore(tx));

// Postable accounts are the leaves: a heading is any account with children.
const accountIds = (
  connection
    .prepare(
      `SELECT id FROM accounts
       WHERE id NOT IN (SELECT parent_id FROM accounts WHERE parent_id IS NOT NULL)`,
    )
    .all() as { id: number }[]
).map((row) => row.id);

if (accountIds.length < 4) {
  console.error('The seeded chart of accounts has too few postable accounts to benchmark.');
  process.exit(1);
}

console.log(`Building ${DAYS} days x ${SALES_PER_DAY} sales…`);
const buildStart = performance.now();

// Insert directly, in one transaction. This is a volume fixture, not a test of
// the posting path — that is covered by the integration tests.
const insertEntry = connection.prepare(
  `INSERT INTO journal_entries (entry_no, entry_date, source_type, source_id, memo, is_opening, created_at, occurred_at)
   VALUES (?, ?, 'SALE', ?, ?, 0, ?, ?)`,
);
const insertLine = connection.prepare(
  `INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor, line_no)
   VALUES (?, ?, ?, ?, ?)`,
);

let entryNo = 0;
const build = connection.transaction(() => {
  for (let day = 0; day < DAYS; day++) {
    const date = new Date(2025, 0, 1 + day);
    const iso = date.toISOString().slice(0, 10);
    const at = date.getTime();

    for (let sale = 0; sale < SALES_PER_DAY; sale++) {
      entryNo++;
      const amount = 500 + ((entryNo * 137) % 20000);
      const info = insertEntry.run(`JE-${String(entryNo).padStart(8, '0')}`, iso, entryNo, 'Sale', at, at);
      const entryId = Number(info.lastInsertRowid);

      // A realistic sale posts several lines: cash, revenue, COGS, inventory.
      const a = accountIds[entryNo % accountIds.length] as number;
      const b = accountIds[(entryNo + 1) % accountIds.length] as number;
      const c = accountIds[(entryNo + 2) % accountIds.length] as number;
      const d = accountIds[(entryNo + 3) % accountIds.length] as number;

      insertLine.run(entryId, a, amount, 0, 1);
      insertLine.run(entryId, b, 0, amount, 2);
      insertLine.run(entryId, c, Math.floor(amount * 0.6), 0, 3);
      insertLine.run(entryId, d, 0, Math.floor(amount * 0.6), 4);
    }
  }
});
build();

const lineCount = (connection.prepare('SELECT COUNT(*) AS c FROM journal_lines').get() as { c: number }).c;
console.log(
  `Built ${entryNo.toLocaleString()} entries / ${lineCount.toLocaleString()} lines in ${((performance.now() - buildStart) / 1000).toFixed(1)}s\n`,
);

interface Benchmark {
  name: string;
  sql: string;
  params?: unknown[];
}

const midAccount = accountIds[0] as number;

const BENCHMARKS: Benchmark[] = [
  {
    name: 'Trial balance (every account, all time)',
    sql: `SELECT account_id, SUM(debit_minor) AS d, SUM(credit_minor) AS c
          FROM journal_lines GROUP BY account_id`,
  },
  {
    name: 'Balance sheet (one aggregate over a date range)',
    sql: `SELECT l.account_id, SUM(l.debit_minor) AS d, SUM(l.credit_minor) AS c
          FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.entry_date <= ? GROUP BY l.account_id`,
    params: ['2025-12-31'],
  },
  {
    name: 'Profit & loss (one month)',
    sql: `SELECT l.account_id, SUM(l.debit_minor) AS d, SUM(l.credit_minor) AS c
          FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.entry_date BETWEEN ? AND ? GROUP BY l.account_id`,
    params: ['2025-06-01', '2025-06-30'],
  },
  {
    name: 'General ledger for one account (one month, paged)',
    sql: `SELECT l.id, l.debit_minor, l.credit_minor, e.entry_date
          FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.account_id = ? AND e.entry_date BETWEEN ? AND ?
          ORDER BY e.entry_date, l.id LIMIT 50`,
    params: [midAccount, '2025-06-01', '2025-06-30'],
  },
  {
    name: 'Journal browser, OLD shape (join then page)',
    sql: `SELECT e.id, e.entry_no, SUM(l.debit_minor) AS total
          FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
          GROUP BY e.id ORDER BY e.entry_date DESC, e.id DESC LIMIT 50`,
  },
  {
    name: 'Journal browser, NEW shape (page then total)',
    sql: `SELECT id, entry_no FROM journal_entries
          ORDER BY entry_date DESC, id DESC LIMIT 50`,
  },
  {
    name: '  …and its totals query for that page',
    sql: `SELECT entry_id, COUNT(*) AS n, SUM(debit_minor) AS d, SUM(credit_minor) AS c
          FROM journal_lines
          WHERE entry_id IN (SELECT id FROM journal_entries ORDER BY entry_date DESC, id DESC LIMIT 50)
          GROUP BY entry_id`,
  },
  {
    name: 'Books integrity check (does everything balance)',
    sql: `SELECT SUM(debit_minor) AS d, SUM(credit_minor) AS c FROM journal_lines`,
  },
];

const time = (fn: () => void, runs = 5): number => {
  fn(); // warm
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)] as number;
};

console.log('Median of 5 runs:\n');
let slowest = 0;
for (const benchmark of BENCHMARKS) {
  const statement = connection.prepare(benchmark.sql);
  const params = benchmark.params ?? [];
  const ms = time(() => void statement.all(...(params as [])));
  slowest = Math.max(slowest, ms);

  const plan = (connection.prepare(`EXPLAIN QUERY PLAN ${benchmark.sql}`).all(...(params as [])) as {
    detail: string;
  }[]).map((row) => row.detail);

  // A scan with no index is the thing that gets slower every year. A scan
  // *using* an index is usually ordered traversal under a LIMIT, which is not
  // the same problem — so only the former is called out.
  const unindexed = plan.filter(
    (detail) => /^SCAN /.test(detail) && !/USING (COVERING )?INDEX/.test(detail),
  );

  console.log(`  ${ms.toFixed(1).padStart(8)} ms  ${benchmark.name}`);
  for (const detail of plan) console.log(`              ${detail}`);
  if (unindexed.length > 0) {
    console.log('              ^ scans the whole table — fine for a total, not for a page');
  }
  console.log('');
}

console.log(
  slowest < 1000
    ? `Slowest report: ${slowest.toFixed(0)} ms at ${(lineCount / 1000).toFixed(0)}k ledger lines.`
    : `SLOW: ${slowest.toFixed(0)} ms. Investigate before shipping.`,
);

connection.close();
rmSync(directory, { recursive: true, force: true });
