import type { TaxBasis } from '@/db/schema/tax';
import { allocate, isZero, mulDiv, subtract, sum, ZERO, type Minor } from '../money';
import { ValidationError } from '../errors';

/**
 * Ghana charges more than one tax on the same sale.
 *
 * A shop here collects NHIL, the GETFund levy and VAT together. They are three
 * separate obligations to three separate purposes, they are remitted on the
 * same return but accounted for separately, and a VAT invoice has to show each
 * one — so a single "tax" figure cannot represent them.
 *
 * They are held as a configurable LIST rather than three hard-coded rates.
 * These rates change with the national budget more often than software gets
 * rewritten, and a shop that has to wait for a new version to charge the
 * correct tax will simply charge the wrong one.
 *
 * ---------------------------------------------------------------------------
 * HOW THEY COMBINE
 *
 * Each component states what it is charged ON, and they are applied in order.
 *
 *  - `NET`             — the goods value, before any tax.
 *  - `NET_PLUS_LEVIES` — the goods value plus every component ahead of it,
 *                        so the tax compounds on those.
 *
 * On GHS 100.00 with NHIL 2.5%, GETFund 2.5% and VAT 15%, all on the net:
 *
 *     net                    100.00
 *     NHIL      2.5%           2.50
 *     GETFund   2.5%           2.50
 *     VAT        15%          15.00
 *                          --------
 *     customer pays          120.00      all-in 20%
 *
 * With VAT on `NET_PLUS_LEVIES`, which is the GRA's own computation:
 *
 *     net                    100.00
 *     NHIL      2.5%           2.50
 *     GETFund   2.5%           2.50
 *     VAT        15% of 105.00 15.75
 *                          --------
 *     customer pays          120.75      all-in 20.75%
 *
 * Which treatment a shop uses is DATA, not a decision taken here. Both exist
 * in the wild, and an invoice that disagrees with the authority's arithmetic
 * is the shop's problem to answer for.
 * ---------------------------------------------------------------------------
 *
 * ROUNDING
 *
 * Each component is rounded on its own base, and the total is defined as the
 * sum of those parts. That ordering is deliberate: NHIL is 2.5% of a stated
 * base and nothing else, so it is worked out and rounded as its own figure.
 * Deriving a combined total first and sharing it out would produce a VAT line
 * that is not 15% of anything — on GHS 1.01 it hands the authority 14 pesewas
 * where 15 are due.
 *
 * Because the total IS the sum of the parts, the two can never disagree, and
 * no pesewa can be charged to the customer while being owed to nobody.
 */

const BASIS_POINTS = 10_000n;

export interface TaxComponent {
  /** Stable identifier — 'VAT', 'NHIL', 'GETFUND'. */
  code: string;
  /** What appears on the receipt. */
  name: string;
  /** Rate in basis points. 250 = 2.5%, 1500 = 15%. */
  rateBp: number;
  /** What the rate is charged on. Never inferred — a wrong guess misprices. */
  basis: TaxBasis;
  /**
   * Whether tax paid on a PURCHASE can be reclaimed.
   *
   * In Ghana, VAT is recoverable and the levies are not: NHIL and GETFund paid
   * to a supplier are part of what the goods cost, and pricing stock without
   * them understates the cost of every sale made from it.
   */
  isRecoverable: boolean;
}

export interface TaxLine extends TaxComponent {
  amount: Minor;
}

export interface TaxBreakdown {
  lines: TaxLine[];
  /** Sum of the lines, exactly. */
  total: Minor;
  /** Value the tax was charged on, excluding tax. */
  net: Minor;
  /** net + total. What the customer pays. */
  gross: Minor;
}

function assertUsable(components: readonly TaxComponent[]): void {
  for (const component of components) {
    if (!Number.isInteger(component.rateBp)) {
      throw new ValidationError(
        `The ${component.name} rate must be a whole number of basis points.`,
        { component },
      );
    }
    if (component.rateBp < 0) {
      throw new ValidationError(`The ${component.name} rate cannot be negative.`, { component });
    }
  }
}

/**
 * Tax per unit of net value, as an EXACT fraction.
 *
 * A combined percentage cannot be written down once compounding is involved:
 * 2.5 + 2.5 + 15 is 20, but VAT charged on the levies makes the true figure
 * 20.75, and on other rate sets it recurs. Carried as a ratio of BigInts, it
 * stays exact all the way to the single rounding at the end.
 */
