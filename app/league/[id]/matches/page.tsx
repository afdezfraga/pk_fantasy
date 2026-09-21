import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../../lib/auth/session.ts';
import { db } from '../../../../lib/db.ts';
import { pokemonLabel } from '../../../../lib/format.ts';
import { getLeagueContext } from '../../../../lib/services/league.ts';
import { getLineup } from '../../../../lib/services/lineup.ts';
import { getMatches, winStreak } from '../../../../lib/services/matches.ts';
import { Empty, NavTabs, Panel } from '../../../components/ui.tsx';
import { standingOf } from '../../../../lib/services/ladder.ts';
import { getTier } from '../../../../lib/ladder.ts';
import { PAYOUTS } from '../../../../config/scoring.ts';
import { MatchHistory } from './MatchHistory.tsx';
import { StandingForm } from './StandingForm.tsx';
import { ReportForm, type Starter } from './ReportForm.tsx';

export const dynamic = 'force-dynamic';

export default async function MatchesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const context = await getLeagueContext(id, user.id);
  if (!context) notFound();
  const { league, myTeam } = context;

  const [squads, matches] = await Promise.all([
    db.ownership.findMany({
      where: { leagueId: id, teamId: { not: null } },
      include: {
        pokemon: { select: { name: true, form: true, tier: true, iconUrl: true } },
      },
      orderBy: { marketValue: 'desc' },
    }),
    getMatches(id),
  ]);

  // Only the starting lineup can be reported, so that's all the form is given.
  const lineup = myTeam ? await getLineup(id, myTeam.id) : null;
  const starters: Starter[] =
    lineup?.starters.map((row) => ({
      slug: row.pokemonSlug,
      label: pokemonLabel(row.pokemon),
      tier: row.pokemon.tier,
      iconUrl: row.pokemon.iconUrl,
      homeUrl: row.pokemon.homeUrl,
    })) ?? [];

  const paidThisRound = myTeam
    ? await db.match.count({
        where: { leagueId: id, round: league.round, homeTeamId: myTeam.id },
      })
    : 0;
  const streak = myTeam ? await winStreak(id, myTeam.id) : 0;
  const reporters = await db.user.findMany({
    where: { id: { in: matches.map((m) => m.reportedById).filter(Boolean) as string[] } },
    select: { id: true, displayName: true },
  });
  const reporterById = new Map(reporters.map((r) => [r.id, r.displayName]));

  // The ladder panel is always available: your Champions rank exists whether or not this
  // league has finished drafting, and it's what the table is built on.
  const canReport = league.status === 'ACTIVE';

  return (
    <div className="flex flex-col gap-5">
      <NavTabs leagueId={id} active="matches" />

      {myTeam && (
        <Panel title="Your ladder rank">
          <p className="mb-3 text-sm text-muted">
            Matches are played on the Champions ranked ladder, so the league table is your rank.
            Update it here whenever it changes — promotions pay a bonus.
          </p>
          <StandingForm leagueId={id} teamId={myTeam.id} current={standingOf(myTeam)} />
        </Panel>
      )}

      {myTeam && !canReport && (
        <Panel title="Matches">
          <Empty>Finish the draft before logging matches.</Empty>
        </Panel>
      )}

      {myTeam && canReport && (
        <ReportForm
          leagueId={id}
          myTeamId={myTeam.id}
          starters={starters}
          round={league.round}
          paidThisRound={paidThisRound}
          payCap={PAYOUTS.paidMatchesPerRound}
          bringToMatch={lineup?.config.bringToMatch ?? 4}
          tierKey={myTeam.tierKey}
          tierName={getTier(myTeam.tierKey).name}
          streak={streak}
        />
      )}

      {canReport && (
      <Panel title={`Results · round ${league.round}`}>
        {matches.length === 0 ? (
          <Empty>No matches reported yet.</Empty>
        ) : (
          <MatchHistory
            leagueId={id}
            matches={matches.map((match) => ({
              id: match.id,
              round: match.round,
              homeName: match.homeTeam.name,
              awayName: match.awayTeam?.name ?? match.opponentName ?? 'Outside opponent',
              homeScore: match.homeScore,
              awayScore: match.awayScore,
              note: match.note,
              reportedBy: match.reportedById ? (reporterById.get(match.reportedById) ?? null) : null,
              playedAt: match.playedAt.toISOString(),
              tierName: match.tierKey ? getTier(match.tierKey).name : null,
              reward: match.reward,
              streak: match.streak,
              valueChanges: match.valueChanges.map((change) => ({
                pokemonSlug: change.pokemonSlug,
                delta: change.delta,
                pct: change.pct,
              })),
              stats: match.stats.map((stat) => ({
                pokemonSlug: stat.pokemonSlug,
                teamId: stat.teamId,
                kos: stat.kos,
                fainted: stat.fainted,
                benched: stat.benched,
                points: stat.points,
              })),
              homeTeamId: match.homeTeamId,
              awayTeamId: match.awayTeamId,
            }))}
            pokemon={Object.fromEntries(
              squads.map((row) => [
                row.pokemonSlug,
                { label: pokemonLabel(row.pokemon), iconUrl: row.pokemon.iconUrl },
              ]),
            )}
          />
        )}
      </Panel>
      )}
    </div>
  );
}
