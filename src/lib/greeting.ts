/**
 * The line at the top of the dashboard.
 *
 * Varied rather than fixed, but not random on every load. It is chosen from the
 * date, the part of the day and who is signed in, so it is the SAME line every
 * time you open the dashboard all morning and a different one after noon. A
 * greeting that changed on every refresh would be noise on a screen a shop owner
 * reloads twenty times a day to check a figure, and churn of that kind reads as
 * unserious on a page whose whole job is to be trusted.
 *
 * Every line is plain. These are read hundreds of times by the same person, and
 * anything clever grates by the second week.
 *
 * Pure, so it can be tested without a browser or a database. The part of the day
 * is decided by the BROWSER's clock, not the server's — see `greeting.tsx` for
 * why that distinction matters.
 */

export const TIME_BANDS = ['morning', 'afternoon', 'evening'] as const;
export type TimeBand = (typeof TIME_BANDS)[number];

/**
 * Which part of the day an hour belongs to.
 *
 * Boundaries chosen for a shop rather than for an office: trading starts early,
 * so anything before noon is morning, and "evening" begins at 17:00 when the
 * light goes rather than at some later hour when a desk worker would go home.
 * A shop open at 22:00 is still greeted with evening, because there is no
 * fourth band and "good night" to someone still working is a joke that stops
 * being funny immediately.
 */
export function bandFor(hour: number): TimeBand {
  if (!Number.isFinite(hour)) return 'morning';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export const GREETINGS: Record<TimeBand, readonly string[]> = {
  morning: ['Good morning', 'Morning', 'Early start'],
  afternoon: ['Good afternoon', 'Afternoon', 'Still going'],
  evening: ['Good evening', 'Evening', 'Long day'],
};

/**
 * A small deterministic hash (FNV-1a, 32-bit).
 *
 * Deterministic is the whole requirement: the same seed must give the same line
 * on the counter PC and the owner's phone, and must keep giving it for as long
 * as the seed holds. `Math.random()` would satisfy "varied" and nothing else.
 */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    // The FNV prime, by shift-and-add rather than multiplication, so this stays
    // inside 32 bits instead of losing precision through a float.
    value += (value << 1) + (value << 4) + (value << 7) + (value << 8) + (value << 24);
  }
  return value >>> 0;
}

/** The first word of a name, or the whole thing when there is only one. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? '';
}

/**
 * The greeting itself.
 *
 * `key` is what holds it steady: pass the business date, the band and the
 * username, and the line stays put until one of them changes. Two people signed
 * in at the same moment see different lines, which is the point — it is a
 * greeting, not a status.
 */
export function greetingFor(band: TimeBand, key: string): string {
  const pool = GREETINGS[band];
  return pool[hash(key) % pool.length] as string;
}

/** What actually goes on screen. */
export function greetingLine(displayName: string, band: TimeBand, key: string): string {
  const name = firstName(displayName);
  const greeting = greetingFor(band, key);
  return name === '' ? greeting : `${greeting}, ${name}`;
}
