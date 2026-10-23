'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { Icon } from '@/components/ui/icon';

const PROCESSING_MS = 700;
const FEED_MS = 1750;

type Stage = 'processing' | 'printing' | 'complete';

/**
 * The paper coming out of the slot.
 *
 * Driven by CSS, not by React state, so a receipt whose script never loads
 * still finishes printing: the one figure this page exists to show is never
 * left hidden behind an animation waiting on JavaScript. The script only names
 * the stage on the little screen and restarts the feed on Replay.
 *
 * The paper is shifted up by what has not come out yet and clipped by the same
 * amount, so only the part below the slot is ever visible.
 */
const PAPER_CSS = `
@keyframes receipt-feed {
  from { transform: translateY(-100%); clip-path: inset(100% 0 0 0); }
  to { transform: none; clip-path: inset(0); }
}
.receipt-paper {
  animation: receipt-feed var(--feed-ms) ease-in-out var(--feed-delay) both;
  --tooth: 12px;
  padding-bottom: calc(1.5rem + var(--tooth) / 2);
  mask: conic-gradient(from -45deg at bottom, #0000, #000 1deg 89deg, #0000 90deg) 50% / var(--tooth) 100%;
}
@media (prefers-reduced-motion: reduce) {
  .receipt-paper { animation: none !important; }
}
@media print {
  .receipt-paper { animation: none !important; transform: none !important; clip-path: none !important; mask: none !important; }
}
`;

const STATUS: Record<Stage, string> = {
  processing: 'Preparing receipt',
  printing: 'Printing receipt',
  complete: 'Receipt printed',
};

/**
 * A till printer the receipt feeds out of. Screen only: the printer is
 * `no-print`, and the paper prints as it always has. The receipt inside
 * `children` opts in with the `receipt-paper` class.
 */
export function ReceiptPrinter({ actions, children }: { actions: ReactNode; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>('processing');
  const [run, setRun] = useState(0);

  useEffect(() => {
    // Reduced motion: the paper is already out (see PAPER_CSS), so say so at once.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timers = [
      setTimeout(() => setStage('printing'), still ? 0 : PROCESSING_MS),
      setTimeout(() => setStage('complete'), still ? 0 : PROCESSING_MS + FEED_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, [run]);

  function replay() {
    // Restarting the CSS animation in place, delay included, keeps the paper
    // and the screen on the same clock.
    root.current
      ?.querySelector('.receipt-paper')
      ?.getAnimations()
      .forEach((animation) => {
        animation.cancel();
        animation.play();
      });
    setStage('processing');
    setRun((n) => n + 1);
  }

  return (
    <div
      ref={root}
      className="mx-auto max-w-md"
      style={{ '--feed-ms': `${FEED_MS}ms`, '--feed-delay': `${PROCESSING_MS}ms` } as CSSProperties}
    >
      <style>{PAPER_CSS}</style>
      {actions}

      <div className="no-print rounded-2xl border border-line bg-surface-sunken p-3 pb-2 shadow-sm">
        <div className="flex items-center gap-2 rounded-lg bg-[oklch(0.22_0.01_150)] px-3 py-2 font-mono text-xs text-[oklch(0.88_0.08_150)] shadow-[inset_0_0_8px_oklch(0.6_0.12_150/0.35)]">
          {stage === 'complete' ? (
            <Icon name="check" className="h-4 w-4 text-[oklch(0.8_0.17_150)]" />
          ) : (
            <span
              aria-hidden="true"
              className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
          )}
          <span role="status" aria-live="polite" className="flex-1">
            {STATUS[stage]}
          </span>
          {stage === 'complete' && (
            <button
              type="button"
              onClick={replay}
              className="rounded px-1.5 py-0.5 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-1"
            >
              Replay
            </button>
          )}
        </div>
        <div aria-hidden="true" className="mx-2 mt-3 h-1.5 rounded-full bg-[oklch(0.15_0_0)]" />
      </div>

      {children}
    </div>
  );
}