function taxPerNet(components: readonly TaxComponent[]): { num: bigint; den: bigint } {
  let num = 0n;
  let den = 1n;

  for (const component of components) {
    const rate = BigInt(component.rateBp);
    // A NET component is charged on the net alone; a compounding one on the
    // net plus everything accumulated so far, which is (den + num) / den.
    const base = component.basis === 'NET_PLUS_LEVIES' ? den + num : den;
    num = num * BASIS_POINTS + rate * base;
    den = den * BASIS_POINTS;

    const divisor = gcd(num, den);
    if (divisor > 1n) {
      num /= divisor;
      den /= divisor;
    }
  }

  return { num, den };
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/**
 * The all-in rate in basis points — what the customer pays over the net.
 *
 * 2000 for Ghana's three charged flat, 2075 with VAT compounding on the
 * levies. Rounded, so it is a figure to SHOW rather than to compute with;
 * every actual amount comes from the exact fraction above.
 */
export function totalRateBp(components: readonly TaxComponent[]): number {
  assertUsable(components);
  const { num, den } = taxPerNet(components);
  if (num === 0n) return 0;
  return Number((num * BASIS_POINTS + den / 2n) / den);
}

/** Each component's amount on a given net, applied in order. */
function linesOn(net: Minor, components: readonly TaxComponent[]): TaxLine[] {
  const lines: TaxLine[] = [];
  let running = ZERO;

  for (const component of components) {
    const base = component.basis === 'NET_PLUS_LEVIES' ? sum([net, running]) : net;
    const amount = component.rateBp === 0 ? ZERO : mulDiv(base, component.rateBp, 10_000);
    running = sum([running, amount]);
    lines.push({ ...component, amount });
  }

  return lines;
}

/**
 * Tax ADDED to a net price.
 *
 * Used when the shop's shelf prices exclude tax.
 */
export function taxOnNet(net: Minor, components: readonly TaxComponent[]): TaxBreakdown {
  assertUsable(components);

  const lines = linesOn(net, components);
  const total = sum(lines.map((line) => line.amount));

  return { lines, total, net, gross: sum([net, total]) };
}

/**
 * Tax EXTRACTED from a price that already contains it.
 *
 * Used when the shop's shelf prices include tax, which is the norm in Ghanaian
 * retail — the customer pays what the label says, so `net + tax === gross` is
 * not negotiable.
 *
 * The net is found by dividing out the exact combined fraction, then each
 * component is worked out from that net in the ordinary way.
 *
 * Not every shelf price can be decomposed exactly. Add tax to GHS 2.76 and you
 * get GHS 3.34; add it to GHS 2.75 and you get GHS 3.32. Nothing produces
 * GHS 3.33, so a shop that puts 3.33 on the label has priced something the
 * arithmetic cannot take apart, and a pesewa has to go somewhere.
 *
 * It goes on the components, largest first, one pesewa each — so no single
 * line is ever more than a pesewa away from its own rate. The net keeps the
 * value the exact division gave it, and the customer still pays what the label
 * says. Bending the net instead would leave every line slightly wrong against
 * the declared value rather than one line wrong by the smallest coin there is.
 */
export function taxWithinGross(gross: Minor, components: readonly TaxComponent[]): TaxBreakdown {
  assertUsable(components);

  const { num, den } = taxPerNet(components);
  if (num === 0n) {
    return { lines: linesOn(gross, components), total: ZERO, net: gross, gross };
  }

  // net = gross / (1 + num/den) = gross * den / (den + num)
  const net = mulDiv(gross, den, den + num);
  const lines = linesOn(net, components);
  const residual = subtract(subtract(gross, net), sum(lines.map((line) => line.amount)));

  const settled = isZero(residual) ? lines : absorb(lines, residual);

  // Now exact by construction: the lines add to gross - net.
  return { lines: settled, total: sum(settled.map((line) => line.amount)), net, gross };
}

/**
 * Hand a rounding residual out across the lines, a pesewa at a time.
 *
 * Biggest line first, because a pesewa moves the biggest rate least. Never
 * more than one pesewa per line: the residual cannot exceed the number of
 * components, since it is only ever the accumulated half-pesewa of the net's
 * own rounding plus one per line.
 *
 * Deterministic on purpose — the same price must always break down the same
 * way, or a reprinted receipt could disagree with the one in the customer's
 * hand.
 */
function absorb(lines: readonly TaxLine[], residual: Minor): TaxLine[] {
  const order = lines
    .map((line, index) => ({ index, size: Math.abs(line.amount) }))
    .sort((a, b) => b.size - a.size || a.index - b.index);

  const amounts = lines.map((line) => line.amount);
  const step = residual > 0 ? 1 : -1;

  let remaining = residual as number;
  for (let step_ = 0; remaining !== 0; step_++) {
    const target = order[step_ % order.length]!.index;
    amounts[target] = sum([amounts[target]!, step as Minor]);
    remaining -= step;
  }

  return lines.map((line, index) => ({ ...line, amount: amounts[index]! }));
}

/**
 * The share of a tax breakdown that a partial return gives back.
 *
 * Apportioned from what was ACTUALLY charged rather than recomputed from the
 * rates, so a return hands back exactly what the customer paid even if the
 * rates have changed since, and the parts still sum to the total.
 */
export function taxShareOf(
  charged: readonly TaxLine[],
  returnedNet: Minor,
  originalNet: Minor,
): TaxLine[] {
  if (originalNet === 0 || isZero(returnedNet)) {
    return charged.map((line) => ({ ...line, amount: ZERO }));
  }

  const total = mulDiv(sum(charged.map((line) => line.amount)), returnedNet, originalNet);

  // Magnitudes: a weight is a proportion of the whole, never a signed amount,
  // and `allocate` refuses negative weights. A return carries negative lines,
  // and the sign rides on `total`, which `allocate` carries into every share.
  const shares = allocate(total, charged.map((line) => Math.abs(line.amount)));

  return charged.map((line, index) => ({ ...line, amount: shares[index] ?? ZERO }));
}
