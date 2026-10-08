# Stitch dashboard implementation

The approved `code.html` is a visual reference only. Its external resources,
placeholder values, synchronization indicator and statement-reconciliation
claims are not included in the application.

## Presentation

- Four financial KPI columns on wide screens; two on tablets; one on phones.
- Primary New Sale action and existing permission-checked transaction links.
- Compact attention rows, with existing explanations and drilldowns retained.
- Two trend cards: independently dated sales/expenses and cash movements.
- Three business summaries: inventory/top product, receivables/payables, money accounts.
- Consolidated Books Check and reconciliation panel with individual results.
- Recorded counts are labelled “Count recorded”, never a claim that today's
  balance or a bank statement has been verified. Missing counts remain “Not verified”.
- Existing error boundary, empty states and updated loading skeleton.

Reused DashboardCard, DashboardFigure, Badge, Icon, TrendLine, PairedBars,
Alert, Skeleton, Next Link and existing theme tokens. DashboardCard gains an
embedded presentation option for sections within the accounting panel.

## Accounting and permissions

No services, financial calculations, posting logic, valuation rules, date
helpers, authentication, route guards or transaction records were modified.
All existing permission-gated service reads remain in place. Customer and
supplier blocks retain independent authorization inside the shared card.
Sales-only users retain their top-product summary without inventory data.

Regression fixtures verify P&L agreement including expense, shrinkage and cash
shortage (net profit 3,700 minor units), ageing total 9,000 with overdue 7,000
and current 2,000, explicit unaged residuals, opposing account differences,
independent filter links, denied reads and unchanged journal/inventory records.
These are disposable test fixtures, not dashboard values.

## Visual review limitation

The browser tool rejected access to the existing localhost dashboard tab under
its URL policy. No alternate browser route was attempted. Fresh desktop,
tablet and mobile screenshots and live responsive inspection could not be
completed in this run. Existing images in this directory document the previous
dashboard, not the Stitch implementation. Responsive breakpoint classes and
server-rendered section structure were inspected; this does not substitute
for browser visual verification.

## Validation

Targeted dashboard, clock and page-permission checks: 43 tests passed.
Full bookkeeping suite: 1,575 tests passed across 101 files. No test failures
remain, and no pre-existing functional test failures were found in this run.
TypeScript passed. Changed-file ESLint passed. Production build passed with
the seven existing dynamic-filesystem tracing warnings in backup/startup code.
The initial sandbox test attempt failed before collection with Windows EPERM
realpath errors; rerunning outside the sandbox succeeded.
