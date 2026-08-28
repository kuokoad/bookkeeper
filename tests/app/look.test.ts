import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { LOOKS, LOOK_LABELS, isLook, lookAttribute } from '@/lib/look';
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
  it('offers exactly two', () => {
    expect([...LOOKS]).toEqual(['default', 'ledger']);
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

  it('leaves the default look on the values it already had', () => {
    // The card tokens exist so a look can change how a card sits on the page.
    // The default's values must be what the app rendered before they existed,
    // or adding them silently restyled every screen.
    expect(CSS).toMatch(/--card-radius: 0\.75rem/);
    expect(CSS).toMatch(/--card-shadow: none/);
  });
});
