import { describe, expect, it } from 'vitest';

import {
  taxOnNet,
  taxShareOf,
  taxWithinGross,
  totalRateBp,
  type TaxComponent,
} from '@/domain/tax/components';
import { minor, mulDiv, sum, type Minor } from '@/domain/money';

const m = (n: number): Minor => minor(n);

/** What a Ghanaian shop charges: two levies and VAT, on the net. */
const GHANA: TaxComponent[] = [
  { code: 'NHIL', name: 'NHIL', rateBp: 250, isRecoverable: false },
  { code: 'GETFUND', name: 'GETFund', rateBp: 250, isRecoverable: false },
  { code: 'VAT', name: 'VAT', rateBp: 1_500, isRecoverable: true },
];

describe('charging tax on top of the price', () => {
  it('splits GHS 100.00 the way the receipt should read', () => {
    const result = taxOnNet(m(10_000), GHANA);

    expect(result.lines.map((line) => [line.code, line.amount])).toEqual([
      ['NHIL', 250],
      ['GETFUND', 250],
      ['VAT', 1_500],
    ]);
    expect(result.total).toBe(2_000);
    expect(result.gross).toBe(12_000);
  });

  it('is 20% altogether', () => {
    expect(totalRateBp(GHANA)).toBe(2_000);
  });

  it('charges nothing when there are no components', () => {
    const result = taxOnNet(m(10_000), []);
    expect(result.total).toBe(0);
    expect(result.gross).toBe(10_000);
  });
});

describe('extracting tax from a shelf price', () => {
  it('works back out of GHS 120.00', () => {
    const result = taxWithinGross(m(12_000), GHANA);

    expect(result.net).toBe(10_000);
    expect(result.total).toBe(2_000);
    expect(result.gross).toBe(12_000);
    expect(result.lines.map((line) => line.amount)).toEqual([250, 250, 1_500]);
  });
});

/** Amounts that do not divide cleanly by any of the three rates. */
const AWKWARD = [1, 3, 7, 33, 99, 101, 333, 1_007, 4_999, 12_345, 99_999, 1_234_567];
const awkwardNegatives = AWKWARD.map((value) => -value);

/**
 * The property that matters. Three components rounded independently can miss
 * the total by a pesewa on an awkward amount, and that pesewa has nowhere to
 * live — it is either charged to the customer and owed to nobody, or owed to
 * the authority and collected from nobody.
 */
describe('the parts always add back to the whole', () => {
  it('when tax is added on', () => {
    for (const value of AWKWARD) {
      const result = taxOnNet(m(value), GHANA);
      expect(sum(result.lines.map((line) => line.amount)), `net ${value}`).toBe(result.total);
      expect(result.gross, `net ${value}`).toBe(value + result.total);
    }
  });

  it('when tax is inside the price', () => {
    for (const value of AWKWARD) {
      const result = taxWithinGross(m(value), GHANA);
      expect(sum(result.lines.map((line) => line.amount)), `gross ${value}`).toBe(result.total);
      // net + tax must return exactly to the price on the label.
      expect(result.net + result.total, `gross ${value}`).toBe(value);
    }
  });

  it('on a rate set that does not divide evenly', () => {
    const odd: TaxComponent[] = [
      { code: 'A', name: 'A', rateBp: 333, isRecoverable: false },
      { code: 'B', name: 'B', rateBp: 667, isRecoverable: false },
      { code: 'C', name: 'C', rateBp: 1, isRecoverable: true },
    ];

    for (const value of AWKWARD) {
      const added = taxOnNet(m(value), odd);
      expect(sum(added.lines.map((l) => l.amount)), `added ${value}`).toBe(added.total);

      const within = taxWithinGross(m(value), odd);
      expect(sum(within.lines.map((l) => l.amount)), `within ${value}`).toBe(within.total);
      expect(within.net + within.total, `within ${value}`).toBe(value);
    }
  });
});

