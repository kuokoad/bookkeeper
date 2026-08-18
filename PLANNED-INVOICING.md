# Planned: invoicing

> **Status: staged, not started.** Nothing in this document is built. It exists
> so the thinking is not lost, and so the decisions below are made deliberately
> rather than during implementation.

---

## Where things stand today

The application produces **receipts**, not invoices.

A credit sale already prints a usable document at `/sales/[id]/receipt`: shop
logo, name, address and phone, the customer's name, line items, discount, tax,
what was paid and by which method, and a **"Balance owing"** line when something
is still outstanding. For a customer who takes goods and pays later, that is a
bill in practice.

What makes it not an invoice:

| Missing | Consequence |
| --- | --- |
| Due date and payment terms | An invoice says *when*. There is no `due_date` column anywhere. |
| An "Invoice" identity and its own numbering | Every sale is `RCP-…`. Customers and accountants expect a distinct `INV-…` sequence. |
| Delivery | No email. The document is printed or shown on screen. |
| Status | No draft / sent / overdue. |
| Customer statement | You can see one customer's balance, but there is no "everything outstanding as at today" document to hand over. |

`invoiceNo` does exist in the code, but for the opposite direction: it records
the **supplier's** invoice number on a purchase. It is not related to this work.

---

## Decide before starting

These change what gets built. They are not implementation details.

**1. Do your customers actually receive a document to pay against?**
If credit is informal — a regular who settles at the end of the month, and you
mainly need to know who owes what — then most of this is not worth building, and
a **customer statement** alone would do. If they are handed a document they pay
against, the full set below is justified. *This is the question that decides the
size of the stage.*

**2. What are the default payment terms?**
Due on receipt, 7 days, 14, 30? Set per customer, or one shop-wide default with
a per-sale override?

**3. Should the receivables ageing be re-based on due date?**
See the warning below. It changes numbers you have already looked at.

**4. Where does invoice numbering start?**
A shop moving from a paper book usually wants to continue its existing sequence
rather than start at 1.

**5. Is emailing wanted at all?**
It needs an internet connection and a mail provider, which cuts against the
local-first design that makes this app work during an outage. My inclination is
to leave it out and let the owner print or share a PDF, but it is your call —
see *Deliberately out of scope*.

---

## The consequence worth understanding first

**Receivables ageing currently buckets by the age of the sale, not by how
overdue the payment is.** With 30-day terms those are different numbers, and the
second is the one you would actually chase on: a sale from 20 days ago is *not*
overdue on 30-day terms, but today it appears in the "1–30 days" bucket as
though it were.

Re-basing ageing on due date is the single change here that most improves the
day-to-day usefulness — and it will make the ageing report show **different
figures from what it shows now**. That is a correction, not a regression, but it
should be a decision rather than a surprise, and the year-end pack's debtors
listing would move with it.

---

## Scope

### In

- `due_date` and `terms_days` on a credit sale, defaulted from settings and
  overridable per sale.
- A distinct `INV-` document sequence, using the existing numbering service.
- An invoice layout: framed as a request for payment rather than a thank-you,
  showing terms, due date, and amount due. Printable, on the existing
  print-friendly foundation.
- Receivables ageing re-based on due date, with sales that have no due date
  falling back to the sale date so historical rows still behave.
- A **customer statement**: everything outstanding for one customer as at a
  date, with running balance. Printable and CSV.
- Overdue surfaced where it is useful — the customer list and the dashboard.
- The year-end pack's debtors listing follows the same basis, so the pack and
  the screen cannot disagree.

### Deliberately out of scope

- **Email delivery.** Needs internet and a mail provider; the app is built to
  work during an outage. Revisit only if the answer to decision 5 is yes.
- **Payment links / online payment.** Same reason, plus it would need a payment
  processor account.
- **Recurring invoices.** No evidence a single retail shop needs them.
- **Quotes and proforma invoices.** Different document, different workflow; not
  asked for.
- **Late-payment interest.** Real accounting consequences, and a shop that wants
  it should say so explicitly.

---

## Implementation notes

**Migration.** Adding columns to `sales` will make drizzle-kit rebuild the
table, and it has generated a broken `INSERT ... SELECT` for exactly this three
times already — it selects the new column from the old table. Patch the
generated SQL to a literal default, then **test on a full copy of the live
database** before applying, checking row counts, that the books still balance,
and `foreign_key_check`.

**Numbering.** Use `nextDocumentNumber` with a new `DOC_TYPES.INVOICE` rather
than inventing a second mechanism.

**Money.** Nothing here computes an amount that does not already exist. The
invoice shows the sale's own totals; the statement sums existing balances. No
new money maths, and none in a component.

**Ageing fallback.** `COALESCE(due_date, business_date)` so a sale recorded
before this stage still ages sensibly rather than vanishing from the report.

**Guards to keep.** The invoice document is a view of a sale, so it needs the
`sales` view permission, and the page must use `requirePageAccess`. The
structural tests will fail if it does not.

---

## Verification

- Domain tests for due-date arithmetic across month ends and leap years, in the
  same style as `domain/financial-year.ts`.
- Integration tests: ageing buckets by due date; a sale with no due date still
  appears; a statement's running balance ties to `getCustomerBalance`.
- A test asserting the statement total equals the customer's control-account
  balance, so the document cannot disagree with the ledger.
- Smoke checks: the invoice renders, shows terms and a due date, and a staff
  member without `sales` view is refused.

## Rough size

Comparable to the year-end pack stage: one migration, one new document type,
one report change, and a statement page. Larger if emailing is wanted, and
considerably smaller if the answer to decision 1 is "a statement is enough".
