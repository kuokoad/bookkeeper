# How to find anything

Narrow any list to exactly what you want, and take it away as a spreadsheet.

## Prerequisites

Signed in, with view permission on whatever you are looking at.

## Steps

### 1. Start with a quick filter

Most pages carry a row of buttons above the table for the questions people ask most.
On Sales: **Today's sales**, **Credit sales**, **Cash sales**, **MoMo sales**,
**Voided**. On Products: **Low stock**, **Out of stock**. On Customers: **Customers
who owe**.

One click. Press it again to turn it off.

### 2. Or set a period

Eight presets: Today, Yesterday, This week, Last week, This month, Last month, This
year, Everything. Or type two dates into **From** and **To** and press **Apply dates**.

Ranges include both ends. First to fifteenth of August includes a sale rung up at
quarter to midnight on the fifteenth.

Leave one date empty for an open-ended range — everything up to a date, or everything
from a date onwards.

### 3. Add as many filters as you need

Filters stack. Every one you add narrows what is already there.

August + Drinks + Cash + "Coca-Cola" shows sales that satisfy **all four**, not any of
them.

### 4. Read what is on

Under the controls sits a row of chips: `Period: 2026-08-01 to 2026-08-15`,
`Method: Cash`, and so on. Each chip has an ✕ that removes **only that filter** and
leaves the rest.

**Clear all** returns to the unfiltered page.

On a phone the controls collapse into one **Filters (3)** button — the number tells
you how many are on without opening it.

### 5. Check the figures above the table

They describe the rows underneath. Filter Sales to cash in the first fortnight and
the count, items sold, revenue, discount, cost of goods and gross profit all narrow
with it.

Two kinds of figure deliberately do not move, and say so:

- **"You owe suppliers"** and **"Total owed to you"** are whole-shop balances.
  Narrowing to one month cannot reduce what you actually owe.
- **The opening balance** on an account statement is what the account held before
  the window, not a subtotal of matching rows.

### 6. Sort

Click a column heading. Click again to reverse it. Sorting keeps your filters and
your place.

### 7. Export

**Download CSV** gives you exactly the rows on screen — same filters, same order.

Filter to cash sales for 1–15 August, press Download, and the file has those sales.
Not the whole month, not the first hundred.

## Verification

Filter something, note the count in the pager (`Showing 1–27 of 27 sales`), then
download and count the rows in the spreadsheet. They match.

If a download would exceed 5,000 rows it stops there and adds a final line saying so.
Narrow the filter and download again.

## Sharing a view

The filters live in the address bar, so the URL **is** the view:

```
/sales?period=custom&from=2026-08-01&to=2026-08-15&method=CASH
```

Bookmark it, send it to your accountant, or press back to step out of it. Refreshing
keeps everything.

## Troubleshooting

**The table is empty but I expected rows.** Check the chips — something narrower than
you meant is probably on. Press **Clear all** and add filters back one at a time.

**A name is missing from a dropdown.** Dropdowns list what the shop actually has.
Archived customers and products are included on the filter dropdowns; if something is
genuinely absent, it has never been used in that context.

**"Negative stock" is not in the stock dropdown.** It only appears when the shop
allows negative stock or something has actually gone negative — otherwise it would be
an option that always returns nothing.

**I typed dates and nothing changed.** Press **Apply dates**. Typed boxes wait for
you to finish; dropdowns apply immediately.

**The dates in the boxes are not the ones in my URL.** The boxes show the range
actually in use. If a date could not be read it was ignored and the page fell back to
this month, and the boxes show that rather than the text you typed.

## Related

- [Filters reference](../reference/filters.md) — every parameter, per page.
- [Filtering](../explanation/filtering.md) — why the totals behave as they do.
