import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../../lib/auth/session.ts';
import { money } from '../../../../lib/format.ts';
import { getClubPage } from '../../../../lib/services/clubpage.ts';
import { activeEffects } from '../../../../lib/services/effects.ts';
import { pendingEvent } from '../../../../lib/services/events.ts';
import { getLeagueContext } from '../../../../lib/services/league.ts';
import { Awards } from '../../../components/Awards.tsx';
import { Constraints } from '../../../components/Constraints.tsx';
import { ClubHeader } from '../../../components/ClubHeader.tsx';
import { crestOf } from '../../../components/ClubCrest.tsx';
import { Empty, NavTabs, Panel } from '../../../components/ui.tsx';
import { CrestEditor } from './CrestEditor.tsx';
import { LineupBoard } from './LineupBoard.tsx';

export const dynamic = 'force-dynamic';

export default async function ClubPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const context = await getLeagueContext(id, user.id);
  if (!context) notFound();
  const { myTeam } = context;

  if (!myTeam) {
    return (
      <div className="flex flex-col gap-5">
        <NavTabs leagueId={id} active="squad" />
        <Panel title="No club">
          <Empty>You're running this league but don't have a club in it.</Empty>
        </Panel>
      </div>
    );
  }

  const club = await getClubPage(id, myTeam.id);
  if (!club) notFound();
  const { team, cards, stats, awards, captain, tierName, config } = club;

  const [effects, pending] = await Promise.all([
    activeEffects(id, myTeam.id),
    pendingEvent(id, myTeam.id),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <NavTabs leagueId={id} active="squad" pendingEvent={Boolean(pending)} />

      {/* Above the board, because this is where you pick who plays. */}
      <Constraints
        constraints={effects.map((effect) => ({
          id: effect.id,
          label: effect.label,
          attested: effect.attested,
          matchesLeft: effect.matchesLeft,
        }))}
      />

      <ClubHeader
        crest={crestOf(team)}
        manager={team.user.displayName}
        tierName={tierName}
        captain={captain?.label ?? null}
        cash={team.cash}
        stats={stats}
        wins={team.wins}
        losses={team.losses}
      />

      {cards.length > 0 && cards.length < config.bringToMatch && (
        <p className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-negative">
          You only have {cards.length} Pokémon — you bring {config.bringToMatch} to a ladder match.
          Sign more from the Market when you can afford to.
        </p>
      )}

      {cards.length === 0 ? (
        <Panel title={`Squad · 0 of ${config.squadMax}`}>
          <Empty>No Pokémon yet. They arrive from the draft and the market.</Empty>
        </Panel>
      ) : (
        <LineupBoard
          leagueId={id}
          squad={cards}
          lineupSize={config.lineupSize}
          bringToMatch={config.bringToMatch}
        />
      )}

      <Panel title="Honours">
        <Awards awards={awards} />
      </Panel>

      <Panel title="Club crest">
        <CrestEditor
          leagueId={id}
          crest={crestOf(team)}
          squad={cards.map((card) => ({ slug: card.slug, label: card.label }))}
          hasUpload={Boolean(team.crestMime)}
        />
      </Panel>

      <p className="text-center text-xs text-muted">
        Squad {cards.length} of {config.squadMax} · spent {money(stats.spent)} · worth{' '}
        {money(stats.squadValue)}. Value moves with every match your Pokémon play, and releasing
        one pays what it is worth today.
      </p>
    </div>
  );
}
