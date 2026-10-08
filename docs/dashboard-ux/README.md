# NunaBooks dashboard UX completion report

Date: 8 October 2026

## Delivered behavior

The dashboard now separates its header and permission-aware quick actions, primary financial figures, Needs Attention, trends, inventory/account summaries, and Books Check/reconciliation. It reuses the existing color, font, surface, border, radius and shadow tokens; both existing themes and looks remain available. No runtime dependencies, database migrations, posting rules, chart-of-accounts changes or inventory valuation changes were introduced.

- Cash & Bank Balance identifies cash, bank, mobile money and other active payment accounts. It remains the original current ledger figure over all recorded dates. Gross cash movements remain a separate six-calendar-month chart and explicitly include internal transfers.
- Net Profit uses `getProfitAndLoss(db, profitPeriod)` directly. Its link opens P&L for exactly the same inclusive month-to-date period. The definition includes all ledger expenses, shrinkage and cash differences.
- Sales and expenses keep independent query parameters. Updating either preserves the other. Exact inclusive date boundaries appear on every period-dependent card. The existing business-date helper and pure calendar arithmetic determine dates; there is no new browser-timezone conversion.
- Every invoice ageing bucket is read from the existing service. Overdue includes 1–30, 31–60, 61–90 and over-90-day buckets. Current means not yet due or due today. Credits retain their signs.
- Where the net customer ledger includes amounts outside the invoice ageing service (unallocated advances, opening balances or future-dated transactions), the dashboard explicitly displays the difference. It never assigns an invented due date or silently calls the difference not yet due. Overdue + current + outside invoice ageing equals the ledger total.
- Needs Attention uses actual account balances, invoice ageing, stock counts, integrity checks and recorded reconciliation results. A negative ledger balance is explicitly distinguished from a confirmed reconciliation discrepancy.
- Reconciliation differences are evaluated per account, so opposite signs on different accounts cannot cancel the alerts. Never-counted accounts say reconciliation has not been verified.
- Books Check displays gross debit/credit totals, their difference, individual entry balancing, customer/supplier control-account checks and source-reference checks. Its copy explains why balanced totals alone cannot establish accounting correctness.
- Server reads remain permission-gated. Supplier reads now require supplier view permission independently of customer view permission. Quick actions require their module's create permission, which also requires view permission. Existing destination page and mutation guards remain in place.
- Loading shows placeholders rather than financial zeros. Read failures propagate to a dashboard-specific error boundary with the installed Next.js `retry()` callback. The dashboard layout authenticates before its loading boundary streams.
- Single-transaction trends now plot that transaction rather than showing the old chart's misleading empty state. Confirmed no-transaction days are added only after the complete period query succeeds.

## Modified and added files

| File | Change |
| --- | --- |
| `src/app/(app)/dashboard/page.tsx` | Dashboard hierarchy, authoritative P&L, dates, alerts, permissions and action links |
| `src/app/(app)/dashboard/layout.tsx` | Authentication before streaming |
| `src/app/(app)/dashboard/loading.tsx` | Responsive financial loading skeleton |
| `src/app/(app)/dashboard/error.tsx` | Honest unavailable-data state and retry |
| `src/components/dashboard/card.tsx` | Reusable token-based card and financial figure |
| `src/lib/dashboard.ts` | Tested calendar windows, preserved filter links, chart series, ageing summary, integrity and reconciliation classification |
| `src/services/cashbook.service.ts` | Read-only daily expense aggregate with existing posted-status and inclusive-date semantics |
| `src/app/(app)/expenses/page.tsx` | Anchor for the existing expense entry form |
| `tests/lib/dashboard.test.ts` | Six classification/date/trend regression tests |
| `tests/services/dashboard.test.tsx` | Thirteen real-database and rendered-dashboard financial/access/read-only tests |
| `tests/lib/clock-format.test.ts` | Existing header regression updated for the approved business-reporting-date header; shared clock behavior tests retained |
| `docs/dashboard-ux/README.md` | This report |
| `docs/dashboard-ux/*.jpg` | Original, improved responsive/theme views and P&L evidence |

Existing modifications in DEPLOYMENT.md, docs/tutorials/first-hour.md and other pre-existing untracked work were not included in this change.

## Financial reconciliation evidence

