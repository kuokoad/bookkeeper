import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { businessSettings, taxComponents } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import {
  applyTax,
  createTaxComponent,
  getTaxProfile,
  listTaxComponents,
  setTaxComponentActive,
  taxComponentUsage,
  updateTaxComponent,
  type TaxComponentInput,
} from '@/services/tax.service';
import { minor } from '@/domain/money';

/**
 * Changing what the shop charges.
 *
 * This is the whole point of holding the rates as data: Ghana moves them with
 * the national budget, and a shop that has to wait for a new version of the
 * software will charge the wrong tax in the meantime. What the editing has to
 * guarantee is that no edit can leave the books in a state that cannot be
 * filed — tax held somewhere that is not a liability, two components fighting
 * over one code, a rate nobody could have meant.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

const chargeTax = () =>
  context.db
    .update(businessSettings)
    .set({ taxEnabled: true })
    .where(eq(businessSettings.id, 1))
    .run();

const idOf = (code: string): number =>
  context.db.select().from(taxComponents).where(eq(taxComponents.code, code)).get()!.id;

const auditFor = (id: number): string[] =>
  (
    context.connection
      .prepare("SELECT summary FROM audit_logs WHERE entity_type = 'tax_component' AND entity_id = ?")
      .all(String(id)) as { summary: string }[]
  ).map((row) => row.summary);

function levyInput(overrides: Partial<TaxComponentInput> = {}): TaxComponentInput {
  return {
    code: 'COVID',
    name: 'COVID-19 Health Recovery Levy',
    rateBp: 100,
    basis: 'NET',
    isRecoverable: false,
    glAccountId: accountIdFor(context.db, ACCOUNT_CODES.NHIL_PAYABLE),
    sortOrder: 15,
    ...overrides,
  };
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});

afterEach(() => context.cleanup());

describe('the budget adds a levy', () => {
  /**
   * Ghana did exactly this in 2021, with the COVID-19 Health Recovery Levy.
   * A shop that had to wait for a release charged the wrong tax until it came.
   */
  it('takes effect on the next sale, without a new version of the software', () => {
    chargeTax();
    expect(getTaxProfile(context.db).totalRateBp).toBe(2_000);

    createTaxComponent(context.db, levyInput(), ACTOR);

    const profile = getTaxProfile(context.db);
    expect(profile.totalRateBp).toBe(2_100);
    expect(profile.components.map((component) => component.code)).toEqual([
      'NHIL',
      'COVID',
      'GETFUND',
      'VAT',
    ]);
    // Charged in sortOrder, and it lands on the receipt in that place too.
    expect(applyTax(profile, minor(10_000)).lines.map((line) => [line.code, line.amount])).toEqual([
      ['NHIL', 250],
      ['COVID', 100],
      ['GETFUND', 250],
      ['VAT', 1_500],
    ]);
  });

  it('says in the audit log what was added and at what rate', () => {
    const id = createTaxComponent(context.db, levyInput(), ACTOR);
    expect(auditFor(id)).toEqual(['Added COVID-19 Health Recovery Levy at 1%']);
  });
});

describe('the budget moves a rate', () => {
  it('applies from now on, and the old rate is not left lying around', () => {
    chargeTax();
    const vat = idOf('VAT');

    updateTaxComponent(
      context.db,
      vat,
      {
        code: 'VAT',
        name: 'VAT',
        rateBp: 1_600,
        basis: 'NET',
        isRecoverable: true,
        glAccountId: accountIdFor(context.db, ACCOUNT_CODES.TAX_PAYABLE),
        sortOrder: 30,
      },
      ACTOR,
    );

    const profile = getTaxProfile(context.db);
    expect(profile.totalRateBp).toBe(2_100);
    expect(applyTax(profile, minor(10_000)).total).toBe(2_100);
  });

  it('records the move itself, not just that something was saved', () => {
    const vat = idOf('VAT');

    updateTaxComponent(
      context.db,
      vat,
      {
        code: 'VAT',
        name: 'VAT',
        rateBp: 1_600,
        basis: 'NET_PLUS_LEVIES',
        isRecoverable: true,
        glAccountId: accountIdFor(context.db, ACCOUNT_CODES.TAX_PAYABLE),
        sortOrder: 30,
      },
      ACTOR,
    );

    const [summary] = auditFor(vat);
    // A shop asking "why did my receipts change on Tuesday?" gets an answer.
    expect(summary).toContain('rate 15% to 16%');
    expect(summary).toContain('value plus the levies');
  });

  it('switching to the GRA computation raises the all-in rate to 20.75%', () => {
    chargeTax();

    updateTaxComponent(
      context.db,
      idOf('VAT'),
      {
        code: 'VAT',
        name: 'VAT',
        rateBp: 1_500,
        basis: 'NET_PLUS_LEVIES',
        isRecoverable: true,
        glAccountId: accountIdFor(context.db, ACCOUNT_CODES.TAX_PAYABLE),
        sortOrder: 30,
      },
      ACTOR,
    );

    const profile = getTaxProfile(context.db);
    expect(profile.totalRateBp).toBe(2_075);
    expect(applyTax(profile, minor(10_000)).lines.map((line) => line.amount)).toEqual([
      250,
      250,
      // 15% of 105.00, which is what a Ghanaian VAT invoice should show.
      1_575,
    ]);
  });
});

