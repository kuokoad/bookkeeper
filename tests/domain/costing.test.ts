import { describe, expect, it } from 'vitest';

import {
  applyReturnIn,
  applyStockIn,
  applyStockOut,
  averageUnitCost,
  EMPTY_STOCK,
  isLowStock,
  isOutOfStock,
  replayChain,
  type StockState,
} from '@/domain/inventory/costing';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, parseQty, type Qty } from '@/domain/quantity';
import { InsufficientStockError, ValidationError } from '@/domain/errors';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);
const state = (qtyUnits: number, valueMinor: number): StockState => ({
  qty: u(qtyUnits),
  value: m(valueMinor),
});

describe('weighted average — the worked example', () => {
  it('re-averages on each purchase and consumes at the average', () => {
    // Buy 10 @ GHS 5.00 -> avg 5.00, qty 10, value 50.00
    let s = applyStockIn(EMPTY_STOCK, u(10), m(5_000)).state;
    expect(s.qty).toBe(10_000);
    expect(s.value).toBe(5_000);
    expect(averageUnitCost(s)).toBe(500);

    // Buy 10 @ GHS 7.00 -> avg 6.00, qty 20, value 120.00
    s = applyStockIn(s, u(10), m(7_000)).state;
    expect(s.qty).toBe(20_000);
    expect(s.value).toBe(12_000);
    expect(averageUnitCost(s)).toBe(600);

    // Sell 5 -> COGS 30.00, avg unchanged at 6.00
    const out = applyStockOut(s, u(5));
    expect(out.totalCost).toBe(3_000);
    expect(out.unitCost).toBe(600);
    expect(out.state.qty).toBe(15_000);
    expect(out.state.value).toBe(9_000);
    expect(averageUnitCost(out.state)).toBe(600);
  });
});

describe('value conservation', () => {
  it('releases exactly the remaining value when the last unit goes', () => {
    // 3 units costing GHS 10.00 total does not divide evenly: 333.33 each.
    const s = applyStockIn(EMPTY_STOCK, u(3), m(1_000)).state;

    const first = applyStockOut(s, u(1));
    const second = applyStockOut(first.state, u(1));
    const third = applyStockOut(second.state, u(1));

    // Not a pesewa created or lost across the three sales.
    expect(first.totalCost + second.totalCost + third.totalCost).toBe(1_000);
    // Nothing is left holding value with no quantity.
    expect(third.state.qty).toBe(0);
    expect(third.state.value).toBe(0);
  });

  it('never strands value when selling everything at once', () => {
    const s = applyStockIn(EMPTY_STOCK, u(7), m(1_001)).state;
    const out = applyStockOut(s, u(7));
    expect(out.totalCost).toBe(1_001);
    expect(out.state).toEqual({ qty: 0, value: 0 });
  });

  it('conserves value across many awkward in/out sequences', () => {
    for (const [qtyIn, cost, qtyOut] of [
      [3, 1_000, 1],
      [7, 999, 3],
      [11, 12_345, 7],
      [1, 1, 1],
      [100, 33_333, 99],
    ] as const) {
      const label = `in=${qtyIn} cost=${cost} out=${qtyOut}`;
      const s = applyStockIn(EMPTY_STOCK, u(qtyIn), m(cost)).state;
      const out = applyStockOut(s, u(qtyOut));

      const left = qtyIn - qtyOut;
      // Selling zero is correctly refused, so only drain a real remainder.
      const remainderCost = left > 0 ? applyStockOut(out.state, u(left)) : null;

      expect(out.totalCost + (remainderCost?.totalCost ?? 0), label).toBe(cost);
      expect((remainderCost ?? out).state.value, label).toBe(0);
      expect((remainderCost ?? out).state.qty, label).toBe(0);
    }
  });

  it('handles fractional quantities without drift', () => {
    // 2.5 kg costing GHS 30.00 -> GHS 12.00/kg
    const s = applyStockIn(EMPTY_STOCK, parseQty('2.5'), m(3_000)).state;
    expect(averageUnitCost(s)).toBe(1_200);

    const out = applyStockOut(s, parseQty('1.5'));
    expect(out.totalCost).toBe(1_800); // 1.5 x 12.00
    expect(out.state.qty).toBe(1_000);
    expect(out.state.value).toBe(1_200);
  });

  it('keeps a long random-ish sequence exactly reconciled', () => {
    let s = EMPTY_STOCK;
    let valueIn = 0;
    let valueOut = 0;

    for (let i = 1; i <= 60; i++) {
      const inResult = applyStockIn(s, u(i % 7 + 1), m(i * 137));
      valueIn += inResult.totalCost;
      s = inResult.state;

      if (s.qty > 0) {
        const outResult = applyStockOut(s, u(1));
        valueOut += outResult.totalCost;
        s = outResult.state;
      }
    }

    // Everything that went in either remains on hand or has been released.
    expect(valueIn - valueOut).toBe(s.value);
  });
});

