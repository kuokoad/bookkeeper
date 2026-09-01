import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Screens that described something other than what they did.
 *
 * Three separate places told the shop owner one thing while the figures beside
 * them did another. None of them was a wrong number — which is why none could
 * be caught by asserting on the ledger, and why they are pinned here against
 * the page source, in the same way `print.test.ts` pins the print rules.
 */

/**
 * The file with its comments taken out.
 *
 * These assertions are about what the page RENDERS, and each fix carries a
 * comment explaining what the old wording was and why it went — which is
 * exactly the string the test then looks for the absence of. Reading the code
 * alone keeps a note about a defect from being mistaken for the defect.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

const read = (...parts: string[]): string =>
  stripComments(readFileSync(join(process.cwd(), 'src', ...parts), 'utf8'));

const DASHBOARD = read('app', '(app)', 'dashboard', 'page.tsx');
const RECEIVABLES = read('app', '(app)', 'accounting', 'receivables', 'page.tsx');
const PAYABLES = read('app', '(app)', 'accounting', 'payables', 'page.tsx');
const BALANCE_SHEET = read('app', '(app)', 'reports', 'balance-sheet', 'page.tsx');

describe('"Total debits" means one thing across the application', () => {
  /**
   * The Accounting hub, the Trial balance page and the health check all sum the
   * gross debits ever posted. The dashboard summed net account balances and
   * called it the same thing, so clicking through from the card changed the
   * figure by hundreds of thousands without changing what it claimed to be.
   */
  it('the dashboard uses the same measure as the rest of the app', () => {
    expect(DASHBOARD).toContain('checkBooksIntegrity');
    expect(DASHBOARD).not.toContain('getTrialBalance');
  });
});

describe('the ageing tables name the date they age from', () => {
  it('receivables says it ages from the due date, because it does', () => {
    expect(RECEIVABLES).toContain('fell due');
    expect(RECEIVABLES).not.toContain('Age is measured from the date of each sale');
  });

  it('payables still says the delivery date, because that is what it uses', () => {
    expect(PAYABLES).toContain('Age is measured from the date of each delivery');
  });

  /**
   * One shared table, two meanings. Receivables shows the oldest DUE date,
   * which can be in the future; payables shows the oldest delivery. Under a
   * bare "Oldest" a customer whose only unpaid invoice was dated 10 August
   * read 09 September.
   */
  it('each page names its own date column', () => {
    expect(RECEIVABLES).toContain('dateHeading="Oldest due"');
    expect(PAYABLES).toContain('dateHeading="Oldest delivery"');
  });
});

describe('the balance sheet and the banner above it agree', () => {
  /**
   * The footnote said there was no year-end closing step to run, on a page
   * whose own banner tells the shop to run one — and `year-end-close.ts` does
   * post closing entries. Both cannot be true.
   */
  it('does not deny the closing step the application provides', () => {
    expect(BALANCE_SHEET).not.toContain('there is no year-end closing step to run');
  });

  it('still explains why this statement does not wait on it', () => {
    expect(BALANCE_SHEET).toContain('whether or not the year has been closed');
  });
});

describe('the stock card counts stock', () => {
  /**
   * Products / Low / Out sit side by side under a heading of "Stock", and Low
   * and Out have always counted only stock-tracked products. Products counted
   * every product, so the card read 12 while Inventory read 11 — the odd one
   * being "Cartage to site", a service that is sold but never held.
   */
  it('counts the products it actually holds, like the two figures beside it', () => {
    expect(DASHBOARD).toContain('stock.trackedCount');
    expect(DASHBOARD).not.toContain('stock.productCount');
  });
});

describe('the login screen names a tab that exists', () => {
  /**
   * The demo panel pointed at "Sign in with PIN" — the label on the submit
   * BUTTON inside the tab. So the one name offered to help somebody find the
   * tab was the one name not written on it.
   */
  const LOGIN_PAGE = read('app', '(auth)', 'login', 'page.tsx');
  const LOGIN_FORM = read('app', '(auth)', 'login', 'login-form.tsx');

  it('points at the tab label, not the button inside it', () => {
    expect(LOGIN_PAGE).toContain('Till PIN</span> tab');
    expect(LOGIN_PAGE).not.toContain('Sign in with PIN</span> tab');
  });

  it('and that label is the one the tab really carries', () => {
    expect(LOGIN_FORM).toContain("'Till PIN'");
  });
});
