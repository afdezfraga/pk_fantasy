/**
 * The club's situation, and the things it has done to deserve an event.
 *
 * Two jobs, both feeding the draw in `events.ts`:
 *
 * - **Context** is what every template's `requires` block is checked against. It is what stops a
 *   "your captain is demoralised after a losing run" event firing on a five-win streak, which is
 *   the difference between events that comment on your season and events that merely interrupt
 *   it.
 * - **Triggers** are stronger: a consequence of how the manager has actually been managing. Leave
 *   a Pokémon on the bench for ten matches and it asks to leave; play the same four every single
 *   match and they burn out. A fired trigger jumps the queue ahead of the random deck, so the
 *   most pointed event available is always the one that gets drawn.
 *
 * Everything here is computed from tables that already exist — no new bookkeeping, and nothing
 * to keep in step.
 */

import { db } from '../db.ts';
import { parseTypes } from '../format.ts';
import { activeEffects, captainSpent } from './effects.ts';
import { sortByLadder } from './ladder.ts';
import { parseConfig } from './ownership.ts';

export interface ContextMember {
  pokemonSlug: string;
  name: string;
  form: string | null;
  starter: boolean;
  captain: boolean;
  marketValue: number;
  types: string[];
  hasMega: boolean;
}

/** An unowned Pokémon an event may offer. Carried on the context so `materialise` stays pure. */
export interface FreeAgent {
  pokemonSlug: string;
  name: string;
  form: string | null;
  marketValue: number;
}

export interface EventContext {
  leagueId: string;
  teamId: string;
  teamName: string;
  round: number;
  cash: number;
  tierKey: string;

  matchesPlayed: number;
  /** Consecutive wins, most recent match first. */
  winStreak: number;
  /** Consecutive losses. Both are zero after a club's very first match either way. */
  losingStreak: number;

  squad: ContextMember[];
  squadSize: number;
  /** How many more Pokémon this club may hold. An event that signs somebody needs at least one. */
  squadRoom: number;
  /** Unowned and legal, cheapest information an event needs to offer a real name. */
  freeAgents: FreeAgent[];
  squadValue: number;
  ownedTypes: string[];
  hasCaptain: boolean;
  captainAvailable: boolean;

  /** 1 is top of the table. */
  ladderPosition: number;
  teamCount: number;

  /** The starter that has gone longest without playing, and how many matches that is. */
  benched: { pokemonSlug: string; matches: number } | null;
  /** A Pokémon that has played in every one of the club's recent matches. */
  everPresent: { pokemonSlug: string; matches: number } | null;
  /** Signings plus sales this round. */
  churnThisRound: number;
}

/**
 * Who has gone longest without playing, counting only matches they could have played in.
 *
 * The cap matters more than it looks. Without it, signing a Pokémon into a club with a long
 * history makes it look as though it has been ignored for every match ever played — so the club
 * would be told its brand-new signing "has not seen the field in a long time" the moment the ink
 * dried. Appearances and opportunities are both measured from the day it arrived.
 *
 * `appearances` holds, per Pokémon, the indices of the matches it took the field in, where 0 is
 * the most recent. `joinedAt` is how many of those recent matches came after it was signed, so
 * indices `0 .. joinedAt - 1` are the ones that count.
 */
function longestBenched(
  starters: ContextMember[],
  appearances: Map<string, number[]>,
  joinedAt: Map<string, number>,
): { pokemonSlug: string; matches: number } | null {
  let worst: { pokemonSlug: string; matches: number } | null = null;

  for (const member of starters) {
    const opportunities = joinedAt.get(member.pokemonSlug) ?? 0;
    if (opportunities === 0) continue;

    const played = (appearances.get(member.pokemonSlug) ?? []).filter(
      (index) => index < opportunities,
    ).length;
    const missed = opportunities - played;

    if (!worst || missed > worst.matches) {
      worst = { pokemonSlug: member.pokemonSlug, matches: missed };
    }
  }

  return worst;
}

/** How far back the context looks. Long enough for a ten-match drought to be visible. */
const WINDOW = 20;

/**
 * How far back burnout looks.
 *
 * Deliberately shorter than `WINDOW`: an event fires roughly every five matches, so ten covers
 * about the last two event windows. Any longer and "has played in every single one" becomes a
 * bar almost nothing clears, and the event would quietly stop firing as a league matured.
 */
const BURNOUT_WINDOW = 10;

