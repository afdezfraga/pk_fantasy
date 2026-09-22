/**
 * Reporting battles, paying out, and moving Pokémon values.
 *
 * A win pays the reward for the ladder tier it was played in, multiplied by the winning streak.
 * Every Pokémon that took part moves in value by that tier's percentage, up for a win and down for
 * a loss.
 *
 * Reporting is free-for-all: anyone can report any match. Every result records who entered it,
 * and deleting a result reverses its payouts and value moves rather than patching balances, so the
 * ledger stays true whatever people do to the history.
 */

import { applyPct, valuePerf, VALUE_RULES } from '../../config/economy.ts';
import { PAYOUTS, scorePokemon, scoreTeam, type PokemonLine } from '../../config/scoring.ts';
import { db } from '../db.ts';
import { parseTypes } from '../format.ts';
import {
  activeEffects,
  chargeForEvent,
  enforce,
  payoutMultiplier,
  tickEffects,
  valueMultiplier,
  type LiveEffect,
  type MatchConstraint,
} from './effects.ts';
import { ensurePendingEvent, EventPendingError, pendingEvent } from './events.ts';
import { audit, postEntry } from './money.ts';
import { parseConfig } from './ownership.ts';
import { recordValue } from './value.ts';

export class MatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchError';
  }
}

export interface ReportInput {
  leagueId: string;
  homeTeamId: string;
  /** Null for a match against someone outside the league — a ladder game, or a solo career. */
  awayTeamId: string | null;
  /** Required when `awayTeamId` is null. */
  opponentName?: string;
  homeScore: number;
  awayScore: number;
  /** Per-Pokémon lines, for either team. Optional — a bare result still works. */
  lines: (PokemonLine & { teamId: string })[];
  /**
   * Ids of the attested effects the manager confirmed they played under.
   *
   * The app cannot check that a match was really played without Mega Evolution, so it asks and
   * records the answer — the same honour system the scoreline itself runs on.
   */
  attested?: string[];
  note?: string;
  reportedById: string;
}

/** Consecutive wins for a team, most recent match first. */
export async function winStreak(leagueId: string, teamId: string): Promise<number> {
  const recent = await db.match.findMany({
    where: { leagueId, OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] },
    orderBy: { playedAt: 'desc' },
    take: 20,
  });

  let streak = 0;
  for (const match of recent) {
    const isHome = match.homeTeamId === teamId;
    const won = isHome ? match.homeScore > match.awayScore : match.awayScore > match.homeScore;
    if (!won) break;
    streak += 1;
  }
  return streak;
}

async function squadValue(leagueId: string, teamId: string): Promise<number> {
  const result = await db.ownership.aggregate({
    where: { leagueId, teamId },
    _sum: { marketValue: true },
  });
  return result._sum.marketValue ?? 0;
}

