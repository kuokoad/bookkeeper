# Stitch visual matching

The user's follow-up explicitly approved exact Inter and Material Symbols
matching, replacing the earlier restriction on introducing those assets.
They are bundled locally with their licenses; the browser does not contact
Google Fonts, GitHub or a CDN. Inter is WOFF2; the 27-glyph Material Symbols
subset is TrueType, identified correctly in CSS and checked by asset tests.

The authenticated shell now uses the reference's 240px charcoal sidebar,
expanded navigation groups, compact rows, NunaBooks brand block, 64px top bar,
24px desktop canvas padding and Inter typography. The dashboard uses the
reference's light palette, small card corners and 22px financial metrics.
Dark-mode preferences remain supported. Quick actions and navigation retain
their real routes and authorization. Period controls live in their KPI cards
and still preserve the independently selected Sales and Expenses periods.

The existing typed Icon component maps to locally bundled Material Symbols.
Sidebar accounts use account_balance; KPI cash uses account_balance_wallet;
notifications use notifications; quick actions use add, receipt, shopping_bag
and credit_score. The new reconciliation menu entry uses its own view
permission. Support opens the existing guide index; all guides remain there.

No accounting services, date calculations, journal rules, valuation rules or
transaction records were changed. Prototype financial numbers, placeholder
destinations, demo identities and unsupported synchronization claims are not
copied. Existing Accounting and Users navigation remain available; the
prototype's nonexistent Payments destination is not invented.

Fresh visual screenshots remain unavailable because browser access to the
dashboard was rejected by browser policy earlier in this task. The changes
have been mapped against the HTML source; pixel-level browser comparison
remains outstanding.

Validation: TypeScript passed; 33 dashboard financial/date/permission tests
and 13 theme/offline-asset tests passed; changed-file ESLint and diff checks
passed. No accounting service or database files appear in the change set.
The final production build passed with the same seven pre-existing dynamic
filesystem tracing warnings in backup/startup code.
