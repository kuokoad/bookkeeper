import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { LOOKS, LOOK_LABELS, isLook, lookAttribute } from '@/lib/look';
import { featuresFromRow } from '@/lib/business-type';
import { getSettings, updateSettings, type SettingsInput } from '@/services/settings.service';

const CSS = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});

afterEach(() => {
  context.cleanup();
});

function currentAsInput(): SettingsInput {
  const settings = getSettings(context.db);
  return {
    businessName: settings.businessName,
    tagline: settings.tagline,
    address: settings.address,
    phone: settings.phone,
    email: settings.email,
    currencyCode: settings.currencyCode,
    currencySymbol: settings.currencySymbol,
    look: settings.look,
    businessType: settings.businessType,
    features: featuresFromRow(settings),
    taxEnabled: settings.taxEnabled,
    taxInclusive: settings.taxInclusive,
    lowStockThresholdMilli: settings.lowStockThresholdMilli,
    allowNegativeStock: settings.allowNegativeStock,
    expiryWarningDays: settings.expiryWarningDays,
    expiryBlocksSales: settings.expiryBlocksSales,
    allowOverpayment: settings.allowOverpayment,
    defaultTermsDays: settings.defaultTermsDays,
    financialYearStartMonth: settings.financialYearStartMonth,
  };
}

describe('choosing a look', () => {
  it('offers exactly three', () => {
    expect([...LOOKS]).toEqual(['default', 'ledger', 'classic']);
  });

  it('puts nothing on the page for the default look', () => {
    // Every Ledger rule is keyed on the attribute being present, so a shop that
    // has never touched this ships the markup it always did and cannot be
    // reached by those rules even by accident.
    expect(lookAttribute('default')).toEqual({});
  });

  it('names the look when one has been chosen', () => {
    expect(lookAttribute('ledger')).toEqual({ 'data-look': 'ledger' });
  });

  it('refuses anything it does not recognise', () => {
    for (const value of ['', 'LEDGER', 'warm', null, undefined, 1]) {
      expect(isLook(value), String(value)).toBe(false);
    }
  });

  it('has a shop-owner name for every look', () => {
    for (const look of LOOKS) {
      expect(LOOK_LABELS[look].name.length, look).toBeGreaterThan(0);
      expect(LOOK_LABELS[look].blurb.length, look).toBeGreaterThan(0);
    }
  });
});

describe('the shop starts as it always looked', () => {
  it('defaults to the standard look', () => {
    expect(getSettings(context.db).look).toBe('default');
  });

  it('keeps the choice once made', () => {
    updateSettings(context.db, { ...currentAsInput(), look: 'ledger' }, ACTOR);
    expect(getSettings(context.db).look).toBe('ledger');
  });

  it('records the change in the audit log by the name the owner clicked', () => {
    // "ledger" in an audit line means nothing to the person who pressed
    // "Ledger". The log is read by people, not by the code that wrote it.
    updateSettings(context.db, { ...currentAsInput(), look: 'ledger' }, ACTOR);

    const entry = context.connection
      .prepare(
        "SELECT summary FROM audit_logs WHERE entity_type = 'business_settings' ORDER BY id DESC",
      )
      .get() as { summary: string } | undefined;

    expect(entry?.summary).toContain('Look');
    expect(entry?.summary).toContain('Ledger');
    expect(entry?.summary).not.toContain('ledger');
  });

  it('is refused by the database itself, not merely by the form', () => {
    // The enum in `text(..., { enum })` generates no SQL. A raw write, a hand
    // edit of the file, or a future code path must still be rejected, or the
    // app renders a look nothing knows how to paint.
    expect(() =>
      context.connection.prepare("UPDATE business_settings SET look = 'neon' WHERE id = 1").run(),
    ).toThrow(/CHECK constraint failed/i);
  });
});

