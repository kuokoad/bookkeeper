# NunaBooks — Architecture

> Status: **Stage 1 design, approved**. This document is the contract the
> implementation follows. Change it deliberately, not silently.

This is the **design record**. For task-shaped and reference material see
[docs/](docs/README.md) — it links back here rather than restating §3 (precision),
§4 (double entry), §5 (schema), §7 (permissions) or §9 (testing).

Three areas that shipped after this document was written are explained there rather
than here: [filtering](docs/explanation/filtering.md),
[inventory costing and batches](docs/explanation/inventory-costing.md), and
[tax components](docs/explanation/tax-in-ghana.md).

---

## 0. Confirmed decisions

| Decision | Choice | Consequence |
|---|---|---|
| Deployment | **Local-first** on the shop's own PC | No internet needed to record a sale. Phones reach it over shop WiFi. Backup = copy one file. |
| Scope | **Single shop**, single stock location | Simplest correct schema. A `business_settings` singleton keeps the door open for branches later. |
| COGS basis | **Weighted average cost** | No cost layers. Re-averages on every purchase. Easy for the owner to explain. |
| Auth | **Self-hosted** username + password / staff PIN | `scrypt` from `node:crypto`, no third party, works offline. |
| Currency | **GHS**, configurable | Stored as integer pesewas. Never floats. |

---

## 1. Technology stack

| Layer | Choice | Why this one |
|---|---|---|
| Runtime | Node.js 24 LTS | Already installed; long support runway. |
| Framework | **Next.js 15 (App Router)** + React 19 | One process serves UI *and* server logic. Server Components keep financial queries on the server. Single `npm start` for the shop PC. |
| Language | **TypeScript 5, `strict`** | Plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters`. No implicit `any` (lint error). `exactOptionalPropertyTypes` was considered and left **off** — it fights React prop spreading and Drizzle config objects hard enough to cost more in workarounds than it catches here. |
| Database | **SQLite** via `better-sqlite3` 12 | Zero-ops, single file, fully offline, ACID. **Synchronous** driver — real nested transactions without async interleaving, which is what makes atomic sale posting simple to get right. Verified working on Node 24 / Windows. |
| ORM / migrations | **Drizzle ORM** + `drizzle-kit` | TypeScript-first schema, SQL-grade control, generated SQL migrations checked into git. No hidden query magic in a financial system. |
| Validation | **Zod** | One schema reused for client hints and authoritative server validation. |
| Styling | **Tailwind CSS v4** | No runtime cost, fast responsive work. |
| Testing | **Vitest** | Unit tests for pure domain logic; integration tests against a real in-memory SQLite with the real migrations. |
| Password hashing | `node:crypto` **scrypt** | OWASP-accepted KDF, zero extra dependencies, no native build step. |

**Rejected and why:** Prisma (heavier, weaker SQLite transaction ergonomics); Postgres
(needs a server process the shop can't maintain); floating-point money (unsafe);
`node:sqlite` (works, but Drizzle support is less mature than for better-sqlite3).

---

## 2. Layered architecture

```
┌──────────────────────────────────────────────────────────┐
│  app/          React Server + Client Components (UI only) │
├──────────────────────────────────────────────────────────┤
│  actions/      'use server' — auth check, Zod parse,      │
│                permission check, then delegate. No logic. │
├──────────────────────────────────────────────────────────┤
│  services/     Transactional orchestration.               │
│                Opens the DB transaction. Calls domain.    │
│                Writes rows. Posts journal entries.        │
│                Writes the audit log. All-or-nothing.      │
├──────────────────────────────────────────────────────────┤
│  domain/       PURE functions. No DB, no I/O, no clock.   │
│                Money, quantity, weighted-average costing, │
│                journal-entry construction, business rules.│
│                100% unit-testable. This is where the      │
│                financial correctness lives.               │
├──────────────────────────────────────────────────────────┤
│  db/           Drizzle schema, migrations, seed.          │
└──────────────────────────────────────────────────────────┘
```

**The rule that matters:** a financial calculation appears in `domain/` exactly once.
UI components never compute money. Services never re-derive a total the domain already
produced.

### Directory structure

```
bookkeeper/
├─ ARCHITECTURE.md
├─ drizzle.config.ts
├─ .env.example                  # committed. .env is git-ignored.
├─ data/                         # git-ignored — the live shop database
│  └─ bookkeeper.db
├─ src/
│  ├─ app/
│  │  ├─ (auth)/login/
│  │  ├─ (app)/                  # authenticated shell: sidebar + mobile nav
│  │  │  ├─ dashboard/ sales/ purchases/ products/ inventory/
│  │  │  ├─ customers/ suppliers/ expenses/ income/ accounts/
│  │  │  └─ reports/ users/ settings/
│  │  └─ api/                    # CSV export, printable receipts
│  ├─ actions/                   # thin 'use server' wrappers
│  ├─ services/                  # transactional orchestration
│  ├─ domain/
│  │  ├─ money.ts                # integer pesewa arithmetic
│  │  ├─ quantity.ts             # integer milli-unit arithmetic
│  │  ├─ accounting/             # chart of accounts, journal builders
│  │  ├─ inventory/              # weighted-average cost engine
│  │  └─ errors.ts               # typed DomainError hierarchy
│  ├─ db/
│  │  ├─ schema/                 # one module per bounded area
│  │  ├─ migrations/             # generated SQL, committed
│  │  ├─ client.ts               # connection + PRAGMAs
│  │  └─ seed/
│  ├─ lib/                       # session, permissions, formatting
│  └─ components/
│     ├─ ui/                     # primitives
│     └─ shared/
└─ tests/
```

---

## 3. Money and quantity: the precision model

Two integer scales. **No floating point ever touches a stored value.**

| Concept | Unit stored | Scale | `GHS 1,250.00` → |
|---|---|---|---|
| Money | pesewas | `100` | `125000` |
| Quantity | milli-units | `1000` | `1.5 kg` → `1500` |

Products can be sold in fractional units (kg, litres) without floats.

Multiplication that could exceed `Number.MAX_SAFE_INTEGER` is performed in **`BigInt`**
inside `domain/money.ts` and narrowed back with an explicit safe-range assertion.
SQLite stores 64-bit integers, so the database side is safe.

### Weighted average without a stored unit cost

Storing a per-unit average cost invites rounding drift. Instead each product carries a
**running pair**: total quantity on hand `Q` and total inventory value `V` (pesewas).

```
Purchase q units for total cost c:   Q' = Q + q      V' = V + c
Sell q units:                        cogs = round(V × q / Q)     ← BigInt
                                     Q'  = Q − q     V' = V − cogs