/** Assembles everything an event draw needs to know about one club. */
export async function buildContext(leagueId: string, teamId: string): Promise<EventContext | null> {
  const league = await db.league.findUnique({
    where: { id: leagueId },
    include: { teams: true },
  });
  const team = league?.teams.find((candidate) => candidate.id === teamId);
  if (!league || !team) return null;

  const [ownerships, matches, effects, unowned] = await Promise.all([
    db.ownership.findMany({
      where: { leagueId, teamId },
      include: { pokemon: { select: { name: true, form: true, types: true, megas: true } } },
      orderBy: { marketValue: 'desc' },
    }),
    db.match.findMany({
      where: { leagueId, homeTeamId: teamId },
      orderBy: { playedAt: 'desc' },
      take: WINDOW,
      include: { stats: { select: { pokemonSlug: true, benched: true, teamId: true } } },
    }),
    activeEffects(leagueId, teamId),
    db.ownership.findMany({
      where: { leagueId, teamId: null, pokemon: { legal: true } },
      include: { pokemon: { select: { name: true, form: true } } },
      orderBy: { marketValue: 'desc' },
    }),
  ]);

  const squad: ContextMember[] = ownerships.map((row) => ({
    pokemonSlug: row.pokemonSlug,
    name: row.pokemon.name,
    form: row.pokemon.form,
    starter: row.starter,
    captain: row.captain,
    marketValue: row.marketValue,
    types: parseTypes(row.pokemon.types),
    hasMega: row.pokemon.megas !== '[]' && row.pokemon.megas !== '',
  }));

  // One pass over recent matches gives the streaks and who actually took the field, keeping the
  // index of each appearance so later questions can be asked over a shorter window.
  let winStreak = 0;
  let losingStreak = 0;
  let streakSettled = false;
  const appearances = new Map<string, number[]>();

  for (const [index, match] of matches.entries()) {
    const won = match.homeScore > match.awayScore;
    if (!streakSettled) {
      if (winStreak === 0 && losingStreak === 0) {
        if (won) winStreak = 1;
        else losingStreak = 1;
      } else if (won && winStreak > 0) winStreak += 1;
      else if (!won && losingStreak > 0) losingStreak += 1;
      else streakSettled = true;
    }

    for (const stat of match.stats) {
      if (stat.teamId !== teamId || stat.benched) continue;
      appearances.set(stat.pokemonSlug, [...(appearances.get(stat.pokemonSlug) ?? []), index]);
    }
  }

  const matchesPlayed = await db.match.count({ where: { leagueId, homeTeamId: teamId } });
  const recent = matches.length;

  // How many of those recent matches each Pokémon was actually available for. A Pokémon signed
  // three matches ago has had three chances, however long the club has existed.
  const joinedAt = new Map<string, number>();
  for (const row of ownerships) {
    const since = row.acquiredAt
      ? matches.filter((match) => match.playedAt > row.acquiredAt!).length
      : recent;
    joinedAt.set(row.pokemonSlug, since);
  }

  const starters = squad.filter((member) => member.starter);
  const benched = longestBenched(starters, appearances, joinedAt);

  // Burnout asks a stricter question over a shorter window: played in *every* one of the last
  // ten. A Pokémon that missed even one has had a breather.
  const burnoutWindow = Math.min(BURNOUT_WINDOW, recent);
  let everPresent: EventContext['everPresent'] = null;
  for (const member of starters) {
    const played = (appearances.get(member.pokemonSlug) ?? []).filter(
      (index) => index < burnoutWindow,
    ).length;
    if (played === burnoutWindow && burnoutWindow > 0 && !everPresent) {
      everPresent = { pokemonSlug: member.pokemonSlug, matches: played };
    }
  }

  const churnThisRound = await db.transaction.count({
    where: {
      leagueId,
      teamId,
      type: { in: ['MARKET_BUY', 'MARKET_SELL', 'TRADE'] },
      round: league.round,
    },
  });

  const order = sortByLadder(league.teams);
  const config = parseConfig(league.config);

  return {
    leagueId,
    teamId,
    teamName: team.name,
    round: league.round,
    cash: team.cash,
    tierKey: team.tierKey,
    matchesPlayed,
    winStreak,
    losingStreak,
    squad,
    squadSize: squad.length,
    squadRoom: Math.max(0, config.squadMax - squad.length),
    freeAgents: unowned.map((row) => ({
      pokemonSlug: row.pokemonSlug,
      name: row.pokemon.name,
      form: row.pokemon.form,
      marketValue: row.marketValue,
    })),
    squadValue: squad.reduce((sum, member) => sum + member.marketValue, 0),
    ownedTypes: [...new Set(squad.flatMap((member) => member.types))],
    hasCaptain: squad.some((member) => member.captain),
    captainAvailable: squad.some((member) => member.captain) && !captainSpent(effects),
    ladderPosition: order.findIndex((candidate) => candidate.id === teamId) + 1,
    teamCount: league.teams.length,
    benched,
    everPresent,
    churnThisRound,
  };
}

