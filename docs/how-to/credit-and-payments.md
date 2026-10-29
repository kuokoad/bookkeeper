# How to buy and sell on credit

Record goods you take from a supplier before paying, sales a customer pays for
later, and the payments that settle both.

## The rule

**A balance is paid off oldest first.** When you record a payment, from a customer
or to a supplier, the app splits it across that person's unpaid documents, starting
with the oldest. You enter one amount and the app decides which document each cedi
goes against. The screens do not let you pick which invoice a payment settles.

## Buying on credit

### Record the delivery

1. Go to **Purchases → New purchase**.
2. Pick the **Supplier**. A new supplier has to be added under **Suppliers** first.
3. Set the **Delivery date** and, if you have it, the supplier's invoice number.
4. Add each product with its quantity and cost. Add an expiry date for goods that
   expire.
5. Under payment:
   - **Nothing paid yet:** leave **Amount paid now** at `0.00`.
   - **Part paid:** enter what you paid, and choose **Paid from** (Cash, MoMo or
     Bank).
6. Save.

The stock goes up straight away. The unpaid part is recorded as money you owe that
supplier.

### See what you owe

- **Suppliers → the supplier** shows their balance and every payment you have made
  them.
- **Accounting → Payables** ("Who you owe") lists every supplier you owe, grouped by
  how old the debt is.
- Each purchase's own page shows what has been paid on it and what is still owed.

Purchases have no due date. "Old" means old since the delivery date.

### Pay a supplier

1. Open **Suppliers → the supplier**.
2. In the pay form, enter the date, **Paid from**, and the amount. The button next to
   the amount fills in their whole balance.
3. Save.

One payment can cover any number of purchases. It is one entry on the account the
money came from, and it is split across their unpaid purchases oldest first, by
delivery date. Each purchase is paid in full before the next gets anything.

You owe GHS 300 (1 Oct), GHS 500 (10 Oct) and GHS 400 (20 Oct), and pay GHS 1,000:

| Purchase | Owed | Paid from this payment | Still owed |
|---|---|---|---|
| 1 Oct | 300 | 300 | 0 |
| 10 Oct | 500 | 500 | 0 |
| 20 Oct | 400 | 200 | 200 |

## Selling on credit

### Ring up the sale

1. Ring the sale up on **Sales → New sale** as usual.
2. Choose the **Customer**. A sale that is not fully paid needs one, and the till
   marks the field *(required)* until you do.
3. Take whatever they pay now, or nothing.
4. Press **Save on credit**.

The unpaid part is recorded as money the customer owes, due after the shop's
**Payment terms** in Settings.

A customer can have a **credit limit**. A sale that would take them over it is
refused.

### See who owes you

- **Customers → the customer** shows their balance and the payments they have made.
  Their **Statement** page lists every sale and payment, ready to print.
- **Accounting → Receivables** ("Who owes you") lists every customer who owes you,
  grouped by how overdue the debt is.
- Each sale's own page shows what has been paid on it and what is still owed.

### Receive a customer payment

1. Open **Customers → the customer**.
2. In the receive-payment form, enter the date, **Method** (the account the money
   went into), the amount and an optional reference.
3. Save.

The payment is split across their unpaid sales oldest first, by sale date, exactly as
supplier payments are. A part payment leaves the newest sale partly unpaid.

A customer owes GHS 200 (2 Oct), GHS 350 (9 Oct) and GHS 150 (15 Oct), and pays
GHS 450:

| Sale | Owed | Paid from this payment | Still owed |
|---|---|---|---|
| 2 Oct | 200 | 200 | 0 |
| 9 Oct | 350 | 250 | 100 |
| 15 Oct | 150 | 0 | 150 |

## Paying more than is owed

By default a payment larger than the balance is refused, in both directions. At a
counter that is usually a typing mistake, and refusing it catches it while the
customer is still there.

To take an advance, switch on **Allow paying more than is owed** in Settings. The
extra then stays on the account:

- **A customer** shows a balance below zero, which means they are in credit. Their
  next credit sale uses it up.
- **A supplier** is shown as an advance you have paid them.

## Correcting a payment

Payments are never edited. To fix one, **Void** it from the payment list on the
customer's or supplier's page, with a reason. The void puts back exactly what that
payment had paid on each document. Then record the correct payment.

See [Fix a mistake](fix-a-mistake.md) for how voids work in general.

## What the screens cannot do yet

- **Pay a specific invoice.** If a customer says "this is for INV-00042", or a
  supplier wants their latest invoice settled first, the app still pays oldest first.
  The payment services already accept a chosen split; the two payment forms do not
  offer one.
- **Due dates on purchases.** Supplier terms are not recorded, so Payables ages
  debts from the delivery date.
