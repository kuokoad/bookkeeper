import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What comes out of the printer.
 *
 * Asserted against the stylesheet rather than a rendered page because print
 * output cannot be captured in a test: no headless browser here produces a
 * sheet of A4 to look at. These rules are load-bearing all the same — one of
 * them is the only thing stopping a customer's invoice carrying a localhost URL
 * across the top — so they are pinned here rather than trusted to survive the
 * next person tidying the stylesheet.
 */

const CSS = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');
const RECEIPT = readFileSync(
  join(process.cwd(), 'src', 'app', '(app)', 'sales', '[id]', 'receipt', 'page.tsx'),
  'utf8',
);

/** The `@page` block, whitespace collapsed. */
const pageRule = (source: string): string | null => {
  const match = /@page\s*\{([^}]*)\}/.exec(source);
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : null;
};

describe('the paper a document prints on', () => {
  it('sets A4, because these are business papers', () => {
    expect(pageRule(CSS)).toMatch(/size:\s*A4/i);
  });

  /**
   * The rule most likely to be "cleaned up" by someone who reads margin: 0 as an
   * oversight. Chrome draws the page URL, the title and the date into the page
   * margin, and no CSS deletes that text — removing the space it occupies is the
   * only way. An invoice reading "localhost:5177/sales/14/invoice" is what this
   * prevents, and the comment above it in globals.css says so.
   */
  it('takes the page margin away, so the browser has nowhere to print its own furniture', () => {
    expect(pageRule(CSS)).toMatch(/margin:\s*0/);
  });

  it('puts the margin back as padding, so nothing is clipped at the paper edge', () => {
    const printBlock = /@media print\s*\{([\s\S]*)\n\}/.exec(CSS)?.[1] ?? '';
    expect(printBlock).toMatch(/body\s*\{[^}]*padding:\s*\d+mm/);
  });
});

describe('a table that runs past one sheet', () => {
  const printBlock = /@media print\s*\{([\s\S]*)\n\}/.exec(CSS)?.[1] ?? '';

  it('repeats its column headings on every sheet', () => {
    expect(printBlock).toMatch(/thead\s*\{[^}]*table-header-group/);
  });

  /**
   * Half an amount on one sheet and half on the next is not a fault a reader
   * spots. It is a figure they read wrongly.
   */
  it('never splits a row down the middle', () => {
    expect(printBlock).toMatch(/tr,[\s\S]{0,40}\{[^}]*break-inside:\s*avoid/);
  });

  it('does not strand a heading at the foot of a sheet', () => {
    expect(printBlock).toMatch(/h3\s*\{[^}]*break-after:\s*avoid/);
  });

  it('does not leave a single line of a paragraph behind', () => {
    expect(printBlock).toMatch(/orphans:\s*[2-9]/);
    expect(printBlock).toMatch(/widows:\s*[2-9]/);
  });
});

describe('the small print', () => {
  it('prints muted text as ink rather than as screen grey', () => {
    const printBlock = /@media print\s*\{([\s\S]*)\n\}/.exec(CSS)?.[1] ?? '';
    expect(printBlock).toMatch(/text-content-muted/);
  });
});