// --- predicates ---------------------------------------------------------------------------------

/** A template's eligibility block. Every field is optional; all present fields must hold. */
export interface Requires {
  minMatches?: number;
  maxMatches?: number;
  minSquad?: number;
  minStarters?: number;
  /** Room for this many more Pokémon. Gates the events that hand one over. */
  minSquadRoom?: number;
  minCash?: number;
  minLosingStreak?: number;
  minWinStreak?: number;
  hasMega?: boolean;
  hasCaptain?: boolean;
  captainAvailable?: boolean;
  bottomOfLadder?: boolean;
  notBottomOfLadder?: boolean;
}

export function meetsRequires(context: EventContext, requires: Requires | undefined): boolean {
  if (!requires) return true;
  const starters = context.squad.filter((member) => member.starter).length;
  const bottom = context.teamCount > 1 && context.ladderPosition === context.teamCount;

  if (requires.minMatches !== undefined && context.matchesPlayed < requires.minMatches) return false;
  if (requires.maxMatches !== undefined && context.matchesPlayed > requires.maxMatches) return false;
  if (requires.minSquad !== undefined && context.squadSize < requires.minSquad) return false;
  if (requires.minStarters !== undefined && starters < requires.minStarters) return false;
  if (requires.minSquadRoom !== undefined && context.squadRoom < requires.minSquadRoom) return false;
  if (requires.minCash !== undefined && context.cash < requires.minCash) return false;
  if (requires.minLosingStreak !== undefined && context.losingStreak < requires.minLosingStreak) {
    return false;
  }
  if (requires.minWinStreak !== undefined && context.winStreak < requires.minWinStreak) return false;
  if (requires.hasMega && !context.squad.some((member) => member.hasMega)) return false;
  if (requires.hasCaptain && !context.hasCaptain) return false;
  if (requires.captainAvailable && !context.captainAvailable) return false;
  if (requires.bottomOfLadder && !bottom) return false;
  if (requires.notBottomOfLadder && bottom) return false;
  return true;
}

// --- triggers -----------------------------------------------------------------------------------

/** A template's trigger block. Unlike `requires`, a match here jumps the queue. */
export interface Trigger {
  /** A starter that has missed this many of the club's recent matches. */
  benchedMatches?: number;
  /** A starter that has played in this many consecutive matches. */
  everyMatchStreak?: number;
  /** Signings, sales and trades this round. */
  churnThisRound?: number;
  /** Bottom of the league table. */
  bottomOfLadder?: boolean;
}

/**
 * Whether a trigger has fired, and which Pokémon it is about.
 *
 * Returning the subject here rather than re-deriving it at apply time means the event names the
 * Pokémon that actually caused it — the one you forgot, not just your most valuable.
 */
export function fires(
  context: EventContext,
  trigger: Trigger | undefined,
): { fired: boolean; subject: string | null } {
  if (!trigger) return { fired: false, subject: null };

  if (trigger.benchedMatches !== undefined) {
    if (!context.benched || context.benched.matches < trigger.benchedMatches) {
      return { fired: false, subject: null };
    }
    return { fired: true, subject: context.benched.pokemonSlug };
  }

  if (trigger.everyMatchStreak !== undefined) {
    if (!context.everPresent || context.everPresent.matches < trigger.everyMatchStreak) {
      return { fired: false, subject: null };
    }
    return { fired: true, subject: context.everPresent.pokemonSlug };
  }

  if (trigger.churnThisRound !== undefined) {
    return { fired: context.churnThisRound >= trigger.churnThisRound, subject: null };
  }

  if (trigger.bottomOfLadder) {
    const bottom = context.teamCount > 1 && context.ladderPosition === context.teamCount;
    return { fired: bottom, subject: null };
  }

  return { fired: false, subject: null };
}
