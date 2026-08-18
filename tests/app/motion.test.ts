import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The rules motion in this application has to keep.
 *
 * Both are the kind of thing that holds when written and quietly stops holding
 * three features later, so they are checked rather than trusted.
 */

const CSS = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const files = sourceFiles(join(process.cwd(), 'src'));

describe('someone who asked for stillness gets it', () => {
  it('has a reduced-motion block', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('switches the entrance animations off entirely, not merely shortens them', () => {
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    // Shortening the duration still lets the element jump from its offset
    // start position, which is movement — exactly what was opted out of.
    expect(block).toMatch(/\.motion-page,[\s\S]{0,120}animation: none !important/);
  });
});

describe('printing', () => {
  it('renders the final state, never mid-entrance', () => {
    const block = CSS.slice(CSS.indexOf('@media print'));
    expect(block).toMatch(/animation: none !important/);
    expect(block).toMatch(/opacity: 1 !important/);
  });
});

describe('nothing animates a figure', () => {
  it('no element carries both a motion class and the money class', () => {
    // `tabular` marks money and quantities. A number sliding or fading into
    // place reads as the value still being uncertain, which is the last
    // impression a set of books should give.
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // Every className string in the file, single or double quoted.
      for (const match of source.matchAll(/className=\{?["'`]([^"'`]*)["'`]/g)) {
        const value = match[1] ?? '';
        if (value.includes('tabular') && value.includes('motion-')) {
          offenders.push(`${relative(process.cwd(), file)}: ${value}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('defines no looping animation', () => {
    // Anything that repeats forever is a distraction at a counter. The one
    // exception is the loading skeleton, which uses Tailwind's own pulse.
    expect(CSS).not.toMatch(/animation-iteration-count:\s*infinite/);
    expect(CSS).not.toMatch(/animation:[^;]*\binfinite\b/);
  });
});

describe('motion stays short', () => {
  it('no entrance runs longer than a fifth of a second', () => {
    const durations = [...CSS.matchAll(/animation:\s*\w+\s+(\d+)ms/g)].map((m) => Number(m[1]));
    expect(durations.length).toBeGreaterThan(0);
    // Someone is standing at a till with a queue behind them.
    for (const duration of durations) expect(duration).toBeLessThanOrEqual(200);
  });
});

describe('the clock', () => {
  const CLOCK = readFileSync(
    join(process.cwd(), 'src', 'components', 'shared', 'clock.tsx'),
    'utf8',
  );

  it('is a client component', () => {
    // Rendered on the server it would show the time the page was opened, for
    // as long as the page stayed open.
    expect(CLOCK.startsWith("'use client'")).toBe(true);
  });

  it('re-reads the time every second', () => {
    // Thirty seconds was the original interval, and on a minute-resolution
    // display that is indistinguishable from a clock that has stopped.
    expect(CLOCK).toMatch(/setInterval\(tick, 1_000\)/);
  });

  it('shows seconds, so it is visibly alive', () => {
    expect(CLOCK).toMatch(/second: '2-digit'/);
  });

  it('clears its timer when the page goes away', () => {
    expect(CLOCK).toMatch(/clearInterval\(timer\)/);
  });
});
