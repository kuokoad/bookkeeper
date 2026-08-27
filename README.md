# NunaBooks

Bookkeeping, inventory, sales and accounts for a small retail shop — built to run
on the shop's own computer, with no internet required to record a sale.

Currency defaults to **GHS** and is configurable. Mobile money is first-class, and
no mobile network is hard-coded.

> **Status: Stages 1–15 complete.**
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
> hardening (error and empty states, verified backups, a production preflight,
> and a measured performance pass), Settings (shop details, currency, tax
> and stock policy), the year-end pack for an accountant, year-end close, and
> a shop logo on receipts.
> Nothing in the menu is a placeholder — every item leads to a working screen.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, database schema and
accounting model.

## Documentation

[**docs/**](docs/README.md) splits by what you are trying to do:

| | |
| --- | --- |
| **Learn it** | [Your first hour](docs/tutorials/first-hour.md) (shop owner) · [Developer setup](docs/tutorials/developer-setup.md) |
| **Get a job done** | [Find anything](docs/how-to/find-anything.md) · [Fix a mistake](docs/how-to/fix-a-mistake.md) · [Manage tax](docs/how-to/manage-tax.md) · [Close a period](docs/how-to/close-a-period.md) · [Back up and restore](docs/how-to/back-up-and-restore.md) |
| **Look it up** | [Commands](docs/reference/commands.md) · [Routes and permissions](docs/reference/routes-and-permissions.md) · [Filters](docs/reference/filters.md) · [Money and quantity](docs/reference/money-and-quantity.md) |
| **Understand why** | [Filtering](docs/explanation/filtering.md) · [Inventory costing](docs/explanation/inventory-costing.md) · [Tax in Ghana](docs/explanation/tax-in-ghana.md) |

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

## Invoices and statements

A sale a customer does not pay for in full becomes an **invoice**: its own
`INV-` number, payment terms, and a date it falls due. A sale settled at the
counter gets a receipt and no invoice number — issuing them for cash sales would
leave gaps in the invoice sequence that read as missing documents.

Open a credit sale and press **Invoice**. It is framed as a request for payment
rather than a thank-you: who owes, how much, by when, and what to quote when
paying. Terms default to 30 days, set under Settings and overridable per sale.
They are snapshotted onto the sale, so changing the shop default never moves the
due date of an invoice already in a customer's hands.

**Customer → Statement** lists everything one customer still owes as at today,
with what is overdue and by how long. The total is the ledger's own figure for
that customer, not a sum of the rows above it — if those two ever disagreed the
statement says so rather than showing the friendlier number.

**Ageing is now measured from the due date, not the sale date.** On 30-day terms
a sale from twenty days ago is not overdue, and ageing it as though it were
sends you chasing a customer who has done nothing wrong. Sales recorded before
invoicing existed have no due date and age from the sale date exactly as before.

## The year-end pack

**Reports → Year-end pack** produces the statements an accountant asks for, for
one financial year, with the previous year alongside every figure. Print it, or
download the whole pack as one CSV.

It contains a Profit & Loss, a Balance Sheet, the **Movement in the Owner's
Stake**, a Trial Balance, notes on the basis of preparation, and the checks the
system performed on itself.

The movement statement is the one that does not appear anywhere else. Because
a year may not be closed yet (see below), the Balance Sheet carries
all-time profit inside the owner's stake, so it cannot show what *this year* did
to it. The movement statement reconciles the two:

```
opening stake + capital introduced − drawings + opening balances brought in
              + profit for the year = closing stake
```

That must come out exactly, and the pack says whether it did. Everything is
drawn from the same reporting code the app uses all year — nothing is
recomputed, so the pack cannot disagree with the on-screen reports.

The financial year is whatever you set under Settings; a year that has not
finished yet is clearly marked provisional rather than presented as final
accounts.

## Light and dark

The app follows whatever your device is set to. A switch in the top bar
overrides that for this browser — useful when the shop is bright at midday and
the same screen is glaring at closing time.

The preference is a cookie rather than an account setting, because it belongs to
the screen rather than to the person: the counter PC and the owner's phone want
different answers, and the same person uses both. It is read on the server and
applied before the page is sent, so there is no flash of the wrong colours.

The sidebar stays dark in both. It is chrome rather than content, and holding it
constant gives the eye a fixed frame while the working area follows your choice.

## Your logo

Under **Settings**, upload a PNG, JPEG or WebP up to 1 MB. It prints at the top
of every receipt.

The image is stored **inside the database**, not as a file on disk. That is
deliberate: `npm run backup` copies the database and nothing else, so a logo
sitting beside it would not be in your backups — a restore would bring back
every sale and every balance and leave a broken image on each receipt. In the
database it is backed up automatically and survives a reinstall.

**SVG files are refused.** An SVG is not really an image but a document that can
carry script, and one served from your own address would run in the browser of
whoever opens a receipt. The format is checked from the file's own bytes, not
from its name or what the browser claims, so renaming a file does not get past
it.

## Settings

Under **Settings** the owner sets the shop's name and contact details (they print
on receipts), the currency, tax, and the stock policy.

**Currency is fixed once you have transactions.** No amount stores its own
currency — every figure in the books is a count of minor units, and the currency
code is what labels all of them. Changing it after trading would silently
relabel every historical amount: a GHS 5,000 sale from last month would begin
reading as USD 5,000 without a single row being touched. So it is refused, with
an explanation. The *symbol* stays editable, because `₵` and `GH₵` are two ways
of writing the same currency.

**Tax** is held in basis points (12.5% is `1250`), never as a floating-point
fraction — 7.3% as `0.073` is not exact, and that error would be multiplied by
every sale. Changing the rate affects sales from then on; sales already recorded
keep the tax they were recorded with. Switching tax off keeps the rate, so
switching it back on does not silently resume at zero.

**Allow selling stock you do not have** is off by default, which is safer: a sale
that would take stock below zero is refused, catching mistakes at the till.

**Allow paying more than is owed** is off by default too. At a counter an amount
larger than the balance is usually a typo, and refusing it catches the mistake
while the customer is still standing there. Switch it on to take deposits and
advance payments: the extra stays on the account as a credit and comes off the
next purchase.

A customer in credit appears on the Balance Sheet as **Customer credit
balances**, under what you owe — not netted off what customers owe you. That
money is owed back, and netting it would understate both figures at once.

Every change is written to the audit log with what it was before and after, so
"when did we turn VAT on?" is answerable. Closing the books for a past period is
under Accounting, beside the ledger it protects.

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

## Closing the year

Under **Accounting → Year-end close**, once a financial year has ended you can
close it. Closing posts one journal entry that sweeps the year's sales and costs
back to zero and carries what is left — the profit — into **Retained Earnings**.
Your drawings for the year are cleared the same way, so each year starts fresh
rather than carrying an ever-growing total.

Closing also **locks the books** to the year end, because figures declared final
should not be open to a sale dated last March.

Three things it will not let you do, each because the result would look final
without being it:

- close a year that has not finished
- close the same year twice
- close out of order, leaving an earlier year open

**It is reversible.** Reopening reverses the closing entry rather than deleting
it — both remain in the ledger, the audit log records who reopened it, and the
lock moves back to the previous closed year. Years reopen newest first.

Closing entries are excluded from the Profit & Loss. A close is dated inside the
year it closes, and its whole job is to cancel that year's revenue and expenses
— counted, it would report a year the shop traded well as having earned nothing.
The Balance Sheet includes them, because that is how profit reaches equity.

You do not have to close at all. An unclosed year still reports correctly: the
Balance Sheet folds unclosed profit into your stake, so `assets = liabilities +
equity` holds either way, and closed and unclosed years can sit side by side.

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
| `npm run db:restore -- <file>` | Put one back (see below)                  |

**Copy them off the machine.** A backup sitting on the same computer does not
survive that computer being stolen, dropped, or having its disk fail. Pointing
`--dir` at a USB stick, and running it at close of business, is the whole
routine.

### Putting a backup back

```bash
npm run db:restore -- ./backups/bookkeeper-2026-08-26T18-00-00.db --force
```

**Do not copy the file over `data/bookkeeper.db` by hand.** That was the
instruction here for a long time and it is wrong in the one situation restoring
is for.

With WAL enabled the newest transactions live in `bookkeeper.db-wal`. Shutting
down cleanly folds them into the main file and deletes it — but a **power cut
does not**, which is the whole point of `synchronous = FULL`. Copy a backup over
the main file with that `-wal` still beside it and SQLite replays it into the
file that was supposed to be free of it, putting back the very transactions you
were undoing. The books still balance afterwards, so nothing warns you.

The command does it properly: it verifies the backup **before** touching
anything, refuses while the app is still running, copies the database it is
about to replace to `bookkeeper.db.replaced-<timestamp>` so a wrong restore is
undoable, removes `-wal` and `-shm`, and verifies the result.

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
  Both counters live in the database, so neither is cleared by a restart, a
  redeploy or a power cut — a throttle that forgets is one an attacker resets
  by waiting for the server to bounce.
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