export async function reportMatch(input: ReportInput) {
  if (input.awayTeamId && input.homeTeamId === input.awayTeamId) {
    throw new MatchError('A team cannot play itself.');
  }
  if (!input.awayTeamId && !input.opponentName?.trim()) {
    throw new MatchError('Name the opponent you played.');
  }
  if (input.homeScore === input.awayScore) {
    throw new MatchError('Champions matches have a winner — the scores cannot be level.');
  }
  if (input.homeScore < 0 || input.awayScore < 0) {
    throw new MatchError('Scores cannot be negative.');
  }

  const league = await db.league.findUniqueOrThrow({ where: { id: input.leagueId } });
  const teamIds = [input.homeTeamId, ...(input.awayTeamId ? [input.awayTeamId] : [])];
  const teams = await db.team.findMany({
    where: { leagueId: input.leagueId, id: { in: teamIds } },
  });
  if (teams.length !== teamIds.length) throw new MatchError('Both teams must be in this league.');

  // Only score Pokémon the reporting teams actually own — otherwise a typo could award points
  // for someone else's Pokémon.
  const owned = await db.ownership.findMany({
    where: { leagueId: input.leagueId, teamId: { in: teamIds } },
    select: { id: true, pokemonSlug: true, teamId: true, starter: true, marketValue: true },
  });
  const ownedBySlug = new Map(owned.map((row) => [row.pokemonSlug, row]));

  for (const line of input.lines) {
    const row = ownedBySlug.get(line.pokemonSlug);
    if (row?.teamId !== line.teamId) {
      throw new MatchError(`One of the Pokémon reported isn't on that team's squad.`);
    }
    // Only the starting lineup plays. The form can't offer a reserve, so reaching this means a
    // stale page or a hand-made request — either way the squad on file is the one that counts.
    if (!row.starter) {
      throw new MatchError(
        `Only Pokémon in the starting lineup can be reported — set your lineup on the Club page.`,
      );
    }
  }

  // A club with a decision outstanding cannot play on. Events are meant to be answered, and a
  // deadline measured in matches is the only one this app can enforce — there are no fixtures
  // and rounds close whenever the commissioner gets round to it.
  const blocking = await pendingEvent(input.leagueId, input.homeTeamId);
  if (blocking) throw new EventPendingError(blocking.title);

  // What each side is playing under. Enforcement applies to the reporting club; multipliers
  // apply to whichever side owns them.
  const effectsByTeam = new Map<string, LiveEffect[]>();
  for (const teamId of teamIds) {
    effectsByTeam.set(teamId, await activeEffects(input.leagueId, teamId));
  }

  const config = parseConfig(league.config);
  const homeEffects = effectsByTeam.get(input.homeTeamId) ?? [];
  const homeLines = input.lines.filter((line) => line.teamId === input.homeTeamId);

  const squadRows = await db.ownership.findMany({
    where: { leagueId: input.leagueId, teamId: input.homeTeamId },
    include: { pokemon: { select: { types: true } } },
  });

  const { constraints, surrendered, surrenderReason } = enforce({
    effects: homeEffects,
    squad: squadRows.map((row) => ({
      pokemonSlug: row.pokemonSlug,
      starter: row.starter,
      types: parseTypes(row.pokemon.types),
    })),
    lines: homeLines.map((line) => ({ pokemonSlug: line.pokemonSlug, benched: line.benched })),
    attested: input.attested ?? [],
    bringToMatch: config.bringToMatch,
  });

  // Sending out a Pokémon that may not play forfeits the match. The app records that rather
  // than refusing the report: a club that has sold down below a legal four has no other way to
  // log a game, and being unable to report at all is a worse outcome than losing one.
  const reportedHomeScore = surrendered ? 0 : input.homeScore;
  const reportedAwayScore = surrendered
    ? Math.max(1, homeLines.filter((line) => !line.benched).length)
    : input.awayScore;

  const homeWon = reportedHomeScore > reportedAwayScore;
  const homeValue = await squadValue(input.leagueId, input.homeTeamId);
  const awayValue = input.awayTeamId ? await squadValue(input.leagueId, input.awayTeamId) : homeValue;
  const homeStreak = await winStreak(input.leagueId, input.homeTeamId);
  const awayStreak = input.awayTeamId ? await winStreak(input.leagueId, input.awayTeamId) : 0;

  // An outside opponent has no team row, so only the league side is scored and paid.
  const sides = [
    {
      teamId: input.homeTeamId,
      tierKey: teams.find((team) => team.id === input.homeTeamId)!.tierKey,
      won: homeWon,
      underdog: homeValue < awayValue,
      streak: homeWon ? homeStreak + 1 : 0,
    },
    ...(input.awayTeamId
      ? [
          {
            teamId: input.awayTeamId,
            tierKey: teams.find((team) => team.id === input.awayTeamId)!.tierKey,
            won: !homeWon,
            underdog: awayValue < homeValue,
            streak: !homeWon ? awayStreak + 1 : 0,
          },
        ]
      : []),
  ];

  // How many matches this team has already been paid for this round.
  const paidThisRound = await db.match.count({
    where: { leagueId: input.leagueId, round: league.round, homeTeamId: input.homeTeamId },
  });
  const withinPayCap = paidThisRound < PAYOUTS.paidMatchesPerRound;

  return db.$transaction(async (tx) => {
    const match = await tx.match.create({
      data: {
        leagueId: input.leagueId,
        round: league.round,
        homeTeamId: input.homeTeamId,
        awayTeamId: input.awayTeamId,
        opponentName: input.awayTeamId ? null : input.opponentName!.trim(),
        homeScore: reportedHomeScore,
        awayScore: reportedAwayScore,
        reportedById: input.reportedById,
        note: surrendered
          ? [input.note?.trim(), `Surrendered — ${surrenderReason}`].filter(Boolean).join(' · ')
          : input.note?.trim() || null,
        tierKey: sides[0].tierKey,
        streak: sides[0].streak,
        // Frozen rather than looked up later, so a result always remembers its own conditions
        // and editing the deck can never rewrite the history of a match already played.
        constraints: constraints.length > 0 ? JSON.stringify(constraints) : null,
      },
    });

    const results: { teamId: string; points: number; money: number; streak: number }[] = [];

    for (const side of sides) {
      const lines = input.lines.filter((line) => line.teamId === side.teamId);
      const score = scoreTeam({
        lines,
        won: side.won,
        underdog: side.underdog,
        streak: side.streak,
        tierKey: side.tierKey,
      });
      const sideEffects = effectsByTeam.get(side.teamId) ?? [];
      // An event can damp or amplify what a match is worth, in money and in value alike.
      const pct = valuePerf(side.tierKey, side.won) * valueMultiplier(sideEffects);

      for (const line of lines) {
        await tx.matchPokemonStat.create({
          data: {
            matchId: match.id,
            teamId: side.teamId,
            pokemonSlug: line.pokemonSlug,
            kos: line.kos,
            fainted: line.fainted,
            benched: line.benched,
            points: scorePokemon(line),
          },
        });

        // Only the Pokémon that actually took part move in value.
        if (line.benched || pct === 0) continue;
        const row = ownedBySlug.get(line.pokemonSlug)!;
        await recordValue(tx, {
          ownershipId: row.id,
          leagueId: input.leagueId,
          teamId: side.teamId,
          pokemonSlug: line.pokemonSlug,
          reason: side.won ? 'WIN' : 'LOSS',
          from: row.marketValue,
          to: applyPct(row.marketValue, pct),
          pct,
          matchId: match.id,
          round: league.round,
        });
      }

      await tx.team.update({
        where: { id: side.teamId },
        data: {
          points: { increment: score.totalPoints },
          wins: { increment: side.won ? 1 : 0 },
          losses: { increment: side.won ? 0 : 1 },
        },
      });

      // Points, values and streaks always count; only the money is capped. Ledger amounts must
      // be whole Pokédollars, so a multiplier rounds here rather than leaving a fraction.
      const payout = withinPayCap ? Math.round(score.money * payoutMultiplier(sideEffects)) : 0;
      if (payout > 0) {
        await postEntry(tx, {
          leagueId: input.leagueId,
          teamId: side.teamId,
          type: 'MATCH_PAYOUT',
          amount: payout,
          description:
            side.streak >= 3 ? `Match won — ${side.streak}-win streak` : 'Match won',
          relatedId: match.id,
        });
      }

      results.push({
        teamId: side.teamId,
        points: score.totalPoints,
        money: payout,
        streak: side.streak,
      });
    }

    await tx.match.update({ where: { id: match.id }, data: { reward: results[0].money } });

    // A payment plan is charged per match, and may push a club into the red — it agreed to it,
    // and being unable to report would be the worse punishment.
    for (const effect of homeEffects) {
      if (effect.kind !== 'UPKEEP') continue;
      await chargeForEvent(tx, {
        leagueId: input.leagueId,
        teamId: input.homeTeamId,
        amount: -(effect.params.amount ?? 0),
        description: effect.label,
      });
    }

    // Restrictions are counted down in matches played, and the ones that lift say so out loud.
    const lifted = await tickEffects(tx, {
      leagueId: input.leagueId,
      teamId: input.homeTeamId,
      round: league.round,
    });

    await tx.team.update({
      where: { id: input.homeTeamId },
      data: { eventCountdown: { decrement: 1 } },
    });

    await audit(tx, {
      leagueId: input.leagueId,
      actorUserId: input.reportedById,
      action: 'MATCH_REPORT',
      detail: { matchId: match.id, results, surrendered },
    });

    return {
      match,
      results,
      paid: withinPayCap,
      paidThisRound: paidThisRound + 1,
      surrendered,
      lifted: lifted.map((effect) => effect.liftedMessage),
    };
  });
}

