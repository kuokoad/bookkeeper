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
 * Each component is charged on the NET goods value, and the parts are added
 * together. On GHS 100.00 with NHIL 2.5%, GETFund 2.5% and VAT 15%:
 *
 *     net                    100.00
 *     NHIL      2.5%           2.50
 *     GETFund   2.5%           2.50
 *     VAT        15%          15.00
 *                          --------
 *     customer pays          120.00
 *
 * Note for whoever reads this next: Ghana's standard GRA computation charges
 * VAT on the value INCLUDING the levies, which makes the effective rate 20.75%
 * rather than 20%. This app was deliberately configured for the flat treatment
 * above. Changing it is a change HERE, not a change to the rates.
 * ---------------------------------------------------------------------------
 */

export interface TaxComponent {
  /** Stable identifier — 'VAT', 'NHIL', 'GETFUND'. */
  code: string;
  /** What appears on the receipt. */
  name: string;
  /** Rate in basis points. 250 = 2.5%, 1500 = 15%. */
  rateBp: number;
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

/** Combined rate in basis points. */
export function totalRateBp(components: readonly TaxComponent[]): number {
  return components.reduce((running, component) => running + component.rateBp, 0);
}

function assertUsable(components: readonly TaxComponent[]): void {
  for (const component of components) {
    if (component.rateBp < 0) {
      throw new ValidationError(`The ${component.name} rate cannot be negative.`, { component });
    }
  }
}

/**
 * Split tax across the components so the parts add back to the total EXACTLY.
 *
 * The total is worked out first and then shared out with the largest-remainder
 * method, rather than rounding each component on its own and hoping the parts
 * agree with the whole. Rounded independently, three components on an awkward
 * amount can miss the total by a pesewa — and that pesewa has nowhere to live:
 * it is either charged to the customer and owed to nobody, or owed to the
 * authority and collected from nobody.
 */
function split(net: Minor, totalTax: Minor, components: readonly TaxComponent[]): TaxLine[] {
  if (components.length === 0 || isZero(totalTax)) {
    return components.map((component) => ({ ...component, amount: ZERO }));
  }

  // Shared out in proportion to the rates, which is the same proportion each
  // component bears to the whole when all are charged on the same net value.
  //
  // The weights are MAGNITUDES. A return, a credit note or a void carries a
  // negative net, and a weight is a share of the whole rather than a signed
  // amount — `allocate` refuses negative weights outright. The sign lives on
  // `totalTax`, which `allocate` carries through to every share, so a return
  // hands back exactly the mirror of what the sale charged.
  const shares = allocate(
    totalTax,
    components.map((component) => Math.abs(mulDiv(net, component.rateBp, 10_000))),
  );

  return components.map((component, index) => ({
    ...component,
    amount: shares[index] ?? ZERO,
  }));
}

/**
 * Tax ADDED to a net price.
 *
 * Used when the shop's shelf prices exclude tax.
 */
export function taxOnNet(net: Minor, components: readonly TaxComponent[]): TaxBreakdown {
  assertUsable(components);

  const rate = totalRateBp(components);
  const total = rate === 0 ? ZERO : mulDiv(net, rate, 10_000);
  const lines = split(net, total, components);

  return { lines, total, net, gross: sum([net, total]) };
}

/**
 * Tax EXTRACTED from a price that already contains it.
 *
 * Used when the shop's shelf prices include tax, which is the norm in Ghanaian
 * retail — the customer pays what the label says.
 *
 *     tax = gross x rate / (10000 + rate)
 */
export function taxWithinGross(gross: Minor, components: readonly TaxComponent[]): TaxBreakdown {
  assertUsable(components);

  const rate = totalRateBp(components);
  const total = rate === 0 ? ZERO : mulDiv(gross, rate, 10_000 + rate);
  const net = subtract(gross, total);
  const lines = split(net, total, components);

  return { lines, total, net, gross };
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

  const total = mulDiv(
    sum(charged.map((line) => line.amount)),
    returnedNet,
    originalNet,
  );

  // Magnitudes again — see the note in `split`. The sign rides on `total`.
  const shares = allocate(total, charged.map((line) => Math.abs(line.amount)));

  return charged.map((line, index) => ({ ...line, amount: shares[index] ?? ZERO }));
}
