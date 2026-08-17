/**
 * Money arithmetic.
 *
 * ---------------------------------------------------------------------------
 * THE RULE: money is ALWAYS an integer number of minor units (pesewas).
 * GHS 1,250.00 is stored, passed around, and compared as 125000.
 * A floating-point number never represents a monetary value anywhere in this
 * application. `0.1 + 0.2 !== 0.3` is not an acceptable property for a system
 * that tells a shop owner how much money they have.
 * ---------------------------------------------------------------------------
 *
 * Multiplication and division are performed in BigInt so intermediate products
 * cannot silently exceed Number.MAX_SAFE_INTEGER, then narrowed back with an
 * explicit range check that throws rather than corrupting a figure.
 */

import { MoneyOverflowError, ValidationError } from './errors';

declare const minorBrand: unique symbol;

/** An integer count of minor currency units (pesewas). Never a fraction. */
export type Minor = number & { readonly [minorBrand]: 'Minor' };

/** Minor units per major unit. 100 pesewas = 1 cedi. */
export const MONEY_SCALE = 100;
export const MONEY_DECIMALS = 2;

export const ZERO = 0 as Minor;

// --- construction ----------------------------------------------------------

/** Wrap a raw integer as Minor, rejecting fractions and unsafe magnitudes. */
export function minor(value: number): Minor {
  if (!Number.isFinite(value)) {
    throw new ValidationError('Amount is not a finite number.', { value });
  }
  if (!Number.isInteger(value)) {
    throw new ValidationError(
      `Money must be a whole number of minor units, received ${value}.`,
      { value },
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyOverflowError('Amount exceeds the safe integer range.', { value });
  }
  return value as Minor;
}

/**
 * Build Minor from a major-unit amount, e.g. fromMajor(12.5) -> 1250.
 *
 * ⚠️ NOT for user input — use `parseMoney(string)` for that.
 *
 * The `number` argument has *already* lost precision before this function is
 * reached. `1.005` is really 1.00499999999999989 in IEEE 754, so it correctly
 * becomes 1.00, not 1.01. No implementation here can recover a digit the caller
 * never actually had. This helper exists for seed data and literals only.
 */
export function fromMajor(major: number): Minor {
  if (!Number.isFinite(major)) {
    throw new ValidationError('Amount is not a finite number.', { major });
  }
  // Route through the string parser so we never inherit binary float error.
  return parseMoney(major.toFixed(MONEY_DECIMALS));
}

// Deliberately has NO sign of its own: the sign is consumed separately above.
// If this pattern also allowed "-", an input like "--1" would strip one minus,
// match the other, and silently return a POSITIVE amount.
const MONEY_INPUT = /^(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?$/;

/**
 * Parse user-entered text into Minor.
 * Accepts "1250", "1250.5", "1,250.50", " GHS 1,250.50 ", "(50.00)" for negative.
 * Rejects more than 2 decimal places rather than silently truncating a figure.
 */
export function parseMoney(input: string): Minor {
  let text = input.trim();
  if (text === '') throw new ValidationError('Enter an amount.');

  // Accounting-style negatives: (50.00) means -50.00
  let parenNegative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    parenNegative = true;
    text = text.slice(1, -1).trim();
  }

  // Drop a leading currency code or symbol.
  text = text.replace(/^[A-Za-z]{2,3}\s*/, '').replace(/^[₵$£€]\s*/, '').trim();

  let signNegative = false;
  if (text.startsWith('-')) {
    signNegative = true;
    text = text.slice(1).trim();
  }

  // Two negatives are an ambiguous instruction, not a positive number. Refuse
  // rather than guess: "(-50)" is a typo, and guessing it into +50 would put a
  // wrong figure into the books.
  if (parenNegative && signNegative) {
    throw new ValidationError(`"${input}" has a confusing sign — enter it once.`, { input });
  }
  const negative = parenNegative || signNegative;

  const match = MONEY_INPUT.exec(text);
  if (!match) {
    throw new ValidationError(`"${input}" is not a valid amount.`, { input });
  }

  const fraction = match[1] ?? '';
  if (fraction.length > MONEY_DECIMALS) {
    throw new ValidationError(
      `Amounts can have at most ${MONEY_DECIMALS} decimal places, "${input}" has ${fraction.length}.`,
      { input },
    );
  }

  const whole = text.split('.')[0]?.replace(/,/g, '') ?? '0';
  const padded = fraction.padEnd(MONEY_DECIMALS, '0');
  const combined = BigInt(whole === '' ? '0' : whole) * BigInt(MONEY_SCALE) + BigInt(padded || '0');

  return fromBigInt(negative ? -combined : combined);
}

// --- BigInt bridge ---------------------------------------------------------

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

export function fromBigInt(value: bigint): Minor {
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw new MoneyOverflowError('Amount exceeds the safe integer range.', {
      value: value.toString(),
    });
  }
  return Number(value) as Minor;
}

/**
 * Integer division rounding half AWAY FROM ZERO (standard commercial rounding).
 * 2.5 -> 3, -2.5 -> -3. Exported for reuse by the quantity module.
 */
