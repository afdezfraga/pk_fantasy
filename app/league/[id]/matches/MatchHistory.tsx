'use client';

import { useActionState, useState } from 'react';

import { deleteMatchAction, type ActionState } from '../../../actions/market.ts';
import { money, signedMoney } from '../../../../lib/format.ts';
import type { MatchConstraint } from '../../../../lib/services/effects.ts';
import { PlayedUnder } from '../../../components/Constraints.tsx';
import { PokemonIcon } from '../../../components/PokemonImage.tsx';
import { Button } from '../../../components/ui.tsx';

export interface MatchRow {
  id: string;
  round: number;
  homeTeamId: string;
  awayTeamId: string | null;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  note: string | null;
  reportedBy: string | null;
  playedAt: string;
  /** Ladder tier it was played in, and what it paid. */
  tierName: string | null;
  reward: number;
  streak: number;
  /** The reporting club's rank after the match, e.g. "Great Ball 4". Null for older reports. */
  rankAfter: string | null;
  /** What was in force when this was played, frozen onto the row at report time. */
  constraints: MatchConstraint[];
  valueChanges: { pokemonSlug: string; delta: number; pct: number }[];
  stats: {
    pokemonSlug: string;
    teamId: string;
    kos: number;
    fainted: boolean;
    benched: boolean;
    points: number;
  }[];
}

export function MatchHistory({
  matches,
  pokemon,
  leagueId,
}: {
  matches: MatchRow[];
  pokemon: Record<string, { label: string; iconUrl: string | null }>;
  leagueId: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [state, remove] = useActionState<ActionState, FormData>(deleteMatchAction, {});

  return (
    <div className="flex flex-col gap-2">
      {state.error && <p className="text-sm text-negative">{state.error}</p>}
      {state.success && <p className="text-sm text-positive">{state.success}</p>}

      <ul className="flex flex-col">
        {matches.map((match) => {
          const homeWon = match.homeScore > match.awayScore;
          const isOpen = open === match.id;

          return (
            <li key={match.id} className="border-b border-line last:border-0">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : match.id)}
                className="flex w-full items-center gap-3 py-3 text-left hover:bg-panel-2"
              >
                <span className="tabular w-8 shrink-0 text-xs text-muted">R{match.round}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    <span className={homeWon ? 'font-semibold' : 'text-muted'}>{match.homeName}</span>
                    <span className="text-muted"> vs </span>
                    <span className={!homeWon ? 'font-semibold' : 'text-muted'}>{match.awayName}</span>
                  </span>
                  {match.note && <span className="block truncate text-xs text-muted">{match.note}</span>}
                  {/* A result means something different if it was won under a handicap. */}
                  <PlayedUnder constraints={match.constraints} />
                </span>
                <span className="shrink-0 text-right">
                  <span className="tabular block text-sm font-bold">
                    {match.homeScore}–{match.awayScore}
                  </span>
                  <span
                    className={`tabular block text-xs ${
                      match.reward > 0 ? 'text-positive' : 'text-muted'
                    }`}
                  >
                    {match.reward > 0 ? `+${money(match.reward)}` : '—'}
                  </span>
                </span>
              </button>

              {isOpen && (
                <div className="flex flex-col gap-3 bg-panel-2 px-3 py-3">
                  {match.stats.length === 0 ? (
                    <p className="text-xs text-muted">No per-Pokémon stats were recorded.</p>
                  ) : (
                    [match.homeTeamId, match.awayTeamId].map((teamId) => {
                      const lines = match.stats.filter((stat) => stat.teamId === teamId);
                      if (lines.length === 0) return null;
                      const name = teamId === match.homeTeamId ? match.homeName : match.awayName;
                      return (
                        <div key={teamId}>
                          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                            {name}
                          </h4>
                          <ul className="flex flex-col gap-0.5">
                            {lines.map((line) => (
                              <li
                                key={line.pokemonSlug}
                                className="flex items-center justify-between gap-2 text-xs"
                              >
                                <PokemonIcon
                                  icon={pokemon[line.pokemonSlug]?.iconUrl ?? null}
                                  alt=""
                                  size={24}
                                />
                                <span className="min-w-0 flex-1 truncate">
                                  {pokemon[line.pokemonSlug]?.label ?? line.pokemonSlug}
                                  <span className="text-muted">
                                    {line.benched
                                      ? ' · benched'
                                      : ` · ${line.kos} KO${line.kos === 1 ? '' : 's'}${
                                          line.fainted ? ', fainted' : ', survived'
                                        }`}
                                  </span>
                                </span>
                                <span
                                  className={`tabular shrink-0 font-semibold ${
                                    line.points > 0
                                      ? 'text-positive'
                                      : line.points < 0
                                        ? 'text-negative'
                                        : 'text-muted'
                                  }`}
                                >
                                  {line.points > 0 ? '+' : ''}
                                  {line.points}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })
                  )}

                  {match.valueChanges.length > 0 && (
                    <div>
                      <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                        Value changes
                      </h4>
                      <ul className="flex flex-col gap-0.5">
                        {match.valueChanges.map((change) => (
                          <li
                            key={change.pokemonSlug}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {pokemon[change.pokemonSlug]?.label ?? change.pokemonSlug}
                              <span className="text-muted">
                                {' '}
                                {change.pct > 0 ? '+' : ''}
                                {change.pct}%
                              </span>
                            </span>
                            <span
                              className={`tabular shrink-0 font-semibold ${
                                change.delta >= 0 ? 'text-positive' : 'text-negative'
                              }`}
                            >
                              {signedMoney(change.delta)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
                    <span className="text-xs text-muted">
                      {match.tierName ?? 'Ladder'}
                      {match.rankAfter && ` → ${match.rankAfter}`}
                      {match.streak >= 3 && ` · ${match.streak}-win streak`} ·{' '}
                      {match.reportedBy ? `reported by ${match.reportedBy}` : 'reporter unknown'} ·{' '}
                      {new Date(match.playedAt).toLocaleDateString()}
                    </span>
                    <form action={remove}>
                      <input type="hidden" name="leagueId" value={leagueId} />
                      <input type="hidden" name="matchId" value={match.id} />
                      <Button variant="danger" type="submit" className="px-2 py-1 text-xs">
                        Delete
                      </Button>
                    </form>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
