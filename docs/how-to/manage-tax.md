# How to manage tax

Set up Ghana's taxes, and change a rate when the budget moves one.

## Prerequisites

`settings` view permission. In practice this means an owner.

## Turn tax on

1. **Settings → Tax**.
2. Switch **Charge tax** on.
3. Decide **prices include tax**:
   - **On** — your shelf prices already contain the tax. The app splits each sale into
     revenue and tax owed.
   - **Off** — tax is added on top at the till.

   This is a fact about how you price your shelves, not about the tax itself. It is
   snapshotted onto every sale, so changing it next year cannot alter a receipt
   already issued.

## Add a tax component

Ghana charges several taxes on one sale — NHIL, GETFund, VAT — and they are separate
obligations. Each gets its own row.

In **Settings → Tax**, add one per tax:

| Field | Meaning |
|---|---|
| **Name** | What appears on the receipt, e.g. `VAT` |
| **Code** | Short identifier, e.g. `VAT` |
| **Rate** | The percentage |
| **Charged on** | `Net` or `Net plus levies` — see below |
| **Held in** | The ledger account this tax accumulates in |
| **Order** | Position on the receipt |
| **Reclaimable on purchases** | Whether you can set tax paid to suppliers against tax collected |

**Charged on** is the one to get right. `Net` charges on the price before any other
tax. `Net plus levies` charges on the price *plus* the levies already added, which
compounds them. That difference is why "is it 20% or 20.75%?" was ever a question.

Under the VAT Act 2025 (Act 1151), from 1 January 2026 the cascade is gone and all
three are reclaimable. If you are setting up fresh, the seed already reflects this.

## When the budget changes a rate

This is the case the whole design exists for. You do not need a software release.

1. **Settings → Tax**.
2. Edit the component. Change the rate.
3. Save.

Sales from that moment charge the new rate. **Sales already recorded keep the rate
they charged** — the tax lines are stored on each sale and read back for a reprint,
not recomputed. A receipt reprinted after a budget still shows what the customer
actually paid.

## When a new levy appears

The COVID-19 Health Recovery Levy arrived in 2021 with no notice. If that happens
again:

1. Add a component with its name, code and rate.
2. Choose the ledger account it accumulates in — a new one if the authority is
   separate, so what you owe each is visible on its own.
3. Set **Charged on** according to the legislation.
4. Save. The till charges it on the next sale.

## Retire a levy

Do not delete it — deactivate it. Sales that charged it must keep their tax lines, and
a deleted component would orphan them. Deactivating stops it applying to new sales
and leaves history intact.

## File a return

**Reports → Tax return**, then set the period.

You get, per component:

- **Output tax** — what you charged customers.
- **Input tax** — what you paid suppliers, split into reclaimable and not.
- **What is owed** — output less reclaimable input.

Each component is reported separately, because a single "tax" figure cannot be filed.
Download the CSV for your records.

Two things worth understanding about the figures:

- **Voided sales appear on both sides.** The original keeps its tax on its own date; a
  mirror carries the negatives on the day of the correction. Tax declared in a filed
  period cannot be un-declared, only adjusted where the cancellation happened.
- **Input tax counts only if it was reclaimable on the day.** Act 1151 was not
  retrospective, so a delivery from before it does not become reclaimable now.

## Verification

After a rate change:

1. Record a test sale on the till and check the receipt shows the new rate.
2. Open a sale from before the change — it still shows the old one.
3. **Reports → Tax return** for the current period lists every active component.
4. **Trial balance** still balances.

## Troubleshooting

**Tax fields are on the settings form but tax is off.** That is intentional. They stay
in the form so saving submits them; a control nobody can see submits nothing and
saving would fail on a field you cannot find.

**The rate on a report is not what I set.** Check the period. Sales keep the rate they
charged, so a period spanning a change shows both.

**Two components look like they are compounding unexpectedly.** Check **Charged on**.
`Net plus levies` on the second component charges it on top of the first.

**The trial balance shows tax I do not recognise.** Each component posts to its own
account. Open **Accounting → Chart of accounts** to see which is which.

## Related

- [Tax in Ghana](../explanation/tax-in-ghana.md) — why this is data, not code.
- [Close a period](close-a-period.md) — locking a period once filed.
