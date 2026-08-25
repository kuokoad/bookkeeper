# Plan — Expiry dates and batch tracking

Status: **proposed, not started.** Nothing in this document is built yet.

Today a product has no expiry date. The only trace of expiry anywhere in the
codebase is `EXPIRED` as a stock-adjustment reason, which lets the shop write
off goods that have *already* spoiled. Nothing warns anyone beforehand.

This plan adds batch-level expiry tracking: each delivery becomes a batch with
its own date, sales draw from the earliest-expiring batch first, and stock that
is about to turn is surfaced while it can still be sold.

---

## 1. The central idea

**A batch tracks quantity. It never tracks cost.**

Inventory is valued by weighted average (`src/domain/inventory/costing.ts`).
Value is pooled across all stock of a product and no per-unit average is ever
stored. That is deliberate and it is not changing.

So batches run *alongside* the value ledger, not inside it:

| Question | Answered by | Unchanged? |
|---|---|---|
| What is this stock worth? | `stock_ledger` (qty + value) | yes — untouched |
| Which physical units left the shelf? | `stock_ledger_batches` (qty only) | new |

`applyStockIn` / `applyStockOut` / `applyStockOutAtCost` are not modified. The
cost of a unit sold is still the running weighted average regardless of which
batch it came from. This is what makes the feature affordable: no re-costing,
no migration of historical value, no change to any report that reads money.

**Consequence to be honest about:** per-batch margin is *not* available and
never will be under weighted-average costing. There is no per-batch cost to
compare a selling price against. What batches give you is FEFO, expiry
warnings, and a recall trace — not batch profitability.

## 2. The single seam

`recordStockMovement` in `src/services/inventory.service.ts:89` is already
described in its own comment as *"the single gateway through which inventory
changes."* Six call sites go through it:

| Caller | Direction | File |
|---|---|---|
| `createSale` | OUT | `sale.service.ts:351` |
| `voidSale` | IN | `sale.service.ts:~667` |
| `createPurchase` | IN | `purchase.service.ts:251` |
| `voidPurchase` | OUT | `purchase.service.ts:~412` |
| `createCustomerReturn` | IN | `returns.service.ts:275` |
| `createSupplierReturn` | OUT | `returns.service.ts:581` |
| `createStockAdjustment` | both | `stock-adjustment.service.ts:123` |

Batch handling goes **inside that one function**. Every caller then gets it for
free, and no service grows its own copy of FEFO logic. This is the difference
between a contained change and a change that touches every transaction in the
application.

The gateway's input and result grow by one field each:

```ts
export interface StockMovementInput {
  // ... everything already there, unchanged ...

  /**
   * IN  — where the incoming stock should land.
   *       `{ kind: 'NEW', expiryDate, supplierId }` opens a batch (a purchase).
   *       `{ kind: 'RESTORE', allocations }` puts units back into the exact
   *       batches they left from (a void or a customer return).
   *       Omitted entirely — lands in the product's undated batch.
   * OUT — `{ kind: 'PICK', allowExpired }` runs FEFO. Omitted means the same
   *       with `allowExpired: false`.
   */
  batch?: BatchDirective;
}

export interface StockMovementResult {
  // ... everything already there, unchanged ...

  /** Which batches this movement touched, and by how much. */
  batchAllocations: { batchId: number; batchRef: string; qtyMilli: number;
                      expiryDate: string | null }[];
}
```

## 3. Schema

Three additions and two settings columns. All additive; nothing existing is
altered.

### `product_batches` — `src/db/schema/inventory.ts`

