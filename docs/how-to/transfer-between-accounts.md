# How to move money between accounts

Record cash taken to the bank, MoMo drawn into the till, or any other money moved
between the shop's own accounts.

## The rule

**A transfer changes where the money is, never how much there is.** It is not income,
not an expense and not owner money. The total the shop holds is the same afterwards,
and profit, owner's capital and drawings are not touched.

Do not record banking as an owner taking money out and putting it back in. The
balances come out right that way, but the deposit lands on the owner's capital and
drawings lines.

## Record a transfer

1. Go to **Accounts** and press **Move money between accounts**. It appears once the
   shop has at least two active accounts.
2. Set the **Date** the money actually moved. Days inside the books lock are greyed
   out.
3. Choose **From** and **To**. The form starts on your default account (usually Cash)
   into the first bank account.
4. Enter the **Amount**.
5. Optionally add a **Reference**, such as the deposit slip number, and a **Note**.
6. Press **Record transfer**.

The form confirms with the transfer's number, for example `TRF-00001`, and both
balances update at once.

The app refuses the same account on both sides, an amount of zero, an archived
account, and a date inside the books lock. It does not stop you moving more than the
From account holds; the Accounts page warns about any balance below zero.

## See your transfers

- **Accounts → Transfers** lists every transfer, newest first, with its reference
  and note.
- Each account's statement shows the transfer as **Transfer**: money out of one
  account, money in to the other.
- **Accounting → Journal** can be filtered to **Transfers**.

On the **Cash flow** report, transfers are left out of the whole-shop figures,
because no money came into or left the business. Pick a single account and its
transfers show as money arriving or leaving that account.

## Correct a transfer

Transfers are never edited. To fix a wrong amount or account:

1. Open **Accounts → Transfers**.
2. Press **Void** on the row and type a reason.
3. Record the transfer again with the right details.

The void posts a reversal dated today and keeps the original, marked **Voided** with
your reason. Both balances go back to where they were. This works even when the
transfer's own date is inside a closed period.

## Who can do it

| Action | Permission (Users → staff member) |
|---|---|
| See transfers | Accounts: **See** |
| Record a transfer | Accounts: **Add** |
| Void a transfer | Accounts: **Void** |

Owners can always do all three.
