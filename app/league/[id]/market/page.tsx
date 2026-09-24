import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../../lib/auth/session.ts';
import { db } from '../../../../lib/db.ts';
import { parseTypes, pokemonLabel } from '../../../../lib/format.ts';
import { getLeagueContext } from '../../../../lib/services/league.ts';
import { openListings } from '../../../../lib/services/listings.ts';
import { NavTabs, Panel } from '../../../components/ui.tsx';
import { ListForSaleForm } from './ListForSaleForm.tsx';
import { ListingBoard } from './ListingBoard.tsx';
import { MarketTable, PriceBands, ValueRules } from './MarketTable.tsx';

export const dynamic = 'force-dynamic';

export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const context = await getLeagueContext(id, user.id);
  if (!context) notFound();
  const { myTeam, config } = context;

  const rows = await db.ownership.findMany({
    where: { leagueId: id },
    include: { pokemon: true, team: { select: { id: true, name: true } } },
    orderBy: { marketValue: 'desc' },
  });

  const owned = rows.filter((row) => row.teamId).length;

  const listings = await openListings(id);
  // Anything already up cannot be listed twice, so it is not offered.
  const onBoard = new Set(listings.map((listing) => listing.pokemonSlug));
  const sellable = myTeam
    ? rows
        .filter((row) => row.teamId === myTeam.id && !onBoard.has(row.pokemonSlug))
        .map((row) => ({
          slug: row.pokemonSlug,
          label: pokemonLabel(row.pokemon),
          value: row.marketValue,
        }))
    : [];
  const bySlug = new Map(rows.map((row) => [row.pokemonSlug, row]));
  const teams = await db.team.findMany({ where: { leagueId: id }, select: { id: true, name: true } });
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));

  return (
    <div className="flex flex-col gap-5">
      <NavTabs leagueId={id} active="market" />

      <Panel title="How value works">
        <ValueRules />
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
            What each tier costs
          </div>
          <PriceBands />
        </div>
      </Panel>

      {myTeam && (
        <Panel title="Sell to the league">
          <ListForSaleForm leagueId={id} squad={sellable} />
        </Panel>
      )}

      {listings.length > 0 && (
        <Panel title={`On the board · ${listings.length}`}>
          <p className="mb-3 text-sm text-muted">
            Pokémon a club has put up at a fixed price. First to sign takes it. A manager may pull
            their own back at any time — but one an event put there stays until it runs out.
          </p>
          <ListingBoard
            leagueId={id}
            cash={myTeam?.cash ?? 0}
            canBuy={Boolean(myTeam)}
            listings={listings.map((listing) => {
              const row = bySlug.get(listing.pokemonSlug);
              return {
                id: listing.id,
                slug: listing.pokemonSlug,
                label: row ? pokemonLabel(row.pokemon) : listing.pokemonSlug,
                tier: row?.pokemon.tier ?? 'UR',
                iconUrl: row?.pokemon.iconUrl ?? null,
                price: listing.price,
                value: row?.marketValue ?? listing.price,
                sellerName: teamNames.get(listing.teamId) ?? 'A club',
                mine: listing.teamId === myTeam?.id,
                fromEvent: listing.reason === 'EVENT',
                openUntil: listing.openUntil.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
              };
            })}
          />
        </Panel>
      )}

      <Panel title={`Market · ${owned} of ${rows.length} owned`}>
        <p className="mb-3 text-sm text-muted">
          Only one team in the league can own each Pokémon. Tap any row to sign it, release it, or
          see who has it.
        </p>
        <MarketTable
          leagueId={id}
          myTeamId={myTeam?.id ?? null}
          cash={myTeam?.cash ?? 0}
          canTrade={Boolean(myTeam)}
          allowTransferOnly={Boolean(config.allowTransferOnly)}
          rows={rows.map((row) => ({
            slug: row.pokemonSlug,
            label: pokemonLabel(row.pokemon),
            tier: row.pokemon.tier,
            types: parseTypes(row.pokemon.types),
            price: row.pokemon.baseValue,
            value: row.marketValue,
            bst: row.pokemon.effectiveBst,
            megas: (JSON.parse(row.pokemon.megas) as { label: string }[]).map((m) => m.label),
            ownerName: row.team?.name ?? null,
            ownerId: row.teamId,
            legal: row.pokemon.legal,
            restricted: row.pokemon.restricted,
            notes: row.pokemon.notes,
            iconUrl: row.pokemon.iconUrl,
            status: row.status,
          }))}
        />
      </Panel>
    </div>
  );
}
