import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../../lib/auth/session.ts';
import { db } from '../../../../lib/db.ts';
import { pokemonLabel } from '../../../../lib/format.ts';
import { getLeagueContext } from '../../../../lib/services/league.ts';
import { getTrades } from '../../../../lib/services/trades.ts';
import { Empty, NavTabs, Panel } from '../../../components/ui.tsx';
import { TradeCentre } from './TradeCentre.tsx';

export const dynamic = 'force-dynamic';

export default async function TradesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const context = await getLeagueContext(id, user.id);
  if (!context) notFound();
  const { league, myTeam } = context;

  if (!myTeam) {
    return (
      <div className="flex flex-col gap-5">
        <NavTabs leagueId={id} active="trades" />
        <Panel title="Trades">
          <Empty>You need a team in this league to trade.</Empty>
        </Panel>
      </div>
    );
  }

  const [squads, offers] = await Promise.all([
    db.ownership.findMany({
      where: { leagueId: id, teamId: { not: null } },
      include: { pokemon: { select: { name: true, form: true, tier: true, iconUrl: true } } },
      orderBy: { marketValue: 'desc' },
    }),
    getTrades(id, myTeam.id),
  ]);

  const rosterByTeam: Record<
    string,
    { slug: string; label: string; tier: string; value: number; iconUrl: string | null }[]
  > = {};
  for (const row of squads) {
    if (!row.teamId) continue;
    (rosterByTeam[row.teamId] ??= []).push({
      slug: row.pokemonSlug,
      label: pokemonLabel(row.pokemon),
      tier: row.pokemon.tier,
      value: row.marketValue,
      iconUrl: row.pokemon.iconUrl,
    });
  }

  const labels = Object.fromEntries(squads.map((row) => [row.pokemonSlug, pokemonLabel(row.pokemon)]));

  return (
    <div className="flex flex-col gap-5">
      <NavTabs leagueId={id} active="trades" />

      <TradeCentre
        leagueId={id}
        myTeamId={myTeam.id}
        myCash={myTeam.cash}
        teams={league.teams.map((team) => ({ id: team.id, name: team.name }))}
        rosterByTeam={rosterByTeam}
        labels={labels}
        offers={offers.map((offer) => ({
          id: offer.id,
          fromTeamId: offer.fromTeamId,
          fromName: offer.fromTeam.name,
          toName: offer.toTeam.name,
          cash: offer.cash,
          status: offer.status,
          note: offer.note,
          give: offer.items.filter((i) => i.side === 'FROM').map((i) => i.pokemonSlug),
          get: offer.items.filter((i) => i.side === 'TO').map((i) => i.pokemonSlug),
        }))}
      />
    </div>
  );
}
