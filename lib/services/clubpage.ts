/**
 * Everything a club page shows, gathered in one place.
 *
 * Both club pages — your own, with the board you can drag, and a rival's, which is the same page
 * without the handles — read from here, so the two can't drift apart.
 */

import { getTier } from '../ladder.ts';
import { money, pokemonLabel, parseTypes } from '../format.ts';
import { db } from '../db.ts';
import { getLineup } from './lineup.ts';
import { getAwards, getClubStats, getValueTrails, type Award, type ClubStats } from './stats.ts';

export interface ClubCard {
  slug: string;
  label: string;
  tier: string;
  types: string[];
  iconUrl: string | null;
  homeUrl: string | null;
  value: number;
  acquiredPrice: number;
  megaCount: number;
  starter: boolean;
  captain: boolean;
  number: number;
  kos: number;
  fainted: number;
  matches: number;
  streak: number;
  trail: number[];
}

export interface ClubPage {
  team: NonNullable<Awaited<ReturnType<typeof db.team.findUnique>>> & {
    user: { displayName: string };
  };
  cards: ClubCard[];
  stats: ClubStats;
  awards: Award[];
  captain: ClubCard | null;
  tierName: string;
  config: Awaited<ReturnType<typeof getLineup>>['config'];
}

export async function getClubPage(leagueId: string, teamId: string): Promise<ClubPage | null> {
  const team = await db.team.findFirst({
    where: { id: teamId, leagueId },
    include: { user: { select: { displayName: true } } },
  });
  if (!team) return null;

  const [{ config, starters, reserves }, stats, trails] = await Promise.all([
    getLineup(leagueId, teamId),
    getClubStats(leagueId, teamId),
    getValueTrails(leagueId, teamId),
  ]);

  const squad = [...starters, ...reserves];
  const cards: ClubCard[] = squad.map((row, index) => {
    const form = stats.form.get(row.pokemonSlug);
    return {
      slug: row.pokemonSlug,
      label: pokemonLabel(row.pokemon),
      tier: row.pokemon.tier,
      types: parseTypes(row.pokemon.types),
      iconUrl: row.pokemon.iconUrl,
      homeUrl: row.pokemon.homeUrl,
      value: row.marketValue,
      acquiredPrice: row.acquiredPrice,
      megaCount: (JSON.parse(row.pokemon.megas) as unknown[]).length,
      starter: row.starter,
      captain: row.captain,
      number: index + 1,
      kos: form?.kos ?? 0,
      fainted: form?.fainted ?? 0,
      matches: form?.matches ?? 0,
      streak: form?.streak ?? 0,
      trail: trails.get(row.pokemonSlug) ?? [],
    };
  });

  const labels = new Map(cards.map((card) => [card.slug, card.label]));

  return {
    team,
    cards,
    stats,
    awards: getAwards(
      stats,
      squad.map((row) => ({
        pokemonSlug: row.pokemonSlug,
        marketValue: row.marketValue,
        acquiredPrice: row.acquiredPrice,
      })),
      (slug) => labels.get(slug) ?? slug,
      money,
    ),
    captain: cards.find((card) => card.captain) ?? null,
    tierName: getTier(team.tierKey).name,
    config,
  };
}
