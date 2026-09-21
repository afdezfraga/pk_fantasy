import { formatDetail, formatStanding, getTier, progressPerRank, type Standing } from '../../lib/ladder.ts';

/** The ladder standing as it appears in the table and on a team header. */
export function RankBadge({ standing, size = 'sm' }: { standing: Standing; size?: 'sm' | 'lg' }) {
  const tier = getTier(standing.tierKey);
  const detail = formatDetail(standing);

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-flex shrink-0 items-center justify-center rounded border px-1.5 py-0.5 text-[11px] font-bold leading-none"
        style={{
          color: tier.color,
          borderColor: `${tier.color}55`,
          backgroundColor: `${tier.color}1f`,
        }}
      >
        {tier.short}
        {standing.rank !== null ? ` ${standing.rank}` : ''}
      </span>
      <span className={size === 'lg' ? 'text-sm' : 'text-xs'}>
        <span className="font-medium">{formatStanding(standing)}</span>
        {/* Explicit separator, not just a margin: "Ultra Ball 3" and "3/4" both end and begin
            with digits, so without one they read as "Ultra Ball 33/4". */}
        {detail && <span className="text-muted"> · {detail}</span>}
      </span>
    </span>
  );
}

/** The progress gauge, for tiers that have one. Gauge length is the tier's own. */
export function RankGauge({ standing }: { standing: Standing }) {
  const tier = getTier(standing.tierKey);
  if (tier.rated || tier.ranks === 0) return null;
  const max = progressPerRank(standing.tierKey);

  return (
    <span className="flex gap-0.5" aria-label={`${standing.progress} of ${max} progress`}>
      {Array.from({ length: max }, (_, index) => (
        <span
          key={index}
          className="h-1.5 w-4 rounded-full"
          style={{ backgroundColor: index < standing.progress ? tier.color : 'var(--color-line)' }}
        />
      ))}
    </span>
  );
}
