# How to record a sale on an earlier day

Enter a sale on the day it actually happened, such as paper receipts written while
the till was down.

## The rule

**Only trusted people can date a sale, and never into the future or a closed
period.** Backdating moves a sale from one period to another while the books still
balance, so nothing downstream would notice a wrong one. The app therefore decides
who may do it and checks every backdated sale itself.

## Who can backdate

Owners, and staff whose permissions tick Sales: **Change** (Users → the staff
member). That is the same permission that lets someone change a price at the till.

Anyone else does not see the date field. Every sale they ring up is dated today.

## Record a backdated sale

1. Go to **Sales → New sale**.
2. In the **Sale date** box above **Customer**, choose the day. Days after today and
   days inside the books lock are greyed out.
3. A warning appears: *This sale will be recorded on …, not today.* Check the date.
4. Ring the sale up and take payment as usual.

The date stays set after each sale, so a pile of receipts from one day can be entered
in one sitting. The warning stays on screen the whole time. Press **Use today** to go
back to today's date.

The sale, its stock movement and its accounting entry are all dated on the chosen
day, so it shows in that day's takings and that period's reports.

## What the app refuses

| Situation | What you see |
|---|---|
| A date after today | *A sale cannot be dated in the future.* |
| A date inside the books lock | *The books are closed up to …* |
| Someone without the permission | *Only an owner or manager can record a sale on an earlier day.* |
| Not enough stock had arrived by that day | *On … there was only … in stock; the rest arrived later. Check the date.* |

The last one is about deliveries. A backdated sale only takes stock that had arrived
by its date, so it cannot sell from a delivery that came in afterwards. If the sale
is refused this way, the date is usually wrong.

**Stock that has expired since** still needs approval. A backdated sale checks expiry
as of today, not as of the chosen day, so picking an earlier date is not a way
round the right to sell expired stock.

## Things to know

- **The till always uses the server's date for today.** A till left open overnight,
  or a computer with its clock set wrong, cannot put an ordinary sale on the wrong
  day.
- **Credit sales count from the chosen day.** A credit sale dated six weeks back on
  30-day terms is already overdue on the day you enter it.
- **The audit log says so.** Each backdated sale's entry in **Users → Audit log**
  ends with *dated …*, so you can find every sale that was moved to another day.
- **Converting a quote always records today's date.** Backdating is only done on
  the till.

To undo a backdated sale entered on the wrong day, void it and enter it again. See
[Fix a mistake](fix-a-mistake.md).
