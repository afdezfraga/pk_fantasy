import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../../lib/auth/session.ts';
import { db } from '../../../../lib/db.ts';
import { parseTypes, pokemonLabel } from '../../../../lib/format.ts';
import { activeEffects, banned, parseConstraints } from '../../../../lib/services/effects.ts';
import { ensurePendingEvent, pendingEvent } from '../../../../lib/services/events.ts';
import { getLeagueContext } from '../../../../lib/services/league.ts';
import { getLineup } from '../../../../lib/services/lineup.ts';
import { getMatches, winStreak } from '../../../../lib/services/matches.ts';
import { RankBadge, RankGauge } from '../../../components/RankBadge.tsx';
import { Empty, NavTabs, Panel } from '../../../components/ui.tsx';
import { standingOf } from '../../../../lib/services/ladder.ts';
import { formatStanding, getTier, type Standing } from '../../../../lib/ladder.ts';
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

  // Opening this page is one of the moments an event can arrive — the draw is lazy.
  if (myTeam && league.status === 'ACTIVE' && context.config.eventsEnabled) {
    await ensurePendingEvent(id, myTeam.id);
  }
  const pending = myTeam ? await pendingEvent(id, myTeam.id) : null;

  // Only the starting lineup can be reported, so that's all the form is given.
  const lineup = myTeam ? await getLineup(id, myTeam.id) : null;
  const effects = myTeam ? await activeEffects(id, myTeam.id) : [];

  const squadForBans = (lineup?.starters ?? []).map((row) => ({
    pokemonSlug: row.pokemonSlug,
    starter: true,
    types: parseTypes(row.pokemon.types),
  }));
  const { reasons, usable } = banned(effects, squadForBans);
  // A ban that would leave the club unable to field a legal four stops being a ban and becomes
  // a bench-only rule, so nobody is ever locked out of reporting entirely.
  const banEnforced = usable >= (lineup?.config.bringToMatch ?? 4);

  const starters: Starter[] =
    lineup?.starters.map((row) => ({
      slug: row.pokemonSlug,
      label: pokemonLabel(row.pokemon),
      tier: row.pokemon.tier,
      iconUrl: row.pokemon.iconUrl,
      homeUrl: row.pokemon.homeUrl,
      barredBy: reasons.get(row.pokemonSlug),
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
      <NavTabs leagueId={id} active="matches" pendingEvent={Boolean(pending)} />

      {myTeam && (
        <Panel
          title="Your ladder rank"
          action={<StandingForm leagueId={id} current={standingOf(myTeam)} />}
        >
          <div className="flex flex-wrap items-center gap-3">
            <RankBadge standing={standingOf(myTeam)} size="lg" />
            <RankGauge standing={standingOf(myTeam)} />
          </div>
          <p className="mt-2 text-xs text-muted">
            The league table is your Champions ladder rank. It moves with each match you report,
            and reaching a new ball tier for the first time in a season pays a bonus.
          </p>
        </Panel>
      )}

      {myTeam && !canReport && (
        <Panel title="Matches">
          <Empty>Finish the draft before logging matches.</Empty>
        </Panel>
      )}

      {/*
        A pending decision replaces the form rather than sitting beside it. Reporting is blocked
        server-side anyway; showing the form would only let someone fill it in and be refused.
      */}
      {myTeam && canReport && pending && (
        <Panel title="A decision is waiting">
          <p className="mb-3 text-sm text-muted">
            <strong className="text-ink">{pending.title}.</strong> {pending.description}
          </p>
          <Link
            href={`/league/${id}/events`}
            className="inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink"
          >
            Deal with it
          </Link>
          <p className="mt-2 text-xs text-muted">
            You can report again as soon as it&rsquo;s answered. If you&rsquo;d rather not think
            about it, your assistant will pick for you.
          </p>
        </Panel>
      )}

      {myTeam && canReport && !pending && (
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
          standing={standingOf(myTeam)}
          banEnforced={banEnforced}
          constraints={effects.map((effect) => ({
            id: effect.id,
            kind: effect.kind,
            label: effect.label,
            attested: effect.attested,
            matchesLeft: effect.matchesLeft,
            eventsLeft: effect.eventsLeft,
          }))}
          attestations={effects
            .filter((effect) => effect.attested)
            .map((effect) => ({ id: effect.id, label: effect.label }))}
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
              rankAfter: match.rankAfter
                ? formatStanding(JSON.parse(match.rankAfter) as Standing)
                : null,
              reward: match.reward,
              streak: match.streak,
              constraints: parseConstraints(match.constraints),
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
