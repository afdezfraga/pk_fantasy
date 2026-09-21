import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../../../lib/auth/session.ts';
import { money } from '../../../../../lib/format.ts';
import { getClubPage } from '../../../../../lib/services/clubpage.ts';
import { getLeagueContext } from '../../../../../lib/services/league.ts';
import { Awards } from '../../../../components/Awards.tsx';
import { ClubHeader } from '../../../../components/ClubHeader.tsx';
import { crestOf } from '../../../../components/ClubCrest.tsx';
import { PlayerCard } from '../../../../components/PlayerCard.tsx';
import { Empty, NavTabs, Panel } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

/** Another manager's club: the same page as your own, with nothing to drag. */
export default async function RivalClubPage({
  params,
}: {
  params: Promise<{ id: string; teamId: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id, teamId } = await params;
  const context = await getLeagueContext(id, user.id);
  if (!context) notFound();

  // Your own club has the editable page; there's no reason to look at the read-only copy.
  if (context.myTeam?.id === teamId) redirect(`/league/${id}/squad`);

  const club = await getClubPage(id, teamId);
  if (!club) notFound();
  const { team, cards, stats, awards, captain, tierName } = club;

  const starters = cards.filter((card) => card.starter);
  const bench = cards.filter((card) => !card.starter);

  return (
    <div className="flex flex-col gap-5">
      <NavTabs leagueId={id} active="home" />

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

      <Panel title={`Starting lineup · ${starters.length}`}>
        {starters.length === 0 ? (
          <Empty>Nobody in the lineup.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {starters.map((card) => (
              <PlayerCard key={card.slug} entry={card} />
            ))}
          </div>
        )}
      </Panel>

      {bench.length > 0 && (
        <Panel title={`Bench · ${bench.length}`}>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {bench.map((card) => (
              <PlayerCard key={card.slug} entry={card} size="compact" />
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Honours">
        <Awards awards={awards} />
      </Panel>

      <p className="text-center text-xs text-muted">
        Squad worth {money(stats.squadValue)}.{' '}
        {context.myTeam && (
          <Link href={`/league/${id}/trades`} className="text-accent hover:underline">
            Offer a trade →
          </Link>
        )}
      </p>
    </div>
  );
}
