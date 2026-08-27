# Tax in Ghana

Why three taxes are stored as data rather than written into the code.

## The problem

Ghana does not charge one sales tax. It charges several at once — NHIL, GETFund and
VAT — and they are three separate obligations to three separate purposes. A single
"tax" figure cannot be filed.

Worse, the rates move. They move with the national budget, and in 2021 the COVID-19
Health Recovery Levy appeared with no warning at all. A shop running software that
hard-codes a rate charges the wrong tax from the day the budget passes until someone
ships a release. In a country where rates change on a political timetable, that is
not an edge case.

## Taxes are rows

So each component is a row in `tax_components` carrying its own name, code, rate,
basis, GL account and whether it is recoverable. The shop edits them in Settings. No
release required.

Each component posts to **its own** ledger account, so the trial balance shows what is
owed to each authority separately rather than one lump that has to be unpicked at
filing time.

`businessSettings.taxRateBp` and `taxLabel` still exist, but they are **derived** —
`syncDerivedTaxSettings` keeps them in step, and nothing prices from them. If you are
computing tax from `taxRateBp`, you have the wrong source.

## Basis: the compounding question

A component's `basis` decides what it is charged on:

- `NET` — on the net price.
- `NET_PLUS_LEVIES` — on the net price plus the levies already added.

That second one is why "is it 20% or 20.75%?" was ever a question. Charging VAT on a
base that already includes NHIL and GETFund compounds them, and the difference is
real money at the margin.

Under the **VAT Act 2025 (Act 1151)** the cascade is gone and all three components
seed with `isRecoverable: true` from 1 January 2026. The old compounding question is
settled. The basis column stays because the law that made it necessary once can make
it necessary again — which is the whole argument for this design.

## Recoverable, as it was on the day

Tax paid to a supplier is only reclaimable if it was reclaimable **at the time of the
purchase**. `isRecoverable` is snapshotted onto each `purchase_taxes` row rather than
read from today's settings, because Act 1151 was not retrospective. Reading the
current setting would reclaim levies on deliveries that never carried the right.

Non-recoverable tax is not an error and is not hidden. It went into the cost of the
goods and out again through cost of sales, so the tax return reports it. An owner who
cannot see it cannot explain their own margin.

## What a receipt remembers

Two things are snapshotted onto every sale, and for the same reason:

- **`taxInclusive`** — whether the prices on that sale already included tax. The shop
  can switch the setting next year; a receipt reprinted afterwards must still describe
  the sale that actually happened.
- **The tax lines themselves** — read back from `sale_taxes` rather than recomputed.
  A reprint after the budget moves a rate must show what the customer paid.

This is the same principle as snapshotting COGS onto a sale. A document records what
happened; it is not a view over current settings.

## Voids and the filed period

The tax return has one rule that is easy to get backwards.

A void does not delete the sale it cancels. The original keeps its positive tax rows
on its own date, and a mirror document carries the negatives on the day of the
correction. That is how VAT works: tax declared in a filed period cannot be
un-declared, only adjusted in the period where the cancellation happened.

Filter out `status = 'VOIDED'` and the original disappears while its mirror remains —
turning a cancelled sale into a negative liability in a month it had nothing to do
with. The report therefore includes both halves.

## Still worth a professional's eye

Imports may differ: the deduction at the ports is not clearly granted under Act 1151.
This is worth checking with a Ghanaian tax professional before relying on the input
tax figures for imported goods.

## Related

- [Manage tax](../how-to/manage-tax.md) — changing a rate when the budget moves.
- [Filters reference](../reference/filters.md) — the tax return's date filter.
- `tests/helpers/tax.ts` — how tests set a tax profile up.
