/**
 * Quantity arithmetic.
 *
 * Quantities are integers in milli-units (3 decimal places), so a shop can sell
 * 1.5 kg of rice or 0.75 L of oil without floating point ever entering the
 * inventory ledger. 1.5 kg is stored as 1500.
 *
 * Same discipline as money: integers only, BigInt for products, explicit
 * overflow errors rather than silent corruption.
 */

import { divRoundHalf, mulDiv, type Minor } from './money';
import { MoneyOverflowError, ValidationError } from './errors';

declare const qtyBrand: unique symbol;

/** An integer count of milli-units. 1 unit = 1000. */
export type Qty = number & { readonly [qtyBrand]: 'Qty' };

export const QTY_SCALE = 1000;
export const QTY_DECIMALS = 3;

export const QTY_ZERO = 0 as Qty;
export const QTY_ONE = QTY_SCALE as Qty;

// --- construction ----------------------------------------------------------

export function qty(value: number): Qty {
  if (!Number.isFinite(value)) {
    throw new ValidationError('Quantity is not a finite number.', { value });
  }
  if (!Number.isInteger(value)) {
    throw new ValidationError(
      `Quantity must be a whole number of milli-units, received ${value}.`,
      { value },
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyOverflowError('Quantity exceeds the safe integer range.', { value });
  }
  return value as Qty;
}

/** fromUnits(3) -> 3000 (i.e. three whole items). */
export function fromUnits(units: number): Qty {
  if (!Number.isFinite(units)) {
    throw new ValidationError('Quantity is not a finite number.', { units });
  }
  return parseQty(units.toFixed(QTY_DECIMALS));
}

// No sign in this pattern — see the note on MONEY_INPUT. A pattern that allows
// its own "-" combined with manual sign stripping turns "--1" into +1.
const QTY_INPUT = /^(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?$/;

/** Parse user input: "3", "1.5", "0.750", "1,200". Rejects >3 decimals. */
export function parseQty(input: string): Qty {
  let text = input.trim();
  if (text === '') throw new ValidationError('Enter a quantity.');

  let negative = false;
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1).trim();
  }

  const match = QTY_INPUT.exec(text);
  if (!match) {
    throw new ValidationError(`"${input}" is not a valid quantity.`, { input });
  }

  const fraction = match[1] ?? '';
  if (fraction.length > QTY_DECIMALS) {
    throw new ValidationError(
      `Quantities can have at most ${QTY_DECIMALS} decimal places, "${input}" has ${fraction.length}.`,
      { input },
    );
  }

  const whole = text.split('.')[0]?.replace(/,/g, '') ?? '0';
  const padded = fraction.padEnd(QTY_DECIMALS, '0');
  const combined = BigInt(whole === '' ? '0' : whole) * BigInt(QTY_SCALE) + BigInt(padded || '0');
  const result = negative ? -combined : combined;

  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyOverflowError('Quantity exceeds the safe integer range.', { input });
  }
  return Number(result) as Qty;
}

/** Parse and reject anything that is not strictly greater than zero. */
export function parsePositiveQty(input: string, label = 'Quantity'): Qty {
  const value = parseQty(input);
  if (value <= 0) {
    throw new ValidationError(`${label} must be greater than zero.`, { input });
  }
  return value;
}

// --- arithmetic ------------------------------------------------------------

function fromBig(value: bigint): Qty {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyOverflowError('Quantity exceeds the safe integer range.', {
      value: value.toString(),
    });
  }
  return Number(value) as Qty;
}

export function addQty(a: Qty, b: Qty): Qty {
  return fromBig(BigInt(a) + BigInt(b));
}

export function subtractQty(a: Qty, b: Qty): Qty {
  return fromBig(BigInt(a) - BigInt(b));
}

export function negateQty(a: Qty): Qty {
  return fromBig(-BigInt(a));
}

export function absoluteQty(a: Qty): Qty {
  return a < 0 ? negateQty(a) : a;
}

export function sumQty(values: readonly Qty[]): Qty {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return fromBig(total);
}

/** Proportion of one quantity to another, as a rounded milli-unit quantity. */
export function scaleQty(value: Qty, numerator: number | bigint, denominator: number | bigint): Qty {
  return fromBig(divRoundHalf(BigInt(value) * BigInt(numerator), BigInt(denominator)));
}

// --- comparison ------------------------------------------------------------

export const isQtyZero = (a: Qty): boolean => a === 0;
export const isQtyPositive = (a: Qty): boolean => a > 0;
export const isQtyNegative = (a: Qty): boolean => a < 0;
export const qtyGreaterThan = (a: Qty, b: Qty): boolean => a > b;
export const qtyGreaterThanOrEqual = (a: Qty, b: Qty): boolean => a >= b;
export const qtyLessThan = (a: Qty, b: Qty): boolean => a < b;
export const qtyLessThanOrEqual = (a: Qty, b: Qty): boolean => a <= b;

export function maxQty(a: Qty, b: Qty): Qty {
  return a >= b ? a : b;
}
export function minQty(a: Qty, b: Qty): Qty {
  return a <= b ? a : b;
}

// --- the money bridge ------------------------------------------------------

/**
 * Line total = unit price x quantity, rounded to the nearest pesewa.
 *
 * This is THE place where a per-unit price becomes a line amount. Every sale
 * line, purchase line and return line goes through it, so rounding behaviour is
 * identical everywhere in the application.
 */
export function extendPrice(unitPrice: Minor, quantity: Qty): Minor {
  return mulDiv(unitPrice, quantity, QTY_SCALE);
}

/**
 * Recover a per-unit price from a line total. Presentation and reporting only —
 * never store the result back as a cost basis, because it is lossy.
 */
export function derivedUnitPrice(lineTotal: Minor, quantity: Qty): Minor {
  if (quantity === 0) {
    throw new ValidationError('Cannot derive a unit price for zero quantity.');
  }
  return mulDiv(lineTotal, QTY_SCALE, quantity);
}

// --- formatting ------------------------------------------------------------

/** 1500 -> "1.5", 3000 -> "3", 750 -> "0.75". Trailing zeros trimmed. */
export function formatQty(value: Qty): string {
  const negative = value < 0;
  const digits = Math.abs(value).toString().padStart(QTY_DECIMALS + 1, '0');
  const whole = digits.slice(0, digits.length - QTY_DECIMALS);
  const fraction = digits.slice(digits.length - QTY_DECIMALS).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** "1.5 kg" */
export function formatQtyWithUnit(value: Qty, unit: string): string {
  return `${formatQty(value)} ${unit}`.trim();
}

/** Plain round-trippable value for a form input. */
export function toQtyInputString(value: Qty): string {
  return formatQty(value).replace(/,/g, '');
}
