# TODOS

## Purchases

### Let the server record a delivery of nothing but free goods

**What:** Make `createPurchase` save a purchase that comes to 0.00 (free samples alone, or every line discounted to nothing): the stock comes in at no cost and no journal entry is posted, and voiding it still works.

**Why:** The owner decided on 2026-10-21 that free goods are real. Today a delivery of only free goods cannot be recorded at all: it posts no journal lines and `postJournalEntry` refuses an entry with none. The new-purchase form now says so before Save, and free goods have to ride on a purchase that is worth something.

**Context:** `src/services/purchase.service.ts` builds the journal lines (around line 340-405) and calls `postJournalEntry`; `assertBalanced` in `src/domain/accounting/journal.ts` refuses an empty entry. `voidPurchase` reverses `journalEntryId`, so a purchase with none needs a path there too. When this lands, drop the zero-total refusal in `src/app/(app)/purchases/new/read-purchase.ts` and flip the "free goods alone" and "whole purchase discounted" rows in `tests/app/purchase-form-parity.test.ts`. Found by the pre-merge review of the purchase-form validation PR.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Compute a purchase's figures in domain/ once

**What:** Move the purchase arithmetic (line total = cost x qty - discount, discount no more than the line, subtotal, invoice discount no more than the subtotal, tax on the net, paid no more than the total) into a pure `domain/` function that both `createPurchase` and the new-purchase form call.

**Why:** ARCHITECTURE section 2: "a financial calculation appears in domain/ exactly once. UI components never compute money." `read-purchase.ts` mirrors `createPurchase` step by step so the screen can agree with Save. `tests/app/purchase-form-parity.test.ts` holds the two together for now, but a new server rule still has to be added in two places.

**Context:** `src/services/purchase.service.ts` (line arithmetic around lines 135-195), `src/services/units.service.ts` `resolveLineUnit`, `src/app/(app)/purchases/new/read-purchase.ts`. The form needs a refusal per field, not one thrown error, so the shared function should return refusals rather than throw on the first.

**Effort:** M
**Priority:** P2
**Depends on:** None

### The purchase total and books lock can change between page load and Save

**What:** Send the total the screen showed in the basket and have the server refuse a purchase whose own total differs, or show the stored total in the success message.

**Why:** The form prices tax with the components read when the page loaded; `createPurchase` reads them again at Save. If the owner changes a rate while a clerk has the form open, the button shows one total and the books store another, and an "All" payment leaves the difference owed to the supplier unseen.

**Context:** `src/app/(app)/purchases/new/page.tsx` passes `getTaxProfile(db).components`; `src/services/purchase.service.ts` calls `getTaxProfile(tx)`. The POS (`src/app/(app)/sales/new/pos.tsx`) has the same gap, so fix both the same way. The books-lock date is read once at page load too: moved back while the form is open, the screen refuses dates the server would accept until a reload (the other way round, the server refuses and says so).

**Effort:** S
**Priority:** P3
**Depends on:** None

### The purchase action drops a negative payment without a word

**What:** Make `createPurchaseAction` refuse a tender of less than zero instead of skipping it.

**Why:** `purchase.actions.ts` skips any amount of zero or less, so a negative payment from a forged or older client saves the purchase as owed in full. The form now refuses a negative payment itself; the server should not be the more forgiving side.

**Context:** `src/actions/purchase.actions.ts`, the tenders loop (`if (amount <= 0) continue;`). Keep skipping exactly zero, which is what an empty "Amount paid now" sends. `tests/app/purchase-form-parity.test.ts` notes this difference in its header; update it.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Required-field messages appear before the person reaches the field

**What:** Show "Enter a quantity." and "Choose a product." only once the field has been left, or the rest of the line is filled, while keeping Save disabled throughout.

**Why:** Choosing a product on a fresh line at once shows "Enter a quantity." under the box the person was about to fill. Messages that arrive before a mistake teach people to ignore them, and the real refusals (2,50, 1.5 Pcs, a discount bigger than the line) look like the same noise.

**Context:** `src/app/(app)/purchases/new/read-purchase.ts` `readLine` treats any line with something in it as finished. Raised by the design review of the purchase-form validation PR.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Tie the "Line total" caption to its figure for screen readers

