/**
 * The top of a club page: crest, name, manager, and the four numbers that say how it's going.
 *
 * Deliberately the same for your own club and a rival's — a league is more fun when everyone's
 * club looks like a club, not a row in a table.
 */

import { money } from '../../lib/format.ts';
import type { ClubStats } from '../../lib/services/stats.ts';
import { ClubCrest, type Crest } from './ClubCrest.tsx';
import { Stat } from './ui.tsx';

export function ClubHeader({
  crest,
  manager,
  tierName,
  captain,
  cash,
  stats,
  wins,
  losses,
}: {
  crest: Crest;
  manager: string;
  tierName: string;
  captain: string | null;
  cash: number;
  stats: ClubStats;
  wins: number;
  losses: number;
}) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      {/* The club's own colours, so two clubs never look the same. */}
      <div
        className="h-1.5 rounded-t-xl"
        style={{
          background: `linear-gradient(90deg, ${crest.primary} 0 50%, ${crest.secondary} 50% 100%)`,
        }}
      />

      <div className="flex flex-wrap items-center gap-4 p-4">
        <ClubCrest crest={crest} size={96} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold tracking-tight uppercase">{crest.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
            <span className="rounded bg-panel-2 px-2 py-1 text-muted">Manager · {manager}</span>
            <span className="rounded bg-accent/15 px-2 py-1 text-accent">{tierName}</span>
            {captain && <span className="rounded bg-panel-2 px-2 py-1 text-muted">Captain · {captain}</span>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-4">
        <Stat label="Cash" value={money(cash)} tone={cash < 0 ? 'bad' : undefined} />
        <Stat label="Squad value" value={money(stats.squadValue)} />
        <Stat label="Record" value={`${wins}–${losses}`} />

        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
          <div className="text-[11px] tracking-wide text-muted uppercase">Last 5</div>
          {stats.last5.length === 0 ? (
            <div className="text-sm text-muted">No matches yet</div>
          ) : (
            <div className="mt-1 flex gap-1">
              {stats.last5.map((result, index) => (
                <span
                  key={index}
                  className={`grid h-6 w-6 place-items-center rounded text-xs font-bold ${
                    result === 'W' ? 'bg-positive text-surface' : 'bg-negative text-white'
                  }`}
                >
                  {result}
                </span>
              ))}
            </div>
          )}
          <div className="mt-1 text-[11px] text-muted">
            {stats.run
              ? `${stats.run.length} ${
                  stats.run.result === 'W'
                    ? stats.run.length === 1
                      ? 'win'
                      : 'wins'
                    : stats.run.length === 1
                      ? 'loss'
                      : 'losses'
                } in a row`
              : 'No run yet'}
            {stats.nextMultiplier > 1 && (
              <span className="ml-1 font-semibold text-accent">
                next win ×{stats.nextMultiplier}
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
