# Shop Bookkeeper

Bookkeeping, inventory, sales and accounts for a small retail shop — built to run
on the shop's own computer, with no internet required to record a sale.

Currency defaults to **GHS** and is configurable. Mobile money is first-class, and
no mobile network is hard-coded.

> **Status: Stages 1–10 complete.**
> Foundation (database, double-entry ledger, auth, permissions, audit),
> Products & Inventory (catalogue, stock ledger, weighted-average costing, stock
> adjustments, low-stock alerts), Sales (POS, split payments, customer credit,
> receivables, receipts) and Purchases (suppliers, deliveries, payables,
> supplier payments), Expenses & Other Income, and Accounts (owner-created
> payment accounts with full movement history and owner capital/drawings), and
> Accounting (chart of accounts, journal browser, trial balance, general ledger,
> receivables/payables ageing), Reports (Profit & Loss, Balance Sheet, Cash
> Flow, sales/purchase/inventory breakdowns, CSV export, print-friendly),
> Reconciliation (cash/MoMo/bank counts with difference tracking), Users &
> Permissions (staff accounts, per-area rights, till PINs, insert-only audit
> log) — with returns in both directions and void-with-reversal throughout —
> and hardening (error and empty states, verified backups, a production
> preflight, and a measured performance pass).
> Menu items marked "Soon" are not yet built — they are shown disabled rather
> than as links that do nothing.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, database schema and
accounting model.

---

## Getting started

Requires **Node.js 22 or newer** (tested on 24).

```bash
npm install
npm run env:init     # creates .env with a fresh random SESSION_SECRET
npm run db:migrate   # creates the database and applies migrations
npm run db:seed      # chart of accounts, numbering, payment accounts
npm run dev          # http://localhost:3000
```

On first run the app opens a **setup screen** to create the shop and its owner
account. That screen closes permanently once an owner exists.

### Demo data

`SEED_DEMO_DATA=true` in `.env` seeds two clearly-marked demo accounts:

| Role  | Username | Password          |
| ----- | -------- | ----------------- |
| Owner | `owner`  | `demo-owner-2026` |
| Staff | `ama`    | `demo-staff-2026` |

These are published here precisely because they must never exist on a real shop's
machine. The seed refuses to run with `NODE_ENV=production`.

---

## Everyday commands

| Command                | What it does                                          |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Development server                                    |
| `npm run build`        | Production build (fails on any type error)            |
| `npm start`            | Run the production build                              |
| `npm run verify`       | Typecheck + lint + tests — run before every commit    |
| `npm test`             | Test suite                                            |
| `npm run smoke`        | End-to-end checks against a running server            |
| `npm run db:generate`  | Generate a migration after changing the schema        |
| `npm run db:migrate`   | Apply pending migrations                              |
| `npm run db:check`     | Verify migration files are consistent                 |
| `npm run db:studio`    | Browse the database                                   |
| `npm run db:reset -- --force` | **Deletes the database.** Development only.    |
| `npm run backup`       | Verified backup of the database                       |
| `npm run preflight`    | Production readiness checks                           |
| `npm run benchmark`    | Time the reports at a year of trading                 |

### If a migration fails with "table already exists"

The database was built from a migration file that has since been regenerated, so
its recorded history no longer matches. In development, rebuild from scratch:

```bash
npm run db:reset -- --force && npm run setup
```

Stop the dev server first — Windows will not delete a database file that a
running process still has open, and `db:reset` reports that rather than
pretending it succeeded.

---

## Where things live

```
src/
  app/        Pages (Next.js App Router)
  actions/    'use server' entry points — auth + validation, no logic
  services/   Transactional orchestration; opens the DB transaction
  domain/     Pure business logic. Money, quantities, accounting. Fully tested.
  db/         Schema, migrations, seed
  lib/        Auth, permissions, formatting
tests/        Unit + integration tests
```

**The rule that matters:** a financial calculation lives in `domain/` exactly once.
UI components never compute money.

---

## How the money works

Two things are worth knowing before changing any code that touches an amount.

**1. Money is always an integer.** GHS 1,250.00 is stored and passed around as
`125000` — a count of pesewas. Quantities are integers too, in thousandths, so
1.5 kg is `1500`. Floating point never represents a monetary value anywhere.
Multiplications go through `BigInt` and throw on overflow rather than silently
producing a wrong figure. Use `parseMoney(string)` for anything a person typed.

**2. No balance is ever stored.** Every figure — cash, MoMo, what a customer owes,
what the stock is worth — is computed from journal lines each time it is shown.
That is what makes *"why is cash GHS 5,240?"* answerable: the same rows that
produce the number can be listed underneath it. Corrections are made by posting a
**reversing entry**, never by editing or deleting history.

Every transaction is written inside one database transaction and its debits must
equal its credits before it commits. If they do not, the whole operation rolls
back — no sale, no stock movement, no payment.

---

## Counting cash, MoMo and bank

**Reconciliation** compares what the books say against what is actually there.
Enter what you counted; the difference is shown live, before you commit, so you
get the chance to recount.

If there is a difference you must explain it, and you then choose:

- **Correct the books** — the difference posts to *Cash Over / Short* and shows
  up in your profit figure. Nothing already recorded is altered.
