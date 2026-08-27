# Filtering

Why filtering is built the way it is, and the mistake it exists to prevent.

## The problem

A bookkeeping page can mislead in a way an ordinary app cannot. If a photo gallery
shows the wrong twelve photos, you notice. If a sales page shows twenty-seven cash
sales under a revenue figure that includes the MoMo ones, the number looks
completely normal. Nobody goes looking for it. They take it to their accountant.

Every rule below exists because breaking it produced exactly that: a plausible
figure that was wrong.

## The four rules

### 1. Parse once, share the parser with the export

`src/lib/list-filters.ts` holds one parser per module. The page uses it, and so does
the CSV route.

An export that reads the query string its own way is how a downloaded file stops
matching the screen it was downloaded from — and the file is the thing that gets
emailed to the accountant, so it is the copy that matters most. Same parser, same
query, same rows.

### 2. Filter in SQL, before the limit

"Unpaid only" used to fetch a page of sales and drop the settled ones in JavaScript.
That answers a different question — *which of the most recent hundred sales are
unpaid* — and it gets quietly wronger the more the shop sells. A shop with two
hundred sales a month sees a credit list that silently stops.

Every filter is now a SQL condition, applied before `LIMIT`. Outstanding balances,
low stock and customer balances are all SQL expressions rather than values computed
after the fact, precisely so they can narrow rows rather than be dropped from them.

### 3. Totals come from the same clause as the rows

`listSales`, `countSales` and `getFilteredSalesSummary` all build from one
`saleConditions` function. Narrow to cash sales in the first fortnight and the count,
the quantity, the revenue, the discount, the cost of goods and the gross profit all
narrow with it.

The alternative — a summary with its own WHERE clause — is how filtered rows end up
under unfiltered totals. It is the defect this whole design is organised against.

Two figures deliberately do **not** move with the filter, and say so on the page:

- **"You owe suppliers"** on Purchases, and **"Total owed to you"** on Customers.
  Narrowing to one month cannot reduce what the shop actually owes.
- **The opening balance** on an account statement. That is what the account held, not
  a subtotal of the rows a search box happens to match.

The rule is not "everything moves with the filter". It is "every figure says which it
is".

### 4. Junk narrows nothing

A hand-edited `?customer=abc` or `?page=-4` is not an error worth a 500 page. It is a
filter nobody meant. Ids, enums, dates, amounts and sort keys all go through
`src/lib/filters.ts` and become `undefined` when they do not parse.

Sort keys matter most: a sort key reaches an `ORDER BY`, so it is checked against a
whitelist and can never be a string that came off the wire.

## Lines against receipts

The one genuinely hard call. A product is a property of a **line**; a tender, an
invoice discount and a tax charge are properties of a **receipt**.

Filter the sales report to Coca-Cola and ask for revenue by day. Summing whole
receipts reports a day on which somebody bought one Coke and six thousand cedis of
rice as six thousand cedis of Coca-Cola.

So choosing a product or category switches every money figure on that report to line
money: that product's revenue net of tax, and that product's cost. The by-day and
by-customer tables get line-level variants with a deliberately **narrower shape** —
no tax, no tax-inclusive total. Tax is charged on the document and is not stored per
line, so it cannot honestly be apportioned, and giving a wrong figure a familiar
column to sit in is how it survives review.

The payment-method table is not shown at all under such a filter. Money is handed
over for a whole receipt; there is no honest way to say how much of a cash payment
was for one product on it. Saying so beats showing a number that answers a different
question.

## The drizzle trap

Worth its own section, because it has caught two people and produces no error.

On a query with **no joins**, drizzle omits the table qualifier. `${sales.id}` renders
as a bare `"id"`. Inside a correlated subquery, SQLite then binds that to the
*subquery's* table — so the subquery stops correlating and returns the same plausible
number for every row.

It bites asymmetrically, which is why it survived review the first time:

```
listSales      joins customers  →  drizzle qualifies  →  correct
countSales     no joins         →  bare "id"          →  wrong
```

The same fragment. Correct in one, wrong in the other.

The fix is to write the outer table's columns out in full:

```ts
const SALE_ID = sql`sales.id`;
// ...
sql`EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = ${SALE_ID})`
```

`sale.service.ts`, `purchase.service.ts`, `catalog.service.ts`, `inventory.service.ts`
and `reporting/operations.service.ts` all carry constants like this. The note on
`listCategories` in `catalog.service.ts` records the first time it happened.

To check one: `query.toSQL().sql`, then look for an unqualified column name inside a
subquery. A test that asserts a per-row count **differs between rows** catches it; one
that checks a single row does not.

## Reading is not writing

Filtering never changes stock, balances, receivables, payables or the accounts. It
never creates a transaction.

That is asserted rather than assumed. `tests/services/sales-filters.test.ts` snapshots
stock quantities and values, journal entries, journal lines and the stock ledger,
runs every filter combination, and asserts nothing moved. A query that accidentally
wrote would look exactly like a query that did not, so it is checked rather than
trusted.

The stock ledger deserves a specific note: every row already carries the running
balance that was true when the movement happened. Narrowing the view to one product
or one week shows fewer rows and **the same balances**. Nothing recomputes a position
from what is on screen.

## Related

- [Filters reference](../reference/filters.md) — every parameter.
- [Find anything](../how-to/find-anything.md) — using it.
- `CLAUDE.md` — the same rules as instructions for anyone changing this code.
