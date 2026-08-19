import { describe, expect, it } from 'vitest';

import {
  applyStockIn,
  applyStockOut,
  applyStockOutAtCost,
  EMPTY_STOCK,
  replayChain,
  type MovementResult,
  type ReplayMovement,
  type StockState,
} from '@/domain/inventory/costing';
import { minor, type Minor } from '@/domain/money';
import { qty as makeQty, type Qty } from '@/domain/quantity';

/**
 * Properties the costing engine must hold for ANY sequence of movements.
 *
 * Hand-written cases prove the situations somebody thought of. These generate
 * thousands of sequences instead — deliveries, sales, returns to a supplier,
 * shelves emptied and refilled, in whatever order — and check the invariants
 * that make the pair (quantity, value) trustworthy at all.
 *
 * The generator is seeded rather than random. A property test that fails once
 * in a hundred runs and cannot be reproduced is worse than no test, so the
 * sequences are the same on every machine and every run, and the seed is
 * printed with any failure so the exact case can be replayed.
 */

/** A small deterministic generator — no Math.random, so failures reproduce. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * `CLEAR_AT_COST` empties the shelf at a stated price rather than at the
 * running average, which is the case that strands value and produces a
 * residual. Its quantity is resolved at run time from whatever is on hand,
 * because landing on exactly zero by chance essentially never happens — and a
 * property test that never reaches the interesting branch passes vacuously.
 */
type Step =
  | { kind: 'IN'; qty: Qty; cost: Minor }
  | { kind: 'OUT'; qty: Qty }
  | { kind: 'OUT_AT_COST'; qty: Qty; cost: Minor }
  | { kind: 'CLEAR'; }
  | { kind: 'CLEAR_AT_COST'; cost: Minor };

function generateSequence(random: () => number, length: number): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < length; i++) {
    const roll = random();
    // Weighted towards stock coming in, or sequences mostly refuse to run.
    const qty = makeQty(Math.max(1, Math.floor(random() * 8_000)));
    const cost = minor(Math.floor(random() * 50_000));
    if (roll < 0.45) {
      steps.push({ kind: 'IN', qty, cost });
    } else if (roll < 0.7) {
      steps.push({ kind: 'OUT', qty });
    } else if (roll < 0.85) {
      steps.push({ kind: 'OUT_AT_COST', qty, cost });
    } else if (roll < 0.93) {
      steps.push({ kind: 'CLEAR' });
    } else {
      steps.push({ kind: 'CLEAR_AT_COST', cost });
    }
  }
  return steps;
}

interface RunResult {
  state: StockState;
  ledger: ReplayMovement[];
  totalIn: number;
  totalOut: number;
  totalResidual: number;
  applied: number;
}

/** Apply a sequence, skipping steps the engine legitimately refuses. */
function run(steps: readonly Step[], allowNegative: boolean): RunResult {
  let state: StockState = EMPTY_STOCK;
  const ledger: ReplayMovement[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let totalResidual = 0;
  let applied = 0;

  for (const step of steps) {
    // The two CLEAR steps take exactly what is on hand, resolved now.
    const stepQty =
      step.kind === 'CLEAR' || step.kind === 'CLEAR_AT_COST' ? state.qty : step.qty;
    if (stepQty <= 0) continue;

    let movement: MovementResult;
    try {
      if (step.kind === 'IN') {
        movement = applyStockIn(state, stepQty, step.cost);
      } else if (step.kind === 'OUT' || step.kind === 'CLEAR') {
        movement = applyStockOut(state, stepQty, { allowNegative, fallbackUnitCost: minor(500) });
      } else {
        movement = applyStockOutAtCost(state, stepQty, step.cost, { allowNegative });
      }
    } catch {
      // Refusing to sell what is not there is correct behaviour, not a failure.
      continue;
    }

    applied += 1;
    state = movement.state;
    totalResidual += movement.residual;

    if (step.kind === 'IN') {
      totalIn += movement.totalCost;
      ledger.push({ qtyIn: stepQty, qtyOut: 0 as Qty, totalCost: movement.totalCost });
    } else {
      totalOut += movement.totalCost;
      ledger.push({ qtyIn: 0 as Qty, qtyOut: stepQty, totalCost: movement.totalCost });
    }
  }

  return { state, ledger, totalIn, totalOut, totalResidual, applied };
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i * 7919 + 13);

describe('whatever the shop does to its stock', () => {
  it('an empty shelf is never worth anything', () => {
    for (const seed of SEEDS) {
      const steps = generateSequence(makeRandom(seed), 30);
      for (const allowNegative of [false, true]) {
        const { state } = run(steps, allowNegative);
        if (state.qty === 0) {
          expect(state.value, `seed ${seed}, allowNegative=${allowNegative}`).toBe(0);
        }
      }
    }
  });

  it('value is conserved: what went in, less what came out, less what was written off', () => {
    for (const seed of SEEDS) {
      const steps = generateSequence(makeRandom(seed), 30);
      for (const allowNegative of [false, true]) {
        const { state, totalIn, totalOut, totalResidual } = run(steps, allowNegative);

        // Nothing is created and nothing evaporates. `residual` is the only way
        // value may leave without being counted as cost, and it is reported so
        // the caller can post it.
        expect(state.value, `seed ${seed}, allowNegative=${allowNegative}`).toBe(
          totalIn - totalOut - totalResidual,
        );
      }
    }
  });

  it('the cached pair always survives a replay of its own movements', () => {
    for (const seed of SEEDS) {
      const steps = generateSequence(makeRandom(seed), 30);
      for (const allowNegative of [false, true]) {
        const { state, ledger } = run(steps, allowNegative);
        const replayed = replayChain(ledger);

        // This is what `verifyProductStock` relies on to prove the cached
        // quantity and value on `products` are not drifting.
        expect(replayed.qty, `seed ${seed} qty, allowNegative=${allowNegative}`).toBe(state.qty);
        expect(replayed.value, `seed ${seed} value, allowNegative=${allowNegative}`).toBe(
          state.value,
        );
      }
    }
  });

  it('refuses to sell what is not on the shelf, unless told otherwise', () => {
    // With negative stock switched off, quantity can never go below zero.
    for (const seed of SEEDS) {
      const steps = generateSequence(makeRandom(seed), 30);
      const { state } = run(steps, false);
      expect(state.qty, `seed ${seed}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('does actually exercise the engine rather than refusing everything', () => {
    // A guard on the guard: if the generator produced sequences the engine
    // always refused, every property above would pass vacuously.
    let applied = 0;
    let residuals = 0;
    for (const seed of SEEDS) {
      const steps = generateSequence(makeRandom(seed), 30);
      const result = run(steps, true);
      applied += result.applied;
      if (result.totalResidual !== 0) residuals += 1;
    }

    expect(applied).toBeGreaterThan(SEEDS.length * 20);
    // And the residual path — the one that used to lose money — is reached.
    expect(residuals).toBeGreaterThan(0);
  });
});
