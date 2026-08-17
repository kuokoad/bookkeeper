import { ValidationError } from './errors';

/**
 * Percentage rates, held as basis points.
 *
 * A tax rate must never be a floating-point fraction: 12.5% as `0.125` is
 * exact, but 7.3% as `0.073` is not, and that error would be multiplied by
 * every sale. So rates are integers of one hundredth of a percent — 12.5%
 * is 1250 — and the conversion to and from what a person types happens here,
 * once, rather than being re-derived in each form.
 */

export const BASIS_POINTS_SCALE = 10_000;
export const PERCENT_DECIMALS = 2;

/** Up to three whole digits and at most two decimals: "12", "12.5", "0.75". */
const PERCENT_INPUT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/**
 * "12.5" -> 1250.
 *
 * Deliberately has no sign of its own: a negative tax rate is not a thing, and
 * accepting one here would push the problem into the ledger.
 */
export function parsePercentToBasisPoints(input: string): number {
  const text = input.trim();
  if (text === '') throw new ValidationError('Enter a percentage.');

  const match = PERCENT_INPUT.exec(text);
  if (!match) {
    throw new ValidationError(
      `"${input}" is not a percentage. Enter it like 12.5, without the % sign.`,
      { input },
    );
  }

  const whole = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(PERCENT_DECIMALS, '0');
  const basisPoints = whole * 100 + Number(fraction);

  if (basisPoints > BASIS_POINTS_SCALE) {
    throw new ValidationError(`A rate of ${input}% is above 100%.`, { input });
  }
  return basisPoints;
}

/** 1250 -> "12.5", 1200 -> "12", 75 -> "0.75". The inverse of the parse above. */
export function formatBasisPoints(basisPoints: number): string {
  if (!Number.isInteger(basisPoints)) {
    throw new ValidationError('A rate in basis points must be a whole number.', { basisPoints });
  }

  const whole = Math.trunc(basisPoints / 100);
  const fraction = Math.abs(basisPoints % 100);
  if (fraction === 0) return String(whole);

  // Trailing zero trimmed so 1250 reads as "12.5" rather than "12.50".
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}