describe('the CSS behind it', () => {
  it('paints Ledger in light and in both routes into dark', () => {
    // Three states, exactly as the theme has: the device query, the explicit
    // dark attribute, and plain light. Miss one and a person who chose dark
    // gets handed a bright screen by a cosmetic setting.
    expect(CSS).toMatch(/:root\[data-look='ledger'\]\s*\{/);
    expect(CSS).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]{0,160}:root\[data-look='ledger'\]:not\(\[data-theme='light'\]\)/,
    );
    expect(CSS).toMatch(/:root\[data-look='ledger'\]\[data-theme='dark'\]\s*\{/);
  });

  it('guards the device query against an explicit light choice', () => {
    // Same trap the theme has: without the :not(), somebody who chose Light
    // would be handed the dark Ledger palette by a phone set to dark.
    const guarded = CSS.match(
      /:root\[data-look='ledger'\]:not\(\[data-theme='light'\]\)/g,
    );
    expect(guarded).not.toBeNull();
  });

  it('tells the browser the scheme is dark in dark Ledger too', () => {
    // Without `color-scheme`, scrollbars and form controls stay light on a
    // dark page — the same defect, in a new combination.
    expect(CSS).toMatch(
      /:root\[data-look='ledger'\]\[data-theme='dark'\][\s\S]{0,60}color-scheme: dark/,
    );
  });

  it('defines the dark Ledger palette for both routes into it', () => {
    // Once under the media query, once under the explicit attribute. With only
    // one, a third of the combinations would be wrong.
    const occurrences = [...CSS.matchAll(/--surface-raised: oklch\(0\.25 0\.018 64\)/g)].length;
    expect(occurrences).toBe(2);
  });

  it('keeps the Stitch colours off every look but Standard', () => {
    // The shell overrides sit on a descendant of <html>, so without a guard
    // they beat whatever a look paints on :root. That is how light Ledger came
    // out Stitch blue-grey and green instead of sand and sage, and how Classic
    // would have shown nothing of its own.
    const overrides = [...CSS.matchAll(/^\s*([^\n{]*\.(?:app-shell|stitch-sidebar))\s*\{[^}]*--(?:surface|accent|sidebar):/gm)];
    expect(overrides.length).toBe(3);
    for (const [, selector] of overrides) {
      expect(selector, selector).toContain(':not([data-look])');
    }
  });

  it('keeps Classic once chosen and marks the page with it', () => {
    updateSettings(context.db, { ...currentAsInput(), look: 'classic' }, ACTOR);
    expect(getSettings(context.db).look).toBe('classic');
    expect(lookAttribute('classic')).toEqual({ 'data-look': 'classic' });
  });

  it('gives Classic a dark of its own, through both routes into dark', () => {
    // Stitch never repainted dark, so without these Classic after sunset is
    // Standard after sunset, and a shop that chose it sees no choice at all.
    // Once under the device query (guarded against an explicit Light), once
    // under the explicit attribute, both telling the browser it is dark.
    expect(CSS).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\[data-look='classic'\]:not\(\[data-theme='light'\]\)\s*\{\s*color-scheme: dark/,
    );
    expect(CSS).toMatch(/:root\[data-look='classic'\]\[data-theme='dark'\]\s*\{\s*color-scheme: dark/);
    expect([...CSS.matchAll(/--surface-raised: oklch\(0\.31 0\.022 250\)/g)]).toHaveLength(2);

    // Visibly not Standard's dark: a different ground and a different accent.
    const standardDark = CSS.match(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/)![1]!;
    const classicDark = CSS.match(/:root\[data-look='classic'\]\[data-theme='dark'\]\s*\{([^}]*)\}/)![1]!;
    for (const token of ['--surface', '--surface-raised', '--accent', '--sidebar']) {
      const value = (body: string) => body.match(new RegExp(`${token}: ([^;]+);`))?.[1];
      expect(value(classicDark), token).toBeDefined();
      expect(value(classicDark), token).not.toBe(value(standardDark));
    }
  });

  it('leaves Ledger its paper: rounded cards with a shadow', () => {
    // Stitch flattens cards and squares every corner, from rules that beat
    // the tokens Ledger sets on :root. Each must step aside for Ledger, or it
    // comes out as flat square panels in warm colours.
    const NOT_LEDGER = ":root:not([data-look='ledger'])";
    // Every rule's full selector, paired with its body.
    const plain = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...plain.matchAll(/(?<=^|})\s*([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
      selectors: selector!.split(',').map((part) => part.trim()),
      body: body!,
    }));

    const cardTokens = rules.filter(
      (rule) => /--card-(radius|shadow)/.test(rule.body) && rule.selectors.some((s) => s.includes('.app-shell')),
    );
    const squared = rules.filter(
      (rule) =>
        /border-radius: 0(\.125rem)? ?(!important)?;/.test(rule.body) &&
        // The print sheet is paper whatever the look; it flattens cards on purpose.
        !rule.selectors.some((s) => s === 'article' || s.startsWith('.app-main')),
    );

    expect(cardTokens).toHaveLength(1);
    expect(squared).toHaveLength(2);
    for (const rule of [...cardTokens, ...squared]) {
      for (const selector of rule.selectors) {
        expect(selector, selector).toContain(NOT_LEDGER);
      }
    }
  });

  it('leaves the default look on the values it already had', () => {
    // The card tokens exist so a look can change how a card sits on the page.
    // The default's values must be what the app rendered before they existed,
    // or adding them silently restyled every screen.
    expect(CSS).toMatch(/--card-radius: 0\.75rem/);
    expect(CSS).toMatch(/--card-shadow: none/);
  });
});