```ts
export const productBatches = sqliteTable('product_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  productId: integer('product_id').notNull()
    .references(() => products.id, { onDelete: 'restrict' }),

  /** 'BAT-00041'. From the sequence service, like every other document. */
  batchRef: text('batch_ref').notNull(),

  /** NULL means "does not expire" — cement, hardware, the opening balance. */
  expiryDate: businessDate('expiry_date'),
  receivedDate: businessDate('received_date').notNull(),

  /**
   * Cached remaining quantity, exactly as `products.qtyOnHandMilli` is a cache.
   * The truth is the sum of this batch's rows in `stock_ledger_batches`, and
   * `verifyProductBatches()` proves one against the other.
   * MAY go negative, but only when the shop has enabled negative stock.
   */
  qtyMilli: qtyMilli('qty_milli').notNull().default(0),

  /** Where it came from: 'PURCHASE' + its id, or 'OPENING', or 'ADJUSTMENT'. */
  sourceType: text('source_type').notNull(),
  sourceId: integer('source_id'),

  /** For a recall: whose delivery was this? */
  supplierId: integer('supplier_id')
    .references(() => suppliers.id, { onDelete: 'set null' }),

  /** Overrides the shop-wide warning window. Null uses settings. */
  warnDays: integer('warn_days'),

  note: text('note'),
  /** Set when the batch reaches zero. Kept, never deleted — the ledger points here. */
  isClosed: boolean('is_closed').notNull().default(false),

  isDemo: isDemo(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('uq_product_batches_ref').on(t.batchRef),
  index('idx_product_batches_product').on(t.productId, t.expiryDate),
  index('idx_product_batches_expiry').on(t.expiryDate),
  index('idx_product_batches_open').on(t.productId, t.isClosed),
  index('idx_product_batches_source').on(t.sourceType, t.sourceId),

  check('ck_product_batches_ref', sql`length(trim(${t.batchRef})) > 0`),
  check('ck_product_batches_expiry_format',
    sql`${t.expiryDate} IS NULL OR ${t.expiryDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
  check('ck_product_batches_received_format',
    sql`${t.receivedDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
  check('ck_product_batches_warn_days',
    sql`${t.warnDays} IS NULL OR ${t.warnDays} >= 0`),
  // A closed batch holds nothing. Mirrors ck_products_zero_qty_zero_value.
  check('ck_product_batches_closed_is_empty',
    sql`${t.isClosed} = 0 OR ${t.qtyMilli} = 0`),
]);
```

### `stock_ledger_batches` — the allocation record

Every movement's batch split, hung off the ledger row that caused it. Append-only,
like the ledger itself.

```ts
export const stockLedgerBatches = sqliteTable('stock_ledger_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ledgerId: integer('ledger_id').notNull()
    .references(() => stockLedger.id, { onDelete: 'restrict' }),
  batchId: integer('batch_id').notNull()
    .references(() => productBatches.id, { onDelete: 'restrict' }),

  qtyInMilli: qtyMilli('qty_in_milli').notNull().default(0),
  qtyOutMilli: qtyMilli('qty_out_milli').notNull().default(0),

  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('uq_stock_ledger_batches').on(t.ledgerId, t.batchId),
  index('idx_stock_ledger_batches_batch').on(t.batchId),
  // Same one-direction rule the ledger itself enforces.
  check('ck_stock_ledger_batches_one_direction',
    sql`(${t.qtyInMilli} > 0 AND ${t.qtyOutMilli} = 0)
     OR (${t.qtyInMilli} = 0 AND ${t.qtyOutMilli} > 0)`),
]);
```

> **Design note — a correction to the earlier sketch.** The original proposal
> was a `sale_item_batches` table. Hanging the allocation off the *ledger row*
> instead is strictly better: one table covers sales, purchases, both kinds of
> return, both kinds of void, and adjustments, rather than sales alone. It also
> sits next to the thing that is already the source of truth for stock. The
> recall query — "which documents drew from batch X?" — becomes a single join
> through `stock_ledger.sourceType / sourceId`.

### `business_settings` — `src/db/schema/system.ts`

```ts
expiryWarningDays: integer('expiry_warning_days').notNull().default(30),
expiryBlocksSales: boolean('expiry_blocks_sales').notNull().default(true),
```

Placed beside `lowStockThresholdMilli` and `allowNegativeStock` (line ~59),
which are the same kind of shop-wide stock policy.

### `sequences`

Add `BATCH` to `DOC_TYPES` and `DEFAULT_SEQUENCES` in
`src/services/sequence.service.ts`: prefix `BAT-`, padding 5. Same atomic
`UPDATE ... RETURNING` numbering as every other document.

### Errors

Add to `src/domain/errors.ts`, next to `InsufficientStockError`:

```ts
export class ExpiredStockError extends DomainError { /* productName, qtyExpired, batchRefs */ }
```

## 4. FEFO — the picking rule, stated exactly

When `recordStockMovement` takes stock OUT, it allocates across open batches in
this order:

1. **Dated, not yet expired** — earliest `expiry_date` first.
2. **Undated** — oldest `id` first. (The opening batch is here, so it drains
   last among equals but before anything expired.)
3. **Expired** — *never automatically.*

Then:

- If steps 1–2 cover the quantity: the sale completes. Any expired batches sit
  untouched and keep showing on the dashboard as "write off?". **This is the
  common case, and staff never see an interruption.**
- If they do not cover it, but expired batches *would*: throw
  `ExpiredStockError`. This is the block. A cashier is stopped. A user holding
  the override permission is offered a confirmation, and on confirming, step 3
  runs — earliest expiry first — and the override is written to the audit log
  with the user, the batch refs, and the reason.
- If even the expired batches do not cover it: the existing
  `InsufficientStockError` path, unchanged.
- If `settings.allowNegativeStock` is on and nothing covers it: the shortfall
  is recorded against the product's **undated batch**, which is permitted to go
  negative. If no undated batch exists, one is opened. This keeps the invariant
  in §6 true even when the shop lets stock go below zero.
- If `settings.expiryBlocksSales` is off: expired batches join step 2 and
  nothing is ever blocked. The warnings still show.

### Putting stock back

A void or a customer return must restore units to the batches they came from,
or the expiry dates become fiction. The rule:

- Read `stock_ledger_batches` for the ledger rows belonging to the original
  document, filtered to this product. That is the exact batch split that left.
- **Full void:** reverse it exactly, batch for batch. If a batch was closed,
  reopen it — never open a replacement, or the trace breaks.
- **Partial return:** allocate the returned quantity across those same batches
  **proportionally**, largest remainder taking any rounding. Deterministic, and
  the same rule `allocate()` in `src/domain/money.ts` already uses for money.
- **Supplier return / purchase void:** takes stock OUT of the batch that
  purchase opened (found by `sourceType = 'PURCHASE'`, `sourceId`), not by
  FEFO. Returning goods to a supplier must remove *their* goods.

## 5. Migration — `0019_*.sql`

Generated with `npm run db:generate`, then **hand-extended** with a data step in
the same file (which is legitimate: the rule in `src/db/schema/index.ts` is that
a migration is never edited *after* it has been applied to a real shop).

```sql
-- ... generated CREATE TABLE / CREATE INDEX statements ...

-- Every product holding stock gets one undated opening batch.
INSERT INTO product_batches
  (product_id, batch_ref, expiry_date, received_date, qty_milli,
   source_type, is_closed, is_demo, created_at, updated_at)
SELECT
  p.id,
  'BAT-OPEN-' || printf('%05d', p.id),
  NULL,                                   -- no date: sells last, never warns
  date('now'),
  p.qty_on_hand_milli,
  'OPENING',
  0,
  p.is_demo,
  unixepoch() * 1000,
  unixepoch() * 1000
FROM products p
WHERE p.track_inventory = 1 AND p.qty_on_hand_milli <> 0;
```

Notes:

- `<> 0`, not `> 0` — a product already negative under `allowNegativeStock`
  carries that negative into its opening batch, so §6's invariant holds from
  the first moment.
- The opening batch gets no `stock_ledger_batches` rows, because the movements
  that built that quantity predate batches entirely. `verifyProductBatches()`
  must therefore treat an `OPENING` batch's quantity as its own starting point
  — see §6.
- `BAT-OPEN-*` refs are outside the `BAT-#####` sequence on purpose, so the
  sequence starts clean at `BAT-00001` for the first real delivery.
- Reversible: dropping the three tables and two columns returns the database to
  its current state. Nothing existing is rewritten.

## 6. The invariants — how this stays provable

The codebase already proves its stock cache against its ledger
(`verifyProductStock`, `verifyStockAgainstLedger`, and the `preflight` check at
`src/db/preflight.ts:143`). Batches get the same treatment, or they are not
trustworthy.

Two new invariants in `src/services/inventory.service.ts`:

```ts
/** Per batch: cached qty === opening qty + sum of its ledger allocations. */
export function verifyProductBatches(db: Db, productId: number): BatchVerification;

/** Per product: sum of batch quantities === products.qtyOnHandMilli. */
export function verifyBatchCoverage(db: Db): BatchCoverageCheck[];
```

The second is the one that matters most. If it ever fails, stock exists that
belongs to no batch — meaning FEFO is silently picking from an incomplete set
and an expiry warning could be missing.

Wired into:

- `src/db/preflight.ts` — a new check, `fail` on drift, alongside the existing
  stock-cache check.
- `src/app/(app)/settings/health/page.tsx` — no code change needed; it renders
  whatever `runPreflight()` returns.
- `tests/services/stock-integrity-check.test.ts` — extended.

## 7. Permissions — one mapping decision, flagged

There is **no `MANAGER` role** in this codebase. `USER_ROLES` is
`['OWNER', 'STAFF']` (`src/db/schema/users.ts:6`), with a per-module permission
matrix over thirteen modules.

So "owner or manager may override" maps onto the existing model as:

```ts
// src/actions/sale.actions.ts — mirrors mayOverridePrice at line 80
const maySellExpired = can(actor, 'inventory', 'void');
```

Rationale: `inventory:void` is already the right to write stock off. Selling
expired goods and writing them off are the same level of trust over the same
goods, and `role-guard.ts` establishes that voiding is this codebase's marker
for a senior action. An owner passes automatically, since `can()` short-circuits
on `role === 'OWNER'`.

The service refuses the sale if the flag is false — the check is not left to the
action layer, exactly as the comment at `sale.actions.ts:75-79` insists.

**If you would rather this were `inventory:edit`, or a new `expiry` module in
`PERMISSION_MODULES`, say so before Phase 4** — it is a one-line change then and
a migration afterwards.

## 8. Phases

Each phase ends green (`npm run verify`) and is committable on its own. Phases
1–2 change no visible behaviour, which means they can land and sit safely while
the rest is built.

---

### Phase 1 — The batch ledger exists and is provable

*No behaviour change. Batches are created, but nothing reads them yet.*

| File | Change |
|---|---|
| `src/db/schema/inventory.ts` | `productBatches`, `stockLedgerBatches`, types |
| `src/db/schema/system.ts` | `expiryWarningDays`, `expiryBlocksSales` |
| `src/db/migrations/0019_*.sql` | generated DDL + opening-batch backfill |
| `src/services/inventory.service.ts` | `verifyProductBatches`, `verifyBatchCoverage` |
| `src/db/preflight.ts` | batch-coverage check |
| `src/services/sequence.service.ts` | `BATCH` doc type, `BAT-` prefix |
| `src/domain/errors.ts` | `ExpiredStockError` |
| `src/db/seed/` | opening batches for demo products |

Tests — `tests/services/batch-integrity.test.ts` (new):
- backfill gives every stocked product exactly one opening batch
- a product with negative stock backfills to a negative opening batch
- `verifyBatchCoverage` is clean on a freshly migrated database
- `verifyBatchCoverage` reports drift when a batch row is corrupted by hand
- `expiryBlocksSales` and `expiryWarningDays` round-trip through settings

*Commit: "Every product's stock now sits in a batch, even if it has no date"*

---

### Phase 2 — The gateway allocates

*Still no visible change. Every existing movement now writes its batch split.*

| File | Change |
|---|---|
| `src/services/inventory.service.ts` | `BatchDirective`, FEFO allocator, batch cache update, `batchAllocations` in the result |
| `src/services/inventory.service.ts` | restore-to-source and proportional-return helpers (§4) |

The allocator is pure and belongs in the domain layer, not the service:

| File | Change |
|---|---|
| `src/domain/inventory/batches.ts` *(new)* | `orderForPicking()`, `allocateFefo()`, `allocateProportional()` — no database, fully unit-testable |

Nothing in `sale.service.ts`, `purchase.service.ts`, `returns.service.ts` or
`stock-adjustment.service.ts` changes yet. They call the gateway without a
`batch` directive and their stock lands in / leaves from the undated batch,
which is exactly what happens today.

Tests — `tests/domain/batch-allocation.test.ts` (new), pure:
- FEFO order: dated-unexpired before undated before expired
- an allocation spanning three batches sums to the requested quantity
- proportional return across two batches, largest remainder, sums exactly
- an allocation that cannot be covered without expired stock is reported as such
- property test alongside `costing-properties.test.ts`: **for any sequence of
  IN/OUT movements, sum of batch quantities === product quantity**

*Commit: "Stock knows which batch it came from"*

---

### Phase 3 — Purchases capture the date

*First visible change. The shop can start dating deliveries.*

| File | Change |
|---|---|
| `src/app/(app)/purchases/new/purchase-entry.tsx` | optional expiry date per line |
| `src/actions/purchase.actions.ts` | parse and pass `expiryDate` per line |
| `src/services/purchase.service.ts` | `PurchaseLineRequest.expiryDate`; pass `{ kind: 'NEW', expiryDate, supplierId }` to the gateway |
| `src/services/purchase.service.ts` | `voidPurchase` / supplier return remove from the source batch |
| `src/app/(app)/purchases/[id]/page.tsx` | show each line's batch ref and date |

Tests — `tests/services/purchases.test.ts` (extend):
- a purchase line with a date opens a batch carrying it
- a purchase line without a date lands in the undated batch
- two lines of the same product with different dates open two batches
- voiding a purchase empties the batch it opened, not the oldest one
- a supplier return draws from that supplier's batch even when an older one exists

*Commit: "A delivery can carry the date its goods run out"*

---

### Phase 4 — Sales pick FEFO, and expired stock is refused

*The heart of it.*

| File | Change |
|---|---|
| `src/services/sale.service.ts` | pass `{ kind: 'PICK', allowExpired }`; surface `ExpiredStockError` |
| `src/actions/sale.actions.ts` | `maySellExpired = can(actor, 'inventory', 'void')` (§7) |
| `src/actions/sale.actions.ts` | audit the override with batch refs and reason |
| `src/app/(app)/sales/new/pos.tsx` | expiring-soon notice on a line; blocked state; override confirmation for those who hold it |
| `src/services/returns.service.ts` | customer return restores to source batches |
| `src/services/sale.service.ts` | `voidSale` restores to source batches |

`pos.tsx` is 32 KB and the busiest screen in the app. The notice and the block
belong in the line-level component that already renders stock state — do not
add a second stock-status path beside it.

Tests — `tests/services/sale-expiry.test.ts` (new):
- 20 expired + 30 good, sell 5 → succeeds, draws from the good batch, expired untouched
- 20 expired + 3 good, sell 5 → `ExpiredStockError`, **nothing is written**
- same case with `maySellExpired` → succeeds, audit row names the batch
- same case with `expiryBlocksSales` off → succeeds without an override
- FEFO across two good batches picks the earlier date first
- voiding a sale returns units to the exact batches they left
- a partial return of a two-batch line splits proportionally
- `verifyBatchCoverage` is clean after every one of the above

Also extend `tests/services/sale-void.test.ts` and `return-tax.test.ts` to
assert batch coverage stays clean — they exercise the paths most likely to
drift.

*Commit: "Expired stock stays on the shelf unless somebody senior says otherwise"*

---

### Phase 5 — Warnings, and the write-off that clears them

| File | Change |
|---|---|
| `src/services/catalog.service.ts` | `getExpirySummary(db)` — expired count/value, expiring-soon count |
| `src/services/notifications.service.ts` | two notices in `getNotices`, gated on `can(user, 'products', 'view')` beside the existing low-stock notice |
| `src/app/(app)/dashboard/page.tsx` | "Expiring soon" card next to low stock |
| `src/db/schema/inventory.ts` | `stockAdjustmentItems.batchId` — nullable FK |
| `src/services/stock-adjustment.service.ts` | an item may target a batch; `EXPIRED` write-offs must |
| `src/app/(app)/inventory/adjustments/new/adjustment-form.tsx` | batch picker when the reason is `EXPIRED` |
| `src/app/(app)/products/page.tsx` | `?expiring=1` filter, beside the existing `?low=1` |

The notices follow the standard set in `notifications.service.ts`: a condition
that holds right now, derived from the ledger, never a nudge.

- `danger` — "N products have expired stock" → `/products?expiring=expired`
- `warning` — "N products expiring within {expiryWarningDays} days" → `/products?expiring=soon`

Tests — `tests/services/notifications.test.ts` (extend):
- no batches with dates → neither notice fires
- a batch inside the window → warning only
- a batch past its date → danger, and it suppresses the warning (matching the
  existing out-of-stock / low-stock precedence)
- the notices are hidden from a user without `products:view`
- an `EXPIRED` adjustment against a batch empties that batch and closes it
- `verifyBatchCoverage` clean afterwards

*Commit: "The shop finds out before the goods turn, not after"*

---

### Phase 6 — Reading it back

| File | Change |
|---|---|
| `src/app/(app)/products/[id]/page.tsx` | batch table: ref, date, remaining, days left |
| `src/app/(app)/reports/inventory/page.tsx` | expiry ageing — expired / ≤7d / ≤30d / ≤90d / later / undated |
| `src/app/api/reports/[report]/route.ts` | CSV for the above |
| `src/services/inventory.service.ts` | `getBatchHistory(db, batchId)` — the recall query |
| `src/app/(app)/inventory/batches/[id]/page.tsx` *(new)* | one batch: where it came from, every document that drew from it |
| `src/services/search.service.ts` | batch ref is searchable |

The recall page is the payoff for §3's design: one join from
`stock_ledger_batches` through `stock_ledger.sourceType/sourceId` answers "who
bought from this delivery?"

Tests — `tests/services/batch-reporting.test.ts` (new):
- expiry ageing buckets sum to total tracked stock
- undated stock lands in the undated bucket, never in "later"
- `getBatchHistory` lists the purchase in and every sale out, in order
- searching a batch ref finds the batch

*Commit: "Trace a bad delivery to the customers who bought it"*

---

## 9. Risks

**FEFO and weighted-average must not be allowed to touch.** The one bug that
would matter here is deriving a cost from a batch. Nothing in this plan does,
and the property test in Phase 2 asserts quantity and value stay independent.
`tests/services/costing-vs-ledger.test.ts` should keep passing untouched
throughout — if it ever needs editing, something has gone wrong.

**`pos.tsx` is the riskiest file.** 32 KB, the busiest screen, and Phase 4 adds
a blocking state to it. Every hour of care spent there is repaid.

**A block that fires wrongly gets routed around.** If staff are stopped at the
counter by a mistyped date, they will sell off-system, and then the books are
wrong in a way no invariant can catch. Two mitigations are already in the plan:
expired stock is *skipped*, not blocking, whenever good stock exists (§4), and
`expiryBlocksSales` lets a shop that does not need this turn it off entirely.

**The opening batch is a lie the shop must be allowed to correct.** It says
"this stock does not expire", which is false for perishables already on the
shelf on migration day. Phase 6's product page must let the owner edit an
opening batch's date, or split it. Worth doing in Phase 3 if the shop has
perishable stock on hand at go-live.

**Two tills, one last unit.** Already handled — allocation happens inside the
existing transaction, and `better-sqlite3` serialises writers. No new exposure,
but `tests/db/transaction-behaviour.test.ts` should gain a batch case.

## 10. Decisions still open

1. **Override permission** — `inventory:void` as proposed in §7, or something
   else? Cheapest to change before Phase 4.
2. **Opening-batch dates at go-live** — does the shop have perishables on hand
   now? If yes, pull the batch-edit UI forward from Phase 6 into Phase 3.
3. **`warnDays` per batch** — included in the schema, but no UI is planned
   before Phase 6. Fine to ship the column unused; say if you want the field on
   the purchase form in Phase 3 instead.
