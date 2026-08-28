import { describe, expect, it } from 'vitest';

import {
  GREETINGS,
  TIME_BANDS,
  bandFor,
  firstName,
  greetingFor,
  greetingLine,
} from '@/lib/greeting';

describe('which part of the day it is', () => {
  it('calls anything before noon morning, because a shop opens early', () => {
    for (const hour of [0, 5, 6, 9, 11]) expect(bandFor(hour)).toBe('morning');
  });

  it('turns over at noon and again at five', () => {
    expect(bandFor(11)).toBe('morning');
    expect(bandFor(12)).toBe('afternoon');
    expect(bandFor(16)).toBe('afternoon');
    expect(bandFor(17)).toBe('evening');
  });

  it('still says evening to a shop open late, never good night', () => {
    for (const hour of [17, 20, 22, 23]) expect(bandFor(hour)).toBe('evening');
  });

  it('falls back to morning rather than throwing on nonsense', () => {
    expect(bandFor(Number.NaN)).toBe('morning');
    expect(bandFor(Number.POSITIVE_INFINITY)).toBe('morning');
  });
});

describe('the greeting itself', () => {
  it('has lines for every band, none of them empty', () => {
    for (const band of TIME_BANDS) {
      expect(GREETINGS[band].length).toBeGreaterThan(0);
      for (const line of GREETINGS[band]) expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * The whole point of seeding rather than randomising. The same person opening
   * the dashboard twice in a morning must see the same words, on the counter PC
   * and on their phone.
   */
  it('gives the same line for the same seed, every time', () => {
    for (const band of TIME_BANDS) {
      const first = greetingFor(band, '2026-08-28:kwame');
      for (let attempt = 0; attempt < 50; attempt += 1) {
        expect(greetingFor(band, '2026-08-28:kwame')).toBe(first);
      }
    }
  });

  it('only ever returns a line from that band', () => {
    for (const band of TIME_BANDS) {
      for (const user of ['kwame', 'ama', 'kofi', 'yaa', 'owner']) {
        for (const day of ['2026-08-28', '2026-08-29', '2026-09-01']) {
          expect(GREETINGS[band]).toContain(greetingFor(band, `${day}:${user}`));
        }
      }
    }
  });

  it('does not hand the whole shop the same line', () => {
    const seen = new Set(
      ['kwame', 'ama', 'kofi', 'yaa', 'esi', 'kojo'].map((user) =>
        greetingFor('morning', `2026-08-28:${user}`),
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it('moves on as the days pass', () => {
    const days = ['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02'];
    const seen = new Set(days.map((day) => greetingFor('evening', `${day}:kwame`)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('the name on the end', () => {
  it('uses the first name only', () => {
    expect(firstName('Kwame Mensah')).toBe('Kwame');
    expect(firstName('Ama')).toBe('Ama');
    expect(firstName('  Kofi   Owusu Ansah ')).toBe('Kofi');
  });

  it('reads as a sentence', () => {
    expect(greetingLine('Kwame Mensah', 'morning', 'seed')).toMatch(/^[A-Z].*, Kwame$/);
  });

  /**
   * A display name is required at every entry point that creates a user, but
   * this renders in a page header: a greeting ending in a bare comma would be
   * the most visible possible way to find that out.
   */
  it('drops the comma rather than trailing one when there is no name', () => {
    for (const name of ['', '   ']) {
      const line = greetingLine(name, 'evening', 'seed');
      expect(line).not.toMatch(/,\s*$/);
      expect(GREETINGS.evening).toContain(line);
    }
  });
});
