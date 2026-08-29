import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  FEATURES,
  FEATURE_KEYS,
  defaultFeatures,
  featuresFromRow,
  isBusinessType,
  isFeatureKey,
  resolveFeatures,
  visible,
  type FeatureKey,
} from '@/lib/business-type';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

describe('the business types on offer', () => {
  it('offers exactly the three a shop can choose', () => {
    expect(BUSINESS_TYPES).toEqual(['general_retail', 'building_materials', 'other']);
  });

  it('refuses anything that is not one of them', () => {
    for (const value of ['', 'GENERAL_RETAIL', 'pharmacy', 'general retail', null, undefined, 1]) {
      expect(isBusinessType(value)).toBe(false);
    }
    for (const value of BUSINESS_TYPES) expect(isBusinessType(value)).toBe(true);
  });

  it('has words for every one of them', () => {
    for (const type of BUSINESS_TYPES) {
      expect(BUSINESS_TYPE_LABELS[type].name.length).toBeGreaterThan(0);
      expect(BUSINESS_TYPE_LABELS[type].blurb.length).toBeGreaterThan(0);
    }
  });
});

describe('the features a type can put away', () => {
  it('refuses a key it does not know', () => {
    for (const key of FEATURE_KEYS) expect(isFeatureKey(key)).toBe(true);
    for (const value of ['', 'EXPIRY_BATCHES', 'deliveries', null, 1]) {
      expect(isFeatureKey(value)).toBe(false);
    }
  });

  /**
   * The test that catches a fourth business type added without anyone deciding
   * what it does with each feature. TypeScript catches it too; this says so in
   * words a reviewer reads.
   */
  it('says where every feature starts for every type', () => {
    for (const key of FEATURE_KEYS) {
      const feature = FEATURES[key];
      expect(feature.key).toBe(key);
      expect(feature.name.length).toBeGreaterThan(0);
      expect(feature.blurb.length).toBeGreaterThan(0);
      expect(feature.hides.length).toBeGreaterThan(0);
      expect(feature.column.length).toBeGreaterThan(0);
      for (const type of BUSINESS_TYPES) {
        expect(typeof feature.defaultOn[type]).toBe('boolean');
      }
    }
  });

  it('gives a key storage, or it is not a key', () => {
    const schema = source('src', 'db', 'schema', 'system.ts');
    for (const key of FEATURE_KEYS) {
      expect(schema).toContain(`'${FEATURES[key].column}'`);
    }
  });
});

describe('where each type starts', () => {
  /**
   * General retail is NOT "every switch on", and stopped being so the moment a
   * second feature existed. It is the ordinary provisions shop: it dates its
   * stock, and it does not write quotes. "Everything on" is what `other` means,
   * which is the type to choose when neither of the others fits.
   */
  it('gives a provisions shop dates but not quotes', () => {
    expect(defaultFeatures('general_retail')).toEqual({
      expiry_batches: true,
      quotations: false,
    });
  });

  it('gives a materials yard quotes but not dates', () => {
    expect(defaultFeatures('building_materials')).toEqual({
      expiry_batches: false,
      quotations: true,
    });
  });

  it('means everything when the shop says "something else"', () => {
    for (const on of Object.values(defaultFeatures('other'))) expect(on).toBe(true);
  });

  it('puts dates away for a building materials yard', () => {
    expect(defaultFeatures('building_materials').expiry_batches).toBe(false);
  });
});

describe('a switch the owner has moved', () => {
  it('beats the type it started from, in both directions', () => {
    expect(resolveFeatures('building_materials', { expiry_batches: true, quotations: true }).expiry_batches).toBe(true);
    expect(resolveFeatures('general_retail', { expiry_batches: false, quotations: true }).expiry_batches).toBe(false);
  });

  it('falls back to the type when nothing was moved', () => {
    expect(resolveFeatures('building_materials')).toEqual(defaultFeatures('building_materials'));
    expect(resolveFeatures('general_retail', {})).toEqual(defaultFeatures('general_retail'));
  });

  it('is what a settings row is read as', () => {
    expect(
      featuresFromRow({ businessType: 'building_materials', featureExpiryBatches: true, featureQuotations: true }),
    ).toEqual({ expiry_batches: true, quotations: true });
    expect(
      featuresFromRow({ businessType: 'general_retail', featureExpiryBatches: false, featureQuotations: true }),
    ).toEqual({ expiry_batches: false, quotations: true });
  });

  it('shows everything when the stored type is not one we know', () => {
    // A hand-edited database file, or a column written by something that has
    // never heard of this list. The worst outcome must be a menu entry nobody
    // needed, never a shop that cannot find a feature it uses.
    expect(
      featuresFromRow({
        businessType: 'pharmacy',
        featureExpiryBatches: true,
        featureQuotations: true,
      }),
    ).toEqual({ expiry_batches: true, quotations: true });
  });
});

