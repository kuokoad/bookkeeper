import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { formatClockDate, formatClockTime, msUntilNextSecond } from '@/lib/clock-format';

/**
 * The clock's behaviour, tested through the functions it actually calls rather
 * than by matching the text of its source. An earlier version of these checks
 * asserted on raw source (`setInterval(tick, 1_000)`), which would fail on a
 * harmless reformat while missing real breakage.
 */

describe('scheduling the next tick', () => {
  it('waits until the next whole second', () => {
    expect(msUntilNextSecond(1_000)).toBe(1000);
    expect(msUntilNextSecond(1_400)).toBe(600);
    expect(msUntilNextSecond(1_999)).toBe(1);
  });

  it('never schedules a zero delay', () => {
    // A zero-delay timer that reschedules itself at the same instant is a
    // busy loop, and would peg a till's CPU.
    for (const ms of [0, 1000, 2000, 1_755_000_000_000]) {
      expect(msUntilNextSecond(ms), String(ms)).toBeGreaterThan(0);
    }
  });

  it('always lands exactly on a boundary', () => {
    // Whatever the starting offset, now + delay must be a whole second — that
    // is what stops the display drifting and skipping a value.
    for (let offset = 0; offset < 1000; offset += 37) {
      const now = 1_700_000_000_000 + offset;
      expect((now + msUntilNextSecond(now)) % 1000, String(offset)).toBe(0);
    }
  });

  it('never waits longer than a second', () => {
    for (let offset = 0; offset < 1000; offset += 13) {
      expect(msUntilNextSecond(1_700_000_000_000 + offset)).toBeLessThanOrEqual(1000);
    }
  });
});

describe('how the clock reads', () => {
  const at = new Date(2026, 7, 18, 21, 14, 7);

  it('shows seconds, so a stopped clock is obvious', () => {
    expect(formatClockTime(at)).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('names the day, which is what a shop actually wants', () => {
    expect(formatClockDate(at)).toContain('Tuesday');
    expect(formatClockDate(at)).toContain('2026');
  });
});

describe('the server and the browser agree', () => {
  const CLOCK = readFileSync(join(process.cwd(), 'src', 'components', 'shared', 'clock.tsx'), 'utf8');
  const DASHBOARD = readFileSync(
    join(process.cwd(), 'src', 'app', '(app)', 'dashboard', 'page.tsx'),
    'utf8',
  );

  it('both sides format through the same functions', () => {
    // Two copies of the Intl config drifted apart mid-change once already,
    // rendering the header at one width and then reflowing it.
    for (const source of [CLOCK, DASHBOARD]) {
      expect(source).toContain('formatClockTime');
      expect(source).toContain('formatClockDate');
    }
  });

  it('neither side builds its own formatter', () => {
    for (const source of [CLOCK, DASHBOARD]) {
      expect(source).not.toContain('Intl.DateTimeFormat');
    }
  });

  it('the clock still runs in the browser', () => {
    // Rendered on the server it would show the time the page was opened, for
    // as long as the page stayed open.
    expect(CLOCK.trimStart().startsWith("'use client'")).toBe(true);
  });

  it('it recovers after a hidden tab or a sleeping machine', () => {
    // Browsers throttle hidden-tab timers; without this the clock comes back
    // frozen, which is the impression the seconds were added to dispel.
    expect(CLOCK).toContain('visibilitychange');
    expect(CLOCK).toContain('clearTimeout');
  });
});