describe('giving tax back on a return', () => {
  const charged = taxOnNet(m(40_000), GHANA).lines;

  it('hands back a quarter when a quarter goes back', () => {
    const share = taxShareOf(charged, m(10_000), m(40_000));

    expect(share.map((line) => line.amount)).toEqual([250, 250, 1_500]);
    expect(sum(share.map((line) => line.amount))).toBe(2_000);
  });

  it('hands back everything when everything goes back', () => {
    const share = taxShareOf(charged, m(40_000), m(40_000));
    expect(share.map((line) => line.amount)).toEqual(charged.map((line) => line.amount));
  });

  it('hands back nothing for nothing', () => {
    const share = taxShareOf(charged, m(0), m(40_000));
    expect(sum(share.map((line) => line.amount))).toBe(0);
  });

  it('still adds up on an awkward fraction', () => {
    for (const returned of [1, 7, 99, 1_003, 13_337, 39_999]) {
      const share = taxShareOf(charged, m(returned), m(40_000));
      const total = sum(share.map((line) => line.amount));
      // The parts add to the share of the whole that actually went back —
      // computed here independently of the function under test.
      const expected = mulDiv(sum(charged.map((line) => line.amount)), returned, 40_000);
      expect(total, `returned ${returned}`).toBe(expected);
      expect(total, `returned ${returned}`).toBeLessThanOrEqual(2_000 * 4);
      for (const [index, line] of share.entries()) {
        expect(line.amount, `returned ${returned} line ${line.code}`).toBeLessThanOrEqual(
          charged[index]!.amount,
        );
      }
    }
  });
});

describe('a return, a credit note or a void', () => {
  /**
   * These carry a NEGATIVE net, and the tax has to mirror it exactly.
   *
   * The shares are worked out from magnitudes and the sign is carried by the
   * total, because a weight is a proportion of the whole rather than a signed
   * amount. Before that, every one of these threw on the way into `allocate`
   * — which would have meant a shop could ring up a taxed sale but never take
   * it back.
   */
  it('charges tax back, mirroring the sale exactly', () => {
    const sale = taxOnNet(m(10_000), GHANA);
    const back = taxOnNet(m(-10_000), GHANA);

    expect(back.lines.map((line) => line.amount)).toEqual([-250, -250, -1_500]);
    expect(back.total).toBe(-2_000);
    expect(back.gross).toBe(-12_000);
    // Line for line, the negative of the sale. Nothing is stranded.
    expect(back.lines.map((line) => -line.amount)).toEqual(
      sale.lines.map((line) => line.amount),
    );
  });

  it('extracts tax from a negative shelf price', () => {
    const result = taxWithinGross(m(-12_000), GHANA);

    expect(result.net).toBe(-10_000);
    expect(result.total).toBe(-2_000);
    expect(result.lines.map((line) => line.amount)).toEqual([-250, -250, -1_500]);
  });

  it('the parts still add back to the whole on awkward negatives', () => {
    for (const value of awkwardNegatives) {
      const added = taxOnNet(m(value), GHANA);
      expect(sum(added.lines.map((line) => line.amount)), `net ${value}`).toBe(added.total);
      expect(added.gross, `net ${value}`).toBe(value + added.total);

      const within = taxWithinGross(m(value), GHANA);
      expect(sum(within.lines.map((line) => line.amount)), `gross ${value}`).toBe(within.total);
      expect(within.net + within.total, `gross ${value}`).toBe(value);
    }
  });

  it('gives back a share of what a negative document charged', () => {
    const charged = taxOnNet(m(-40_000), GHANA).lines;
    const share = taxShareOf(charged, m(-10_000), m(-40_000));

    expect(share.map((line) => line.amount)).toEqual([-250, -250, -1_500]);
    expect(sum(share.map((line) => line.amount))).toBe(-2_000);
  });
});

describe('refusing nonsense', () => {
  it('rejects a negative rate', () => {
    expect(() =>
      taxOnNet(m(10_000), [{ code: 'X', name: 'X', rateBp: -100, isRecoverable: false }]),
    ).toThrow(/cannot be negative/i);
  });
});