export function divRoundHalf(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new ValidationError('Division by zero in a money calculation.');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = a / b;
  const remainder = a % b;
  const rounded = remainder * 2n >= b ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

// --- arithmetic ------------------------------------------------------------

export function add(a: Minor, b: Minor): Minor {
  return fromBigInt(BigInt(a) + BigInt(b));
}

export function subtract(a: Minor, b: Minor): Minor {
  return fromBigInt(BigInt(a) - BigInt(b));
}

export function negate(a: Minor): Minor {
  return fromBigInt(-BigInt(a));
}

export function absolute(a: Minor): Minor {
  return a < 0 ? negate(a) : a;
}

export function sum(values: readonly Minor[]): Minor {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return fromBigInt(total);
}

/**
 * value x numerator / denominator, rounded half away from zero.
 * The workhorse behind discounts, tax, weighted-average COGS and proration.
 */
export function mulDiv(
  value: Minor,
  numerator: number | bigint,
  denominator: number | bigint,
): Minor {
  return fromBigInt(divRoundHalf(BigInt(value) * BigInt(numerator), BigInt(denominator)));
}

/** Multiply by a whole number of times. */
export function multiply(value: Minor, factor: number): Minor {
  if (!Number.isInteger(factor)) {
    throw new ValidationError('Use mulDiv for fractional multiplication.', { factor });
  }
  return fromBigInt(BigInt(value) * BigInt(factor));
}

/** Basis points: 100 bp = 1%. A 12.5% tax rate is 1250 bp. */
export const BASIS_POINTS = 10_000;

export function percentOf(value: Minor, basisPoints: number): Minor {
  if (!Number.isInteger(basisPoints)) {
    throw new ValidationError('Rate must be expressed in whole basis points.', { basisPoints });
  }
  return mulDiv(value, basisPoints, BASIS_POINTS);
}

// --- comparison ------------------------------------------------------------

export const isZero = (a: Minor): boolean => a === 0;
export const isPositive = (a: Minor): boolean => a > 0;
export const isNegative = (a: Minor): boolean => a < 0;
export const equals = (a: Minor, b: Minor): boolean => a === b;
export const greaterThan = (a: Minor, b: Minor): boolean => a > b;
export const greaterThanOrEqual = (a: Minor, b: Minor): boolean => a >= b;
export const lessThan = (a: Minor, b: Minor): boolean => a < b;
export const lessThanOrEqual = (a: Minor, b: Minor): boolean => a <= b;

export function max(a: Minor, b: Minor): Minor {
  return a >= b ? a : b;
}
export function min(a: Minor, b: Minor): Minor {
  return a <= b ? a : b;
}

/** Clamp to zero — useful for "amount still owing" style figures. */
export function atLeastZero(a: Minor): Minor {
  return a > 0 ? a : ZERO;
}

// --- allocation ------------------------------------------------------------

/**
 * Split `total` across `weights` without losing or inventing a single pesewa.
 *
 * Uses the largest-remainder method: floor each share, then hand the leftover
 * units out one at a time to the largest remainders. sum(result) === total,
 * always. Used for prorating an invoice-level discount across line items.
 */
export function allocate(total: Minor, weights: readonly number[]): Minor[] {
  if (weights.length === 0) {
    throw new ValidationError('Cannot allocate across zero recipients.');
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new ValidationError('Allocation weights must be non-negative finite numbers.');
  }

  const weightTotal = weights.reduce((acc, w) => acc + w, 0);

  // Nothing to weight by: split as evenly as possible.
  if (weightTotal === 0) {
    return allocate(total, weights.map(() => 1));
  }

  const totalBig = BigInt(total);
  const weightBig = weights.map((w) => BigInt(Math.round(w * 1_000_000)));
  const weightSumBig = weightBig.reduce((acc, w) => acc + w, 0n);

  const shares: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let distributed = 0n;

  for (let i = 0; i < weightBig.length; i++) {
    const product = totalBig * (weightBig[i] ?? 0n);
    // Truncate toward zero, then track what was left behind.
    const share = product / weightSumBig;
    const remainder = product - share * weightSumBig;
    shares.push(share);
    remainders.push({ index: i, remainder: remainder < 0n ? -remainder : remainder });
    distributed += share;
  }

  // Hand out the residual units, largest remainder first.
  let leftover = totalBig - distributed;
  const step = leftover < 0n ? -1n : 1n;
  remainders.sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index));

  let cursor = 0;
  while (leftover !== 0n && remainders.length > 0) {
    const target = remainders[cursor % remainders.length];
    if (target) {
      shares[target.index] = (shares[target.index] ?? 0n) + step;
      leftover -= step;
    }
    cursor++;
  }

  return shares.map(fromBigInt);
}

// --- formatting ------------------------------------------------------------

/** "125000" -> "1,250.00". No currency code. */
export function toDecimalString(value: Minor, groupThousands = true): string {
  const negative = value < 0;
  const digits = Math.abs(value).toString().padStart(MONEY_DECIMALS + 1, '0');
  const whole = digits.slice(0, digits.length - MONEY_DECIMALS);
  const fraction = digits.slice(digits.length - MONEY_DECIMALS);
  const grouped = groupThousands ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
  return `${negative ? '-' : ''}${grouped}.${fraction}`;
}

/** "125000" -> "GHS 1,250.00". Currency is configurable, never hard-coded at call sites. */
export function formatMoney(value: Minor, currencyCode = 'GHS'): string {
  return `${currencyCode} ${toDecimalString(value)}`;
}

/** Plain value for an <input type="text"> — no grouping, so it round-trips through parseMoney. */
export function toInputString(value: Minor): string {
  return toDecimalString(value, false);
}