| Check | Result |
| --- | --- |
| Dashboard/P&L with sale, expense, shrinkage and cash shortage in a disposable database | Both GHS 37.00: GHS 50.00 gross profit − GHS 2.00 expense − GHS 10.00 shrinkage − GHS 1.00 cash shortage |
| Ageing boundaries: future, due today, 1, 30, 31, 60, 61, 90 and 91 days overdue | Exactly one bucket per invoice; GHS 70.00 overdue + GHS 20.00 current = GHS 90.00 ledger balance |
| Unallocated customer advance in disposable database | GHS -5.00 explicitly outside invoice ageing; no invented due date |
| Opposing unresolved differences on cash/mobile money | Both GHS 1.00 and GHS -1.00 shown separately |
| Daily expense query | Sum agrees with expense total, includes both date boundaries, excludes voided transactions |
| Dashboard reads | Journal lines and stock ledger snapshots unchanged |
| Live local demo, 1–8 October 2026 | Dashboard and exact-period P&L both GHS 0.00 |
| Live local demo receivables | GHS 30,558.00 overdue + GHS 0.00 current = GHS 30,558.00 ledger; original dashboard wrongly showed only GHS 3,080.00 over 30 days |
| Original/improved demo balances | Cash GHS 15,799.50, stock GHS 218,533.32, supplier balance GHS 59,590.00 retained |

All test transactions above were created in disposable test databases. Browser verification did not create, edit or void any financial transactions in the running app.

## Validation

- Baseline: 172 tests passed across app guards/design checks, financial reports, receivables ageing and reconciliation.
- Focused final regressions: 31 passed (dashboard helpers, rendered dashboard with real database, page guards).
- `npm run typecheck`: passed.
- `npm run build`: passed on final source, including build TypeScript checking.
- `npm run lint`: passed with 13 warnings in existing untracked `brag-output/work` scripts. Targeted lint of every modified source/test file passed with zero warnings.
- `git diff --check`: passed.
- Full suite: `npm run test -- --maxWorkers=2 --reporter=dot` passed all 1,573 tests across 101 suites, with no unhandled errors.

### Earlier failures and unchanged warnings

No assertion failures were found in the baseline subset. The first sandboxed test attempt could not start workers because of EPERM filesystem restrictions; rerunning outside the sandbox passed.

The first broad post-change run found one test requiring the former dashboard clock. That regression was updated to validate the approved business-reporting-date header while preserving the clock's own tests. The same concurrent broad run reported a Vitest worker RPC timeout; the final full run limits workers to two. These are separately reported rather than hidden as pre-existing assertion failures.

The production build reports seven filesystem tracing warnings from unchanged `src/db/backup.ts` and `src/db/startup.ts`. No warning points to the dashboard changes. Those existing tracing concerns are outside this UI task.

## Browser verification and screenshots

Used the existing authenticated local demo at `http://localhost:5177`.

- Expense period changed to 90 days, retaining sales at 30 days.
- Sales then changed to 7 days, retaining expenses at 90 days.
- Net Profit opened `/reports/profit-and-loss?period=custom&from=2026-10-01&to=2026-10-08`; report agreed with the dashboard.
- Record Expense opened `/expenses#record-expense`, landing on the existing form.
- Mobile at a requested 390px viewport: document client width and scroll width both 375px (the scrollbar accounts for the difference), with no horizontal page overflow.
- Desktop light/dark verified. The original dark theme and normal viewport were restored after verification.

| Screenshot | Scope |
| --- | --- |
| `before.jpg` | Original dashboard, full page, 672px viewport, dark |
| `after-narrow-dark.jpg` | Improved dashboard at the same 672px width, dark |
| `after-mobile-dark.jpg` | Improved 390px mobile viewport, dark |
| `after-desktop-dark.jpg` | Improved 1440px desktop viewport, dark |
| `after-desktop-light.jpg` | Improved 1440px desktop viewport, light |
| `after-desktop-light-viewport.jpg` | Desktop light first-screen preview |
| `profit-and-loss.jpg` | Exact-period P&L result |

## Remaining limits and preserved semantics

1. A due-date bucket cannot be assigned honestly to a ledger-only opening amount or unallocated customer credit. Those amounts are explicitly reconciled outside invoice ageing; they are not misclassified as current. The two invoice buckets reconcile to invoice outstanding; including the separate ledger-only difference reconciles to the full customer ledger.
2. Original period semantics are retained: the 7d/30d/90d controls mean today minus 7/30/90 through today inclusively (8/31/91 business dates). The exact dates are shown rather than silently changing the accounting window.
3. Cash movements retain their existing full-calendar-month window, including any future-dated entries in the final month and internal transfers. They are not presented as net operating cash flow.
4. Receive Payment deliberately requires choosing a customer through the existing customer list; no standalone payment form or posting path was introduced.
5. Reconciliation uses the existing service's definition of unresolved recorded differences, per account. It does not infer missing bank statements, invent a count or claim an uncounted account is reconciled.

## Visual comparison

Original and improved dashboards at the same 672px width and original dark theme:

| Before | After |
| --- | --- |
| ![Original dashboard](C:/ClaudeProjects/bookkeeper/docs/dashboard-ux/before.jpg) | ![Improved dashboard](C:/ClaudeProjects/bookkeeper/docs/dashboard-ux/after-narrow-dark.jpg) |

Desktop light preview:

![Improved desktop dashboard](C:/ClaudeProjects/bookkeeper/docs/dashboard-ux/after-desktop-light-viewport.jpg)