- **Leave it open** — the books are untouched and the difference is flagged as
  unresolved, so you can go looking for the money first.

Either way the count is kept permanently, including the snapshot of what the
system claimed at the time. **No past transaction is ever edited to make the
numbers agree** — that is the whole point.

## Closing the books

Under **Accounting → Books lock** the owner can close everything up to a date.
Transactions dated on or before it are then refused, so a past month cannot be
quietly rewritten once you have reviewed it.

It is a control, not an accounting close: nothing is zeroed and no closing entry
is posted. Mistakes in a closed period stay correctable the proper way — void
the transaction, which posts a dated reversal today instead of altering history.

Moving the lock **backward**, or removing it, reopens a period that was declared
final. That is recorded distinctly in the audit log, with the user's name.

> There is deliberately **no year-end closing step**. Revenue and expense
> accounts accumulate, and the balance sheet folds all-time profit straight into
> your stake. That keeps `assets = liabilities + equity` true at any date
> without a ritual to remember, at the cost of a permanently-zero Retained
> Earnings account and a trial balance that shows all-time figures unless you
> date-filter it.

## Backups

The entire business lives in one file: `data/bookkeeper.db`. Run:

```bash
npm run backup
```

This writes a timestamped, **verified** copy into `backups/`. It is safe to run
while the shop is trading — it uses SQLite's online backup rather than copying
the file behind the database's back, which is what makes a plain file copy
unreliable.

Every backup is checked before it counts: structural integrity, foreign keys,
and that the books inside the copy still balance. **A backup that fails
verification is deleted and the command fails**, because a broken backup you
believe in is worse than no backup at all.

Each backup is a single self-contained file with no `-wal`/`-shm` companions, so
it can be copied on its own and still be whole.

| Command                        | What it does                              |
| ------------------------------ | ----------------------------------------- |
| `npm run backup`               | Verified backup, keeping the newest 14    |
| `npm run backup -- --keep=30`  | Keep 30 instead                           |
| `npm run backup -- --dir=D:/x` | Write straight to a USB stick             |

**Copy them off the machine.** A backup sitting on the same computer does not
survive that computer being stolen, dropped, or having its disk fail. Pointing
`--dir` at a USB stick, and running it at close of business, is the whole
routine.

To restore, stop the app and copy a backup file over `data/bookkeeper.db`.

The database is configured with `synchronous = FULL`, which is slower on purpose:
it survives a power cut without losing the last transactions committed.

## Before a real shop uses this

```bash
npm run preflight
```

It answers, one by one: is the session secret real, is demo seeding off, are
migrations applied, is the database uncorrupted, **do the books balance**, is
there an active owner, and are there any demo records or published demo
credentials still present. Anything that would be unsafe to trade on is a
failure, not a warning.

## Speed

`npm run benchmark` builds a throwaway database at a year of trading (365 days
x 200 sales = 292,000 ledger lines) and times every report, printing each query
plan. Measured on that data:

| Report                          | Time   |
| ------------------------------- | ------ |
| Journal browser (50 rows)       | 0.8 ms |
| General ledger, one account     | 6 ms   |
| Profit & loss, one month        | 21 ms  |
| Trial balance, all time         | 287 ms |
| Balance sheet, all time         | 458 ms |

Paged screens are proportional to the page, not to how long the shop has been
open. The whole-ledger totals genuinely read every row — that is what they are —
and stay well under a second at a year's volume.

---

## Security notes

- Passwords are hashed with **scrypt** (per-user salt, parameters stored with the
  hash). They are never logged, never stored, and are stripped from audit records.
- Sessions are opaque random tokens; the database stores only their SHA-256, so a
  copied database file cannot be replayed as a login.
- Every server action re-checks the session **and** the permission on the server.
  Hidden buttons are a courtesy, not the protection.
- Failed logins lock an account for 15 minutes, with a separate per-IP throttle.
- Cookies are `httpOnly` + `SameSite=Lax`. They are **not** `Secure` by default
  because the shop runs over plain HTTP on its own LAN. Set `COOKIE_SECURE=true`
  if you put it behind HTTPS; `npm run preflight` reminds you.
- A **till PIN** is a second credential for the same account, for signing in at
  the counter without typing a password in front of a queue. It is hashed like a
  password and shares one throttle and one lockout counter with password
  sign-in, so it cannot be used to buy extra guesses.
- Two structural tests enforce the rules across every file rather than
  file-by-file: [tests/app/page-guards.test.ts](tests/app/page-guards.test.ts)
  checks all 48 pages guard themselves, and
  [tests/app/action-guards.test.ts](tests/app/action-guards.test.ts) checks all
  49 server actions authenticate, that none takes the acting user from its own
  arguments, and that no client component imports server code.
- Errors never claim a write happened. A failed page says plainly that nothing
  was saved — every write is one database transaction, so that is true.

### Known issue

`npm audit` reports 4 moderate advisories against a transitive `esbuild` inside
`drizzle-kit`'s config loader. It is a development-only dependency and is not part
of the shipped app; the fix requires a drizzle-kit downgrade that would lose
migration features. Revisit when drizzle-kit updates.