/**
 * Reports a match, then draws the club's next event if this one brought it due.
 *
 * The draw sits outside the match transaction on purpose: an event failing to draw must never
 * roll back a result somebody has already played.
 */
export async function reportMatchAndDraw(input: ReportInput) {
  const result = await reportMatch(input);
  const event = await ensurePendingEvent(input.leagueId, input.homeTeamId);
  return { ...result, drewEvent: event !== null };
}

/**
 * Removes a match and undoes everything it caused.
 *
 * Compensating ledger entries rather than deleting the originals: the ledger is append-only, so
 * "this never happened" is itself recorded.
 */
export async function deleteMatch(input: { matchId: string; actorUserId: string }) {
  return db.$transaction(async (tx) => {
    const match = await tx.match.findUniqueOrThrow({
      where: { id: input.matchId },
      include: { stats: true, valueChanges: true },
    });

    // Take back each value move — but only from a Pokémon still with the team that earned it. One
    // sold or traded since has already been cashed out at that value, and the new owner didn't
    // earn or lose anything from this match.
    for (const change of match.valueChanges) {
      const row = await tx.ownership.findUnique({
        where: {
          leagueId_pokemonSlug: { leagueId: match.leagueId, pokemonSlug: change.pokemonSlug },
        },
      });
      if (!row || row.teamId !== change.teamId) continue;
      await tx.ownership.update({
        where: { id: row.id },
        data: { marketValue: Math.max(VALUE_RULES.minValue, row.marketValue - change.delta) },
      });
    }

    const payouts = await tx.transaction.findMany({
      where: { relatedId: match.id, type: 'MATCH_PAYOUT' },
    });

    for (const payout of payouts) {
      if (!payout.teamId) continue;
      await postEntry(tx, {
        leagueId: match.leagueId,
        teamId: payout.teamId,
        type: 'MATCH_PAYOUT',
        amount: -payout.amount,
        description: 'Reversed — match deleted',
        relatedId: match.id,
      });
    }

    const homeWon = match.homeScore > match.awayScore;
    const affected: [string, boolean][] = [
      [match.homeTeamId, homeWon],
      ...(match.awayTeamId ? ([[match.awayTeamId, !homeWon]] as [string, boolean][]) : []),
    ];
    for (const [teamId, won] of affected) {
      const points = match.stats
        .filter((stat) => stat.teamId === teamId)
        .reduce((sum, stat) => sum + stat.points, 0);
      // Bonus points aren't stored per team, so recompute the same way they were awarded.
      const lines = match.stats
        .filter((stat) => stat.teamId === teamId)
        .map((stat) => ({
          pokemonSlug: stat.pokemonSlug,
          kos: stat.kos,
          fainted: stat.fainted,
          benched: stat.benched,
        }));
      const recomputed = scoreTeam({
        lines,
        won,
        underdog: false,
        streak: won ? 1 : 0,
        tierKey: match.tierKey ?? 'beginner',
      });
      void points;

      await tx.team.update({
        where: { id: teamId },
        data: {
          points: { decrement: recomputed.totalPoints },
          wins: { decrement: won ? 1 : 0 },
          losses: { decrement: won ? 0 : 1 },
        },
      });
    }

    // Give back the match this one counted against every restriction still in force, and the
    // one it counted toward the next event.
    //
    // Deliberately partial: an event this match *drew* stays drawn, and a decision already
    // taken stays taken. That matches how the ledger treats a deleted match — the money comes
    // back through a compensating entry rather than the history being rewritten — and undoing
    // a choice somebody has already lived with would be worse than leaving it.
    await tx.activeEffect.updateMany({
      where: { leagueId: match.leagueId, teamId: match.homeTeamId, matchesLeft: { gt: 0 } },
      data: { matchesLeft: { increment: 1 } },
    });
    await tx.team.update({
      where: { id: match.homeTeamId },
      data: { eventCountdown: { increment: 1 } },
    });

    await tx.match.delete({ where: { id: match.id } });

    await audit(tx, {
      leagueId: match.leagueId,
      actorUserId: input.actorUserId,
      action: 'MATCH_DELETE',
      detail: { matchId: match.id },
    });

    return match;
  });
}

/** Recent matches with the names needed to render them. */
export async function getMatches(leagueId: string, take = 25) {
  return db.match.findMany({
    where: { leagueId },
    include: { homeTeam: true, awayTeam: true, stats: true, valueChanges: true },
    orderBy: { playedAt: 'desc' },
    take,
  });
}

export { PAYOUTS };
