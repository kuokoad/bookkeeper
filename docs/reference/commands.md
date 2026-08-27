# Commands

Every script in `package.json`, what it does, and when you want it.

Run them with `npm run <name>`.

## Daily

| Command | What it does |
|---|---|
| `dev` | Starts the development server. Add `-- -p 5177` to pick a port. |
| `test` | Runs the whole suite once (`vitest run`). 1,273 tests. |
| `test:watch` | Runs the suite and re-runs on save. |
| `typecheck` | `tsc --noEmit`. Types only, no output. |
| `lint` | `eslint .` across the repo. |

## Before you claim it works

| Command | What it does |
|---|---|
| `verify` | `typecheck` + `lint` + `db:check` + `test`, in that order, stopping at the first failure. |
| `build` | The production build. Catches what `dev` does not. |
| `smoke` | End-to-end checks against a **running** server. Pass a base URL: `node scripts/smoke-test.mjs http://localhost:5177`. Defaults to port 3000. |

`verify` and `build` are both worth running. A green `dev` proves very little.

## Database

| Command | What it does |
|---|---|
| `setup` | `db:migrate` then `db:seed`. What you want on a fresh clone. |
| `db:migrate` | Applies pending migrations from `src/db/migrations/`. |
| `db:seed` | Seeds the chart of accounts, payment accounts and tax components. Idempotent — running it twice changes nothing. Adds demo data too when `SEED_DEMO_DATA=true`. |
| `db:generate` | Generates a migration from schema changes. Run after editing `src/db/schema/`. |
| `db:check` | Verifies migrations and schema agree. Part of `verify`. |
| `db:reset` | **Destroys and rebuilds the database.** Development only. |
| `db:studio` | Opens Drizzle Studio to browse the data. |

## Records and health

| Command | What it does |
|---|---|
| `backup` | Writes a timestamped copy of the database to `backups/`. |
| `db:restore` | Restores from a backup file. |
| `preflight` | Replays the whole stock ledger and checks every product's cached quantity and value against it. Slow on purpose — waiting for it is the point. Run it when the Inventory page warns that stock disagrees with the ledger. |
| `benchmark` | Times the heavy report queries. |
| `env:init` | Generates a `.env` with a fresh random `SESSION_SECRET`. Run once per machine. |

## Notes

- **`db:reset` destroys data.** It is for development databases only. There is no
  confirmation prompt.
- **`preflight` is the answer to "the numbers look wrong".** It recomputes from the
  ledger rather than trusting the cache, and names the product where the two parted
  company.
- **`smoke` needs a server already running.** It makes real HTTP requests and signs
  in; it does not start anything itself.

## Related

- [Developer setup](../tutorials/developer-setup.md) — these commands in the order
  you first need them.
- [Back up and restore](../how-to/back-up-and-restore.md) — `backup` and `db:restore`
  in context.
