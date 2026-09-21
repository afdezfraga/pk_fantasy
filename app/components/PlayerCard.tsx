/**
 * A squad card: the big, readable unit the club page is built from.
 *
 * Shows the three things a manager keeps checking — what it's worth now against what it cost,
 * what it has done (KOs, times down, current run), and whether it's starting. Used both on the
 * drag-and-drop board and, without any of the dragging, on another club's page.
 */

import { money, signedMoney } from '../../lib/format.ts';
import { PokemonArt } from './PokemonImage.tsx';
import { TierBadge, TypePills } from './ui.tsx';

export interface PlayerCardData {
  slug: string;
  label: string;
  tier: string;
  types: string[];
  iconUrl: string | null;
  homeUrl: string | null;
  value: number;
  acquiredPrice: number;
  megaCount: number;
  starter: boolean;
  captain: boolean;
  /** Shirt number, i.e. its place in the squad order. */
  number: number;
  kos: number;
  fainted: number;
  matches: number;
  streak: number;
  /** Recent values, oldest first. Fewer than two points draws nothing. */
  trail: number[];
}

/** A bare value line. No axes, no labels: it is there to show a direction, not a number. */
function Sparkline({ trail }: { trail: number[] }) {
  // Two points is a signing and one match — a straight line that says nothing but looks loud.
  if (trail.length < 3) return null;

  const up = trail[trail.length - 1] >= trail[0];

  const low = Math.min(...trail);
  const high = Math.max(...trail);
  const span = high - low || 1;
  const points = trail
    .map((value, index) => {
      const x = (index / (trail.length - 1)) * 100;
      const y = 20 - ((value - low) / span) * 18;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="h-5 w-full" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={up ? 'var(--color-positive)' : 'var(--color-negative)'}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PlayerCard({
  entry,
  size = 'full',
  children,
}: {
  entry: PlayerCardData;
  /** 'compact' drops the sparkline and shrinks the art, for the reserves row. */
  size?: 'full' | 'compact';
  /** Controls the card offers — a drag handle, a bench button, the armband. */
  children?: React.ReactNode;
}) {
  const art = size === 'full' ? 104 : 64;

  return (
    <article
      className={`relative flex flex-col items-center gap-1 rounded-xl border px-2 pt-3 pb-2 text-center ${
        entry.starter ? 'border-accent/40 bg-accent/5' : 'border-line bg-panel-2'
      }`}
    >
      <span className="tabular absolute top-2 left-2 text-xs font-bold text-muted">
        {entry.number}
      </span>
      {entry.captain && (
        <span className="absolute top-2 right-2 rounded bg-accent px-1 text-[10px] font-bold text-accent-ink">
          CAP
        </span>
      )}

      <PokemonArt home={entry.homeUrl} icon={entry.iconUrl} alt="" size={art} />

      <div className="flex w-full items-center justify-center gap-1.5">
        <TierBadge tier={entry.tier} />
        <span className="min-w-0 truncate text-sm font-semibold">{entry.label}</span>
        {entry.megaCount > 0 && <span className="shrink-0 text-[10px] text-accent">★</span>}
      </div>

      <TypePills types={entry.types} />

      <div className="tabular w-full text-xs">
        <div className="font-semibold">{money(entry.value)}</div>
        <div className="text-[11px] text-muted">
          paid {money(entry.acquiredPrice)}
          {entry.trail.length > 1 && (
            // Movement since it was signed for, which is the part a manager can change.
            <span
              className={
                entry.value >= entry.trail[0] ? ' text-positive' : ' text-negative'
              }
            >
              {' '}
              {signedMoney(entry.value - entry.trail[0])}
            </span>
          )}
        </div>
      </div>

      {size === 'full' && <Sparkline trail={entry.trail} />}

      <dl className="tabular grid w-full grid-cols-3 gap-1 border-t border-line pt-1.5 text-[11px]">
        <div>
          <dd className="font-bold text-positive">{entry.kos}</dd>
          <dt className="text-muted">KOs</dt>
        </div>
        <div>
          <dd className="font-bold text-negative">{entry.fainted}</dd>
          <dt className="text-muted">Down</dt>
        </div>
        <div>
          <dd className="font-bold">{entry.streak}</dd>
          <dt className="text-muted">Run</dt>
        </div>
      </dl>

      {children}
    </article>
  );
}
