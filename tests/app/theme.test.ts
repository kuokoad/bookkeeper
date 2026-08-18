import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { THEMES, isTheme, themeAttribute } from '@/lib/theme';

const CSS = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');

describe('choosing a colour scheme', () => {
  it('offers exactly three states', () => {
    expect([...THEMES]).toEqual(['system', 'light', 'dark']);
  });

  it('puts nothing on the page when following the device', () => {
    // An attribute of any kind would override the media query, which is the
    // whole point of "system".
    expect(themeAttribute('system')).toEqual({});
  });

  it('names the choice when one has been made', () => {
    expect(themeAttribute('light')).toEqual({ 'data-theme': 'light' });
    expect(themeAttribute('dark')).toEqual({ 'data-theme': 'dark' });
  });

  it('refuses anything it does not recognise', () => {
    for (const value of ['', 'blue', 'DARK', null, undefined, 1]) {
      expect(isTheme(value), String(value)).toBe(false);
    }
  });
});

describe('the CSS behind it', () => {
  it('guards the device query against an explicit light choice', () => {
    // Without the :not(), someone who chose Light would still be handed the
    // dark palette by a phone set to dark — the setting would appear broken
    // for exactly the people who bothered to use it.
    expect(CSS).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]{0,120}:root:not\(\[data-theme='light'\]\)/);
  });

  it('has a dark block that wins regardless of the device', () => {
    expect(CSS).toMatch(/:root\[data-theme='dark'\]\s*\{/);
  });

  it('tells the browser which scheme is in use', () => {
    // Without `color-scheme`, scrollbars and form controls stay light on a
    // dark page.
    expect(CSS).toMatch(/:root\[data-theme='dark'\][\s\S]{0,80}color-scheme: dark/);
    expect(CSS).toMatch(/:root\[data-theme='light'\][\s\S]{0,80}color-scheme: light/);
  });

  it('defines the dark palette for both routes into it', () => {
    // The same token, once under the media query and once under the explicit
    // attribute. If only one existed, one of the three states would be wrong.
    const occurrences = [...CSS.matchAll(/--surface-raised: oklch\(0\.23/g)].length;
    expect(occurrences).toBe(2);
  });

  it('shows only one half of the switch at a time', () => {
    // The switch is two buttons; CSS picks which is visible. Under "match my
    // device" the server cannot know which way the switch should point, so the
    // browser decides — which is the only place that knows.
    expect(CSS).toMatch(/\.theme-when-dark \{\s*display: none/);
    expect(CSS).toMatch(/:root\[data-theme='dark'\] \.theme-when-light \{\s*display: none/);
    expect(CSS).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]{0,200}\.theme-when-light \{\s*display: none/,
    );
  });

  it('still has a light palette on bare :root', () => {
    // The default, and what an explicit light choice falls back to.
    const root = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('@media (prefers-color-scheme'));
    expect(root).toMatch(/--surface: oklch\(0\.99/);
  });
});
