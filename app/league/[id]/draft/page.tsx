import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../../lib/auth/session.ts';
import { db } from '../../../../lib/db.ts';
import { money, parseTypes, pokemonLabel } from '../../../../lib/format.ts';
import { autoAdvanceStalled, getDraftState } from '../../../../lib/services/draft.ts';
import { getLeagueContext } from '../../../../lib/services/league.ts';
import { PokemonIcon } from '../../../components/PokemonImage.tsx';
import { Empty, NavTabs, Panel, TierBadge, TypePills } from '../../../components/ui.tsx';
import { DraftBoard } from './DraftBoard.tsx';
import { FinishDraft } from './FinishDraft.tsx';

/** The draft moves while you watch it, so don't let Next hand back a cached copy. */
export const dynamic = 'force-dynamic';

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const context = await getLeagueContext(id, user.id);
  if (!context) notFound();

  // A team can be priced out mid-draft; clear any stalled slots before rendering so the board
  // never shows someone "on the clock" who has no legal move.
  await autoAdvanceStalled(id);
  const state = await getDraftState(id);
  if (!state) {
    return (
      <div className="flex flex-col gap-5">
        <NavTabs leagueId={id} active="draft" />
        <Panel title="Draft">
          <Empty>
            This league hasn't drafted yet.{' '}
            <Link href={`/league/${id}`} className="text-accent hover:underline">
              Back to the league
            </Link>
          </Empty>
        </Panel>
      </div>
    );
  }

  const { myTeam, config } = context;
  const teamsById = new Map(context.league.teams.map((team) => [team.id, team]));

  const [available, picks] = await Promise.all([
    db.ownership.findMany({
      where: { leagueId: id, teamId: null, pokemon: { legal: true } },
      include: { pokemon: true },
      orderBy: [{ marketValue: 'desc' }],
    }),
    db.draftPick.findMany({
      where: { draftId: state.draft.id },
      orderBy: { overall: 'desc' },
      take: 40,
    }),
  ]);

  const pickedSlugs = picks.map((pick) => pick.pokemonSlug).filter(Boolean) as string[];
  const pickedPokemon = await db.pokemon.findMany({ where: { slug: { in: pickedSlugs } } });
  const pokemonBySlug = new Map(pickedPokemon.map((pokemon) => [pokemon.slug, pokemon]));

  const onTheClockTeam = state.onTheClock ? teamsById.get(state.onTheClock.teamId) : null;
  const isMyTurn = Boolean(myTeam && state.onTheClock?.teamId === myTeam.id);

  return (
    <div className="flex flex-col gap-5">
      <NavTabs leagueId={id} active="draft" />

      <Panel title={state.isComplete ? 'Draft complete' : `Round ${(state.onTheClock?.round ?? 0) + 1} of ${state.draft.rounds}`}>
        {state.isComplete ? (
          <p className="text-sm text-muted">
            Every pick is in.{' '}
            <Link href={`/league/${id}/squad`} className="text-accent hover:underline">
              See your squad →
            </Link>
          </p>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted">On the clock</div>
              <div className={`text-lg font-bold ${isMyTurn ? 'text-accent' : ''}`}>
                {isMyTurn ? 'You' : (onTheClockTeam?.name ?? 'Unknown')}
              </div>
            </div>
            <div className="tabular text-right text-sm text-muted">
              Pick {state.draft.cursor + 1} of {state.totalPicks}
            </div>
          </div>
        )}
        {!state.isComplete && context.isCommissioner && (
          <div className="mt-3 border-t border-line pt-3">
            <FinishDraft leagueId={id} />
          </div>
        )}
      </Panel>

      {myTeam && !state.isComplete && (
        <DraftBoard
          leagueId={id}
          teamId={myTeam.id}
          isMyTurn={isMyTurn}
          cash={myTeam.cash}
          pokemon={available.map((row) => ({
            slug: row.pokemonSlug,
            label: pokemonLabel(row.pokemon),
            tier: row.pokemon.tier,
            types: parseTypes(row.pokemon.types),
            value: row.pokemon.baseValue,
            bst: row.pokemon.effectiveBst,
            megas: (JSON.parse(row.pokemon.megas) as { label: string }[]).map((m) => m.label),
            iconUrl: row.pokemon.iconUrl,
            homeUrl: row.pokemon.homeUrl,
          }))}
        />
      )}

      <Panel title="Picks so far">
        {picks.length === 0 ? (
          <Empty>No picks yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {picks.map((pick) => {
              const pokemon = pick.pokemonSlug ? pokemonBySlug.get(pick.pokemonSlug) : null;
              return (
                <li
                  key={pick.id}
                  className="flex items-center justify-between gap-3 border-t border-line py-2 first:border-0"
                >
                  <span className="tabular w-10 shrink-0 text-xs text-muted">
                    {pick.round + 1}.{(pick.overall % context.league.teams.length) + 1}
                  </span>
                  <PokemonIcon icon={pokemon?.iconUrl ?? null} alt="" size={28} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className={pokemon ? 'font-medium' : 'text-muted italic'}>
                      {pokemon ? pokemonLabel(pokemon) : 'skipped — out of budget'}
                    </span>
                    <span className="text-muted"> → {teamsById.get(pick.teamId)?.name}</span>
                  </span>
                  {pokemon && <TierBadge tier={pokemon.tier} />}
                  <span className="tabular shrink-0 text-xs text-muted">{money(pick.price)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