describe('hiding a menu entry', () => {
  const items = [
    { href: '/sales', label: 'Sales' },
    { href: '/dates', label: 'Dates', feature: 'expiry_batches' as FeatureKey },
  ];

  it('keeps everything a shop is offered', () => {
    expect(visible(items, { expiry_batches: true, quotations: true })).toHaveLength(2);
  });

  it('drops only what belongs to a feature that is off', () => {
    const shown = visible(items, { expiry_batches: false, quotations: true });
    expect(shown.map((item) => item.href)).toEqual(['/sales']);
  });

  it('never drops an entry that names no feature', () => {
    const plain: { href: string; feature?: FeatureKey }[] = [{ href: '/dashboard' }];
    expect(visible(plain, { expiry_batches: false, quotations: true })).toHaveLength(1);
  });
});

describe('the lists that declare a feature', () => {
  /**
   * A typo in a `feature:` key would hide nothing, silently, forever — the
   * filter would look up an undefined switch and keep the item. Cheaper to
   * assert here than to notice in a shop.
   */
  it('only ever name a feature that exists', () => {
    const files = [
      ['src', 'components', 'shared', 'navigation.ts'],
      ['src', 'app', '(app)', 'reports', 'page.tsx'],
      ['src', 'app', '(app)', 'accounting', 'page.tsx'],
    ];
    for (const parts of files) {
      for (const match of source(...parts).matchAll(/feature: '([^']+)'/g)) {
        expect(isFeatureKey(match[1])).toBe(true);
      }
    }
  });
});

describe('the places a hidden feature is filtered out', () => {
  it('filters the menu in the app layout, beside the permission check', () => {
    const layout = source('src', 'app', '(app)', 'layout.tsx');
    expect(layout).toContain('visible(');
    expect(layout).toContain('featuresFromRow(settings)');
    // From the row the layout already read for the shop name, never a second
    // query: the name and the menu must be two readings of one row.
    expect(layout).not.toContain('getFeatures()');
  });

  it('filters the two hand-written index lists, which no menu filter reaches', () => {
    for (const parts of [
      ['src', 'app', '(app)', 'reports', 'page.tsx'],
      ['src', 'app', '(app)', 'accounting', 'page.tsx'],
    ]) {
      expect(source(...parts), parts.join('/')).toContain('visible(');
    }
  });

  /**
   * A business type is not a permission and must never behave like one. If a
   * page ever guarded on a feature, a record written before the shop changed
   * type would stop opening from a link or a search result.
   */
  it('never guards a route', () => {
    for (const parts of [
      ['src', 'app', '(app)', 'layout.tsx'],
      ['src', 'app', '(app)', 'reports', 'page.tsx'],
      ['src', 'app', '(app)', 'accounting', 'page.tsx'],
    ]) {
      const text = source(...parts);
      expect(text).not.toMatch(/redirect\([^)]*feature/i);
      expect(text).not.toMatch(/requirePageAccess\([^)]*feature/i);
    }
  });
});

describe('the menu key stays parseable', () => {
  /**
   * `page-guards.test.ts` parses navigation.ts with a regex that stops at the
   * first `}`. A `feature` value that was an object or a template literal would
   * truncate the match, and the item's `module` would silently vanish from the
   * check that a menu link never demands more than the page behind it.
   */
  it('is always a bare quoted string on the item line', () => {
    const nav = source('src', 'components', 'shared', 'navigation.ts');
    for (const line of nav.split(/\r?\n/)) {
      if (!line.includes('feature:') || line.trim().startsWith('*')) continue;
      if (line.includes('feature?:')) continue;
      expect(line).toMatch(/feature: '[a-z_]+'/);
    }
  });
});

/**
 * Quotations is the first feature that is BOTH a permission and a shop-type
 * switch, and the two must not be confused. The permission decides whether this
 * person may see it. The feature decides whether this shop was ever offered it.
 */
describe('the quotations menu entry', () => {
  const nav = () => source('src', 'components', 'shared', 'navigation.ts');

  it('declares its permission and its feature, on one line', () => {
    const line = nav()
      .split(/\r?\n/)
      .find((row) => row.includes("href: '/quotations'"));
    expect(line).toBeDefined();
    expect(line).toContain("module: 'quotations'");
    expect(line).toContain("feature: 'quotations'");
  });

  it('is named in plain words on the no-access page, not as a slug', () => {
    const modules = source('src', 'components', 'shared', 'modules.ts');
    expect(modules).toContain("module: 'quotations'");
    expect(modules).toContain("label: 'Quotations'");
  });

  it('is a real permission module the database will accept', () => {
    const users = source('src', 'db', 'schema', 'users.ts');
    const tuple = /PERMISSION_MODULES = \[([\s\S]*?)\] as const/.exec(users)?.[1] ?? '';
    expect(tuple).toContain("'quotations'");
  });

  /**
   * A page guarded on the feature would stop a converted quote opening from
   * the number printed on a customer's copy. Only the permission guards.
   */
  it('never guards a quotations page on the feature', () => {
    for (const parts of [
      ['src', 'app', '(app)', 'quotations', 'page.tsx'],
      ['src', 'app', '(app)', 'quotations', '[id]', 'page.tsx'],
      ['src', 'app', '(app)', 'quotations', '[id]', 'print', 'page.tsx'],
    ]) {
      const page = source(...parts);
      expect(page).toContain("requirePageAccess('quotations'");
      expect(page).not.toContain('getFeatures');
      expect(page).not.toContain('featuresFromRow');
    }
  });
});