**What:** Give each purchase line's total a programmatic label, e.g. `<output aria-label="Line total">` or a `dl`/`dt`/`dd` pair, instead of two sibling spans. While there: announce field messages as they appear (render each `FieldError` all the time with `aria-live="polite"`), and say what a "—" means ("not worked out"), since elsewhere in the app a dash in a money column means nil.

**Why:** A screen reader reads the caption and the amount as unrelated text, hears nothing when a box turns invalid until it lands on that box, and reads a missing total as either nothing or "em dash".

**Context:** `src/app/(app)/purchases/new/purchase-entry.tsx`, the "Line total" block (around line 453) and `FieldError`. Raised by the adversarial review on 2026-10-20 and deliberately skipped then; the live-message and dash points came from the design review of the validation PR. `tests/ui/purchase-entry.test.tsx` reads figures via `getByText(...).parentElement` and `nextElementSibling`; switch to `getByRole('status', { name: 'Line total' })` or similar when this changes.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Forms

### Invalid fields never turn red, anywhere in the app

**What:** Move the unlayered `* { border-color: var(--border); }` in `src/app/globals.css` into `@layer base`, then check every screen, since border colour classes that never applied will start to.

**Why:** Unlayered CSS beats Tailwind's utilities, so `border-danger` on an invalid input never shows. The message under the field does, but the red box that should catch the eye is missing on every form.

**Context:** Found in the browser check of the purchase-form validation PR on 2026-10-21 (computed border grey despite the class). `TextInput` in `src/components/ui/field.tsx` adds `border-danger` when `invalid`. `border-line-strong` inputs will get darker borders once utilities win.

**Effort:** S
**Priority:** P2
**Depends on:** None

### A half-typed date keeps the old one without saying so

**What:** Make `DateField` show that the date in its boxes is not the date that will be saved, while a date is part-typed or impossible (31/09).

**Why:** `DateField` commits only a complete, valid date, so a part-edited delivery or expiry date leaves the boxes showing one date while the previous one is saved. A part-typed expiry date saves as no date at all.

**Context:** `src/components/ui/date-field.tsx`, `assemble` (around line 138). Affects every date field in the app. Found by the reviews of the purchase-form validation PR.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Completed

### The end-to-end smoke test has been red on main since 31 August

**What:** Find out why 16 checks in CI's "End-to-end against a running server" smoke job fail, and fix the script or the app so the job is green again.

**Why:** A smoke test that is always red cannot catch the regression it exists for. Every `verify` run on main since 2026-08-31 has concluded failure, so a real break would look like business as usual.

**Context:** Found while shipping the-screen-agrees-with-the-books (2026-10-20). Run 39516297909 (branch, 99ee459) and run 39407460849 (main, bc7f6bc) fail the identical 16 checks. Failing: books balanced, where the figures come from, dashboard money cards, chosen period, product search, seeded products, fractional kg quantity, seeded categories, customers, suppliers, expenses, other income, no negative account, supplier owed, purchase form lists suppliers, and filtering ("all NaN, filtered NaN"). Neighbouring checks on the same pages pass (stock quantities, low stock, seeded shortage, both demo accounts, phone sign-out), so suspect the script's text matchers drifted when UI work changed those pages, not the pages themselves. The script prints no failure reason; make it print what it looked for and what it saw first. The "Typecheck, lint, migrations, tests" job is green on Node 22 and 24.

**Effort:** M
**Priority:** P0
**Depends on:** None
**Completed:** 2026-10-21, branch claude/fix-e2e-smoke. Three causes, not one. (1) Matcher drift from dc742f9, which replaced the provisions demo with a building-materials yard on 31 August: product, category, customer, supplier, expense and income names. (2) Matcher drift from the dashboard redesign and the Stat card icon: Books Check wording, card titles, the 7d/30d/90d picker, and the audit count regex (the NaN). (3) A real figure: the demo seed left the Bank Account at GHS -7,288, overdrawn for ten weeks, because the owner float was dated after the deliveries it paid for. Seed fixed, test added in tests/db/demo-seed.test.ts. The script now prints what it looked for and what the page showed.

