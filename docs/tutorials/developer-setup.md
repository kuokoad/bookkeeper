# Developer setup

From a fresh clone to a running shop with demo data and a green test suite. About ten
minutes, most of it `npm install`.

## What you'll need

- **Node.js 22 or newer** (tested on 24)
- Git
- A terminal

No database server. The whole shop is one SQLite file.

## Step 1: Install and configure

```bash
git clone https://github.com/kuokoad/bookkeeper.git
cd bookkeeper
npm install
npm run env:init
```

`env:init` writes a `.env` with a freshly generated random `SESSION_SECRET`. It is
git-ignored and must never be committed.

Open `.env` and set:

```
SEED_DEMO_DATA=true
```

That gives you a shop with products, sales, customers and suppliers to look at,
rather than an empty one.

## Step 2: Create and seed the database

```bash
npm run setup
```

That runs the migrations and then the seed. You will see the chart of accounts,
payment accounts and tax components go in, then the demo shop, and finally:

```
Owner  ->  owner / demo-owner-2026
Staff  ->  ama / demo-staff-2026 (PIN 8351)
```

Those credentials are published in the README on purpose: they exist so it is obvious
they must never be on a real shop's machine. The seed refuses to run with
`NODE_ENV=production`.

## Step 3: Run it

```bash
npm run dev -- -p 5177
```

Open **http://localhost:5177**, sign in as `owner` / `demo-owner-2026`, and you are
looking at a working shop. The dashboard shows today's takings, what is owed, and
what needs attention.

That is the working result. Everything below is orientation.

## Step 4: Confirm it is healthy

```bash
npm run verify
```

Typecheck, lint, a migration check, then 1,273 tests. Takes a couple of minutes and
should be entirely green.

```bash
npm run build
```

The production build catches what `dev` does not. Run both before you believe a
change works.

While the server from step 3 is still running, in another terminal:

```bash
node scripts/smoke-test.mjs http://localhost:5177
```

End-to-end checks against the real thing. It signs in and exercises every page.

## Step 5: Find your way around

```
src/
  app/        Pages (Next.js App Router)
  actions/    'use server' entry points — auth + validation, no logic
  services/   Transactional orchestration; opens the DB transaction
  domain/     Pure business logic. Money, quantities, accounting. Fully tested.
  db/         Schema, migrations, seed
  lib/        Auth, permissions, formatting, filters
tests/        Mirrors src/
```

**The rule that matters:** a financial calculation lives in `domain/` exactly once,
and UI components never compute money.

Worth reading next, in this order:

1. **`CLAUDE.md`** — the rules anyone changing this code needs, including a drizzle
   trap that has caught two people.
2. **`ARCHITECTURE.md` §2, §3, §4** — layering, the precision model, double entry.
3. [Money and quantity](../reference/money-and-quantity.md) — before you touch a
   number.

## Step 6: Make a change

Try something small end to end:

1. Edit a label on `/sales` in `src/app/(app)/sales/page.tsx`.
2. Watch it hot-reload.
3. `npm run verify`.

That is the loop.

## What you built

A running bookkeeping app with a month of demo trading in it, a green test suite, and
a map of where things live.

Things worth trying from here:

- **Filter something.** `/sales`, press **Cash sales**, watch every figure above the
  table move with it. See [Find anything](../how-to/find-anything.md).
- **Follow a figure to its source.** Dashboard → a sale → its journal entry →
  the trial balance. Every number traces back to an event.
- **Break something on purpose.** Change a COGS calculation and watch the report
  invariant tests fail. They exist to catch exactly that.

## Troubleshooting

**`SESSION_SECRET` errors on start.** Run `npm run env:init`.

**Port 3000 is taken.** `npm run dev -- -p 5177`, and remember to pass the same base
URL to the smoke test.

**The setup screen appears instead of login.** No owner exists yet — the seed did not
run, or did not create demo users. Check `SEED_DEMO_DATA=true` and re-run
`npm run db:seed`.

**Tests fail on a fresh clone.** Run `npm run db:check` first. If migrations and
schema disagree, `npm run db:generate` was probably skipped after a schema edit.

**"Stock records disagree with the ledger" on Inventory.** `npm run preflight` replays
the whole ledger and names the product where they parted company. On a fresh seed this
should never appear.

## Related

- [Commands](../reference/commands.md) — every script.
- [Your first hour](first-hour.md) — the same app from a shop owner's side.
- [Routes and permissions](../reference/routes-and-permissions.md) — the full surface.