```

Value is *allocated*, never recomputed, so `V` is conserved exactly to the pesewa —
the remainder stays in inventory instead of evaporating into rounding. Displayed
average cost (`V / Q`) is a **presentation-only** derivation.

Selling the last unit drives `Q → 0`; the engine then forces `V → 0` and posts any
residual pesewa to COGS, so inventory can never hold value with zero quantity.

---

## 4. Accounting model — double entry

### Chart of accounts (seeded, code-stable)

| Code | Account | Type | Normal |
|---|---|---|---|
| 1000 | Cash on Hand | ASSET | Debit |
| 1010 | Mobile Money *(one per MoMo account)* | ASSET | Debit |
| 1020 | Bank | ASSET | Debit |
| 1100 | Accounts Receivable | ASSET | Debit |
| 1200 | Inventory | ASSET | Debit |
| 2000 | Accounts Payable | LIABILITY | Credit |
| 2100 | VAT Payable | LIABILITY | Credit |
| 2110 | NHIL Payable | LIABILITY | Credit |
| 2120 | GETFund Levy Payable | LIABILITY | Credit |
| 3000 | Owner's Capital | EQUITY | Credit |
| 3100 | Owner's Drawings | CONTRA_EQUITY | Debit |
| 3200 | Retained Earnings | EQUITY | Credit |
| 3900 | Opening Balance Equity | EQUITY | Credit |
| 4000 | Sales Revenue | REVENUE | Credit |
| 4100 | Sales Discounts | CONTRA_REVENUE | Debit |
| 4200 | Other Income | REVENUE | Credit |
| 5000 | Cost of Goods Sold | COGS | Debit |
| 5900 | Inventory Shrinkage | EXPENSE | Debit |
| 6000+ | Operating Expenses *(one per expense category)* | EXPENSE | Debit |

Payment accounts (Cash, MTN MoMo, Telecel Cash, Bank…) are **user-created rows** that
each own a GL asset account. No mobile network is hard-coded.

### Every balance is derived

There is **no stored balance column** for money. An account's balance is
`SUM(debit) − SUM(credit)` over its journal lines, sign-adjusted for account type.
This is what makes *"why is cash GHS 5,240?"* answerable: click the number, get the lines.

### Worked postings

```
Cash sale — GHS 500 goods that cost GHS 320
  Dr 1000 Cash              500.00
     Cr 4000 Sales Revenue          500.00
  Dr 5000 COGS              320.00
     Cr 1200 Inventory              320.00