describe('edits that would make the books unfileable', () => {
  it('refuses to hold tax anywhere but a liability account', () => {
    /**
     * Tax collected is money held FOR the authority. Booked to revenue it
     * becomes money the shop earned: profit overstated by every pesewa
     * collected, and the debt owed nowhere on the balance sheet.
     */
    expect(() =>
      createTaxComponent(
        context.db,
        levyInput({ glAccountId: accountIdFor(context.db, ACCOUNT_CODES.SALES_REVENUE) }),
        ACTOR,
      ),
    ).toThrow(/liability account/i);
  });

  it('refuses a second component with the same code', () => {
    expect(() => createTaxComponent(context.db, levyInput({ code: 'VAT' }), ACTOR)).toThrow(
      /already exists/i,
    );
  });

  it('refuses to rename one component onto another’s code', () => {
    expect(() =>
      updateTaxComponent(
        context.db,
        idOf('NHIL'),
        {
          code: 'VAT',
          name: 'NHIL',
          rateBp: 250,
          basis: 'NET',
          isRecoverable: false,
          glAccountId: accountIdFor(context.db, ACCOUNT_CODES.NHIL_PAYABLE),
          sortOrder: 10,
        },
        ACTOR,
      ),
    ).toThrow(/already exists/i);
  });

  it('refuses a rate nobody could have meant', () => {
    expect(() => createTaxComponent(context.db, levyInput({ rateBp: -1 }), ACTOR)).toThrow(
      /between 0% and 1000%/i,
    );
    expect(() => createTaxComponent(context.db, levyInput({ rateBp: 100_001 }), ACTOR)).toThrow(
      /between 0% and 1000%/i,
    );
    // A percentage typed into a basis-points field is the likely mistake here.
    expect(() => createTaxComponent(context.db, levyInput({ rateBp: 12.5 }), ACTOR)).toThrow(
      /whole number of basis points/i,
    );
  });

  it('refuses a code that is not a code', () => {
    expect(() => createTaxComponent(context.db, levyInput({ code: 'a levy!' }), ACTOR)).toThrow(
      /letters, digits or underscores/i,
    );
    expect(() => createTaxComponent(context.db, levyInput({ code: '   ' }), ACTOR)).toThrow(
      /letters, digits or underscores/i,
    );
  });

  it('refuses a nameless tax, which would print as a blank line on a receipt', () => {
    expect(() => createTaxComponent(context.db, levyInput({ name: '  ' }), ACTOR)).toThrow(
      /Enter a name/i,
    );
  });

  it('takes a lowercase code as the same code', () => {
    expect(() => createTaxComponent(context.db, levyInput({ code: 'vat' }), ACTOR)).toThrow(
      /already exists/i,
    );
  });
});

describe('switching a tax off', () => {
  it('stops it appearing on new sales, and leaves the row where it is', () => {
    chargeTax();
    setTaxComponentActive(context.db, idOf('GETFUND'), false, ACTOR);

    const profile = getTaxProfile(context.db);
    expect(profile.components.map((component) => component.code)).toEqual(['NHIL', 'VAT']);
    expect(profile.totalRateBp).toBe(1_750);
    // Still there to switch back on, and still linked to anything it charged.
    expect(listTaxComponents(context.db).map((row) => row.code)).toContain('GETFUND');
  });

  it('is recorded, because it changes what customers are charged', () => {
    const id = idOf('GETFUND');
    setTaxComponentActive(context.db, id, false, ACTOR);
    expect(auditFor(id)).toEqual(['GETFund switched off']);
  });

  it('says nothing when nothing changed', () => {
    const id = idOf('GETFUND');
    setTaxComponentActive(context.db, id, true, ACTOR);
    expect(auditFor(id)).toEqual([]);
  });
});

describe('what a component has already charged', () => {
  it('is nothing before any sale has used it', () => {
    expect(taxComponentUsage(context.db, idOf('VAT'))).toBe(0);
  });
});
