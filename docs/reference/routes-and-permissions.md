# Routes and permissions

Every page and API route, and what it requires.

## How permission works

Thirteen modules: `sales`, `purchases`, `inventory`, `products`, `customers`,
`suppliers`, `expenses`, `income`, `accounts`, `reports`, `reconciliation`, `users`,
`settings`.

Four actions per module: `view`, `create`, `edit`, `void`.

An owner holds everything. Staff hold whatever the owner granted, per module and per
action. Pages call `requirePageAccess(module, action)`, which renders the no-access
page for a person; API routes call `requirePermission(...)`, which throws for code.
The difference matters: a thrown error is right for a caller that is code, and wrong
for someone who typed an address.

## Pages

### Daily

| Route | Module |
|---|---|
| `/dashboard` | — (any signed-in user) |
| `/sales` | `sales` view |
| `/sales/new` | `sales` create |
| `/sales/[id]` | `sales` view |
| `/sales/[id]/receipt` | `sales` view |
| `/sales/[id]/invoice` | `sales` view |
| `/purchases` | `purchases` view |
| `/purchases/new` | `purchases` create |
| `/purchases/[id]` | `purchases` view |
| `/expenses` | `expenses` view |
| `/income` | `income` view |

### Stock

| Route | Module |
|---|---|
| `/products` | `products` view |
| `/products/new` | `products` create |
| `/products/[id]/edit` | `products` edit |
| `/products/categories` | `products` view |
| `/inventory` | `inventory` view — the stock ledger |
| `/inventory/adjustments` | `inventory` view |
| `/inventory/adjustments/new` | `inventory` create |
| `/inventory/adjustments/[id]` | `inventory` view |
| `/inventory/batches/[id]` | `inventory` view |

### People

| Route | Module |
|---|---|
| `/customers`, `/customers/new`, `/customers/[id]`, `/customers/[id]/edit` | `customers` |
| `/customers/[id]/statement` | `customers` view |
| `/suppliers`, `/suppliers/new`, `/suppliers/[id]`, `/suppliers/[id]/edit` | `suppliers` |

### Money

| Route | Module |
|---|---|
| `/accounts` | `accounts` view |
| `/accounts/[id]` | `accounts` view — one account's statement |
| `/accounting` | `accounts` view |
| `/accounting/chart` | `accounts` view |
| `/accounting/journal`, `/accounting/journal/[id]` | `accounts` view |
| `/accounting/ledger/[id]` | `accounts` view |
| `/accounting/trial-balance` | `accounts` view |
| `/accounting/receivables` | `accounts` view |
| `/accounting/payables` | `accounts` view |
| `/reconciliation` | `reconciliation` view |

### Reports

`/reports` and every page under it require `reports` view:
`balance-sheet`, `cash-flow`, `inventory`, `profit-and-loss`, `purchases`, `sales`,
`tax`, `year-end`.

### Admin and account

| Route | Module |
|---|---|
| `/users`, `/users/new`, `/users/[id]` | `users` |
| `/users/audit` | `users` view |
| `/settings` | `settings` view |
| `/settings/health` | `settings` view |
| `/account/password` | signed in — deliberately **not** gated on a module, or somebody forced to change their password could never do it |

### Unauthenticated

| Route | Notes |
|---|---|
| `/login` | password or till PIN |
| `/setup` | closes permanently once any account exists |
| `/no-access` | shown when a signed-in user lacks the module |
| `/search` | signed in — searches products, customers, suppliers, receipts |

## API routes

| Route | Requires | Notes |
|---|---|---|
| `/api/exports/[list]` | view on **that list's own module** | Filtered CSV. Throttled per user. |
| `/api/reports/[report]` | `reports` view | Report CSV. Throttled per user. |
| `/api/backup` | `settings` **edit** | Downloads the database. Deliberately the write-level permission, not view — the same owner-level gate as the other controls that affect the whole shop. Staff are refused. |
| `/api/logo` | none | Serves the shop logo. Sends `X-Content-Type-Options: nosniff`. |

`/api/exports/[list]` takes `sales`, `purchases`, `expenses`, `income`, `products`,
`stock-movements`, `customers`, `suppliers`, `account`.

Export permission is checked **per module, not once for reports**. Someone who may
see sales but not expenses cannot export expenses by guessing a URL.

## The business type is not a permission

No route is gated by the shop's business type, and none ever should be.

A permission answers "may this person see it" and is enforced by the page's own
`requirePageAccess`. A business type answers "does this shop want to be offered
it", is enforced by the menu, and protects nothing: type the address of a
feature the shop has put away and the page opens normally.

That is deliberate, and it is what makes the setting safe. A shop changes type
after months of trading, and every quotation, delivery or dated batch it
recorded before the change must still open from a link, a search result, or a
reference on a printed receipt. Guarding a route on a feature would break all
three, silently, for records that are still perfectly valid.

`src/lib/business-type.ts` holds the switches and `visible()`, the one predicate
behind every hidden link. `tests/app/business-type-moves-nothing.test.ts` asserts
that changing type moves no figure on any report.

## Things that are not routes

- Server actions in `src/actions/` do their own `requirePermission` before anything
  else. They are entry points too, and are guarded as such.
- Every page under `(app)` also runs through the session check in the layout
  (`getCurrentUser` then `redirect`), so an unauthenticated request never reaches a
  page's own permission call. `/dashboard` and `/search` rely on that check alone —
  they gate on being signed in, not on a module.

## Related

- **ARCHITECTURE §7** — the permission model and session handling in full.
- [Filters](filters.md) — the query parameters these pages accept.