Credit sale GHS 500, customer pays GHS 200 now (MoMo)
  Dr 1010 MoMo              200.00
  Dr 1100 A/Receivable      300.00
     Cr 4000 Sales Revenue          500.00
  + the COGS/Inventory pair above

Customer later settles GHS 300 in cash
  Dr 1000 Cash              300.00
     Cr 1100 A/Receivable           300.00

Purchase GHS 1,000 on credit, GHS 400 paid from bank
  Dr 1200 Inventory       1,000.00
     Cr 1020 Bank                   400.00
     Cr 2000 A/Payable              600.00

Cash expense — GHS 80 transport
  Dr 6xxx Transport           80.00
     Cr 1000 Cash                    80.00

Owner takes GHS 200 for personal use
  Dr 3100 Drawings           200.00
     Cr 1000 Cash                   200.00
```

### Integrity guarantees

- `journal_lines` has `CHECK` constraints: `debit >= 0`, `credit >= 0`, exactly one of
  them non-zero.
- **Every enum column has a real SQL `CHECK ... IN (...)`.** Drizzle's
  `text('x', { enum: [...] })` is a *TypeScript-only* constraint that emits no SQL —
  the database would otherwise accept any string for an account type, an audit
  action or a journal source type. The lists are generated from the same const
  tuples the types use (`src/db/schema/_check.ts`), so they cannot drift.
- An account's `normal_balance` must agree with its `type`, enforced in SQL. A
  revenue account with a debit normal balance would make every sign-adjusted
  report present it backwards.
- `journal_entries` must carry a `source_id` unless the entry is an opening
  balance — traceability is a database rule, not a convention.
- The service asserts `Σ debit = Σ credit` **inside** the transaction before commit;
  an unbalanced entry rolls the whole operation back.
- Every entry carries `source_type` + `source_id`. An entry with no traceable business
  transaction cannot be created — there is no free-form journal UI in v1.
- Nothing is deleted. Corrections create a **reversing entry** linked by
  `reverses_entry_id` / `reversed_by_entry_id`.

---

## 5. Database schema (ERD)

`1` ──< `N` denotes one-to-many.

### System & security
```
users ──< sessions
users ──< user_permissions          (module, can_view/create/edit/void)
users ──< audit_logs
business_settings                   (singleton: name, address, currency, policies, logo)
sequences                           (doc_type → next_no; atomic numbering)
```

### Catalog & inventory
```
categories ──< products
suppliers  ──< products              (preferred supplier, nullable)
products   ──< stock_ledger          ← inventory source of truth
products   ──< sale_items / purchase_items / return_items / stock_adjustment_items
stock_adjustments ──< stock_adjustment_items
```

`stock_ledger` — append-only, one row per movement:
`id, product_id, occurred_at, movement_type, source_type, source_id, qty_in, qty_out,
unit_cost_minor (display), total_cost_minor (exact), balance_qty, balance_value_minor, user_id`

`balance_qty` / `balance_value_minor` are the running `(Q, V)` pair **after** the
movement. `products.qty_on_hand` / `stock_value_minor` mirror the newest row as a
read cache; an integrity report recomputes the chain from row 1 and flags any drift.

### Parties
```
customers ──< sales, payments, returns
suppliers ──< purchases, payments, returns
```

### Money movement
```
payment_accounts ──1:1── accounts (GL)       Cash / MTN MoMo / Telecel / Bank
payment_accounts ──< reconciliations

sales      ──< sale_items
sales      ──< sale_payments        (split payment: N methods per sale)
purchases  ──< purchase_items
purchases  ──< purchase_payments

payments   ──< payment_allocations  → sales | purchases     (settling debt)
expenses   → expense_categories, payment_accounts
income     → income_categories, payment_accounts
returns    ──< return_items          linked to the original sale/purchase
```

### Ledger
```
accounts ──< journal_lines >── journal_entries
journal_entries.source_type/source_id → sale | purchase | payment | expense |
                                        income | adjustment | opening | reversal