### One validation pass for the new-purchase form, so the screen agrees with what Save stores

**What:** Make the purchase form flag, and refuse to Save, every entry the server refuses or would store wrongly. Make the line figures, Subtotal, Total, Paid and the Save button agree with each other.

**Why:** A plausible wrong figure is the failure this app ranks worst. One of these reaches the books today: a cleared cost box saves stock at zero cost. The rest show confident totals for a purchase the server will refuse.

**Context:** `src/app/(app)/purchases/new/purchase-entry.tsx`. Found by the adversarial reviews on 2026-10-20, branch the-screen-agrees-with-the-books, where the line itself got "—" for unreadable input and a red flag on an oversized discount. In priority order:
1. **Zero cost reaches the books.** `toMinor('')` returns 0 (around line 61) and the basket sends `unitCost: '0'` (around line 206). `purchase.service.ts:141` only rejects below zero. Choosing an alternate unit has the same effect: `UnitPicker`'s onChange (around line 356) pre-fills `fmt(product.altCostPrice ?? 0)`, a typed-looking 0.00, and overwrites any cost already typed. Decide whether a zero cost is ever legitimate (free samples?) before blocking it, and flag a zero cost from either path.
2. **An oversized line discount is red, but the totals ignore it.** `discountTooBig` (around line 300) only colours the field. The totals loop (around lines 166-176) still adds `gross - discount`, and `canSubmit` (around line 195) leaves Save enabled with a total the server refuses (`purchase.service.ts:148`).
3. **A line figure the totals never include.** Every row computes a "Line total", but the totals loop and the basket (around lines 167 and 193) silently skip rows with no product or an empty qty. A row with qty and cost but no product shows, say, 50.00 that Save drops, and an empty-qty row with a discount shows "-5.00". Flag a skipped row instead of figuring it.
4. **A zero qty reads as a confident 0.00.** The server refuses it (`parsePositiveQty`, `purchase.service.ts:138`), and with a discount the red flag lands on the wrong field.
5. **Totals show 0.00 while a line cannot be read.** An unreadable row sets `invalid` and is skipped, so Subtotal and Total read 0.00.
6. **A bad invoice discount or paid amount counts as 0.** Around lines 179-180, an unreadable value becomes 0 and an oversized discount clamps Total to 0, with no warning (server refuses at `purchase.service.ts:159`).
7. **Commas mean different things to the client and the server.** The client's `toMinor` and `toMilli` strip every comma, so "2,50" shows 250.00. The server's `MONEY_INPUT` and `QTY_INPUT` only accept proper thousands grouping.
8. **An invalid field points at an error that isn't there.** It sets `aria-describedby="<id>-error"` (`src/components/ui/field.tsx:50`), but no such element exists on a purchase line, so the red field never says why.

Prefer reusing the server's parsers (`src/domain/` `parseMoney`, `parseQty`) on the client over keeping a second hand-rolled pair. Add tests beside `tests/ui/purchase-entry.test.tsx`.

**Effort:** M
**Priority:** P1
**Depends on:** None
**Completed:** 2026-10-21, branch the-purchase-form-agrees-with-save. One reading of the form (`read-purchase.ts`, on the server's `parseMoney`, `parsePositiveQty`, unit checks and `taxOnNet`) now drives every line figure, the totals and Save. All eight are fixed. A cost is never pre-filled as 0.00, an empty cost box blocks Save, and a 0 typed on purpose is allowed and labelled as free goods (the owner's decision, 2026-10-21: samples and bonus goods are real). Found on the way and fixed with them: the form left out the tax the server adds on top, so its Total was short and it refused payment of the full amount; and a quantity finer than its unit allows (1.5 Pcs) was only refused after Save. The pre-merge review (2026-10-22) added: a purchase that comes to 0.00 is refused on screen as the server refuses it, the books-lock date and the invoice-number and reference lengths are checked before Save, a typed cost kept across a change of unit is flagged, and `tests/app/purchase-form-parity.test.ts` runs the same entries through the form's reading and `createPurchase`.
