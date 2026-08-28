# Your first hour

Set your shop up, put something on the shelf, sell it, and see what it earned. About
twenty minutes, and by the end you will have a real sale in real books.

This is for the person running the shop. If you are setting the app up on a machine,
start with [Developer setup](developer-setup.md) instead.

## What you'll need

- The app open in a browser
- Your shop's name
- One product you sell, its cost and its price

## Step 1: Create your shop

The first time the app opens it shows a setup screen. It asks five things:

- **Business name** — what appears on receipts
- **What kind of shop it is** — see below
- **Your name**
- **Username and password** — this is the owner account

Fill it in and continue. That screen closes permanently once an owner exists, so
nobody can create a second owner behind your back later.

### What kind of shop is it?

Three answers, and the only thing they change is what you are offered:

- **General retail** — a provisions shop, a mini-mart, a chemical shop. Every
  feature switched on. This is the app as it has always been, and the answer to
  give if you are unsure.
- **Building materials** — cement, pipes, roofing, hardware. Nothing on those
  shelves carries a date, so expiry dates and batches are put away.
- **Something else** — shows everything.

You can change it later in **Settings**, and change any individual feature back
on or off underneath it. What it never does is change a figure: switching type
puts menu entries away and brings them back, and every total on every report
reads exactly the same before and after. Nothing you have recorded is removed,
hidden from a report, or made unreachable — a screen that has been put away
still opens from a link or from search.

You are now signed in, looking at the dashboard. It is empty. That is correct.

## Step 2: Add something you sell

**Products → Add product.**

Fill in the name, what it costs you, and what you sell it for. A soft drink, a bag of
rice — anything real.

Save. The product exists, with **no stock**. That is deliberate and it is the most
important idea in the app: you cannot type a stock figure in. Every unit on the shelf
has to arrive through a recorded event.

## Step 3: Put stock on the shelf

**Inventory → New adjustment.**

- **Reason:** `Opening stock`
- Add your product, direction **In**, the quantity you have, and what it cost you in
  total.

Save.

Go back to **Products**. Your product now shows a quantity and a stock value. That
figure did not come from a form field — it came from a movement you recorded, and
you can click **History** to see it.

**That is the working result.** You have stock, and you can prove where it came from.

## Step 4: Sell something

**Sales → New sale.**

Type the product name or scan its barcode. Set a quantity. Choose how the customer
paid — cash, mobile money, bank. Complete the sale.

You get a receipt. Print it or move on.

## Step 5: See what it earned

Back on **Sales**, your sale is in the list with four figures across the top:

- **Sales** — how many
- **Items sold**
- **Revenue** — what came in
- **Cost of goods** — what those goods cost you
- **Gross profit** — the difference

The profit is real. It uses what the goods **actually cost when you sold them**, taken
from the stock movement in step 3 — not today's cost price. Change your cost price
tomorrow and this sale's profit does not move.

Check **Products** again: the quantity has gone down by what you sold.

## Step 6: Follow the money

Two places worth looking, because they are the difference between a till and a set of
books.

**Accounts.** Your cash (or MoMo) account went up by the sale. Click into it: every
line that moved money, with the balance after each one, and an opening and closing
balance that add up.

**Accounting → Trial balance.** Every account, debits and credits, and they balance.
Your one sale wrote a complete double-entry record: money in, revenue recorded, stock
out, cost recognised.

You did not do any of that. Ringing up the sale did.

## What you built

A shop with stock you can account for, a sale you can trace, and books that balance.

Everything else in the app is more of this:

- **Sell on credit** — add a customer, choose them on a sale, and pay it off later. See
  what is owed on **Customers**.
- **Record what you spend** — **Expenses**. Your profit is not real until your costs
  are in.
- **Buy stock properly** — **Purchases** records a delivery, adds the stock at what
  you actually paid, and tracks what you owe the supplier.
- **See how you are doing** — **Reports → Profit & Loss**.

Two things worth knowing early:

- **Nothing is ever deleted.** A mistake is corrected by a reversing document. See
  [Fix a mistake](../how-to/fix-a-mistake.md).
- **Back up.** The whole business is one file. See
  [Back up and restore](../how-to/back-up-and-restore.md). Do this today, not later.

## Making it easy on the eyes

Two separate controls, and they work together rather than against each other.

**Brightness** is the small switch at the top of every screen. Light or dark, and it
belongs to the device you are holding: the counter computer in a bright shop and your
phone at midnight want different answers, and the same person uses both. Anyone signed
in can change it, on their own screen, without affecting anybody else's.

**The look** is **Settings → Look**, and it belongs to the shop. Two choices:

- **Standard** — crisp and neutral, with a dark menu.
- **Ledger** — warm and paper-like, the feel of the book this replaced.

Whichever you pick applies to every screen the shop signs in on, so the counter, the
back office and your phone all agree. Only an owner can change it, and the change is
recorded in the audit log like any other setting.

Both looks show exactly the same figures. This is paint: it cannot alter a total, a
balance or a report, and switching back and forth is safe at any time.

## Troubleshooting

**I cannot type a stock number on the product form.** Correct — there is no such
field. Stock only changes through a purchase, a sale or a recorded adjustment. That is
what lets any figure be traced back to its cause.

**My sale would take stock below zero.** By default the app refuses. If you genuinely
sell before recording deliveries, an owner can allow it in **Settings**, but the
figures will show negative stock until the delivery is entered.

**The profit looks wrong.** It is revenue less what the goods cost when they left, not
less today's cost price. If you entered opening stock at the wrong total cost, correct
it with another adjustment rather than editing anything.

**I made a mistake in setup.** Shop name and most settings are editable in
**Settings**. The owner account is not removable — that is the point of it.

**The shop looks different on my phone than on the counter computer.** Check which of
the two controls differs. The **look** is shop-wide, so it is the same everywhere; the
**brightness** switch is per device, so one screen can be dark while another is light.
That is deliberate, not a fault.

**A staff member wants a different look and cannot change it.** They cannot: the look
is a shop-wide setting and **Settings** is owner-only. They can still switch their own
screen between light and dark, which is the control that usually matters at a till in
daylight.

## Related

- [Find anything](../how-to/find-anything.md) — once you have more than a few sales.
- [Manage tax](../how-to/manage-tax.md) — if you are VAT registered.
- [`README.md`](../../README.md) — the fuller shop owner's guide.