describe('stock availability rules', () => {
  it('refuses to sell more than is on hand by default', () => {
    const s = state(5, 5_000);
    expect(() => applyStockOut(s, u(6), { productName: 'Milo 400g' })).toThrow(
      InsufficientStockError,
    );
  });

  it('reports available and requested amounts in readable units', () => {
    const s = applyStockIn(EMPTY_STOCK, parseQty('2.5'), m(1_000)).state;
    try {
      applyStockOut(s, parseQty('4'), { productName: 'Rice' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const domainError = error as InsufficientStockError;
      expect(domainError.userMessage).toContain('Rice');
      expect(domainError.userMessage).toContain('2.5');
      expect(domainError.userMessage).toContain('4');
    }
  });

  it('refuses zero and negative quantities in both directions', () => {
    expect(() => applyStockOut(state(5, 500), u(0))).toThrow(ValidationError);
    expect(() => applyStockIn(EMPTY_STOCK, u(0), m(100))).toThrow(ValidationError);
    expect(() => applyStockIn(EMPTY_STOCK, u(-1), m(100))).toThrow(ValidationError);
  });

  it('refuses to receive stock at a negative cost', () => {
    expect(() => applyStockIn(EMPTY_STOCK, u(1), m(-1))).toThrow(ValidationError);
  });

  it('sells from an empty product only when negative stock is enabled', () => {
    expect(() => applyStockOut(EMPTY_STOCK, u(1))).toThrow(InsufficientStockError);

    const out = applyStockOut(EMPTY_STOCK, u(2), {
      allowNegative: true,
      fallbackUnitCost: m(500),
    });
    expect(out.state.qty).toBe(-2_000);
    expect(out.totalCost).toBe(1_000); // 2 x 5.00 at the fallback rate
    expect(out.state.value).toBe(-1_000);
  });

  it('consumes real value first, then the fallback rate for the excess', () => {
    // 2 on hand worth GHS 12.00 total (6.00 each); sell 5 with fallback 5.00.
    const s = state(2, 1_200);
    const out = applyStockOut(s, u(5), { allowNegative: true, fallbackUnitCost: m(500) });

    // 12.00 real + 3 x 5.00 fallback = 27.00
    expect(out.totalCost).toBe(2_700);
    expect(out.state.qty).toBe(-3_000);
    expect(out.state.value).toBe(-1_500);
  });

  it('brings a negative position back to zero cleanly', () => {
    const negative: StockState = { qty: u(-3), value: m(-1_500) };
    const back = applyStockIn(negative, u(3), m(1_500));
    expect(back.state.qty).toBe(0);
    expect(back.state.value).toBe(0);
  });

  it('leaves no stranded value when receiving stock clears a negative position', () => {
    // Received at a different price than the position was costed at.
    const negative: StockState = { qty: u(-2), value: m(-1_000) };
    const back = applyStockIn(negative, u(2), m(1_400));
    expect(back.state.qty).toBe(0);
    // Zero quantity must mean zero value, whatever the arithmetic produced.
    expect(back.state.value).toBe(0);
  });
});

describe('returns', () => {
  it('restores exactly the value the sale removed', () => {
    const s = applyStockIn(EMPTY_STOCK, u(3), m(1_000)).state;
    const sale = applyStockOut(s, u(1));

    const returned = applyReturnIn(sale.state, u(1), sale.totalCost);

    // The pair is back exactly where it started — a return neither creates nor
    // destroys profit.
    expect(returned.state.qty).toBe(s.qty);
    expect(returned.state.value).toBe(s.value);
  });

  it('restores the original cost even after the average has moved', () => {
    let s = applyStockIn(EMPTY_STOCK, u(10), m(5_000)).state; // 5.00 each
    const sale = applyStockOut(s, u(2)); // COGS 10.00
    s = applyStockIn(sale.state, u(10), m(15_000)).state; // average rises

    const beforeValue = s.value;
    const returned = applyReturnIn(s, u(2), sale.totalCost);

    // Returned at what it originally cost, not at today's higher average.
    expect(returned.state.value - beforeValue).toBe(sale.totalCost);
  });
});

describe('replayChain — proving the cached balance', () => {
  it('reproduces the same state as sequential application', () => {
    let s = EMPTY_STOCK;
    const movements = [];

    const in1 = applyStockIn(s, u(10), m(5_000));
    movements.push({ qtyIn: u(10), qtyOut: 0 as Qty, totalCost: in1.totalCost });
    s = in1.state;

    const in2 = applyStockIn(s, u(10), m(7_000));
    movements.push({ qtyIn: u(10), qtyOut: 0 as Qty, totalCost: in2.totalCost });
    s = in2.state;

    const out1 = applyStockOut(s, u(5));
    movements.push({ qtyIn: 0 as Qty, qtyOut: u(5), totalCost: out1.totalCost });
    s = out1.state;

    expect(replayChain(movements)).toEqual(s);
  });

  it('returns empty stock for no movements', () => {
    expect(replayChain([])).toEqual(EMPTY_STOCK);
  });
});

describe('stock level helpers', () => {
  it('flags low stock against the product threshold, falling back to the shop default', () => {
    expect(isLowStock(u(3), u(5), u(10))).toBe(true);
    expect(isLowStock(u(6), u(5), u(10))).toBe(false);
    // No product-specific level -> use the shop-wide default.
    expect(isLowStock(u(8), null, u(10))).toBe(true);
    expect(isLowStock(u(12), null, u(10))).toBe(false);
  });

  it('treats hitting the threshold exactly as low', () => {
    expect(isLowStock(u(5), u(5), u(10))).toBe(true);
  });

  it('detects out of stock including negative positions', () => {
    expect(isOutOfStock(u(0))).toBe(true);
    expect(isOutOfStock(u(-2))).toBe(true);
    expect(isOutOfStock(u(1))).toBe(false);
  });
});

describe('averageUnitCost', () => {
  it('is zero for an empty product rather than dividing by zero', () => {
    expect(averageUnitCost(EMPTY_STOCK)).toBe(0);
  });

  it('is a display-only rounding of the exact pair', () => {
    // GHS 10.00 across 3 units -> 3.3333..., displayed as 3.33
    const s = applyStockIn(EMPTY_STOCK, u(3), m(1_000)).state;
    expect(averageUnitCost(s)).toBe(333);
    // ...but the exact value is preserved, not 3 x 333.
    expect(s.value).toBe(1_000);
  });
});
