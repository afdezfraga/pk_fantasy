import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../lib/auth/session.ts';
import { db } from '../../../lib/db.ts';
import { money, pokemonLabel, signedMoney } from '../../../lib/format.ts';
import { getLeagueContext } from '../../../lib/services/league.ts';
import { ensurePendingEvent, getEvents, pendingEvent } from '../../../lib/services/events.ts';
import { getRankEvents, sortByLadder, standingOf } from '../../../lib/services/ladder.ts';
import { roundProgress } from '../../../lib/services/rounds.ts';
import { ClubCrest, crestOf } from '../../components/ClubCrest.tsx';
import { PokemonIcon } from '../../components/PokemonImage.tsx';
import { RankBadge, RankGauge } from '../../components/RankBadge.tsx';
import { Empty, NavTabs, Panel, Stat } from '../../components/ui.tsx';
import { AdvanceRound } from './AdvanceRound.tsx';
import { AdvanceSeason } from './AdvanceSeason.tsx';
import { StartDraftForm } from './StartDraftForm.tsx';

export const dynamic = 'force-dynamic';

/** A restriction ending, as opposed to the other notices the feed carries. */
function lifted(event: { status: string; templateKey: string }): boolean {
  return event.status === 'NOTICE' && event.templateKey.startsWith('lifted:');
}

/** A windfall, on its way through the feed. Gold, the same as the card it came from. */
function fortune(event: { detail: string }): boolean {
  try {
    return (JSON.parse(event.detail || '{}') as { tone?: string }).tone === 'fortune';
  } catch {
    return false;
  }
}

