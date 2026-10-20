# TODOS

## CI

### The end-to-end smoke test has been red on main since 31 August

**What:** Find out why 16 checks in CI's "End-to-end against a running server" smoke job fail, and fix the script or the app so the job is green again.

**Why:** A smoke test that is always red cannot catch the regression it exists for. Every `verify` run on main since 2026-08-31 has concluded failure, so a real break would look like business as usual.

**Context:** Found while shipping the-screen-agrees-with-the-books (2026-10-20). Run 39516297909 (branch, 99ee459) and run 39407460849 (main, bc7f6bc) fail the identical 16 checks. Failing: books balanced, where the figures come from, dashboard money cards, chosen period, product search, seeded products, fractional kg quantity, seeded categories, customers, suppliers, expenses, other income, no negative account, supplier owed, purchase form lists suppliers, and filtering ("all NaN, filtered NaN"). Neighbouring checks on the same pages pass (stock quantities, low stock, seeded shortage, both demo accounts, phone sign-out), so suspect the script's text matchers drifted when UI work changed those pages, not the pages themselves. The script prints no failure reason; make it print what it looked for and what it saw first. The "Typecheck, lint, migrations, tests" job is green on Node 22 and 24.

**Effort:** M
**Priority:** P0
**Depends on:** None

## Purchases

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

### Tie the "Line total" caption to its figure for screen readers

**What:** Give each purchase line's total a programmatic label, e.g. `<output aria-label="Line total">` or a `dl`/`dt`/`dd` pair, instead of two sibling spans.

**Why:** A screen reader reads the caption and the amount as unrelated text.

**Context:** `src/app/(app)/purchases/new/purchase-entry.tsx`, the "Line total" block (around line 397). Raised by the adversarial review on 2026-10-20 and deliberately skipped then. `tests/ui/purchase-entry.test.tsx` reads the figure via `getByText('Line total').parentElement`; switch it to `getByRole('status', { name: 'Line total' })` or similar when this changes.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Completed
