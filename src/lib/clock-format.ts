/**
 * How the dashboard clock is written, in one place.
 *
 * The server renders the first paint and the browser takes over a moment
 * later. When those two used separate `Intl.DateTimeFormat` configs they had to
 * be edited in lockstep, and during this very change they were briefly out of
 * step — the server showing `09:14 pm` while the browser showed `09:14:10 pm`,
 * which is exactly the reflow the initial values exist to prevent.
 *
 * Deliberately free of both `server-only` and `'use client'`: it is used from
 * both sides, and it touches nothing but the clock.
 */

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

export const formatClockDate = (at: Date): string => DATE_FORMAT.format(at);
export const formatClockTime = (at: Date): string => TIME_FORMAT.format(at);

/**
 * Milliseconds until the next whole second.
 *
 * A plain one-second interval drifts: each tick starts a fraction late, and the
 * error accumulates until a displayed second is skipped entirely — `:07`
 * followed by `:09`. Scheduling to the boundary instead keeps the digits
 * honest, and re-scheduling after each tick means a slow frame cannot push the
 * clock permanently off the beat.
 *
 * Never returns 0: a zero-delay timer that immediately reschedules itself at
 * the same instant is a busy loop.
 */
export function msUntilNextSecond(nowMs: number): number {
  const remainder = nowMs % 1000;
  return remainder === 0 ? 1000 : 1000 - remainder;
}