export default async function LeagueHome({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const context = await getLeagueContext(id, user.id);
  if (!context) notFound();

  const { league, myTeam, isCommissioner, config } = context;

  const [squadRows, recent, events, rankEvents, matchCounts] = await Promise.all([
    db.ownership.groupBy({
      by: ['teamId'],
      where: { leagueId: id, teamId: { not: null } },
      _sum: { marketValue: true },
      _count: { _all: true },
    }),
    db.transaction.findMany({
      where: { leagueId: id, teamId: { not: null } },
      include: { team: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    getEvents(id, 5),
    getRankEvents(id, 6),
    db.match.groupBy({
      by: ['homeTeamId'],
      where: { leagueId: id },
      _count: { _all: true },
    }),
  ]);

  const progress = league.status === 'ACTIVE' ? await roundProgress(id, league.round) : null;

  const matchesByTeam = new Map(matchCounts.map((row) => [row.homeTeamId, row._count._all]));

  // The league hub is the page people land on, so it is the likeliest place for a due event to
  // arrive. The draw is idempotent and guarded, so doing it here costs nothing.
  if (myTeam && league.status === 'ACTIVE' && config.eventsEnabled) {
    await ensurePendingEvent(id, myTeam.id);
  }
  const pending = myTeam ? await pendingEvent(id, myTeam.id) : null;

  const squadByTeam = new Map(
    squadRows.map((row) => [
      row.teamId,
      { value: row._sum.marketValue ?? 0, count: row._count._all },
    ]),
  );

  // League position is ladder position — everyone grinds the public ladder separately, so
  // there is no head-to-head record to sort on.
  const standings = sortByLadder(league.teams);

  const mySquadValue = myTeam ? (squadByTeam.get(myTeam.id)?.value ?? 0) : 0;
  const mySquadSize = myTeam ? (squadByTeam.get(myTeam.id)?.count ?? 0) : 0;

  const myStarters = myTeam
    ? await db.ownership.findMany({
        where: { leagueId: id, teamId: myTeam.id, starter: true },
        include: {
          pokemon: { select: { name: true, form: true, iconUrl: true } },
        },
        orderBy: { marketValue: 'desc' },
      })
    : [];

  return (
    <div className="flex flex-col gap-5">
      <NavTabs
        leagueId={id}
        active="home"
        showDraft={Boolean(league.draft)}
        pendingEvent={Boolean(pending)}
      />

      {myTeam && (
        <Panel
          title={myTeam.name}
          action={
            <Link href={`/league/${id}/squad`} className="text-xs text-accent hover:underline">
              Club page →
            </Link>
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <ClubCrest crest={crestOf(myTeam)} size={48} />
            <RankBadge standing={standingOf(myTeam)} size="lg" />
            <RankGauge standing={standingOf(myTeam)} />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Cash"
              value={money(myTeam.cash)}
              tone={myTeam.cash < 0 ? 'bad' : undefined}
            />
            <Stat label="Squad value" value={money(mySquadValue)} />
            <Stat label="Squad" value={`${mySquadSize} / ${config.squadMax}`} />
            <Stat label="Record" value={`${myTeam.wins}–${myTeam.losses}`} />
          </div>
          {myStarters.length > 0 && (
            <a
              href={`/league/${id}/squad`}
              className="mt-3 flex items-center gap-1 rounded-lg border border-line bg-panel-2 px-2 py-2 transition hover:border-accent/40"
              title="Starting lineup"
            >
              {myStarters.map((row) => (
                <PokemonIcon
                  key={row.pokemonSlug}
                  icon={row.pokemon.iconUrl}
                  alt={pokemonLabel(row.pokemon)}
                  size={40}
                />
              ))}
              <span className="ml-auto pr-1 text-xs text-muted">lineup →</span>
            </a>
          )}
        </Panel>
      )}

      {league.status === 'SETUP' && (
        <Panel title="Getting started">
          <p className="mb-3 text-sm text-muted">
            {league.season > 1
              ? `Season ${league.season} is about to begin. Everyone kept their captain and starts again at Poké Ball 4 — run the draft to share out the rest. New players can still join with the code.`
              : league.teams.length > 1
                ? "Share this invite code so the rest can join. Once everyone's in, run the draft to share out the Pokémon."
                : 'Share this invite code if you want company — or just start the draft and play a solo career.'}
          </p>
          <div className="mb-4 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-center">
            <div className="text-[11px] uppercase tracking-wide text-muted">Invite code</div>
            <div className="font-mono text-2xl font-bold tracking-[0.3em] text-accent">
              {league.inviteCode}
            </div>
          </div>
          {isCommissioner ? (
            <StartDraftForm
              leagueId={id}
              teamCount={league.teams.length}
              defaultRounds={config.draftRounds}
            />
          ) : (
            <p className="text-sm text-muted">Waiting for the commissioner to start the draft.</p>
          )}
        </Panel>
      )}

      {league.status === 'ACTIVE' && progress && (
        <Panel title={`Season ${league.season} · Round ${league.round}`}>
          <p className="text-sm text-muted">
            The round closes by itself once {progress.needed} of {progress.teams}{' '}
            {progress.teams === 1 ? 'club has' : 'clubs have'} played all {progress.matchesEach}{' '}
            paid matches.{' '}
            <span className="text-ink">
              {progress.done} {progress.done === 1 ? 'has' : 'have'} so far.
            </span>
          </p>
          {isCommissioner && (
            <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
              <AdvanceRound leagueId={id} round={league.round} />
              <AdvanceSeason leagueId={id} season={league.season} />
            </div>
          )}
        </Panel>
      )}

      {myTeam && pending && (
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
            Nothing else can be reported until this is answered.
          </p>
        </Panel>
      )}

      {events.length > 0 && (
        <Panel title="League news">
          <ul className="flex flex-col gap-2">
            {events.map((event) => (
              <li
                key={event.id}
                className={`rounded-lg border px-3 py-2 ${
                  // A restriction lifting is good news, and reads as such. A club's own decision
                  // is not news of that kind — it is simply what happened — so it stays neutral.
                  // A windfall is the exception, and carries its gold through to the feed.
                  fortune(event)
                    ? 'fortune'
                    : lifted(event)
                      ? 'border-positive/40 bg-positive/10'
                      : 'border-line bg-panel-2'
                }`}
              >
                <div
                  className={`text-xs font-semibold ${
                    lifted(event) && !fortune(event) ? 'text-positive' : 'text-accent'
                  }`}
                >
                  {event.title}
                </div>
                <div className="text-sm text-muted">{event.description}</div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {league.status === 'DRAFTING' && (
        <Panel title="Draft in progress">
          <Link
            href={`/league/${id}/draft`}
            className="block rounded-lg border border-accent/40 bg-accent/10 px-4 py-3 text-center text-sm font-semibold text-accent"
          >
            Go to the draft room →
          </Link>
        </Panel>
      )}

      <Panel title="Ladder standings">
        {standings.length === 0 ? (
          <Empty>No teams yet.</Empty>
        ) : (
          <ul className="flex flex-col">
            {standings.map((team, index) => {
              const standing = standingOf(team);
              const isMe = team.id === myTeam?.id;
              return (
                <li
                  key={team.id}
                  className={`border-b border-line last:border-0 ${isMe ? 'text-accent' : ''}`}
                >
                  <Link
                    href={isMe ? `/league/${id}/squad` : `/league/${id}/club/${team.id}`}
                    className="flex items-center gap-3 py-3 transition hover:opacity-80"
                  >
                    <span className="tabular w-5 shrink-0 text-sm font-bold text-muted">
                      {index + 1}
                    </span>
                    <ClubCrest crest={crestOf(team)} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{team.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <RankBadge standing={standing} />
                        <RankGauge standing={standing} />
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="tabular text-sm font-semibold">{team.points} pts</div>
                      <div className="tabular text-xs text-muted">
                        {matchesByTeam.get(team.id) ?? 0} played
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">
          Position is your Champions ladder rank. Fantasy points come from how your Pokémon perform:
          they decide the club honours, they don't set the table. Tap a club to look round it.
        </p>
      </Panel>

      {rankEvents.length > 0 && (
        <Panel title="Climbing">
          <ul className="flex flex-col gap-1 text-sm">
            {rankEvents.map((event) => (
              <li key={event.id} className="flex items-baseline justify-between gap-3 py-1">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{event.team.name}</span>
                  <span className="text-muted">
                    {' '}
                    {event.rungDelta >= 0 ? '→' : '↓'} {event.toLabel}
                  </span>
                </span>
                {event.bonus > 0 && (
                  <span className="tabular shrink-0 font-medium text-positive">
                    +{money(event.bonus)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Recent activity">
        {recent.length === 0 ? (
          <Empty>Nothing has happened yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {recent.map((entry) => (
              <li key={entry.id} className="flex items-baseline justify-between gap-3 py-1">
                <span className="min-w-0 truncate">
                  <span className="text-muted">{entry.team?.name}</span> {entry.description}
                </span>
                <span
                  className={`tabular shrink-0 font-medium ${
                    entry.amount >= 0 ? 'text-positive' : 'text-negative'
                  }`}
                >
                  {signedMoney(entry.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
