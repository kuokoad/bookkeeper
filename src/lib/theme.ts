/**
 * The colour scheme preference.
 *
 * Stored in a cookie rather than against the user, deliberately. It is a
 * property of the screen you are looking at, not of who you are: the counter PC
 * in a bright shop and the owner's phone at midnight want different answers,
 * and the same person uses both. A per-user setting would fight that.
 *
 * This half is pure so it can be tested and, if ever needed, used from a client
 * component. Reading the cookie lives in `theme.server.ts`.
 */

export const THEME_COOKIE = 'bk_theme';
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/**
 * What to put on `<html>`.
 *
 * 'system' sets nothing at all, which is what lets the media query decide.
 */
export function themeAttribute(theme: Theme): { 'data-theme'?: 'light' | 'dark' } {
  return theme === 'system' ? {} : { 'data-theme': theme };
}
