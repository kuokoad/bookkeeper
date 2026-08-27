# Filters

Every filter in the app, its URL parameter, and where it applies.

Filters live in the URL, so any filtered view can be refreshed, bookmarked, shared
with your accountant, and stepped back out of with the browser's back button.

Anything unrecognised is **ignored**, not rejected: a hand-edited parameter narrows
nothing rather than producing an error page.

## Shared across every filtered page

| Parameter | Values | Notes |
|---|---|---|
| `period` | `today` `yesterday` `week` `last-week` `month` `last-month` `year` `all` `custom` | Defaults to `month`. `week` starts on Monday. |
| `from`, `to` | `YYYY-MM-DD` | Used with `period=custom`. Either may be omitted for an open-ended range. |
| `q` | free text, trimmed, capped at 100 characters | What it searches differs per page — see below. |
| `page` | positive integer | Clamped to the last real page. Reset to 1 whenever a filter changes. |
| `sort`, `direction` | per-page column, `asc` / `desc` | Validated against a whitelist. |
| `min`, `max` | amounts, e.g. `50` or `1,250.50` | Entered backwards, they are swapped. |

**Date ranges include both ends.** Business dates are stored as `YYYY-MM-DD` text
and compared as text, so 1–15 August covers a sale rung up at 23:47 on the 15th.

## Sales — `/sales`

| Parameter | Values |
|---|---|
| `customer`, `product`, `category`, `account`, `staff` | id |
| `method` | `CASH` `MOBILE_MONEY` `BANK` `OTHER` |
| `status` | `POSTED` `VOIDED` |
| `paid` | `paid` `unpaid` |
| `sort` | `date` `amount` `profit` `customer` `receipt` |

`q` searches receipt number, invoice number, customer name and phone, product name,
SKU and barcode.

Quick filters: today's sales, credit sales, cash sales, MoMo sales, voided.

## Purchases — `/purchases`

| Parameter | Values |
|---|---|
| `supplier`, `product`, `category`, `account` | id |
| `method` | `CASH` `MOBILE_MONEY` `BANK` `OTHER` |
| `status` | `POSTED` `VOIDED` |
| `paid` | `paid` `partial` `outstanding` |
| `sort` | `date` `amount` `supplier` `outstanding` `reference` |

`q` searches purchase number, invoice number, supplier name and phone, product name
and SKU.

## Products — `/products`

| Parameter | Values |
|---|---|
| `category`, `supplier` | id |
| `stock` | `in-stock` `low` `out` `negative` |
| `expiring` | `expired` `soon` |
| `archived` | `active` `archived` |
| `sort` | `name` `quantity` `cost` `price` `value` `category` |

`q` searches name, SKU and barcode. **`low` includes what has run out** — a product
at zero is the most urgent case of below-minimum, and hiding it from the reorder
list is the one thing that list must never do.

`negative` only appears in the dropdown when the shop allows negative stock or
something has actually gone negative.

No date filters: a product is a position, not an event.

## Stock movements — `/inventory`

| Parameter | Values |
|---|---|
| `product`, `category`, `user` | id |
| `movement` | `OPENING_STOCK` `PURCHASE` `PURCHASE_RETURN` `SALE` `SALE_RETURN` `ADJUSTMENT_IN` `ADJUSTMENT_OUT` |

`q` searches product name, SKU, the source reference and the movement's note.

Defaults to `period=all`, not this month: "where did this stock go" is a question
whose answer must not stop at the first of the month.

`user` reaches through to the document behind the movement — the ledger records what
moved and why, not who; the person is on the sale, delivery or adjustment.

## Expenses and income — `/expenses`, `/income`

| Parameter | Values |
|---|---|
| `category`, `account`, `staff` | id |
| `status` | `POSTED` `VOIDED` |
| `sort` | `date` `amount` `category` `reference` |

`q` searches description, reference and note.

## Customers and suppliers — `/customers`, `/suppliers`

| Parameter | Values |
|---|---|
| `balance` | `owing` `zero` `credit` |
| `archived` | `active` `archived` |
| `sort` | `name` `balance` |

`q` searches name, phone and email (plus contact person for suppliers).

**`owing` is read from the ledger**, not from a flag on the record, so "customers who
owe" can never drift from what the accounts say is owed.

## One account's statement — `/accounts/[id]`

| Parameter | Values |
|---|---|
| `type` | a journal source type, e.g. `SALE` `EXPENSE` `CUSTOMER_PAYMENT` |
| `flow` | `in` `out` |

`q` searches entry number, memo and line description.

The statement always shows an **opening balance** read from the ledger, so
opening + in − out = closing and the running balance carries across pages.

Filtering by type, direction, amount or text narrows the movements but **not** the
opening balance — that is what the account held, not a subtotal of matching rows.
The page says so when you narrow beyond the dates.

## Receivables and payables — `/accounting/receivables`, `/accounting/payables`

| Parameter | Values |
|---|---|
| `customer` / `supplier` | id |
| `status` | `overdue` (over 90 days) `current` |
| `asAt` | `YYYY-MM-DD` |

The ledger agreement check runs against the **whole** report, before narrowing, so
looking at one customer cannot raise a false alarm.

## Reports

| Report | Accepts |
|---|---|
| `/reports/sales` | dates, `customer`, `product`, `category`, `account` |
| `/reports/purchases` | dates, `supplier`, `product`, `category`, `account` |
| `/reports/inventory` | `category`, `supplier`, `stock`, plus dates for the movement table |
| `/reports/profit-and-loss` | dates |
| `/reports/cash-flow` | dates, `account` |
| `/reports/tax` | dates |

On the sales report, choosing a **product or category** switches every money figure
to line money — that product's revenue net of tax and that product's cost — and hides
the payment-method table, because money is handed over for a whole receipt. See
[Filtering](../explanation/filtering.md) for why.

## Exports

Every filtered list has a **Download CSV** button. The export runs the same parser and
the same query as the screen, so the file holds exactly the rows you were looking at.

`/api/exports/<list>?<the same parameters>` where `<list>` is one of `sales`,
`purchases`, `expenses`, `income`, `products`, `stock-movements`, `customers`,
`suppliers`, or `account` (which also needs `id`).

Each export requires view permission on **its own module** — access to sales is not
access to expenses. Downloads stop at 5,000 rows and say so in a final line rather
than truncating silently.

## Related

- [Find anything](../how-to/find-anything.md) — using these from the screen.
- [Filtering](../explanation/filtering.md) — how they reach the database.
