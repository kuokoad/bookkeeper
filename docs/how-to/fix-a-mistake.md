# How to fix a mistake

Undo a wrong sale, take goods back, or correct a stock count — without deleting
anything.

## The rule

**Nothing in this app is ever edited or deleted.** A mistake is corrected by
appending a document that reverses it, dated on the day you make the correction.

That is not bureaucracy. It is what makes every figure traceable to an event, and it
is why a filed tax period cannot silently change under you six weeks later. The
original stands; the correction stands beside it; the pair nets to nothing.

So there is no Delete button anywhere, and you should not go looking for one.

## Which correction do you want?

| What happened | What to do | Where |
|---|---|---|
| You rang up a sale that never happened | **Void** it | the sale's own page |
| The customer brought goods back | **Return** | the sale's own page |
| You recorded an expense twice | **Void** it | the row on Expenses |
| A payment was recorded against the wrong customer | **Void** the payment | the payment row |
| The shelf count does not match the app | **Stock adjustment** | Inventory → New adjustment |
| Goods were damaged, lost or expired | **Stock adjustment** | Inventory → New adjustment |

**Void** and **return** are different things and the app keeps them apart on purpose.
A return is a real business event: the customer brought goods back and the shop took
them. A void is a correction of a data-entry error. Reports separate them so genuine
returns do not look like mistakes.

## Voiding a sale

1. Open the sale from `/sales`.
2. Press **Void**.
3. Type a reason. This is required — "Rang it up twice", "Wrong customer". It is
   written to the audit log and shown on the reversal.
4. Confirm.

What happens: a mirror document is written, dated today, with every figure negated.
Stock goes back to the exact batches it came from — not to whichever batch happens to
be oldest, or the expiry dates on your shelf become fiction. The journal entry is
reversed. The original keeps its receipt number and stays visible, marked **Voided**.

Both halves appear on Sales. Use the **Voided** quick filter to see corrections, or
filter to `Posted` to hide them.

## Returning goods

1. Open the sale.
2. Press **Return**.
3. Choose the lines and quantities coming back. You cannot return more than was sold,
   across all returns on that sale.
4. Confirm.

Stock goes back into the batches it left from, at the cost it left at. A return
carries its own document kind, so the sales report can separate it from a void.

## Stock adjustments

Use these when the shelf and the app disagree, for a reason that is not a sale or a
delivery.

1. Go to **Inventory → New adjustment**.
2. Pick a reason:

   | Reason | Use for |
   |---|---|
   | `OPENING_STOCK` | entering what you already had when you started using the app |
   | `COUNT_CORRECTION` | a physical count that disagrees with the app |
   | `DAMAGED` | breakages |
   | `LOST` | theft or shrinkage |
   | `EXPIRED` | goods past their date, taken off the shelf |
   | `FOUND` | stock that turned up |
   | `INTERNAL_USE` | goods the shop consumed itself |
   | `OTHER` | anything else, with a note |

3. Add each product, the direction (in or out), and the quantity.
4. Confirm.

Every adjustment writes to the stock ledger and posts to the accounts, so stock value
and the Inventory account stay equal. The reason is recorded — a shop that writes off
a lot of `DAMAGED` stock should be able to see that it does.

Opening stock is a normal adjustment rather than a special import. That is deliberate:
it means the very first figure in the app traces back to a recorded event like every
figure after it.

## When the books are locked

If the period is closed, a correction dated inside it is refused. That is the lock
doing its job.

Options, in order of preference:

1. **Date the correction today.** Usually right — the correction happened today.
2. **Ask an owner.** Owners can override the lock; staff cannot. The override is
   audited.
3. **Unlock the period**, in Settings, if the close was premature.

## Verification

After any correction:

- **Trial balance** (`/accounting/trial-balance`) still balances.
- The **Inventory** page shows no red alert about stock disagreeing with the ledger.
- The original document is still there, marked as voided or returned against.

If the Inventory page does warn, run `npm run preflight` — it replays the whole ledger
and names the product where the cache and the ledger parted company.

## Troubleshooting

**"Give a reason for voiding this sale."** The reason is required. A correction with
no explanation is not much use to whoever reads the books later.

**I cannot void — the button is missing.** Voiding needs the `void` action on that
module. Staff often have `create` but not `void`.

**Voiding is refused because the period is locked.** See above.

**I want to change one line on a sale.** You cannot. Void it and ring it up correctly.
The pair tells the truth about what happened; an edited receipt would not.

## Related

- [Close a period](close-a-period.md) — the lock that refuses back-dated corrections.
- [Inventory costing](../explanation/inventory-costing.md) — what a reversal does to
  stock value.
- **ARCHITECTURE §4** — how reversal entries are posted.
