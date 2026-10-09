import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '@/components/ui/icon';
import { NAV_SECTIONS } from '@/components/shared/navigation';

describe('offline Stitch assets', () => {
  it('serves genuine local font files with the matching CSS formats', () => {
    expect(readFileSync('public/fonts/InterVariable.woff2').subarray(0, 4).toString()).toBe('wOF2');
    expect(readFileSync('public/fonts/MaterialSymbolsOutlined.ttf').readUInt32BE(0)).toBe(0x00010000);
    const css = readFileSync('src/app/globals.css', 'utf8');
    expect(css).toContain("url('/fonts/InterVariable.woff2') format('woff2')");
    expect(css).toContain("url('/fonts/MaterialSymbolsOutlined.ttf') format('truetype')");
    expect(css).not.toContain('fonts.googleapis.com');
    expect(css).not.toContain('fonts.gstatic.com');
  });
  it('uses decorative prototype glyphs rather than announcing icon names', () => {
    const icon = renderToStaticMarkup(<Icon name="notifications" />);
    expect(icon).toContain('aria-hidden="true"');
    expect(icon).toContain('notifications</span>');
    expect(renderToStaticMarkup(<Icon name="sales" />)).toContain('shopping_cart</span>');
    expect(renderToStaticMarkup(<Icon name="bank" />)).toContain('account_balance</span>');
  });
  it('keeps reconciliation navigation protected by its own permission', () => {
    const item = NAV_SECTIONS.flatMap((section) => section.items).find((item) => item.href === '/reconciliation');
    expect(item?.module).toBe('reconciliation');
  });
});
