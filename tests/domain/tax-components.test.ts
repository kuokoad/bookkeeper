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
  { code: 'NHIL', name: 'NHIL', rateBp: 250, basis: 'NET', isRecoverable: false },
  { code: 'GETFUND', name: 'GETFund', rateBp: 250, basis: 'NET', isRecoverable: false },
  { code: 'VAT', name: 'VAT', rateBp: 1_500, basis: 'NET', isRecoverable: true },
];

/** The same three the way the GRA computes them: VAT sits on top of the levies. */
const GHANA_GRA: TaxComponent[] = [
  { code: 'NHIL', name: 'NHIL', rateBp: 250, basis: 'NET', isRecoverable: false },
  { code: 'GETFUND', name: 'GETFund', rateBp: 250, basis: 'NET', isRecoverable: false },
  { code: 'VAT', name: 'VAT', rateBp: 1_500, basis: 'NET_PLUS_LEVIES', isRecoverable: true },
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
      { code: 'A', name: 'A', rateBp: 333, basis: 'NET', isRecoverable: false },
      { code: 'B', name: 'B', rateBp: 667, basis: 'NET_PLUS_LEVIES', isRecoverable: false },
      { code: 'C', name: 'C', rateBp: 1, basis: 'NET_PLUS_LEVIES', isRecoverable: true },
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

describe("the GRA's own computation, with VAT on top of the levies", () => {
  /**
   * Ghana's standard treatment. The levies are added to the value first and
   * VAT is charged on the sum, so the all-in figure is 20.75% rather than the
   * 20% that adding the three percentages suggests. A shop that files against
   * the wrong one of these is short or over on every return it makes.
   */
  it('charges VAT on the value plus the levies', () => {
    const result = taxOnNet(m(10_000), GHANA_GRA);

    expect(result.lines.map((line) => [line.code, line.amount])).toEqual([
      ['NHIL', 250],
      ['GETFUND', 250],
      // 15% of 105.00, not of 100.00.
      ['VAT', 1_575],
    ]);
    expect(result.total).toBe(2_075);
    expect(result.gross).toBe(12_075);
  });

  it('reports the all-in rate, not the sum of the percentages', () => {
    expect(totalRateBp(GHANA)).toBe(2_000);
    expect(totalRateBp(GHANA_GRA)).toBe(2_075);
  });

  it('works back out of a tax-inclusive shelf price', () => {
    // A price that DOES decompose exactly: every line is its own rate on its
    // own base, with nothing left over. Not something a bigger number buys —
    // GHS 12,345.67 has a residual and this does not.
    const result = taxWithinGross(m(12_075), GHANA_GRA);

    expect(result.net).toBe(10_000);
    expect(result.lines.map((line) => line.amount)).toEqual([250, 250, 1_575]);
    expect(result.total).toBe(2_075);
  });

  it('keeps every identity on awkward amounts, both directions', () => {
    for (const value of [...AWKWARD, ...awkwardNegatives]) {
      const added = taxOnNet(m(value), GHANA_GRA);
      expect(sum(added.lines.map((l) => l.amount)), `net ${value}`).toBe(added.total);
      expect(added.gross, `net ${value}`).toBe(value + added.total);

      const within = taxWithinGross(m(value), GHANA_GRA);
      expect(sum(within.lines.map((l) => l.amount)), `gross ${value}`).toBe(within.total);
      // The customer pays exactly what the label says.
      expect(within.net + within.total, `gross ${value}`).toBe(value);
    }
  });

  it('a price too small to split three ways still adds up', () => {
    /**
     * Three pesewas. The net rounds to 2 and every component rounds to
     * nothing, so the single pesewa of tax goes to the first line rather than
     * disappearing — it is owed to somebody, and this records which somebody.
     */
    const result = taxWithinGross(m(3), GHANA_GRA);

    expect(result.net).toBe(2);
    expect(result.total).toBe(1);
    expect(result.lines.map((line) => line.amount)).toEqual([1, 0, 0]);
    expect(result.net + result.total).toBe(3);
  });

  it('takes a price apart that has no exact decomposition', () => {
    /**
     * GHS 3.33 is not reachable: 2.75 grosses up to 3.32 and 2.76 to 3.34.
     * The net keeps what the exact division gave it, the levies stay exactly
     * 2.5% of it, and the odd pesewa comes off VAT — the largest line, where
     * it moves the rate least.
     */
    const result = taxWithinGross(m(333), GHANA_GRA);

    expect(result.net).toBe(276);
    expect(result.lines.map((line) => line.amount)).toEqual([7, 7, 43]);
    expect(result.total).toBe(57);
    // The only thing that may never bend: the customer pays the label price.
    expect(result.net + result.total).toBe(333);
    // And the levies are still exactly 2.5% of the declared net.
    expect(result.lines[0]!.amount).toBe(mulDiv(m(276), 250, 10_000));
  });
});

describe('rounding each component on its own base', () => {
  /**
   * GHS 1.01 at Ghana's three rates. Each component is its own obligation on
   * a stated base, so each is rounded as its own figure and the total is what
   * they come to. Working out 20% of 1.01 first and sharing the 20 pesewas
   * across the three would hand the authority 14 pesewas of VAT where 15 are
   * due — a VAT line that is 15% of nothing at all.
   */
  it('gives the authority what is due on each base', () => {
    const result = taxOnNet(m(101), GHANA);

    expect(result.lines.map((line) => [line.code, line.amount])).toEqual([
      ['NHIL', 3],
      ['GETFUND', 3],
      ['VAT', 15],
    ]);
    // 21, not the 20 that rounding the combined rate would produce.
    expect(result.total).toBe(21);
    expect(result.gross).toBe(122);
  });

  it('the total is the sum of the parts, so the two cannot disagree', () => {
    for (const components of [GHANA, GHANA_GRA]) {
      for (const value of AWKWARD) {
        const result = taxOnNet(m(value), components);
        expect(sum(result.lines.map((line) => line.amount)), `net ${value}`).toBe(result.total);
      }
    }
  });
});

describe('the identities hold across every price, not just chosen ones', () => {
  /**
   * The chosen amounts above prove the cases somebody thought of. This sweeps
   * every pesewa from 1 to 5,000 in both directions, over four rate sets, and
   * checks the things that must never be false whatever the shop charges.
   */
  const RATE_SETS: [string, TaxComponent[]][] = [
    ['ghana flat', GHANA],
    ['ghana as the GRA computes it', GHANA_GRA],
    ['a single tax', [{ code: 'T', name: 'T', rateBp: 1_750, basis: 'NET', isRecoverable: true }]],
    [
      'rates that do not divide',
      [
        { code: 'A', name: 'A', rateBp: 333, basis: 'NET', isRecoverable: false },
        { code: 'B', name: 'B', rateBp: 667, basis: 'NET_PLUS_LEVIES', isRecoverable: false },
        { code: 'C', name: 'C', rateBp: 1, basis: 'NET_PLUS_LEVIES', isRecoverable: true },
      ],
    ],
  ];

  for (const [label, components] of RATE_SETS) {
    it(`adding tax on: ${label}`, () => {
      for (let value = -5_000; value <= 5_000; value++) {
        const result = taxOnNet(m(value), components);

        expect(sum(result.lines.map((l) => l.amount)), `${label} net ${value}`).toBe(result.total);
        expect(result.gross, `${label} net ${value}`).toBe(value + result.total);
        expect(result.net, `${label} net ${value}`).toBe(value);
        // Nothing is rounded away: every line is exactly its rate on its base.
        let running = 0;
        for (const line of result.lines) {
          const base = line.basis === 'NET_PLUS_LEVIES' ? m(value + running) : m(value);
          expect(line.amount, `${label} ${line.code} on ${value}`).toBe(
            mulDiv(base, line.rateBp, 10_000),
          );
          running += line.amount;
        }
      }
    });

    it(`extracting tax from: ${label}`, () => {
      for (let value = -5_000; value <= 5_000; value++) {
        const result = taxWithinGross(m(value), components);

        // The one that may never bend: the customer pays the label price.
        expect(result.net + result.total, `${label} gross ${value}`).toBe(value);
        expect(sum(result.lines.map((l) => l.amount)), `${label} gross ${value}`).toBe(
          result.total,
        );
        expect(result.gross, `${label} gross ${value}`).toBe(value);

        // No line is ever more than a single pesewa from its own rate.
        let running = 0;
        for (const line of result.lines) {
          const base = line.basis === 'NET_PLUS_LEVIES' ? m(result.net + running) : result.net;
          const exact = mulDiv(base, line.rateBp, 10_000);
          expect(
            Math.abs(line.amount - exact),
            `${label} ${line.code} on gross ${value}`,
          ).toBeLessThanOrEqual(1);
          running += line.amount;
        }
      }
    });
  }

  it('a return is the exact mirror of the sale it reverses', () => {
    for (const [label, components] of RATE_SETS) {
      for (let value = 1; value <= 2_000; value++) {
        const sale = taxOnNet(m(value), components);
        const back = taxOnNet(m(-value), components);

        // Written as a sum rather than a negation: -0 and 0 are different
        // values to a deep-equality check, and both mean nothing charged.
        for (const [index, line] of back.lines.entries()) {
          expect(line.amount + sale.lines[index]!.amount, `${label} ${value} ${line.code}`).toBe(0);
        }
        expect(back.total + sale.total, `${label} ${value}`).toBe(0);
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
      taxOnNet(m(10_000), [
        { code: 'X', name: 'X', rateBp: -100, basis: 'NET', isRecoverable: false },
      ]),
    ).toThrow(/cannot be negative/i);
  });

  it('rejects a fractional rate', () => {
    // BigInt would throw a RangeError from deep inside the money helpers; the
    // shop should be told which rate is wrong instead.
    expect(() =>
      taxOnNet(m(10_000), [
        { code: 'X', name: 'X', rateBp: 12.5, basis: 'NET', isRecoverable: false },
      ]),
    ).toThrow(/whole number of basis points/i);
  });
});
