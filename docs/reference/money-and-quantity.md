# Money and quantity

The two number types. Read this before writing anything that touches a figure.

Money is `Minor`, an integer count of **pesewas** (1/100 of a cedi). Quantity is
`Qty`, an integer count of **milli-units** (1/1000 of a unit). Neither is ever a
float, because 0.1 + 0.2 is not 0.3 and a shop's books cannot be approximately
right.

Both are *branded* types: TypeScript will not let a bare `number` be passed where a
`Minor` is expected, so the compiler catches a raw figure before it reaches the
books.

```ts
import { minor, add, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

const price: Minor = minor(1_250);      // GHS 12.50
const count: Qty = fromUnits(3);        // 3.000 units
```

| | Money | Quantity |
|---|---|---|
| Type | `Minor` | `Qty` |
| Scale | `MONEY_SCALE = 100` | `QTY_SCALE = 1000` |
| Module | `@/domain/money` | `@/domain/quantity` |
| `1` means | one pesewa | one thousandth of a unit |

## Making one

| Function | Takes | Gives |
|---|---|---|
| `minor(n)` | an integer count of pesewas | `Minor` |
| `fromMajor(n)` | a count of cedis | `Minor` |
| `parseMoney(s)` | user text: `"1250"`, `"1,250.50"`, `"GHS 20"`, `"(50.00)"` for negative | `Minor`, **throws** on junk or more than 2 decimals |
| `qty(n)` | an integer count of milli-units | `Qty` |
| `fromUnits(n)` | a count of whole units | `Qty` |
| `parseQty(s)` | user text | `Qty`, throws on junk |
| `parsePositiveQty(s, label)` | user text | `Qty`, throws if not above zero |

`parseMoney` **throws rather than guessing**. `"(-50)"` is a typo with two negatives,
not minus fifty, and guessing would put a wrong figure into the books. Filter boxes
are the exception and use the lenient `parseAmount` in `@/lib/filters`, which returns
`undefined` on junk — a filter is a question, not a posting.

## Arithmetic

Never use `+`, `-` or `*` on these directly. The helpers keep the brand and round
correctly.

| Money | Quantity | Does |
|---|---|---|
| `add(a, b)` | `addQty(a, b)` | sum of two |
| `subtract(a, b)` | `subtractQty(a, b)` | difference |
| `negate(a)` | `negateQty(a)` | sign flip |
| `absolute(a)` | `absoluteQty(a)` | magnitude |
| `sum(values)` | `sumQty(values)` | total of a list |
| `multiply(v, factor)` | `scaleQty(v, num, den)` | scaling |
| `mulDiv(v, num, den)` | — | `v × num ÷ den`, rounded half away from zero, computed in BigInt so it cannot overflow |
| `percentOf(v, basisPoints)` | — | a percentage, where `BASIS_POINTS = 10_000` so 1250 is 12.5% |
| `allocate(total, weights)` | — | splits a total so the parts add back to it exactly |
| `max` / `min` / `atLeastZero` | `maxQty` / `minQty` | bounds |

`allocate` is the one to reach for when splitting a discount or a tax across lines.
Dividing and rounding each part independently loses or invents a pesewa; `allocate`
gives the remainder to the largest weights so the parts always sum to the whole.

## Comparison

`isZero`, `isPositive`, `isNegative`, `equals`, `greaterThan`, `greaterThanOrEqual`,
`lessThan`, `lessThanOrEqual` — and the `Qty` equivalents prefixed `isQty` /
`qtyGreaterThan` and so on.

## Crossing the two

```ts
extendPrice(unitPrice: Minor, quantity: Qty): Minor   // qty × price
derivedUnitPrice(lineTotal: Minor, quantity: Qty): Minor
```

`extendPrice` is how a line total is computed. It handles the scale difference (100
against 1000) so callers never do that arithmetic themselves.

## Showing one

Presentation lives in `@/lib/format`, not in the domain.

| Function | Gives |
|---|---|
| `money(v)` | `"GHS 12.50"` |
| `money(v, { bare: true })` | `"12.50"` — for a column already headed GHS |
| `moneyAccounting(v)` | `"(12.50)"` for negatives |
| `quantity(v, unit)` | `"3 pcs"` |
| `formatMoney(v, code)` | the domain-level formatter |
| `toDecimalString(v)` | `"12.50"` |

**Nothing in a formatter calculates.** A total that first appears in a formatter is a
total nobody has tested.

## Dates

Business dates are `'YYYY-MM-DD'` strings, not `Date` objects, and are compared as
text. That is what makes a date range inclusive at both ends without any timezone
reasoning. `toBusinessDate()`, `fromBusinessDate()` and `isValidBusinessDate()` are
in `@/lib/format`.

Never filter trading on a timestamp. A range of 1–15 August must include a sale rung
up at 23:47 on the 15th.

## Related

- **ARCHITECTURE §3** — why the precision model is built this way, in full.
- [Inventory costing](../explanation/inventory-costing.md) — where `mulDiv` and
  `allocate` earn their keep.
