# NunaBooks documentation

Bookkeeping, inventory, sales and accounts for a small Ghanaian retail shop.

These pages are split by **what you are trying to do**, not by feature. Pick the
row that matches your situation.

| You want to… | Go to |
|---|---|
| Learn the app by using it | [Tutorials](#tutorials) |
| Get a specific job done | [How-to guides](#how-to-guides) |
| Look something up | [Reference](#reference) |
| Understand why it works this way | [Explanation](#explanation) |

Two other documents sit outside this split and are worth knowing about:

- **[`../README.md`](../README.md)** — the shop owner's guide: what the app does,
  how to run it, backups, security notes.
- **[`../ARCHITECTURE.md`](../ARCHITECTURE.md)** — the design record: layering,
  the money model, double entry, the schema, testing strategy. Where a page here
  would repeat it, it links instead.

---

## Tutorials

Learning by doing. Start here if the app is new to you.

- **[Your first hour](tutorials/first-hour.md)** — set the shop up, add a product,
  ring up a sale, and see what it earned. For a shop owner.
- **[Developer setup](tutorials/developer-setup.md)** — clone to a running app with
  demo data and a green test suite. For a developer.

## How-to guides

Specific jobs, assuming you already know your way around.

- **[Find anything](how-to/find-anything.md)** — filters, search, quick filters and
  exports across every list and report.
- **[Fix a mistake](how-to/fix-a-mistake.md)** — void, return, adjust. Nothing is
  ever edited or deleted, so this is how corrections work.
- **[Manage tax](how-to/manage-tax.md)** — Ghana's three taxes as editable data, and
  what to do when a budget moves a rate.
- **[Close a period](how-to/close-a-period.md)** — lock the books for a month, close
  a financial year, produce the accountant's pack.
- **[Back up and restore](how-to/back-up-and-restore.md)** — the database is the
  business records. This is how you keep them.

## Reference

Facts to look up. Complete and checked against the code.

- **[Commands](reference/commands.md)** — every npm script and what it does.
- **[Routes and permissions](reference/routes-and-permissions.md)** — every page and
  API route, and the permission each requires.
- **[Filters](reference/filters.md)** — every filter, its URL parameter, and which
  pages accept it.
- **[Money and quantity](reference/money-and-quantity.md)** — the `Minor` and `Qty`
  API. Read before writing anything that touches a number.

## Explanation

Why the app is built the way it is.

- **[Filtering](explanation/filtering.md)** — how a filter reaches the database, why
  the totals are computed the way they are, and the drizzle trap that has caught
  two people.
- **[Inventory costing](explanation/inventory-costing.md)** — weighted average, the
  stock ledger, and why batches carry no money.
- **[Tax in Ghana](explanation/tax-in-ghana.md)** — why three taxes are data rather
  than a rate constant.

Design material not repeated here: **precision** (ARCHITECTURE §3), **double entry**
(§4), **the schema** (§5), **permissions** (§7), **testing** (§9).
