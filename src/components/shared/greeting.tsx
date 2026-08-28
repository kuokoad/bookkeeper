'use client';

import { useEffect, useState } from 'react';

import { bandFor, greetingLine, type TimeBand } from '@/lib/greeting';

/**
 * The dashboard greeting, agreeing with the clock beside it.
 *
 * A client component for one reason. The `Clock` in this same header ticks from
 * the BROWSER's clock, so it shows the shop's own time. If this line were
 * rendered from the server's clock the two could contradict each other in the
 * same eyeful — "Good evening" beside a clock reading 09:14 — on any host not
 * set to the shop's timezone. Ghana is UTC+0 so a UTC server happens to agree
 * today, which is exactly the kind of accident that holds until the day someone
 * moves the deployment.
 *
 * The server's guess is passed in as `initialBand` so the heading is filled on
 * first paint rather than appearing a beat late. On a host that agrees with the
 * shop, the browser recomputes the same band and nothing moves. On one that does
 * not, the line corrects itself on mount, which is the right way round: briefly
 * wrong then right beats confidently wrong all day.
 *
 * `suppressHydrationWarning` for the same reason `Clock` carries it — the server
 * and the browser may genuinely disagree here, and that disagreement is the
 * thing being handled rather than a bug.
 */
export function Greeting({
  displayName,
  initialBand,
  seed,
}: {
  displayName: string;
  /** The band as the server saw it. Corrected on mount if the browser differs. */
  initialBand: TimeBand;
  /** Holds the line steady: business date and username. The band is added here. */
  seed: string;
}) {
  const [band, setBand] = useState<TimeBand>(initialBand);

  useEffect(() => {
    const sync = () => setBand(bandFor(new Date().getHours()));

    sync();

    /**
     * A till screen is left open all day, so a page loaded at 11:50 would still
     * say "Good morning" at four in the afternoon. Re-read whenever the tab is
     * looked at again, which is when anybody would notice.
     */
    const resync = () => {
      if (document.visibilityState === 'visible') sync();
    };

    document.addEventListener('visibilitychange', resync);
    window.addEventListener('focus', resync);

    return () => {
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('focus', resync);
    };
  }, []);

  return (
    <h1 className="text-2xl font-semibold text-content" suppressHydrationWarning>
      {greetingLine(displayName, band, `${seed}:${band}`)}
    </h1>
  );
}
