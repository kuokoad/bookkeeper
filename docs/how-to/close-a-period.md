# How to close a period

Lock a month once it is filed, close a financial year, and produce the pack your
accountant asks for.

## Prerequisites

Owner. Closing and locking are owner-level acts.

## Lock the books to a date

Once you have filed a month, stop anyone from recording into it.

1. **Settings → Closing the books**.
2. Set **Books locked before** to the first day that should still be open. Locking
   before `2026-09-01` closes August and everything earlier.
3. Save.

From then on, any document dated before that date is refused — sales, purchases,
expenses, adjustments, corrections. The refusal names the lock so the person
understands what stopped them.

**Owners can override.** Staff cannot, and every override is written to the audit log.
That is the balance the lock is aiming for: an accident is blocked, a deliberate
correction by the person answerable for the books is possible and recorded.

Moving the lock date back reopens a period. Do that only if the close was premature.

## What to check before locking

Work through these. Each one is a question your accountant will ask.

1. **Trial balance** (`/accounting/trial-balance`) balances. If it does not, stop —
   nothing else is meaningful until it does.
2. **Balance sheet** balances: assets equal liabilities plus equity.
3. **Inventory** shows no red alert. Stock value must equal the Inventory account.
   If it warns, run `npm run preflight`.
4. **Receivables** and **payables** agree with their control accounts. Both pages check
   this themselves and say so if they disagree.
5. **Reconcile** each cash, MoMo and bank account against the real balance
   (`/reconciliation`).
6. **Tax return** filed for the period, if you are registered.

`/settings/health` runs the readiness checks in one place.

## Close a financial year

A year-end close is more than a lock. It moves the year's profit into equity and
starts the next year from zero on the income and expense accounts.

1. Check everything in the list above, for the whole year.
2. **Reports → Year-end pack**. Read it. This is what your accountant gets.
3. **Settings → Closing the year**, choose the financial year, and close it.

What happens: one closing entry moves every revenue and expense balance into retained
earnings. Income and expense accounts start the new year at zero; assets, liabilities
and equity carry forward. The closing is recorded in `year_end_closings` with who did
it and when.

A closed year can be **reopened** if something was wrong. The reopen is audited like
everything else.

## The accountant's pack

**Reports → Year-end pack** produces a full set for one financial year with the prior
year alongside:

- Profit & Loss
- Balance sheet
- Movement in the owner's stake
- Cash flow
- Owed by customers, and owed to suppliers, by age
- Trial balance
- The checks the app performed, each answered yes or no

Print it, or download the CSV. The checks section is deliberately part of the pack:
an accountant can see the app verified itself, and see if anything failed.

## Verification

After locking:

- Try recording a sale dated inside the locked period as a staff user. It is refused.
- The same as an owner offers an override.

After closing a year:

- **Profit & Loss** for the new year starts at zero.
- **Balance sheet** still balances.
- The owner's stake moved by the year's profit.
- The pack's checks all read yes.

## Troubleshooting

**The trial balance does not balance.** Stop. Do not close. Report it — this should
never happen and it means one of the figures is lying. Nothing else is trustworthy
until it is resolved.

**Stock value does not match the Inventory account.** Run `npm run preflight`. It
replays the whole stock ledger and names the product where the cache and the ledger
parted company.

**"The books are locked" when recording today's sale.** The lock date is in the
future. Set it to the first day that should still be open, not to today.

**I closed the year too early.** Reopen it in Settings, fix what was wrong, close it
again. Both acts are audited.

**Receivables disagree with the control account.** The report says which of the three
figures differ — the ageing total, the sum of customer balances, and the Accounts
Receivable account. All three must match.

## Related

- [Fix a mistake](fix-a-mistake.md) — corrections, and what the lock does to them.
- [Back up and restore](back-up-and-restore.md) — take one before closing a year.
- **ARCHITECTURE §13, §14** — the year-end pack and the close, in design terms.