```

Indexes on every foreign key, plus `(occurred_at)` on `stock_ledger`,
`(entry_date)` on `journal_entries`, `(account_id, entry_date)` on `journal_lines`,
and unique indexes on `products.sku`, `products.barcode`, `users.username`.

---

## 6. Workflows

### Sale (one atomic transaction)
1. Validate: items non-empty, quantities > 0, stock available *(unless the negative-stock
   policy is enabled in settings)*, payment total ≤ total unless overpayment allowed.
2. Insert `sales` + `sale_items`, snapshotting unit price **and** the cost basis.
3. For each item: run the weighted-average engine → append `stock_ledger`, update the
   product cache.
4. Insert `sale_payments` per method (split payments supported).
5. Post the journal entry (revenue / AR / cash / COGS / inventory).
6. Assert balanced. Write `audit_logs`. Commit — or roll everything back.

Profit uses the **snapshotted** cost basis on `sale_items`, never today's product cost.
Editing a product's price tomorrow cannot retroactively change last week's profit.

### Purchase
Validate → `purchases` + items → stock ledger IN (raises average cost) → payments →
journal (Inventory / Cash / AP) → audit → commit.

### Payments, returns, adjustments
Same shape: validate, write source rows, move stock if applicable, post a balanced
journal entry, audit, commit atomically. Returns are **new linked transactions**;
the original is never mutated.

### Reconciliation
Records expected vs actual vs difference with an explanation. It **never** edits
history. An explained difference posts its own adjusting entry (cash over/short) so
the ledger still ties out — with the discrepancy visible, not hidden.

---

## 7. Users, permissions, security

- **Owner/Admin** — everything, including users, settings, voids, reconciliation.
- **Staff** — per-module flags (`view` / `create` / `edit` / `void`) across sales,
  purchases, inventory, customers, suppliers, expenses, reports, settings.

Security posture: scrypt password hashing with per-user salt; opaque 32-byte session
tokens stored **hashed** (SHA-256) so a database copy can't be replayed; HTTP-only,
`SameSite=Lax` cookies; every server action re-checks session **and** permission on
the server; all input re-validated with Zod server-side regardless of client checks;
Drizzle parameterises all SQL; React escapes output by default; rate-limited login.
Audit records are insert-only — no UI path deletes them.

### Two guards, because the caller differs

Authorisation is one decision (`can()`), but there are two ways to answer a refusal:

| Guard | Used by | On refusal |
| --- | --- | --- |
| `requirePermission` | server actions, API routes | throws `ForbiddenError` — the caller is code, which catches it and returns a message or a 403 |
| `requirePageAccess` | pages | redirects to `/no-access?area=…` — the caller is a person who typed an address, and a thrown error would render Next's server-error page |

Both make the identical `can()` check from the session cookie; only the response
differs. Hiding a nav link is convenience — these are what actually refuse.
`tests/app/page-guards.test.ts` reads all 48 page files and fails if one uses the
throwing guard, since the rule has to hold in every file, not just today's.

`/no-access` echoes back only a module name it recognises, so a crafted link cannot
put arbitrary text on the page.

### Accounts are switched off, never deleted

There is no delete path for a user, by design: their sales, cash counts and audit
trail must remain attributable. `setUserActive(false)` ends their sessions at once.
Two guards prevent locking everyone out — the last active owner cannot be switched
off or demoted, and nobody can switch off their own account.

Changing someone's role or permissions invalidates their open sessions, because a
live session carries the old rights in memory. An owner-initiated password reset
sets `mustChangePassword`; the app shell redirects to `/account/password`, which
lives **outside** the app shell so the redirect needs no path exception.

A till PIN is an alternative credential for the same account, hashed the same way
and sharing one lockout counter with password login — so PIN attempts cannot be
used to sidestep the password rate limit.

---

## 8. Reports

P&L, Balance Sheet, Cash Flow, Trial Balance, AR/AP ageing, sales/purchase/inventory
reports — **all computed from `journal_lines` and `stock_ledger`**, never from stored
totals. The Balance Sheet balances because it reads the same double-entry data that
is asserted balanced at write time. A Trial Balance page exists specifically so the
owner (or an auditor) can prove the books tie out.

---

## 9. Testing strategy

- **Unit** (pure, fast): money/BigInt edge cases, weighted-average sequences including
  sell-to-zero and returns, journal builders, business rules.
- **Integration** (real SQLite, real migrations, per-test fresh DB): full sale/purchase/
  payment/return/adjustment flows; assert stock, ledger, balances and audit rows together.
- **Invariant tests** — the ones that matter most:
  1. every journal entry balances;
  2. the balance sheet balances after a randomised transaction sequence;
  3. `Σ stock_ledger` value per product equals the product cache equals the GL
     Inventory account balance;
  4. AR subledger total equals GL 1100; AP subledger total equals GL 2000;
  5. a rolled-back operation leaves **zero** partial rows.
- **Structural tests** (`tests/app/page-guards.test.ts`): read every page file and
  assert the rules that must hold across all of them at once — the right guard,
  and no page left statically prerendered. These catch the next file added, which
  is where a per-file convention actually breaks.
- **End-to-end** (`scripts/smoke-test.mjs`, against a running server): real HTTP,
  real session cookies, real refusals. It is what proved that a page-level refusal
  was rendering a 500 rather than an explanation.

---

## 10. Self-review against the brief

| Question | Answer |
|---|---|
| Is the accounting model internally consistent? | Yes — one posting path, balance asserted pre-commit, contra accounts for discounts and drawings. |
| Can inventory be reconciled? | Yes — append-only ledger with running `(Q, V)`, recomputable from row 1 and cross-checked against GL Inventory. |
| Can every cash balance be explained? | Yes — no stored balances; every figure drills through to journal lines. |
| Customer / supplier debt accurate? | Yes — AR/AP subledgers reconciled to their GL control accounts by test. |
| Reversible without destroying history? | Yes — void/reverse creates linked reversing entries; no destructive deletes anywhere. |
| Correct P&L? | Yes — revenue and snapshotted COGS from the ledger, not from current product cost. |
| Balanced Balance Sheet? | Yes — by construction, and asserted by an invariant test. |
| Can staff be stopped from reaching what they shouldn't? | Yes — checked server-side per page and per action from the session cookie; proved over real HTTP, not just by hiding links. |
| Is there a record of who did what? | Yes — insert-only audit log with no update or delete function anywhere in the codebase, asserted by test. |

---

## 11. Hardening

**Failure is shown, never implied away.** There was no error boundary at all
before this stage: any failure rendered Next's default server-error page.
There are now `error.tsx` (inside the shell), `global-error.tsx` (root layout
failure, self-styled since the stylesheet may not have loaded) and `not-found.tsx`.
Each states that **nothing was saved** — true, because every write is a single
transaction — and shows the error digest so a failure can be matched to the
server log. Nothing internal is printed.

**Loading, and why there is only one.** A `loading.tsx` wraps its page in a
Suspense boundary, which flushes the response headers *before* the page runs. A
`redirect()` or `notFound()` from inside the page can then only happen in the
browser — the HTTP status is already 200. A shell-wide `loading.tsx` was tried
and measurably broke exactly that: staff hitting `/users` got **200 with the
shell**, and a missing record got 200 instead of 404. The smoke test caught it.

So streaming is used in one place, `/reports` — the slow section, where a
balance sheet takes about half a second — and its access check lives in
`reports/layout.tsx`, which renders *before* the boundary and so still refuses
with a real HTTP redirect. `tests/app/page-guards.test.ts` fails if any future
`loading.tsx` appears without that layout check.

The skeleton deliberately shows no numbers, not even zeros: in a bookkeeping
application a figure on screen is a claim about the shop's money, so a grey box
is safer than a plausible-looking balance.

**Backups.** `npm run backup` uses SQLite's online backup API, so it is safe
while trading. The copy is then taken out of WAL mode, which is what makes it a
single self-contained file rather than three that must travel together. Every
backup is verified before it counts — integrity, foreign keys, and that the
books inside it still balance — and a backup that fails verification is deleted
and the command fails loudly. Retention trims only *after* a verified backup
exists, so a failure never leaves the shop with fewer backups than it had.

**Production preflight.** `npm run preflight` answers the questions that are
easy to get wrong once and discover months later: placeholder secret, demo
seeding still on, migrations unapplied, corruption, unbalanced books, no active
owner, demo records or published demo credentials still present. Unsafe-to-trade
conditions fail; judgement calls warn.

### Performance, measured not assumed

`npm run benchmark` builds a year of trading (365 x 200 sales = 292k ledger
lines) and times every report with its query plan. It found a real defect: the
journal browser joined lines and grouped **every entry in history** before
taking 50 rows — 286ms at one year, and worse every year after. Paging first and
totalling only that page brought it to **0.8ms**, and made the cost proportional
to the page instead of to the shop's age.

The whole-ledger aggregates (trial balance 287ms, balance sheet 458ms) genuinely
read every row, which is what they are for; they stay well under a second.

---

## 12. Settings

The settings table was always consumed by the services — tax by `sale.service`,
the stock policy by four services, the currency by nearly every page — but
nothing could edit it. This stage added the screen, and with it the guards that
editing makes necessary.

**Currency cannot change once the books have entries.** No amount stores its own
currency; every figure is a count of minor units and the currency code labels
all of them at render time. Changing it after trading would relabel history
without touching a row — the same class of harm as editing a past transaction,
which this application refuses elsewhere. So `updateSettings` refuses it, and
because the check runs inside the transaction, a rejected currency change rolls
back the whole save rather than letting the other fields through. The symbol
stays editable: `₵` and `GH₵` are the same currency.

**Rates are basis points, for the same reason money is pesewas.** 7.3% as a
float is not exact, and the error would be multiplied by every sale.
`domain/rate.ts` owns both directions of the conversion, and a property test
walks all 10,001 rates asserting `parse(format(bp)) === bp` — because the form
renders with one and saves with the other, and a mismatch would change the tax
rate on a save that changed nothing.

**The audit entry says what changed, not that something did.** `Tax: off → on`
and `Allow negative stock: off → on` are the entries an auditor needs. A save
that changes nothing writes no entry at all, since a log full of no-ops is a log
nobody reads.

Two columns — `allow_overpayment` and `financial_year_start_month` — exist in
the schema but are read by no code. They are deliberately **not** on the screen:
a control that does nothing is worse than an absent one. They are either wired
up or dropped, as a separate decision.

---

## 13. The year-end pack

Composed entirely from the existing reporting services. A pack that recomputed
its own figures could disagree with the on-screen Profit & Loss, and there would
be no way to tell which was right — so it calls the same functions the app uses
all year, over a fixed period, with the prior year alongside.

**The movement in the owner's stake** is the one statement that exists only
here, and it exists because of a documented trade-off: there is no year-end
close, so revenue and expense accumulate and the balance sheet folds all-time
profit into equity. The balance sheet therefore cannot show what *this* year did
to the owner's stake. This reconciles them:

```
opening + capital introduced − drawings + opening balances brought in + profit
```

**A bug the statement caught in itself.** The first version omitted the movement
in Opening Balance Equity — the account used when stock or a bank balance is
entered as a starting position rather than bought or earned. On the demo data
that left GHS 2,285.50 unexplained, and the pack reported `Owner's stake
reconciles: NO` rather than presenting a tidy but wrong statement. That is the
behaviour worth keeping: the check is on the page, so the pack tells on itself.

`financial_year_start_month`, one of the two columns previously read by no code,
now decides the period. All date arithmetic is on `YYYY-MM-DD` strings in
`domain/financial-year.ts` — a `Date` carries a timezone, and parsing
"2025-12-31" west of UTC yields the 30th, which would file a year-end sale in
the wrong year.

---

## 14. Year-end close

Reverses a trade-off this document previously defended. Closing sweeps a year's
revenue, expense and drawings accounts to zero and carries the result to
Retained Earnings, in one journal entry dated on the year end.

**The trap, and the flag that avoids it.** A closing entry is dated *inside* the
year it closes, and cancels that year's revenue and expenses exactly. Counted by
the Profit & Loss, it would report a well-traded year as having earned nothing.
So entries carry `is_closing`, the P&L excludes them, and the balance sheet
includes them — the latter is how profit reaches equity at all. The reversal
posted when reopening is dated inside the year too, and is flagged the same way;
without that, reopening reported the year's profit twice.

**The balance sheet formula did not have to change.** Equity is
`posted Retained Earnings + all-time profit`. Once a year is closed its trading
accounts sum to zero and contribute nothing to the second term, while the first
holds what was swept in. An unclosed year is the reverse. Each year is counted
exactly once either way, which is what lets closed and unclosed years coexist.

**Trial balance, corrected.** It reported *gross* debits and credits per
account. After a close that reads absurdly: Sales Revenue shows a year of sales
on one side and the closing entry on the other, for an account that now holds
nothing. It now reports each account's **net** balance on its natural side and
omits accounts that net to zero — a trial balance of balances, which is the
standard form.

**Refusals.** Closing a year that has not ended, closing twice, and closing out
of order are all refused: each produces figures that look final and are not.
Reopening is refused underneath a later closed year, whose figures were computed
with this one already swept.

**Reversible, and locked.** Closing sets the books lock to the year end.
Reopening reverses the entry rather than deleting it, moves the lock back to the
previous closed year, and records both in `year_end_closings` — which keeps the
close and its reversal linked rather than floating free.

---

## 15. The logo, and the first untrusted binary

The schema carried a `logo_path` column, read by nothing, whose name presumed a
file on disk. Two facts made that the wrong answer, both learned elsewhere in
this project: `createBackup` copies `env.DATABASE_PATH` and nothing else, so a
file beside the database would be missing from every backup and a restore would
be silently incomplete; and on a managed host the application folder is
rewritten on each deploy. The image is stored in the database instead, and the
column was replaced rather than inherited.

**Every other input so far has been text through Zod.** A file upload is the
first untrusted binary, and `src/lib/image.ts` is the boundary:

- The format is read from **magic bytes**. The browser's `Content-Type` and the
  filename are chosen by whoever uploads, so neither is consulted, and the
  filename never reaches a path.
- **SVG is refused by name in the error message.** It is a document that can
  execute, and one served from the app's own origin would run with the viewer's
  session on the machine of whoever opens a receipt.
- Byte length **and pixel dimensions** are capped: a small compressed file can
  decompress into something enormous.
- The stored mime type is the sniffed one, and it is what the serving route
  sends back with `nosniff` — otherwise the uploader would choose the
  `Content-Type` their file is served with.

The dimension parsers for PNG, JPEG and WebP are hand-written and tested against
real encoder output, because a parser tested only against bytes we wrote
ourselves proves nothing about a file a shop owner uploads.

---

## 16. Motion

Small on purpose. This is a till: someone is at a counter with a queue, and
motion that delays a tap is worse than none. Everything is an **entrance** —
nothing loops, nothing moves on a timer, 160ms for content and 120ms for
feedback.

**Nothing animates a figure.** A number sliding or fading into place reads as
the value still being uncertain, which is the last impression a set of books
should give. `tests/app/motion.test.ts` fails if any element carries both a
motion class and `tabular`, the class that marks money and quantities.

**Reduced motion means none, not less.** The pre-existing blanket rule shortened
durations to 0.01ms, which still lets an element jump from its offset start
position — movement, for someone who asked for stillness. The entrance classes
are switched off outright instead.

**Print renders the final state.** A receipt must never come out of the printer
mid-entrance, so `@media print` forces `animation: none`, `opacity: 1` and no
transform.

`PageTransition` keys on the **pathname only**, never the full URL. Keying on
the query string would remount on every filter change and paging click —
resetting the till's cart the moment the address gained a query.

React's `<ViewTransition>` was considered and not used: it is not exported by
React 19.2.8, only by canary builds.

---

## 17. Overpayment

The last column read by no code. Both payment services hard-refused an amount
larger than the balance, with a comment saying deposits were not modelled — so
the setting had a name and no behaviour.

It now decides. Off by default, and the refusal names the setting instead of
merely saying no: at a counter, an amount larger than the balance is usually a
typo, and refusing it catches the mistake while the customer is still there.

**Where the excess goes.** It stays on the party's own subledger balance, which
turns negative — a customer in credit. Auto-allocation draws it down against
their next purchase with no extra machinery, because allocation already works
from the balance.

**Why the balance sheet had to change.** A negative customer balance sits inside
Accounts Receivable, and the control account nets it off. Left alone, the
balance sheet would report less owed than customers actually owe AND omit money
the shop is holding on their behalf — and it would still balance, which is
exactly why nobody would notice. `subledger-split.ts` splits each control
account by the sign of each party's own balance: debtors as an asset, credits as
the liability they are. A test asserts the two still sum to the control account,
so the split can never invent a figure.

---

## 18. The dashboard

Rebuilt as a card grid after a QuickBooks dashboard was offered as a reference.
The **patterns** were taken — a card per question, a headline figure, a small
picture beneath it, a period selector where one helps — and none of the
branding, palette or chrome.

**Charts are hand-written SVG, rendered on the server.** No charting library:
that would have been the largest thing in the bundle, and these arrive as markup
with **zero client JavaScript**, which is what a counter PC and a phone over
shop WiFi deserve. It also keeps the runtime at eight dependencies.

Rules the charts keep:

- **A component never computes money.** Charts receive values already totalled
  by a service, plus the label already formatted. The arithmetic in
  `components/ui/chart.tsx` produces pixel positions and nothing else.
- **A figure is never only a shape.** Every chart is `role="img"` with a written
  summary, and the card states the same numbers as text — a chart cannot be read
  aloud, quoted over the phone, or checked against a receipt.
- **Paired bars share one scale.** Two series on separate scales is how a chart
  misleads without stating anything false.
- **An empty period says so**, rather than drawing a flat line at zero, which
  would read as a real measurement.

`getMoneyByMonth` was added so the cash-flow chart costs **one** grouped query
rather than one aggregate per month. The dashboard is the most-opened screen;
six whole-ledger aggregates on it would be the slowest thing in the app within a
year of trading.

Two defects were found while doing this. A "Build progress" panel still claimed
stages 1 and 2 were complete, and pointed at menu items marked "Soon" that no
longer exist. And `getExpensesByCategory` returned its total as a raw driver
number rather than branded `Minor` — the only reporting function that did. The
brand caught it at the call site, which is exactly its job; the fix went into
the service, not a cast at the boundary.

---

## 19. The shell: dark chrome, search, notifications

The sidebar is dark in **both** themes. It is chrome rather than content, and
holding it constant gives the eye a fixed frame while the working area follows
the shop's light or dark preference. Its colours are our own tokens
(`--sidebar-*`), not the reference's.

Two of the reference's chrome features turned out to be **real functionality we
lacked**, not styling:

**Search** applies permission *per record type, before querying*. Filtering
results afterwards would still have run the query, and a count or a timing
difference can disclose that records exist. A type the person cannot view is
never queried at all. Wildcards in the term are escaped, so searching `%` means
a literal percent rather than "every row in every table".

The search page requires only a **session**, not a module. Guarding it on
`reports` locked till staff out of a box sitting in their own top bar — caught
by testing it as a staff member against the running server, not by reading it.

**Notifications** are conditions that hold right now, each linking to the screen
that clears it: books out of balance, stock out or low, customers overdue, a
finished year not closed, no backup taken in a week. Nothing is a tip or a
nudge — a bell that cries wolf is ignored on the one occasion it matters.
Backups are read from the audit log, since nothing else records them.

They are permission-filtered too. Owner housekeeping is invisible to till staff,
who cannot act on it. The single exception is an unbalanced ledger, shown to
everyone: if the books are broken, no screen can be trusted whatever the
person's role.

**The menu was too long.** Sixteen links under five headings, plus the shop
name, the action button and the user footer — enough to scroll on a laptop,
which is a menu nobody reads to the bottom of. Two changes: sections now fold
(`<details>` again, no JavaScript, with the section containing the current page
already open on arrival), and three occasionally-used pages moved to the screen
they belong to — Other Income beside Expenses, Reconciliation under Accounting,
the Audit log on the Users page. Thirteen links remain.

Demoting a page orphans it unless the parent links to it, and none of the three
parents did. Those links were added first, and the smoke test now asserts each
parent still links to its child and that the child still opens — so a page can
never quietly become unreachable.

The notification panel is a `<details>` element — it opens and closes with **no
JavaScript**, for the same reason the charts are server-rendered SVG.

### Known trade-offs, stated openly
- **Local-first means one machine holds the data.** Automated local backups are in
  Stage 10; off-site backup is the owner's responsibility until sync is added.
- **Weighted average is not FIFO.** Correct and standard for small retail, but not
  ideal for perishables with volatile pricing. The cost engine sits behind an
  interface so FIFO can be added without touching the posting layer.
- **No free-form journal entry in v1.** Deliberate — it protects traceability. An
  owner-only adjusting-entry screen can come later if a real need appears.
