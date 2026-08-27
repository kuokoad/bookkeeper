@AGENTS.md

# Working on NunaBooks

Bookkeeping for a small Ghanaian retail shop. The product is the figures, so
the bar is not "does it run" — it is "would a shop owner be right to trust
this number". A plausible wrong figure is worse than a missing one, because
nobody goes looking for it.

Already written down, do not restate it here:

- **`ARCHITECTURE.md`** §2 layering, §3 money and quantity precision,
  §4 double entry, §9 testing strategy.
- **`README.md`** "Where things live" and "How the money works".

Read those before changing anything in `domain/` or `services/`.

## Before saying it works

```bash
npm run verify   # typecheck + lint + drizzle-kit check + vitest
npm run build    # the production build catches what dev does not
```

Both, every time. `npm run dev` alone proves very little.

## Traps that have already bitten

**Drizzle drops the table qualifier on a query with no joins.** `${sales.id}`
renders as a bare `"id"`, and inside a raw `sql` subquery SQLite binds that to
the SUBQUERY's table — silently turning a correlated subquery into an
uncorrelated one that returns the same plausible number for every row. It bites
asymmetrically: the identical fragment is correct in a query that joins and
wrong the moment it is reused in a count that does not. Reference the outer
table's columns as literal qualified SQL — ``const SALE_ID = sql`sales.id` `` —
the way `sale.service.ts`, `purchase.service.ts`, `catalog.service.ts`,
`inventory.service.ts` and `reporting/operations.service.ts` all now do. To
check one: `query.toSQL().sql`, and look for an unqualified name inside a
subquery.

## Filtering

Every list and report is filtered through one system. When adding or changing
a filter, keep these — each exists because breaking it produced a wrong figure
on a screen:

1. **Parse once, in `lib/list-filters.ts`.** One parser per module, used by
   both the page and its CSV route. An export that parses the query string its
   own way is how a downloaded file stops matching the screen it came from.
2. **Filter in SQL, before the limit.** Never `.filter()` a page of results —
   that answers "which of the most recent hundred", not the question asked.
3. **Totals come from the same conditions builder as the rows.** `list*`,
   `count*` and `getFiltered*Summary` share one clause. Filtered rows under
   unfiltered totals is the specific way this application would mislead.
4. **Validate everything; junk narrows nothing.** A hand-edited query string is
   a filter nobody meant, not a 500. Ids, enums, dates, amounts and sort keys
   all go through `lib/filters.ts` — a sort key reaches an `ORDER BY`, so it can
   never be a string off the wire.
5. **Controls show the RESOLVED value, never the raw parameter.** If the server
   rejected the input, echoing it back leaves the controls describing data that
   is not on screen.
6. **Reads never write.** `tests/services/sales-filters.test.ts` snapshots
   stock, balances, journal entries and the ledger across every filter
   combination and asserts nothing moved. Keep that true.

`FilterBar` handles the UI and resets the page number and one-shot flash keys
on every change, so pages do not each reimplement it. `Pagination` and
`SortLink` carry the active filters.

Dates are `'YYYY-MM-DD'` text compared with `>=` / `<=`, so a range is
inclusive at both ends and a sale rung up at 23:47 on the closing day is in it.
Never filter trading on a timestamp.

## Tests

`tests/` mirrors `src/`. A test asserts what a shop owner would check, not that
a function was called. Add one for every fixed bug — name the behaviour that
broke, not the function.

Money assertions are in minor units (`5_000` is GHS 50.00). `tests/helpers/`
has the throwaway database and the tax setup.
