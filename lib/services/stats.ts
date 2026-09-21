/**
 * The numbers a club page is made of.
 *
 * Everything here is derived from `Match` and `MatchPokemonStat` rather than stored on the team,
 * so deleting a match takes its stats with it and nothing has to be kept in step by hand.
 */

import { streakMultiplier } from '../../config/scoring.ts';
import { db } from '../db.ts';

export interface PokemonForm {
  pokemonSlug: string;
  matches: number;
  wins: number;
  kos: number;
  fainted: number;
  points: number;
  /** Consecutive wins in the matches this Pokémon actually played. */
  streak: number;
}

export interface ClubStats {
  /** 'W' or 'L', oldest first, for the last five matches. */
  last5: ('W' | 'L')[];
  /** Consecutive results of the same kind, most recent first. */
  run: { result: 'W' | 'L'; length: number } | null;
  winStreak: number;
  /** What the next win would be multiplied by. */
  nextMultiplier: number;
  matches: number;
  squadValue: number;
  spent: number;
  form: Map<string, PokemonForm>;
}

export async function getClubStats(leagueId: string, teamId: string): Promise<ClubStats> {
  const [matches, squad] = await Promise.all([
    db.match.findMany({
      where: { leagueId, OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] },
      include: { stats: { where: { teamId } } },
      orderBy: { playedAt: 'desc' },
      take: 100,
    }),
    db.ownership.findMany({
      where: { leagueId, teamId },
      select: { pokemonSlug: true, marketValue: true, acquiredPrice: true },
    }),
  ]);

  const won = (match: (typeof matches)[number]) =>
    match.homeTeamId === teamId
      ? match.homeScore > match.awayScore
      : match.awayScore > match.homeScore;

  const results = matches.map(won);

  let run: ClubStats['run'] = null;
  if (results.length > 0) {
    let length = 0;
    while (length < results.length && results[length] === results[0]) length += 1;
    run = { result: results[0] ? 'W' : 'L', length };
  }
  const winStreak = run?.result === 'W' ? run.length : 0;

  const form = new Map<string, PokemonForm>();
  // Oldest first, so a Pokémon's own streak counts forward and ends on its latest match.
  for (const match of [...matches].reverse()) {
    const isWin = won(match);
    for (const stat of match.stats) {
      const entry = form.get(stat.pokemonSlug) ?? {
        pokemonSlug: stat.pokemonSlug,
        matches: 0,
        wins: 0,
        kos: 0,
        fainted: 0,
        points: 0,
        streak: 0,
      };
      entry.matches += 1;
      entry.wins += isWin ? 1 : 0;
      entry.kos += stat.kos;
      entry.fainted += stat.fainted ? 1 : 0;
      entry.points += stat.points;
      entry.streak = isWin ? entry.streak + 1 : 0;
      form.set(stat.pokemonSlug, entry);
    }
  }

  return {
    last5: results.slice(0, 5).reverse().map((win) => (win ? 'W' : 'L')),
    run,
    winStreak,
    nextMultiplier: streakMultiplier(winStreak + 1),
    matches: matches.length,
    squadValue: squad.reduce((sum, row) => sum + row.marketValue, 0),
    spent: squad.reduce((sum, row) => sum + row.acquiredPrice, 0),
    form,
  };
}

export interface Award {
  key: string;
  emoji: string;
  title: string;
  /** The Pokémon that won it, already named for display. */
  name: string;
  value: string;
}

/**
 * The club's honours board.
 *
 * Only awards with something to show are returned — an empty "most KOs: 0" tells nobody
 * anything, and a page full of zeroes on day one looks broken rather than new.
 */
export function getAwards(
  stats: ClubStats,
  squad: { pokemonSlug: string; marketValue: number; acquiredPrice: number }[],
  label: (slug: string) => string,
  money: (amount: number) => string,
): Award[] {
  const forms = [...stats.form.values()];
  const best = <T>(rows: T[], by: (row: T) => number): T | null =>
    rows.length === 0 ? null : rows.reduce((a, b) => (by(b) > by(a) ? b : a));

  const topKos = best(forms, (row) => row.kos);
  const topFaints = best(forms, (row) => row.fainted);
  const topStreak = best(forms, (row) => row.streak);
  const topPoints = best(forms, (row) => row.points);
  const dearest = best(squad, (row) => row.marketValue);
  const bestDeal = best(squad, (row) => row.marketValue - row.acquiredPrice);

  const awards: (Award | null)[] = [
    topKos && topKos.kos > 0
      ? {
          key: 'kos',
          emoji: '🥇',
          title: 'Golden boot · most KOs',
          name: label(topKos.pokemonSlug),
          value: String(topKos.kos),
        }
      : null,
    topPoints && topPoints.points > 0
      ? {
          key: 'points',
          emoji: '⭐',
          title: 'Player of the season',
          name: label(topPoints.pokemonSlug),
          value: `${topPoints.points} pts`,
        }
      : null,
    topStreak && topStreak.streak > 1
      ? {
          key: 'streak',
          emoji: '📈',
          title: 'Best run going',
          name: label(topStreak.pokemonSlug),
          value: `${topStreak.streak} wins`,
        }
      : null,
    topFaints && topFaints.fainted > 0
      ? {
          key: 'faints',
          emoji: '💀',
          title: 'Down the most',
          name: label(topFaints.pokemonSlug),
          value: String(topFaints.fainted),
        }
      : null,
    dearest
      ? {
          key: 'value',
          emoji: '💎',
          title: 'Most valuable',
          name: label(dearest.pokemonSlug),
          value: money(dearest.marketValue),
        }
      : null,
    bestDeal && bestDeal.marketValue - bestDeal.acquiredPrice > 0
      ? {
          key: 'deal',
          emoji: '🧠',
          title: 'Best signing',
          name: label(bestDeal.pokemonSlug),
          value: `+${money(bestDeal.marketValue - bestDeal.acquiredPrice)}`,
        }
      : null,
  ];

  return awards.filter((award): award is Award => award !== null);
}

/**
 * The last few values of each of a squad's Pokémon, oldest first — the sparkline on its card.
 *
 * Read from the `ValueChange` trail, so the line is exactly the moves that were recorded rather
 * than a separate history that could disagree with them.
 */
export async function getValueTrails(
  leagueId: string,
  teamId: string,
  perPokemon = 12,
): Promise<Map<string, number[]>> {
  const changes = await db.valueChange.findMany({
    where: { leagueId, teamId },
    orderBy: { createdAt: 'asc' },
    select: { pokemonSlug: true, valueAfter: true },
  });

  const trails = new Map<string, number[]>();
  for (const change of changes) {
    const trail = trails.get(change.pokemonSlug) ?? [];
    trail.push(change.valueAfter);
    trails.set(change.pokemonSlug, trail);
  }
  for (const [slug, trail] of trails) {
    if (trail.length > perPokemon) trails.set(slug, trail.slice(-perPokemon));
  }
  return trails;
}