describe('a receipt, which is not a business paper', () => {
  /**
   * `auto` rather than A4 or 80mm. The shop has an A4 printer today and may
   * have a till roll next year, and the person at the printer has already told
   * the dialog which paper they loaded. Guessing either way is wrong half the
   * time; deferring to the dialog is right both times.
   */
  it('follows whatever paper the dialog was given, on its own route', () => {
    expect(RECEIPT).toMatch(/@page\s*\{\s*size:\s*auto/);
  });

  it('does not inherit the A4 document margin, which would waste most of a roll', () => {
    expect(RECEIPT).toMatch(/body\s*\{\s*padding:\s*\dmm/);
  });

  /**
   * A receipt printed on A4 with the roll's 4mm ran its figures out to the
   * paper edge, where a printer cannot mark and the last column can be clipped.
   * In print a media query measures the page, so this asks whether the paper is
   * a sheet or a roll and pads accordingly.
   */
  it('pads like a sheet when the paper is a sheet', () => {
    expect(RECEIPT).toMatch(/@media print and \(min-width: \d+mm\)/);
    const sheetRule = /@media print and \(min-width: \d+mm\)\s*\{[^}]*\{([^}]*)\}/.exec(RECEIPT);
    expect(sheetRule?.[1]).toMatch(/padding:\s*14mm/);
  });

  it('keeps that rule on the receipt route only', () => {
    // @page cannot be scoped to a component, so the scoping IS the route. If
    // this ever moved into globals.css it would override A4 for every document.
    expect(CSS).not.toMatch(/size:\s*auto/);
  });
});

/**
 * What must NOT come out of the printer.
 *
 * A receipt printed before these rules existed carried the top bar, the shop
 * name, a Sign out button and the mobile navigation, then pushed a second blank
 * sheet out carrying the navigation again. Every one of those is chrome for
 * working the app, and none of it belongs on paper a customer keeps.
 */
describe('the application shell', () => {
  const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

  it('hides the top bar', () => {
    expect(source('src', 'components', 'shared', 'top-bar.tsx')).toMatch(
      /<header className="no-print/,
    );
  });

  it('hides the mobile bottom navigation', () => {
    expect(source('src', 'components', 'shared', 'app-nav.tsx')).toMatch(
      /className="no-print fixed inset-x-0 bottom-0/,
    );
  });

  it('hides the sidebar', () => {
    expect(source('src', 'app', '(app)', 'layout.tsx')).toMatch(/<aside className="no-print/);
  });

  /**
   * Hiding the chrome is not enough on its own: the space reserved for it still
   * prints, and a viewport-height minimum plus the gap left for the mobile bar
   * is what produced the blank second sheet.
   */
  it('reclaims the space that chrome occupied, so no blank sheet follows', () => {
    const layout = source('src', 'app', '(app)', 'layout.tsx');
    expect(layout).toMatch(/className="app-shell/);
    expect(layout).toMatch(/className="app-main/);

    const printBlock = /@media print\s*\{([\s\S]*)\n\}/.exec(CSS)?.[1] ?? '';
    expect(printBlock).toMatch(/\.app-shell\s*\{[^}]*min-height:\s*0/);
    expect(printBlock).toMatch(/\.app-main\s*\{[^}]*padding:\s*0/);
  });
});

/**
 * Plain paper.
 *
 * The first invoice printed came out with a rounded, bordered box drawn around
 * it and half the sheet empty beside it. That is the screen's card rendered
 * onto paper, where the sheet is already the card.
 */
describe('the document on the page', () => {
  const printBlock = /@media print\s*\{([\s\S]*)\n\}/.exec(CSS)?.[1] ?? '';

  it('uses the full width of the sheet', () => {
    expect(printBlock).toMatch(/\.app-main > \.motion-page > \*\s*\{[^}]*max-width:\s*none/);
  });

  it('draws no box around itself', () => {
    expect(printBlock).toMatch(/article,[\s\S]{0,40}\{[^}]*border:\s*0/);
    expect(printBlock).toMatch(/article,[\s\S]{0,40}\{[^}]*border-radius:\s*0/);
    expect(printBlock).toMatch(/article,[\s\S]{0,40}\{[^}]*box-shadow:\s*none/);
  });

  /**
   * Card sets radius and shadow as INLINE styles, which a plain rule cannot
   * reach. Without !important the corners stay rounded on every report.
   */
  it('overrides the inline styles Card sets', () => {
    const cardRule = /article,[\s\S]{0,40}\{([^}]*)\}/.exec(printBlock)?.[1] ?? '';
    for (const property of ['border', 'border-radius', 'box-shadow', 'background']) {
      expect(cardRule).toMatch(new RegExp(`${property}:[^;]*!important`));
    }
  });

  it('keeps nested cards padded, so a report does not run together', () => {
    // Only the OUTERMOST card is flattened to zero padding.
    expect(printBlock).toMatch(/> \* > article,[\s\S]{0,60}> \* > section\s*\{[^}]*padding:\s*0/);
  });
});
